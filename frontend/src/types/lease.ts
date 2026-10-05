import type { Diagram } from './diagram'
import type { Furniture } from './furniture'
import type { Member } from './member'
import type { DisassemblyStep } from './step'

/**
 * 编辑租约。同一 jointTypeId 在 leases 表中至多存在一条未过期记录，
 * 自增主键（fence）作为租约世代号：每次接管都会换发更大的 fence，
 * 旧页迟到保存时凭此被守卫识别并拦下。
 */
export interface LeaseRecord {
  jointTypeId: string
  holderId: string
  holderName: string
  fence: number
  acquiredAt: number
  expiresAt: number
}

export interface StageEntryBase {
  /** 暂存条目自身主键，例如 member:member-dt-tenon */
  id: string
  savedAt: number
  /** 最近一次写入该条目的标签页；与当前持有者不同即“上一版未确认修改” */
  authorId: string
  authorName: string
  /** 写入时所持租约的世代号 */
  savedFence: number
  /** 被租约守卫拦下的迟到保存（旧页超时后写入），需显式确认 */
  fromLateSave: boolean
  /** 备份/迟到条目指向的正式条目 id；正式条目该字段为空 */
  refId?: string
  note?: string
}

export interface MemberStageEntry extends StageEntryBase {
  kind: 'member'
  member: Member
}

export interface StepOrderStageEntry extends StageEntryBase {
  kind: 'step-order'
  /** 整个拆装步序重排后的完整序列，入库时 bulkPut */
  steps: DisassemblyStep[]
}

export interface DiagramStageEntry extends StageEntryBase {
  kind: 'diagram'
  diagram: Diagram
}

export interface FurnitureStageEntry extends StageEntryBase {
  kind: 'furniture'
  /** 已生成正式 id、但尚未入正表的家具关联 */
  furniture: Furniture
}

export type StageEntry =
  | MemberStageEntry
  | StepOrderStageEntry
  | DiagramStageEntry
  | FurnitureStageEntry

export type StageEntryKind = StageEntry['kind']

/** 每个榫卯一份暂存区，租约交接时原样保留 */
export interface EditStage {
  jointTypeId: string
  entries: StageEntry[]
  updatedAt: number
}

export interface PendingSummary {
  jointTypeId: string
  total: number
  mine: number
  handoff: number
  late: number
}

export type LeaseChannelMessage =
  | {
      type: 'lease-acquired'
      jointTypeId: string
      holderId: string
      holderName: string
      fence: number
      acquiredAt: number
      expiresAt: number
    }
  | { type: 'lease-heartbeat'; jointTypeId: string; holderId: string; expiresAt: number }
  | { type: 'lease-released'; jointTypeId: string; holderId: string }
  | {
      type: 'lease-taken'
      jointTypeId: string
      holderId: string
      holderName: string
      fence: number
      expiresAt: number
    }
  | { type: 'stage-updated'; jointTypeId: string; byHolderId: string }
  | { type: 'catalog-committed'; jointTypeId: string; byHolderId: string }
