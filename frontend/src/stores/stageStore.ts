import { create } from 'zustand'
import type { EditStage, StageEntry } from '../types/lease'
import { editBus } from '../utils/editBus'
import { leaseManager } from '../utils/leaseManager'
import {
  adoptStageEntry,
  commitStage,
  discardStageEntry,
  getAllStages,
  getStage,
} from '../utils/stageService'

export interface CommitOutcome {
  ok: boolean
  committed: number
  message?: string
}

interface StageState {
  /** jointTypeId -> 暂存区；null 表示已加载但为空 */
  stages: Record<string, EditStage | null>
  loadingJoint: string | null
  loadForJoint: (jointTypeId: string) => Promise<EditStage>
  loadAll: () => Promise<void>
  commit: (jointTypeId: string, fence: number) => Promise<CommitOutcome>
  discard: (jointTypeId: string, entryId: string) => Promise<void>
  adopt: (jointTypeId: string, entryId: string) => Promise<void>
  /** 本地乐观更新（写入暂存成功后立即反映到 UI） */
  patchEntry: (jointTypeId: string, entry: StageEntry) => void
  entriesFor: (jointTypeId: string) => StageEntry[]
  /** 每个榫卯的待确认/待复核数量汇总，供总览角标使用 */
  summaries: () => Array<{ jointTypeId: string; pending: number; review: number }>
}

function emptyStage(jointTypeId: string): EditStage {
  return { jointTypeId, entries: [], updatedAt: Date.now() }
}

export const useStageStore = create<StageState>((set, get) => {
  // 其他标签页更新了暂存或入库后，重新拉取受影响的榫卯暂存区
  editBus.subscribe((message) => {
    if (message.type === 'stage-updated') {
      void get().loadForJoint(message.jointTypeId)
      void get().loadAll()
      return
    }
    if (message.type === 'catalog-committed') {
      // 他页入库后正表变化，各编辑页的工作副本由 RemoteCatalogSync 刷新；
      // 这里同步暂存视图（正式条目已被清掉）
      void get().loadForJoint(message.jointTypeId)
      void get().loadAll()
    }
  })

  return {
    stages: {},
    loadingJoint: null,

    loadForJoint: async (jointTypeId) => {
      set({ loadingJoint: jointTypeId })
      try {
        const stage = await getStage(jointTypeId)
        set((state) => ({ stages: { ...state.stages, [jointTypeId]: stage } }))
        return stage
      } finally {
        set({ loadingJoint: null })
      }
    },

    loadAll: async () => {
      const all = await getAllStages()
      set((state) => {
        const stages = { ...state.stages }
        all.forEach((stage) => {
          stages[stage.jointTypeId] = stage
        })
        return { stages }
      })
    },

    commit: async (jointTypeId, fence) => {
      try {
        const { committed } = await commitStage(jointTypeId, fence)
        await get().loadForJoint(jointTypeId)
        editBus.post({
          type: 'catalog-committed',
          jointTypeId,
          byHolderId: leaseManager.holder.id,
        })
        return { ok: true, committed }
      } catch (error) {
        return {
          ok: false,
          committed: 0,
          message: error instanceof Error ? error.message : '入库失败，未确认修改仍保留在暂存区。',
        }
      }
    },

    discard: async (jointTypeId, entryId) => {
      await discardStageEntry(jointTypeId, entryId)
      await get().loadForJoint(jointTypeId)
      editBus.post({ type: 'stage-updated', jointTypeId, byHolderId: leaseManager.holder.id })
    },

    adopt: async (jointTypeId, entryId) => {
      await adoptStageEntry(jointTypeId, entryId)
      await get().loadForJoint(jointTypeId)
      editBus.post({ type: 'stage-updated', jointTypeId, byHolderId: leaseManager.holder.id })
    },

    patchEntry: (jointTypeId, entry) => {
      set((state) => {
        const stage = state.stages[jointTypeId] ?? emptyStage(jointTypeId)
        const rest = stage.entries.filter((item) => item.id !== entry.id)
        const next: EditStage = {
          ...stage,
          entries: [...rest, entry],
          updatedAt: Date.now(),
        }
        return { stages: { ...state.stages, [jointTypeId]: next } }
      })
    },

    entriesFor: (jointTypeId) => get().stages[jointTypeId]?.entries ?? [],

    summaries: () => Object.values(get().stages)
      .filter((stage): stage is EditStage => Boolean(stage))
      .map((stage) => ({
        jointTypeId: stage.jointTypeId,
        pending: stage.entries.filter((entry) => !entry.refId && !entry.fromLateSave).length,
        review: stage.entries.filter((entry) => Boolean(entry.refId) || entry.fromLateSave).length,
      }))
      .filter((item) => item.pending > 0 || item.review > 0),
  }
})
