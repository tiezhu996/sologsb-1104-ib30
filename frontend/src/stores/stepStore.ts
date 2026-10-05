import { create } from 'zustand'
import type { DisassemblyStep } from '../types/step'
import { leaseManager } from '../leases/leaseManager'
import { db } from '../utils/db'

interface StepState {
  steps: DisassemblyStep[]
  currentStepIndex: number
  loading: boolean
  loadSteps: (jointTypeId: string) => Promise<void>
  moveStep: (jointTypeId: string, from: number, to: number) => Promise<void>
  setCurrentStep: (index: number) => void
}

export const useStepStore = create<StepState>((set, get) => ({
  steps: [],
  currentStepIndex: 0,
  loading: false,

  loadSteps: async (jointTypeId) => {
    set({ loading: true })
    try {
      const steps = await db.steps.where('jointTypeId').equals(jointTypeId).sortBy('seq')
      set((state) => ({
        steps,
        currentStepIndex: Math.min(state.currentStepIndex, Math.max(0, steps.length - 1)),
      }))
    } finally {
      set({ loading: false })
    }
  },

  moveStep: async (jointTypeId, from, to) => {
    const ordered = [...get().steps]
      .filter((step) => step.jointTypeId === jointTypeId)
      .sort((a, b) => a.seq - b.seq)
    if (from < 0 || to < 0 || from >= ordered.length || to >= ordered.length || from === to) return
    const [moved] = ordered.splice(from, 1)
    if (!moved) return
    ordered.splice(to, 0, moved)
    const resequenced = ordered.map((step, index) => ({ ...step, seq: index + 1 }))
    set((state) => ({
      steps: [
        ...state.steps.filter((step) => step.jointTypeId !== jointTypeId),
        ...resequenced,
      ],
      currentStepIndex: to,
    }))
    // 调序归当前编辑租约：先在工作区留底，再做 fence 校验写入
    leaseManager.patchDraft(jointTypeId, 'steps', () => resequenced)
    await leaseManager.commitSteps(jointTypeId, resequenced)
  },

  setCurrentStep: (index) => set({
    currentStepIndex: Math.max(0, index),
  }),
}))
