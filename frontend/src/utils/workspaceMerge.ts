import type { Diagram } from '../types/diagram'
import type { Furniture } from '../types/furniture'
import type { Member } from '../types/member'
import type { StageEntry } from '../types/lease'
import type { DisassemblyStep } from '../types/step'

/**
 * 图鉴正表与暂存区合并：编辑页展示的一律是“含待确认修改”的工作副本，
 * 只有正式条目（无 refId 且非迟到停放）参与覆盖；交接备份与迟到条目
 * 只出现在待复核面板中，不会混进正常视图。
 */

function canonical(entries: StageEntry[]): StageEntry[] {
  return entries.filter((entry) => !entry.refId && !entry.fromLateSave)
}

export function mergeMembers(catalog: Member[], entries: StageEntry[]): Member[] {
  const staged = new Map(
    canonical(entries)
      .filter((entry): entry is Extract<StageEntry, { kind: 'member' }> => entry.kind === 'member')
      .map((entry) => [entry.member.id, entry.member]),
  )
  return catalog.map((member) => staged.get(member.id) ?? member)
}

export function mergeSteps(
  catalog: DisassemblyStep[],
  entries: StageEntry[],
): DisassemblyStep[] {
  const order = canonical(entries).find((entry) => entry.kind === 'step-order') as
    | Extract<StageEntry, { kind: 'step-order' }>
    | undefined
  return order ? order.steps : catalog
}

export function mergeDiagrams(catalog: Diagram[], entries: StageEntry[]): Diagram[] {
  const staged = new Map(
    canonical(entries)
      .filter((entry): entry is Extract<StageEntry, { kind: 'diagram' }> => entry.kind === 'diagram')
      .map((entry) => [entry.diagram.id, entry.diagram]),
  )
  return catalog.map((diagram) => staged.get(diagram.id) ?? diagram)
}

export function mergeFurniture(catalog: Furniture[], entries: StageEntry[]): Furniture[] {
  const staged = canonical(entries)
    .filter((entry): entry is Extract<StageEntry, { kind: 'furniture' }> => entry.kind === 'furniture')
    .map((entry) => entry.furniture)
  const stagedIds = new Set(staged.map((item) => item.id))
  return [...catalog.filter((item) => !stagedIds.has(item.id)), ...staged]
}

/** 某类数据是否存在待确认的正式条目 */
export function hasPendingKind(entries: StageEntry[], kind: StageEntry['kind']): boolean {
  return canonical(entries).some((entry) => entry.kind === kind)
}
