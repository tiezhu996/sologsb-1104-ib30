/* eslint-disable no-console */
/**
 * 单写者租约交接端到端验证（Node + fake-indexeddb）。
 * 用两个 holder 身份模拟同一浏览器的两个标签页：
 *  1. 先到先得，他页占用时第二页只能只读
 *  2. 持有者所有编辑先进暂存，不写正表
 *  3. 确认入库只发生在租约有效时，五张正表在单事务内更新
 *  4. 旧租约超时后他页接管（fence 换发），旧页迟到保存被守卫拦下并停放
 *  5. 交接时上一版未确认修改保留为备份，接管者可采纳
 *  6. 崩溃（不释放）后 TTL 到期，另一页可接管；暂存仍可找回
 */

// ---- 浏览器环境垫片 ----
class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>()
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor(public name: string) {
    const set = FakeBroadcastChannel.channels.get(name) ?? new Set<FakeBroadcastChannel>()
    set.add(this)
    FakeBroadcastChannel.channels.set(name, set)
  }
  postMessage(data: unknown) {
    const set = FakeBroadcastChannel.channels.get(this.name)
    set?.forEach((peer) => {
      if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data }))
    })
  }
  addEventListener(type: string, handler: (event: { data: unknown }) => void) {
    if (type === 'message') this.onmessage = handler
  }
  removeEventListener() {
    this.onmessage = null
  }
  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }
}

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

const sharedIndexedDB = new IDBFactory()
;(globalThis as { indexedDB?: unknown }).indexedDB = sharedIndexedDB
;(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange
;(globalThis as { structuredClone?: unknown }).structuredClone ??= (value: unknown) =>
  JSON.parse(JSON.stringify(value))
;(globalThis as { addEventListener?: unknown }).addEventListener ??= () => {}
;(globalThis as { window?: unknown }).window = globalThis

function setupSession(holderId: string, holderName: string): void {
  const storage = new Map<string, string>([
    ['gbmortise-holder-id', holderId],
    ['gbmortise-holder-name', holderName],
  ])
  ;(globalThis as { sessionStorage?: Storage }).sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() { return storage.size },
  } as Storage
  ;(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel
}

type Modules = {
  db: typeof import('../src/utils/db.ts').db
  leaseManager: typeof import('../src/utils/leaseManager.ts').leaseManager
  stage: typeof import('../src/utils/stageService.ts')
}

let singleton: Modules | null = null

/** 切换“当前标签页”身份（共享模块图下模拟不同运行时） */
async function asTab(holderId: string, holderName: string): Promise<Modules> {
  setupSession(holderId, holderName)
  if (!singleton) {
    singleton = {
      db: (await import('../src/utils/db.ts')).db,
      leaseManager: (await import('../src/utils/leaseManager.ts')).leaseManager,
      stage: await import('../src/utils/stageService.ts'),
    }
  }
  singleton.leaseManager.__setHolderForTests(holderId, holderName)
  return singleton
}

let failures = 0
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

async function main() {
  const jointTypeId = 'joint-dovetail'
  let tabA = await asTab('tab-A', '标签页 AAAA')
  let tabB = await asTab('tab-B', '标签页 BBBB')

  console.log('1) 领取与互斥')
  tabA = await asTab('tab-A', '标签页 AAAA')
  const acquiredA = await tabA.leaseManager.acquire(jointTypeId)
  assert(acquiredA.status === 'acquired' && acquiredA.lease.fence > 0, 'A 首次领取成功，fence 为自增主键')
  const fenceA = acquiredA.status === 'acquired' ? acquiredA.lease.fence : 0

  tabB = await asTab('tab-B', '标签页 BBBB')
  const acquiredB = await tabB.leaseManager.acquire(jointTypeId)
  assert(acquiredB.status === 'held-by-other', 'B 在 A 持约期间只能看到 held-by-other')

  console.log('2) 编辑只进暂存，不碰正表')
  tabA = await asTab('tab-A', '标签页 AAAA')
  const memberBefore = await tabA.db.members.get('member-dt-tenon')
  const editedMember = { ...(memberBefore!), lengthMm: 222 }
  await tabA.stage.stageMember(jointTypeId, fenceA, editedMember)
  const memberAfterStage = await tabA.db.members.get('member-dt-tenon')
  assert(memberAfterStage?.lengthMm === 128, '暂存后正表构件尺寸仍为种子值 128')
  const stageA = await tabA.stage.getStage(jointTypeId)
  assert(stageA.entries.some((entry) => entry.id === 'member:member-dt-tenon'), '暂存区出现构件修改条目')

  console.log('3) 确认入库需要有效租约，且一次事务写正表')
  await tabA.stage.commitStage(jointTypeId, fenceA)
  const memberCommitted = await tabA.db.members.get('member-dt-tenon')
  assert(memberCommitted?.lengthMm === 222, '提交后正表更新为 222')
  const stageAfterCommit = await tabA.stage.getStage(jointTypeId)
  assert(stageAfterCommit.entries.length === 0, '提交成功后正式条目从暂存移除')

  console.log('4) 超时接管 + 旧页迟到保存被拦截')
  await tabA.stage.stageMember(jointTypeId, fenceA, { ...editedMember, widthMm: 88 })
  const leaseARow = await tabA.db.leases.get(fenceA)
  await tabA.db.leases.put({ ...leaseARow!, expiresAt: Date.now() - 1 })

  tabB = await asTab('tab-B', '标签页 BBBB')
  const takeover = await tabB.leaseManager.acquire(jointTypeId)
  assert(takeover.status === 'acquired' && takeover.tookOver === true, 'B 在 A 超时后接管成功')
  assert(takeover.lease.fence > fenceA, '新 fence 大于旧 fence')
  const fenceB = takeover.status === 'acquired' ? takeover.lease.fence : 0

  tabA = await asTab('tab-A', '标签页 AAAA')
  let lateCaught = false
  try {
    await tabA.stage.stageMember(jointTypeId, fenceA, { ...editedMember, thicknessMm: 99 })
  } catch {
    lateCaught = true
  }
  assert(lateCaught, 'A 的迟到保存抛出租约失效错误')
  const memberStill = await tabA.db.members.get('member-dt-tenon')
  assert(memberStill?.thicknessMm !== 99, '迟到保存没有写入正表')
  const stageAfterLate = await tabB.stage.getStage(jointTypeId)
  const lateEntry = stageAfterLate.entries.find((entry) => entry.fromLateSave)
  assert(Boolean(lateEntry), '迟到保存被停放为 fromLateSave 待复核条目')
  assert(lateEntry?.refId === 'member:member-dt-tenon', '迟到条目指向正式条目 id')

  console.log('5) 交接保留上一版未确认修改')
  tabB = await asTab('tab-B', '标签页 BBBB')
  await tabB.stage.stageMember(jointTypeId, fenceB, { ...editedMember, widthMm: 77 })
  const stageHandoff = await tabB.stage.getStage(jointTypeId)
  const handoffBackup = stageHandoff.entries.find(
    (entry) => entry.refId === 'member:member-dt-tenon' && !entry.fromLateSave,
  )
  assert(Boolean(handoffBackup), 'B 接手修改后，A 的上一版保留为交接备份')
  const canonicalEntry = stageHandoff.entries.find((entry) => entry.id === 'member:member-dt-tenon')
  assert(
    canonicalEntry?.kind === 'member' && canonicalEntry.member.widthMm === 77,
    '正式暂存条目是 B 的新版 77',
  )

  await tabB.stage.adoptStageEntry(jointTypeId, handoffBackup!.id)
  const stageAdopted = await tabB.stage.getStage(jointTypeId)
  const adoptedCanonical = stageAdopted.entries.find((entry) => entry.id === 'member:member-dt-tenon')
  assert(
    adoptedCanonical?.kind === 'member' && adoptedCanonical.member.widthMm === 88,
    '采纳后正式条目恢复为 A 的上一版 88',
  )

  console.log('6) 崩溃恢复：TTL 到期可接管，暂存不丢')
  const leaseBRow = await tabB.db.leases.get(fenceB)
  await tabB.db.leases.put({ ...leaseBRow!, expiresAt: Date.now() - 1 })
  tabA = await asTab('tab-A', '标签页 AAAA')
  const recoveredA = await tabA.leaseManager.acquire(jointTypeId)
  assert(recoveredA.status === 'acquired', 'B 崩溃超时后 A 可重新领取')
  const stageRecovered = await tabA.stage.getStage(jointTypeId)
  assert(stageRecovered.entries.length >= 2, '重开后暂存区（含备份/迟到条目）仍然可找回')

  console.log('7) 旧 fence 无法确认入库')
  const fenceRecovered = recoveredA.status === 'acquired' ? recoveredA.lease.fence : 0
  tabB = await asTab('tab-B', '标签页 BBBB')
  let commitBlocked = false
  try {
    await tabB.stage.commitStage(jointTypeId, fenceB)
  } catch (error) {
    commitBlocked = error instanceof tabB.stage.NotLeaseHolderError
  }
  assert(commitBlocked, 'B 失去租约后确认入库被整笔拒绝（NotLeaseHolderError）')
  tabA = await asTab('tab-A', '标签页 AAAA')
  const result = await tabA.stage.commitStage(jointTypeId, fenceRecovered)
  assert(result.committed >= 1, 'A 用新 fence 成功把正式条目入库')

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部租约交接断言通过')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
