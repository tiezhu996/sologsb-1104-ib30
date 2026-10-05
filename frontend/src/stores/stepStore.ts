import { create } from 'zustand'
import type { DisassemblyStep } from '../types/step'
import { db } from '../utils/db'
import { editBus } from '../utils/editBus'
import { leaseManager } from '../utils/leaseManager'
import { stageStepOrder } from '../utils/stageService'
import { useStageStore } from './stageStore'

function notifyStaged(jointTypeId: string): void {
  void useStageStore.getState().loadForJoint(jointTypeId)
  editBus.post({ type: 'stage-updated', jointTypeId, byHolderId: leaseManager.holder.id })
}

interface StepState {
  /** 各榫卯的步序工作副本：已入库序列与暂存序列的最新值 */
  stepsByJoint: Record<string, DisassemblyStep[]>
  currentStepIndex: number
  loading: boolean
  loadSteps: (jointTypeId: string) => Promise<void>
  /** 拖拽调序归属编辑租约：只写暂存区，确认后才入正表 */
  moveStep: (
    jointTypeId: string,
    fence: number,
    currentSteps: DisassemblyStep[],
    from: number,
    to: number,
  ) => Promise<void>
  setCurrentStep: (index: number) => void
}

export const useStepStore = create<StepState>((set, get) => ({
  stepsByJoint: {},
  currentStepIndex: 0,
  loading: false,

  loadSteps: async (jointTypeId) => {
    set({ loading: true })
    try {
      const steps = await db.steps.where('jointTypeId').equals(jointTypeId).sortBy('seq')
      set((state) => ({
        stepsByJoint: { ...state.stepsByJoint, [jointTypeId]: steps },
        currentStepIndex: Math.min(state.currentStepIndex, Math.max(0, steps.length - 1)),
      }))
    } finally {
      set({ loading: false })
    }
  },

  moveStep: async (jointTypeId, fence, currentSteps, from, to) => {
    const ordered = [...currentSteps].sort((a, b) => a.seq - b.seq)
    if (from < 0 || to < 0 || from >= ordered.length || to >= ordered.length || from === to) return
    const [moved] = ordered.splice(from, 1)
    if (!moved) return
    ordered.splice(to, 0, moved)
    const resequenced = ordered.map((step, index) => ({ ...step, seq: index + 1 }))
    // 乐观更新先行；守卫不通过会回滚并重新拉取
    set((state) => ({
      stepsByJoint: { ...state.stepsByJoint, [jointTypeId]: resequenced },
      currentStepIndex: to,
    }))
    try {
      await stageStepOrder(jointTypeId, fence, resequenced)
      notifyStaged(jointTypeId)
    } catch (error) {
      await get().loadSteps(jointTypeId)
      void useStageStore.getState().loadForJoint(jointTypeId)
      throw error
    }
  },

  setCurrentStep: (index) => set({
    currentStepIndex: Math.max(0, index),
  }),
}))
