import { create } from 'zustand'
import type { Furniture, FurnitureName } from '../types/furniture'
import type { JointType } from '../types/jointType'
import type { Member } from '../types/member'
import { leaseManager } from '../leases/leaseManager'
import { db, ensureSeedData } from '../utils/db'

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
  addFurniture: (draft: FurnitureDraft) => Promise<Furniture>
  setSelectedJoint: (id: string) => void
  updateMemberDimensions: (
    memberId: string,
    dimensions: Pick<Member, 'lengthMm' | 'widthMm' | 'thicknessMm' | 'toleranceMm'>,
  ) => Promise<void>
  renameMember: (memberId: string, name: Member['name']) => Promise<void>
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** 构件修改由租约工作区留底并受 fence 保护落库；迟到旧页写入在此被拒 */
async function commitMemberChange(next: Member): Promise<void> {
  await leaseManager.commitMember(next.jointTypeId, next)
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
    const joint: JointType = { ...draft, id: createId('joint'), schemaRev: 2 }
    await db.joints.add(joint)
    set((state) => ({
      joints: [...state.joints, joint].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      selectedJointId: joint.id,
      stepCounts: { ...state.stepCounts, [joint.id]: 0 },
    }))
    return joint
  },

  addFurniture: async (draft) => {
    // 家具关系同样归编辑租约：反查页新建时临时领取，写完立即交还
    return leaseManager.withQuickLease(draft.jointTypeId, async () => {
      const furniture: Furniture = { ...draft, id: createId('furniture'), schemaRev: 2 }
      leaseManager.patchDraft(draft.jointTypeId, 'furniture', (rows) => [...rows, furniture])
      await db.furniture.add(furniture)
      set((state) => ({ furniture: [...state.furniture, furniture] }))
      return furniture
    })
  },

  setSelectedJoint: (id) => set({ selectedJointId: id }),

  updateMemberDimensions: async (memberId, dimensions) => {
    const member = get().members.find((item) => item.id === memberId)
    if (!member) return
    const next: Member = { ...member, ...dimensions, schemaRev: member.schemaRev ?? 2 }
    await commitMemberChange(next)
    set((state) => ({
      members: state.members.map((item) => (item.id === memberId ? next : item)),
    }))
  },

  renameMember: async (memberId, name) => {
    const member = get().members.find((item) => item.id === memberId)
    if (!member) return
    const next: Member = { ...member, name, schemaRev: member.schemaRev ?? 2 }
    await commitMemberChange(next)
    set((state) => ({
      members: state.members.map((item) => (item.id === memberId ? next : item)),
    }))
  },
}))

export type { FurnitureName }
