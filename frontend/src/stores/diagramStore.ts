import { create } from 'zustand'
import type { Diagram } from '../types/diagram'
import { leaseManager } from '../leases/leaseManager'
import { db } from '../utils/db'

interface DiagramState {
  diagrams: Diagram[]
  selectedDiagramId: string | null
  selectedMemberId: string | null
  draftSvgMarkup: string
  draftTitle: string
  currentJointTypeId: string | null
  loading: boolean
  loadDiagrams: (jointTypeId: string) => Promise<void>
  setSelectedDiagram: (id: string) => void
  setSelectedMember: (id: string | null) => void
  setDraftSvgMarkup: (markup: string) => void
  setDraftTitle: (title: string) => void
  saveDraft: () => Promise<void>
  saveDiagram: (diagram: Diagram) => Promise<void>
}

function patchSelectedDiagram(
  jointTypeId: string | null,
  diagramId: string | null,
  patch: (diagram: Diagram) => Diagram,
): void {
  if (!jointTypeId || !diagramId) return
  leaseManager.patchDraft(jointTypeId, 'diagrams', (rows) =>
    rows.map((diagram) => (diagram.id === diagramId ? patch(diagram) : diagram)),
  )
}

export const useDiagramStore = create<DiagramState>((set, get) => ({
  diagrams: [],
  selectedDiagramId: null,
  selectedMemberId: null,
  draftSvgMarkup: '',
  draftTitle: '',
  currentJointTypeId: null,
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
          diagrams,
          currentJointTypeId: jointTypeId,
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
    const selected = state.diagrams.find((diagram) => diagram.id === id)
    return {
      selectedDiagramId: id,
      selectedMemberId: null,
      draftSvgMarkup: selected?.svgMarkup ?? '',
      draftTitle: selected?.title ?? '',
    }
  }),

  setSelectedMember: (id) => set({ selectedMemberId: id }),

  setDraftSvgMarkup: (markup) => {
    const state = get()
    set({ draftSvgMarkup: markup })
    patchSelectedDiagram(state.currentJointTypeId, state.selectedDiagramId, (diagram) => ({ ...diagram, svgMarkup: markup }))
  },

  setDraftTitle: (title) => {
    const state = get()
    set({ draftTitle: title })
    patchSelectedDiagram(state.currentJointTypeId, state.selectedDiagramId, (diagram) => ({ ...diagram, title }))
  },

  saveDraft: async () => {
    const state = get()
    const selected = state.diagrams.find((diagram) => diagram.id === state.selectedDiagramId)
    if (!selected) return
    const updated: Diagram = {
      ...selected,
      title: state.draftTitle.trim() || selected.title,
      svgMarkup: state.draftSvgMarkup,
    }
    await get().saveDiagram(updated)
  },

  saveDiagram: async (diagram) => {
    const state = get()
    if (!state.currentJointTypeId) throw new Error('尚未进入示意图绘制台，无法保存')
    // 内联图保存受当前编辑租约 fence 保护；旧页迟到保存在此被拒绝
    leaseManager.patchDraft(state.currentJointTypeId, 'diagrams', (rows) =>
      rows.map((item) => (item.id === diagram.id ? diagram : item)),
    )
    await leaseManager.commitDiagram(state.currentJointTypeId, diagram)
    set((current) => ({
      diagrams: current.diagrams.map((item) => item.id === diagram.id ? diagram : item),
      draftSvgMarkup: current.selectedDiagramId === diagram.id ? diagram.svgMarkup : current.draftSvgMarkup,
      draftTitle: current.selectedDiagramId === diagram.id ? diagram.title : current.draftTitle,
    }))
  },
}))
