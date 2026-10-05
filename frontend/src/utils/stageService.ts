import { db } from './db'
import { leaseManager, LeaseExpiredError } from './leaseManager'
import type {
  DiagramStageEntry,
  EditStage,
  FurnitureStageEntry,
  MemberStageEntry,
  StageEntry,
  StepOrderStageEntry,
} from '../types/lease'

type StageWriteResult = { late: boolean }

function emptyStage(jointTypeId: string): EditStage {
  return { jointTypeId, entries: [], updatedAt: Date.now() }
}

async function mutateStage(
  jointTypeId: string,
  mutate: (stage: EditStage) => void,
): Promise<EditStage> {
  return db.transaction('rw', db.stages, async () => {
    const stage = (await db.stages.get(jointTypeId)) ?? emptyStage(jointTypeId)
    mutate(stage)
    stage.updatedAt = Date.now()
    await db.stages.put(stage)
    return stage
  })
}

function removeEntry(stage: EditStage, entryId: string): void {
  stage.entries = stage.entries.filter((entry) => entry.id !== entryId)
}

function findCanonical(stage: EditStage, entryId: string): StageEntry | undefined {
  return stage.entries.find((entry) => entry.id === entryId && !entry.refId)
}

/** 为“上一版未确认修改”留一份交接备份；同一来源的备份只保留最新一份 */
function keepHandoffBackup(stage: EditStage, current: StageEntry): void {
  const backupId = `${current.id}:handoff:${current.authorId}`
  removeEntry(stage, backupId)
  stage.entries.push({
    ...current,
    id: backupId,
    refId: current.id,
    fromLateSave: false,
  } as StageEntry)
}

/** 旧页迟到保存被守卫拦下：停放为待复核迟到条目，绝不直接覆盖图鉴或新暂存 */
function parkLateEntry(stage: EditStage, attempted: StageEntry, canonicalId?: string): void {
  const lateId = `${attempted.id}:late:${attempted.savedAt}`
  removeEntry(stage, lateId)
  stage.entries.push({
    ...attempted,
    id: lateId,
    refId: canonicalId,
    fromLateSave: true,
    note: '旧租约超时后的迟到保存，未写入图鉴，请人工复核。',
  } as StageEntry)
}

/** 暂存一次编辑（写前过租约守卫），返回是否被判定为迟到保存 */
async function stageEntry(
  jointTypeId: string,
  fence: number,
  build: (meta: {
    savedAt: number
    authorId: string
    authorName: string
    savedFence: number
  }) => StageEntry,
): Promise<StageWriteResult> {
  const now = Date.now()
  const attempted = build({
    savedAt: now,
    authorId: leaseManager.holder.id,
    authorName: leaseManager.holder.name,
    savedFence: fence,
  })

  return db.transaction('rw', [db.stages, db.leases], async () => {
    // 唯一权威判定：在写入同一事务内读取租约行，
    // 保证“领取—编辑—暂存”之间若发生接管，本次保存必定被拦下。
    const liveLease = await db.leases.get(fence)
    const valid = Boolean(
      liveLease
        && liveLease.holderId === leaseManager.holder.id
        && liveLease.jointTypeId === jointTypeId
        && liveLease.expiresAt > now,
    )

    await mutateStage(jointTypeId, (stage) => {
      const existing = findCanonical(stage, attempted.id)

      if (!valid) {
        parkLateEntry(stage, attempted, existing?.id)
        return
      }

      if (existing && existing.authorId !== attempted.authorId) {
        // 新持有者首次改同一条目：先保留上一版未确认修改
        keepHandoffBackup(stage, existing)
      }
      removeEntry(stage, attempted.id)
      stage.entries.push(attempted)
    })

    return { late: !valid }
  })
}

/** 守卫失败时抛出的错误带条目信息，便于 UI 提示 */
async function guardOrThrow(
  result: StageWriteResult,
): Promise<void> {
  if (result.late) throw new LeaseExpiredError()
}

export async function getStage(jointTypeId: string): Promise<EditStage> {
  return (await db.stages.get(jointTypeId)) ?? emptyStage(jointTypeId)
}

export async function getAllStages(): Promise<EditStage[]> {
  return db.stages.toArray()
}

// ---- 各类编辑的暂存入口 -------------------------------------------------

export async function stageMember(
  jointTypeId: string,
  fence: number,
  member: MemberStageEntry['member'],
): Promise<void> {
  const result = await stageEntry(jointTypeId, fence, (meta) => ({
    id: `member:${member.id}`,
    kind: 'member',
    member: { ...member },
    fromLateSave: false,
    ...meta,
  }))
  await guardOrThrow(result)
}

export async function stageStepOrder(
  jointTypeId: string,
  fence: number,
  steps: StepOrderStageEntry['steps'],
): Promise<void> {
  const result = await stageEntry(jointTypeId, fence, (meta) => ({
    id: `step-order:${jointTypeId}`,
    kind: 'step-order',
    steps: steps.map((step) => ({ ...step })),
    fromLateSave: false,
    ...meta,
  }))
  await guardOrThrow(result)
}

export async function stageDiagram(
  jointTypeId: string,
  fence: number,
  diagram: DiagramStageEntry['diagram'],
): Promise<void> {
  const result = await stageEntry(jointTypeId, fence, (meta) => ({
    id: `diagram:${diagram.id}`,
    kind: 'diagram',
    diagram: { ...diagram },
    fromLateSave: false,
    ...meta,
  }))
  await guardOrThrow(result)
}

export async function stageFurniture(
  jointTypeId: string,
  fence: number,
  furniture: FurnitureStageEntry['furniture'],
): Promise<void> {
  const result = await stageEntry(jointTypeId, fence, (meta) => ({
    id: `furniture:${furniture.id}`,
    kind: 'furniture',
    furniture: { ...furniture },
    fromLateSave: false,
    ...meta,
  }))
  await guardOrThrow(result)
}

// ---- 待复核操作 ---------------------------------------------------------

/** 丢弃某条暂存（正式条目 / 交接备份 / 迟到条目都可以） */
export async function discardStageEntry(jointTypeId: string, entryId: string): Promise<void> {
  await mutateStage(jointTypeId, (stage) => {
    // 丢弃正式条目时，它派生的备份/迟到条目一并清掉，避免悬挂
    const related = stage.entries.filter((entry) => entry.refId === entryId)
    related.forEach((entry) => removeEntry(stage, entry.id))
    removeEntry(stage, entryId)
  })
}

/** 采纳交接备份/迟到条目为当前待确认正式条目 */
export async function adoptStageEntry(jointTypeId: string, entryId: string): Promise<void> {
  await mutateStage(jointTypeId, (stage) => {
    const entry = stage.entries.find((item) => item.id === entryId)
    if (!entry || !entry.refId) return
    const canonicalId = entry.refId
    const promoted: StageEntry = {
      ...entry,
      id: canonicalId,
      refId: undefined,
      fromLateSave: false,
      note: undefined,
      savedAt: Date.now(),
    }
    // 旧正式条目的内容先存为交接备份，不丢失当前版本
    const current = findCanonical(stage, canonicalId)
    if (current) keepHandoffBackup(stage, current)
    removeEntry(stage, canonicalId)
    removeEntry(stage, entryId)
    stage.entries.push(promoted)
  })
}

// ---- 入库（唯一允许写五张正表的入口） ------------------------------------

export class NotLeaseHolderError extends Error {
  constructor() {
    super('只有当前持有编辑租约的标签页才能确认入库。')
    this.name = 'NotLeaseHolderError'
  }
}

/**
 * 把暂存区中的正式条目（不含备份/迟到条目）确认写入图鉴。
 * 全程在一个 IndexedDB 事务内完成，并在事务内复核租约 fence：
 * 旧页即便点到“入库”，也会因租约已被接管而整笔回滚。
 * 提交成功后，仅清理对应交接备份；迟到条目保留供人工处理。
 */
export async function commitStage(jointTypeId: string, fence: number): Promise<{ committed: number }> {
  const stage = await getStage(jointTypeId)
  const canonical = stage.entries.filter((entry) => !entry.refId && !entry.fromLateSave)
  if (canonical.length === 0) return { committed: 0 }

  await db.transaction(
    'rw',
    [db.leases, db.joints, db.members, db.steps, db.diagrams, db.furniture, db.stages],
    async () => {
      const now = Date.now()
      const lease = await db.leases.get(fence)
      if (
        !lease
        || lease.holderId !== leaseManager.holder.id
        || lease.jointTypeId !== jointTypeId
        || lease.expiresAt <= now
      ) {
        throw new NotLeaseHolderError()
      }

      for (const entry of canonical) {
        if (entry.kind === 'member') {
          await db.members.put(entry.member)
        } else if (entry.kind === 'step-order') {
          await db.steps.bulkPut(entry.steps)
        } else if (entry.kind === 'diagram') {
          await db.diagrams.put(entry.diagram)
        } else if (entry.kind === 'furniture') {
          await db.furniture.put(entry.furniture)
        }
      }

      await mutateStage(jointTypeId, (mutable) => {
        for (const entry of canonical) {
          removeEntry(mutable, entry.id)
          // 对应交接备份（不是迟到条目）入库后已无意义
          mutable.entries = mutable.entries.filter(
            (item) => !(item.refId === entry.id && !item.fromLateSave),
          )
        }
      })
    },
  )

  return { committed: canonical.length }
}
