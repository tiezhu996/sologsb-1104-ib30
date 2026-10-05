import { create } from 'zustand'
import type { LeaseRecord } from '../types/lease'
import { leaseManager } from '../utils/leaseManager'

export type LeaseStatus = 'loading' | 'held' | 'locked' | 'reclaim'

interface LeaseState {
  /** jointTypeId -> 当前有效租约（本页或他页） */
  leases: Record<string, LeaseRecord | null>
  statusOf: (jointTypeId: string) => LeaseStatus
  refresh: (jointTypeId: string) => Promise<LeaseRecord | null>
  acquire: (jointTypeId: string) => Promise<{ ok: boolean; tookOver: boolean }>
  release: (jointTypeId: string) => Promise<void>
}

function statusFor(jointTypeId: string, lease: LeaseRecord | null | undefined): LeaseStatus {
  if (lease === undefined) return 'loading'
  if (!lease) return 'reclaim'
  return lease.holderId === leaseManager.holder.id ? 'held' : 'locked'
}

export const useLeaseStore = create<LeaseState>((set, get) => {
  // 租约变化（心跳、接管、释放）时把最新租约灌进 store
  leaseManager.onLeaseChange((jointTypeId, lease) => {
    set((state) => ({ leases: { ...state.leases, [jointTypeId]: lease } }))
  })

  return {
    leases: {},

    statusOf: (jointTypeId) => statusFor(jointTypeId, get().leases[jointTypeId]),

    refresh: async (jointTypeId) => {
      const lease = await leaseManager.getActiveLease(jointTypeId)
      set((state) => ({ leases: { ...state.leases, [jointTypeId]: lease } }))
      return lease
    },

    acquire: async (jointTypeId) => {
      const outcome = await leaseManager.acquire(jointTypeId)
      if (outcome.status === 'held-by-other') return { ok: false, tookOver: false }
      return { ok: true, tookOver: outcome.tookOver }
    },

    release: async (jointTypeId) => {
      await leaseManager.release(jointTypeId)
      set((state) => ({ leases: { ...state.leases, [jointTypeId]: null } }))
    },
  }
})
