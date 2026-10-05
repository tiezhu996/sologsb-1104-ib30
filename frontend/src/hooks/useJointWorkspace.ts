import { useEffect, useMemo } from 'react'
import { useDiagramStore } from '../stores/diagramStore'
import { useJointStore } from '../stores/jointStore'
import { useStageStore } from '../stores/stageStore'
import { useStepStore } from '../stores/stepStore'
import { mergeDiagrams, mergeFurniture, mergeMembers, mergeSteps } from '../utils/workspaceMerge'
import type { Diagram } from '../types/diagram'
import type { Furniture } from '../types/furniture'
import type { Member } from '../types/member'
import type { StageEntry } from '../types/lease'
import type { DisassemblyStep } from '../types/step'

export interface JointWorkspace {
  members: Member[]
  steps: DisassemblyStep[]
  diagrams: Diagram[]
  furniture: Furniture[]
  /** 全部暂存条目（含交接备份与迟到条目），供待复核面板使用 */
  stageEntries: StageEntry[]
  /** 需要人工处理：交接备份 + 迟到停放 */
  reviewEntries: StageEntry[]
  /** 待确认入图鉴的正式修改数 */
  pendingCount: number
  /** 其中由别的标签页留下、接管后可见的数量 */
  handoffCount: number
  /** 被守卫拦下的迟到保存数量 */
  lateCount: number
  reload: () => Promise<void>
}

/**
 * 汇总某个榫卯的图鉴正表与暂存区，返回编辑页应展示的工作副本。
 * 进入时确保正表与暂存都已加载；其他标签页入库后由总线触发刷新。
 */
export function useJointWorkspace(jointTypeId: string): JointWorkspace {
  const loadAll = useJointStore((state) => state.loadAll)
  const catalogMembers = useJointStore((state) => state.members)
  const catalogFurniture = useJointStore((state) => state.furniture)
  const catalogStepsByJoint = useStepStore((state) => state.stepsByJoint)
  const catalogDiagramsByJoint = useDiagramStore((state) => state.diagramsByJoint)
  const loadSteps = useStepStore((state) => state.loadSteps)
  const loadDiagrams = useDiagramStore((state) => state.loadDiagrams)
  const stage = useStageStore((state) => state.stages[jointTypeId])
  const loadForJoint = useStageStore((state) => state.loadForJoint)

  useEffect(() => {
    if (!jointTypeId) return
    void loadAll()
    void loadSteps(jointTypeId)
    void loadDiagrams(jointTypeId)
    void loadForJoint(jointTypeId)
  }, [jointTypeId, loadAll, loadSteps, loadDiagrams, loadForJoint])

  const stageEntries = stage?.entries ?? []

  const members = useMemo(
    () => mergeMembers(
      catalogMembers.filter((member) => member.jointTypeId === jointTypeId),
      stageEntries,
    ),
    [catalogMembers, jointTypeId, stageEntries],
  )
  const steps = useMemo(
    () => mergeSteps(catalogStepsByJoint[jointTypeId] ?? [], stageEntries),
    [catalogStepsByJoint, jointTypeId, stageEntries],
  )
  const diagrams = useMemo(
    () => mergeDiagrams(catalogDiagramsByJoint[jointTypeId] ?? [], stageEntries),
    [catalogDiagramsByJoint, jointTypeId, stageEntries],
  )
  const furniture = useMemo(
    () => mergeFurniture(
      catalogFurniture.filter((item) => item.jointTypeId === jointTypeId),
      stageEntries,
    ),
    [catalogFurniture, jointTypeId, stageEntries],
  )

  const reviewEntries = useMemo(
    () => stageEntries.filter((entry) => entry.refId || entry.fromLateSave),
    [stageEntries],
  )
  const pendingEntries = useMemo(
    () => stageEntries.filter((entry) => !entry.refId && !entry.fromLateSave),
    [stageEntries],
  )

  return {
    members,
    steps,
    diagrams,
    furniture,
    stageEntries,
    reviewEntries,
    pendingCount: pendingEntries.length,
    handoffCount: reviewEntries.filter((entry) => !entry.fromLateSave).length,
    lateCount: reviewEntries.filter((entry) => entry.fromLateSave).length,
    reload: async () => {
      await Promise.all([
        loadAll(),
        loadSteps(jointTypeId),
        loadDiagrams(jointTypeId),
        loadForJoint(jointTypeId),
      ])
    },
  }
}
