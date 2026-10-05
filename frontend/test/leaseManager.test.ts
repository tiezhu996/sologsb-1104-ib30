import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
// fake-indexeddb 必须在引入 db 之前完成全局注入
import 'fake-indexeddb/auto'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import Dexie from 'dexie'
import { EditLeaseManager, LeaseBusyError, LeaseLostError, disposeAllManagersForTest } from '../src/leases/leaseManager'
import { db, ensureSeedData } from '../src/utils/db'
import type { Member } from '../src/types/member'

let manager: EditLeaseManager
const RESOURCE = 'joint-dovetail'

async function expireLease(resourceId = RESOURCE): Promise<void> {
  const lease = await db.leases.get(resourceId)
  assert.ok(lease)
  await db.leases.put({ ...lease, expiresAt: Date.now() - 1 })
}

async function getMember(memberId: string): Promise<Member | undefined> {
  return db.members.get(memberId)
}

function patchMemberLength(member: Member, lengthMm: number): Member {
  return { ...member, lengthMm }
}

beforeEach(async () => {
  // 每个用例独立的 IndexedDB 实例，避免租约 / 种子数据相互污染
  const fresh = new IDBFactory()
  Dexie.dependencies.indexedDB = fresh as unknown as IDBFactory
  Dexie.dependencies.IDBKeyRange = IDBKeyRange
  // 断开并删除上一用例的连接，强制 Dexie 用新工厂重新建库
  await db.delete()
  await db.open()
  await ensureSeedData()
  manager = new EditLeaseManager('标签页甲')
})

afterEach(async () => {
  await disposeAllManagersForTest()
  await db.close()
})

test('同一榫卯同时只能有一个写者，活跃租约未过期时拒绝第二页', async () => {
  await manager.retain(RESOURCE)
  const other = new EditLeaseManager('标签页乙')
  await assert.rejects(() => other.retain(RESOURCE), LeaseBusyError)
})

test('租约过期后另一页可接管，fence 递增并产生交接', async () => {
  const first = await manager.retain(RESOURCE)
  await expireLease()

  const other = new EditLeaseManager('标签页乙')
  const second = await other.retain(RESOURCE)
  assert.notEqual(second.leaseId, first.leaseId)
  assert.ok(second.fence > first.fence)
})

test('旧写者迟到保存不能写入已入库图鉴（fence/leaseId 校验）', async () => {
  await manager.retain(RESOURCE)
  const member = (await getMember('member-dt-tenon'))!
  await manager.commitMember(RESOURCE, patchMemberLength(member, 200))
  assert.equal((await getMember('member-dt-tenon'))?.lengthMm, 200)

  // 模拟崩溃：租约过期，第二页接管
  await expireLease()
  const other = new EditLeaseManager('标签页乙')
  await other.retain(RESOURCE)

  // 旧页迟到保存（其内存中的 member 对象 + 旧租约身份）
  const stale = patchMemberLength(member, 999)
  await assert.rejects(() => manager.commitMember(RESOURCE, stale), LeaseLostError)

  // 图鉴保持接管后的值，未被旧页覆盖
  assert.equal((await getMember('member-dt-tenon'))?.lengthMm, 200)
})

test('接管时保留上一版未确认修改，接管者能看到待复核内容并选择性采用', async () => {
  await manager.retain(RESOURCE)
  // 输入但未保存的 SVG 修改只存在于工作区
  manager.patchDraft(RESOURCE, 'diagrams', (rows) =>
    rows.map((d) => (d.id === 'diagram-dovetail' ? { ...d, svgMarkup: '<svg>未保存的修改</svg>' } : d)),
  )
  await manager.persistDraft(RESOURCE)

  await expireLease()
  const other = new EditLeaseManager('标签页乙')
  await other.retain(RESOURCE)

  const stashes = await other.listPendingStashes(RESOURCE)
  assert.equal(stashes.length, 1)
  const diff = await other.diffAgainstCommitted(RESOURCE, stashes[0]!)
  assert.ok(diff)
  assert.equal(diff!.diagrams.length, 1)
  assert.equal(diff!.diagrams[0]!.state, 'changed')

  // 接管者采用后才写入图鉴
  await other.adoptStash(stashes[0]!.id, ['diagrams'])
  const adopted = await db.diagrams.get('diagram-dovetail')
  assert.equal(adopted?.svgMarkup, '<svg>未保存的修改</svg>')
  assert.equal((await other.listPendingStashes(RESOURCE)).length, 0)
})

test('写入失败后重开仍能在恢复队列找回并重试', async () => {
  await manager.retain(RESOURCE)
  const held = manager.currentLeaseForTest(RESOURCE)
  const member = (await getMember('member-dt-tenon'))!

  // 手工构造一笔停在 pending 的提交（模拟写入事务失败 / 进程中断）
  await db.commits.put({
    id: 'commit-crashed',
    resourceId: RESOURCE,
    leaseId: held!.leaseId,
    fence: held!.fence,
    holder: manager.tabId,
    createdAt: Date.now(),
    attempts: 0,
    lastError: 'crash',
    status: 'pending',
    kind: 'member',
    payload: patchMemberLength(member, 333),
  })

  const pending = await manager.listPendingCommits(RESOURCE)
  assert.equal(pending.length, 1)
  await manager.retryCommit('commit-crashed')
  assert.equal((await getMember('member-dt-tenon'))?.lengthMm, 333)
  assert.equal((await manager.listPendingCommits(RESOURCE)).length, 0)
})

test('交接后旧租约遗留的失败写入不能重放，被拒绝且不覆盖图鉴', async () => {
  await manager.retain(RESOURCE)
  const oldLease = manager.currentLeaseForTest(RESOURCE)!
  const member = (await getMember('member-dt-tenon'))!
  await db.commits.put({
    id: 'commit-stale',
    resourceId: RESOURCE,
    leaseId: oldLease.leaseId,
    fence: oldLease.fence,
    holder: manager.tabId,
    createdAt: Date.now(),
    attempts: 0,
    lastError: 'crash',
    status: 'pending',
    kind: 'member',
    payload: patchMemberLength(member, 777),
  })

  await expireLease()
  const other = new EditLeaseManager('标签页乙')
  const newLease = await other.retain(RESOURCE)
  assert.notEqual(newLease.leaseId, oldLease.leaseId)

  await assert.rejects(() => other.retryCommit('commit-stale'), LeaseLostError)
  const row = await db.commits.get('commit-stale')
  assert.equal(row?.status, 'rejected')
  assert.notEqual((await getMember('member-dt-tenon'))?.lengthMm, 777)
})

test('构件尺寸 / 拆装动作 / 内联图 / 家具关系四类内容都归同一份租约', async () => {
  const lease = await manager.retain(RESOURCE)
  await manager.commitMember(RESOURCE, patchMemberLength((await getMember('member-dt-tenon'))!, 150))
  const steps = (await db.steps.where('jointTypeId').equals(RESOURCE).toArray())
    .sort((a, b) => a.seq - b.seq)
    .map((s, i) => ({ ...s, seq: i + 1, holdSec: s.holdSec + 1 }))
  await manager.commitSteps(RESOURCE, steps)
  const diagram = await db.diagrams.get('diagram-dovetail')
  await manager.commitDiagram(RESOURCE, { ...diagram!, title: '接管后的图名' })

  // 另一页租约活跃时，家具关系写入也被挡住
  const other = new EditLeaseManager('标签页乙')
  await assert.rejects(
    () => other.withQuickLease(RESOURCE, async () => 'written'),
    LeaseBusyError,
  )

  // 工作区快照包含四类内容且随租约更新
  await manager.persistDraft(RESOURCE)
  const draft = manager.getDraft(RESOURCE)
  assert.ok(draft)
  assert.equal(draft!.leaseId, lease.leaseId)
  assert.ok(draft!.members.some((m) => m.lengthMm === 150))
  assert.ok(draft!.steps.every((s) => s.holdSec >= 7))
  assert.ok(draft!.diagrams.some((d) => d.title === '接管后的图名'))
  assert.ok(draft!.furniture.length >= 1)
})

test('同标签页快速重复领取（SPA 跳转）不产生新租约', async () => {
  const first = await manager.retain(RESOURCE)
  const second = await manager.retain(RESOURCE)
  assert.equal(second.leaseId, first.leaseId)
})

test('与已入库内容一致的工作区不产生待复核留底', async () => {
  await manager.retain(RESOURCE)
  await expireLease()
  const other = new EditLeaseManager('标签页乙')
  await other.retain(RESOURCE)
  assert.equal((await other.listPendingStashes(RESOURCE)).length, 0)
})

test('接管者采用或丢弃留底时，旧租约遗留的 pending 写入一并作废', async () => {
  await manager.retain(RESOURCE)
  const oldLease = manager.currentLeaseForTest(RESOURCE)!
  // 未确认修改
  manager.patchDraft(RESOURCE, 'diagrams', (rows) =>
    rows.map((d) => (d.id === 'diagram-dovetail' ? { ...d, title: '旧页留底标题' } : d)),
  )
  await manager.persistDraft(RESOURCE)
  // 以及一笔失败留队的提交
  const member = (await getMember('member-dt-tenon'))!
  await db.commits.put({
    id: 'commit-pending',
    resourceId: RESOURCE,
    leaseId: oldLease.leaseId,
    fence: oldLease.fence,
    holder: manager.tabId,
    createdAt: Date.now(),
    attempts: 0,
    lastError: 'storage error',
    status: 'pending',
    kind: 'member',
    payload: patchMemberLength(member, 888),
  })

  await expireLease()
  const other = new EditLeaseManager('标签页乙')
  await other.retain(RESOURCE)
  const stashes = await other.listPendingStashes(RESOURCE)
  assert.equal(stashes.length, 1)

  await other.adoptStash(stashes[0]!.id, ['diagrams'])

  const stale = await db.commits.get('commit-pending')
  assert.equal(stale?.status, 'rejected')
  // 被作废的提交内容没有写进图鉴，且恢复队列不再列出它
  assert.notEqual((await getMember('member-dt-tenon'))?.lengthMm, 888)
  assert.deepEqual(await other.listPendingCommits(RESOURCE), [])
})
