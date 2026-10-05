import { useCallback, useEffect, useState } from 'react'
import { useLeaseStore } from '../stores/leaseStore'
import { leaseManager } from '../utils/leaseManager'
import type { LeaseRecord } from '../types/lease'

export interface JointLease {
  status: 'loading' | 'held' | 'locked' | 'reclaim'
  lease: LeaseRecord | null
  holderName: string
  /** 他人租约剩余毫秒数，用于展示可接管倒计时 */
  remainingMs: number
  acquire: () => Promise<boolean>
  release: () => Promise<void>
  refresh: () => Promise<LeaseRecord | null>
}

/**
 * 进入编辑时领取该榫卯的单写者租约，并在本页停留期间维持心跳。
 * - held：本页持有，可以编辑
 * - locked：其他标签页持有且未超时，只读等待
 * - reclaim：租约已失效/被释放，可立即接管
 *
 * autoTakeover（编辑页默认 true）：等待中若他页正常关闭释放租约，立即接管；
 * 他页崩溃则靠 TTL 倒计时到期接管。
 * autoAcquire（默认 true）：进入页面即领取；家具反查这类跨榫卯浏览页
 * 传 false，仅在真正要写入（打开登记表单）时才领取。
 */
export function useJointLease(
  jointTypeId: string,
  options: { autoTakeover?: boolean; autoAcquire?: boolean } = {},
): JointLease {
  const { autoTakeover = true, autoAcquire = true } = options
  const lease = useLeaseStore((state) => state.leases[jointTypeId])
  const refresh = useLeaseStore((state) => state.refresh)
  const acquireStore = useLeaseStore((state) => state.acquire)
  const releaseStore = useLeaseStore((state) => state.release)
  const [remainingMs, setRemainingMs] = useState(0)

  // 进入页面：先看一眼现有租约，空闲就领取，被占用就等待；
  // 离开（路由切走/换榫卯）时延迟释放，同标签页内跳转下一个编辑页可取消。
  useEffect(() => {
    if (!jointTypeId || !autoAcquire) return
    let cancelled = false
    void (async () => {
      const active = await refresh(jointTypeId)
      if (cancelled) return
      if (!active || active.holderId === leaseManager.holder.id) {
        await acquireStore(jointTypeId)
      }
    })()
    return () => {
      cancelled = true
      leaseManager.scheduleRelease(jointTypeId)
    }
  }, [jointTypeId, autoAcquire, refresh, acquireStore])

  // 等待中他页正常释放：立即接管（只对编辑页生效）
  useEffect(() => {
    if (!jointTypeId || !autoTakeover) return
    const unsubscribe = leaseManager.onRemoteMessage((message) => {
      if (message.type !== 'lease-released' || message.jointTypeId !== jointTypeId) return
      if (message.holderId === leaseManager.holder.id) return
      void acquireStore(jointTypeId)
    })
    return unsubscribe
  }, [jointTypeId, autoTakeover, acquireStore])

  // locked 状态下轮询：他页租约一过期立即接管（崩溃场景）
  useEffect(() => {
    if (!jointTypeId || !lease || lease.holderId === leaseManager.holder.id) return
    const timer = setInterval(() => {
      const left = lease.expiresAt - Date.now()
      setRemainingMs(Math.max(0, left))
      if (left <= 0) void acquireStore(jointTypeId)
    }, 500)
    return () => clearInterval(timer)
  }, [jointTypeId, lease, acquireStore])

  // held 状态下也维护一个到期边界，心跳异常时能及时翻转
  useEffect(() => {
    if (!jointTypeId || !lease || lease.holderId !== leaseManager.holder.id) return
    const timer = setInterval(() => {
      const left = lease.expiresAt - Date.now()
      setRemainingMs(Math.max(0, left))
      if (left <= 0) void refresh(jointTypeId)
    }, 1000)
    return () => clearInterval(timer)
  }, [jointTypeId, lease, refresh])

  const acquire = useCallback(async () => {
    const { ok } = await acquireStore(jointTypeId)
    return ok
  }, [acquireStore, jointTypeId])

  const release = useCallback(() => releaseStore(jointTypeId), [releaseStore, jointTypeId])
  const refreshLease = useCallback(() => refresh(jointTypeId), [refresh, jointTypeId])

  const status: JointLease['status'] = (() => {
    if (lease === undefined) return 'loading'
    if (!lease) return 'reclaim'
    return lease.holderId === leaseManager.holder.id ? 'held' : 'locked'
  })()

  return {
    status,
    lease: lease ?? null,
    holderName: lease?.holderName ?? '',
    remainingMs: status === 'locked' ? remainingMs : 0,
    acquire,
    release,
    refresh: refreshLease,
  }
}
