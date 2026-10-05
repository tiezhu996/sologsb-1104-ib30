import { create } from 'zustand'
import type { Diagram } from '../types/diagram'
import { db } from '../utils/db'
import { editBus } from '../utils/editBus'
import { leaseManager } from '../utils/leaseManager'
import { stageDiagram } from '../utils/stageService'
import { useStageStore } from './stageStore'

function notifyStaged(jointTypeId: string): void {
  void useStageStore.getState().loadForJoint(jointTypeId)
  editBus.post({ type: 'stage-updated', jointTypeId, byHolderId: leaseManager.holder.id })
}

interface DiagramState {
  /** 各榫卯的示意图工作副本（含待确认修改） */
  diagramsByJoint: Record<string, Diagram[]>
  selectedDiagramId: string | null
  selectedMemberId: string | null
  draftSvgMarkup: string
  draftTitle: string
  loading: boolean
  loadDiagrams: (jointTypeId: string) => Promise<void>
  setSelectedDiagram: (id: string) => void
  setSelectedMember: (id: string | null) => void
  setDraftSvgMarkup: (markup: string) => void
  setDraftTitle: (title: string) => void
  /** 保存内联图归属编辑租约：只写暂存区，确认后才入正表 */
  saveDraft: (
    jointTypeId: string,
    fence: number,
    base: Diagram,
    title: string,
    svgMarkup: string,
  ) => Promise<Diagram>
}

export const useDiagramStore = create<DiagramState>((set, get) => ({
  diagramsByJoint: {},
  selectedDiagramId: null,
  selectedMemberId: null,
  draftSvgMarkup: '',
  draftTitle: '',
  loading: false,

  loadDiagrams: async (jointTypeId) => {
    set({ loading: true })
    try {
      const diagrams = await db.diagrams.where('jointTypeId').equals(jointTypeId).toArray()
      set((state) => {
        const selectedDiagramId = diagrams.some((diagram) => diagram.id === state.selectedDiagramId)
          ? state.selectedDiagramId
          : diagrams[0]?.id ?? null
        const selected = diagrams.find((diagram) => diagram.id === selectedDiagramId)
        return {
          diagramsByJoint: { ...state.diagramsByJoint, [jointTypeId]: diagrams },
          selectedDiagramId,
          selectedMemberId: selectedDiagramId === state.selectedDiagramId ? state.selectedMemberId : null,
          draftSvgMarkup: selected?.svgMarkup ?? '',
          draftTitle: selected?.title ?? '',
        }
      })
    } finally {
      set({ loading: false })
    }
  },

  setSelectedDiagram: (id) => set((state) => {
    const diagrams = Object.values(state.diagramsByJoint).flat()
    const selected = diagrams.find((diagram) => diagram.id === id)
    return {
      selectedDiagramId: id,
      selectedMemberId: null,
      draftSvgMarkup: selected?.svgMarkup ?? '',
      draftTitle: selected?.title ?? '',
    }
  }),

  setSelectedMember: (id) => set({ selectedMemberId: id }),
  setDraftSvgMarkup: (markup) => set({ draftSvgMarkup: markup }),
  setDraftTitle: (title) => set({ draftTitle: title }),

  saveDraft: async (jointTypeId, fence, base, title, svgMarkup) => {
    const updated: Diagram = {
      ...base,
      title: title.trim() || base.title,
      svgMarkup,
    }
    try {
      await stageDiagram(jointTypeId, fence, updated)
      notifyStaged(jointTypeId)
    } catch (error) {
      await get().loadDiagrams(jointTypeId)
      void useStageStore.getState().loadForJoint(jointTypeId)
      throw error
    }
    set((current) => ({
      diagramsByJoint: {
        ...current.diagramsByJoint,
        [jointTypeId]: (current.diagramsByJoint[jointTypeId] ?? [])
          .map((item) => (item.id === updated.id ? updated : item)),
      },
      draftTitle: updated.title,
      draftSvgMarkup: updated.svgMarkup,
    }))
    return updated
  },
}))
