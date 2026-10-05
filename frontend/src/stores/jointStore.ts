import { create } from 'zustand'
import type { Furniture, FurnitureName } from '../types/furniture'
import type { JointType } from '../types/jointType'
import type { Member } from '../types/member'
import { db, ensureSeedData } from '../utils/db'
import { editBus } from '../utils/editBus'
import { leaseManager, LeaseExpiredError } from '../utils/leaseManager'
import { stageFurniture, stageMember } from '../utils/stageService'
import { useStageStore } from './stageStore'

function notifyStaged(jointTypeId: string): void {
  // 本页写入后立即刷新暂存缓存（跨标签页通道不会回送发送者）
  void useStageStore.getState().loadForJoint(jointTypeId)
  editBus.post({ type: 'stage-updated', jointTypeId, byHolderId: leaseManager.holder.id })
}

export type JointDraft = Omit<JointType, 'id' | 'schemaRev'>
export type FurnitureDraft = Omit<Furniture, 'id' | 'schemaRev'>

interface JointState {
  joints: JointType[]
  members: Member[]
  furniture: Furniture[]
  stepCounts: Record<string, number>
  selectedJointId: string | null
  loading: boolean
  loadAll: () => Promise<void>
  addJoint: (draft: JointDraft) => Promise<JointType>
  /** 家具关系归属编辑租约：先暂存，确认后才入正表 */
  stageFurnitureRelation: (jointTypeId: string, fence: number, draft: FurnitureDraft) => Promise<Furniture>
  setSelectedJoint: (id: string) => void
  /** 构件尺寸修改归属编辑租约：只写暂存区 */
  updateMemberDimensions: (
    jointTypeId: string,
    memberId: string,
    dimensions: Pick<Member, 'lengthMm' | 'widthMm' | 'thicknessMm' | 'toleranceMm'>,
  ) => Promise<void>
  renameMember: (jointTypeId: string, memberId: string, name: Member['name']) => Promise<void>
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** 写入暂存前按当前租约做一次校验，返回可用 fence；失效则抛错 */
async function requireFence(jointTypeId: string): Promise<number> {
  const lease = await leaseManager.getActiveLease(jointTypeId)
  if (!lease || lease.holderId !== leaseManager.holder.id) throw new LeaseExpiredError()
  return lease.fence
}

export const useJointStore = create<JointState>((set, get) => ({
  joints: [],
  members: [],
  furniture: [],
  stepCounts: {},
  selectedJointId: null,
  loading: false,

  loadAll: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      await ensureSeedData()
      const [joints, members, furniture, steps] = await Promise.all([
        db.joints.toArray(),
        db.members.toArray(),
        db.furniture.toArray(),
        db.steps.toArray(),
      ])
      const stepCounts = steps.reduce<Record<string, number>>((counts, step) => {
        counts[step.jointTypeId] = (counts[step.jointTypeId] ?? 0) + 1
        return counts
      }, {})
      const selectedJointId = get().selectedJointId
      set({
        joints: joints.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
        members,
        furniture,
        stepCounts,
        selectedJointId: selectedJointId && joints.some((joint) => joint.id === selectedJointId)
          ? selectedJointId
          : joints[0]?.id ?? null,
      })
    } finally {
      set({ loading: false })
    }
  },

  addJoint: async (draft) => {
    const joint: JointType = { ...draft, id: createId('joint'), schemaRev: 3 }
    await db.joints.add(joint)
    set((state) => ({
      joints: [...state.joints, joint].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      selectedJointId: joint.id,
      stepCounts: { ...state.stepCounts, [joint.id]: 0 },
    }))
    return joint
  },

  stageFurnitureRelation: async (jointTypeId, fence, draft) => {
    const furniture: Furniture = {
      ...draft,
      id: createId('furniture'),
      schemaRev: 3,
    }
    await stageFurniture(jointTypeId, fence, furniture)
    notifyStaged(jointTypeId)
    return furniture
  },

  setSelectedJoint: (id) => set({ selectedJointId: id }),

  updateMemberDimensions: async (jointTypeId, memberId, dimensions) => {
    const current = get().members.find((member) => member.id === memberId)
    if (!current) return
    const fence = await requireFence(jointTypeId)
    const member: Member = { ...current, ...dimensions }
    await stageMember(jointTypeId, fence, member)
    notifyStaged(jointTypeId)
    set((state) => ({
      members: state.members.map((item) => (item.id === memberId ? member : item)),
    }))
  },

  renameMember: async (jointTypeId, memberId, name) => {
    const current = get().members.find((member) => member.id === memberId)
    if (!current) return
    const fence = await requireFence(jointTypeId)
    const member: Member = { ...current, name }
    await stageMember(jointTypeId, fence, member)
    notifyStaged(jointTypeId)
    set((state) => ({
      members: state.members.map((item) => (item.id === memberId ? member : item)),
    }))
  },
}))

export type { FurnitureName }
