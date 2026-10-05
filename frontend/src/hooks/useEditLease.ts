import { useCallback, useEffect, useRef, useState } from 'react'
import { LeaseBusyError, leaseManager, type LeaseSnapshot } from '../leases/leaseManager'
import type { EditLease } from '../utils/db'

export type EditLeaseStatus = 'loading' | 'active' | 'locked' | 'lost' | 'error'

export interface EditLeaseState {
  status: EditLeaseStatus
  lease: EditLease | null
  /** 锁页时展示当前持有者与到期时间 */
  busyHolder: string | null
  busyExpiresAt: number | null
  /** 租约是否已过期可直接接管 */
  canTakeover: boolean
  error: string | null
  takeover: () => void
  retryAcquire: () => void
}

/**
 * 进入编辑页领取单写者租约；离开时按引用计数交还。
 * 租约被他人接管后本页进入 lost（只读）状态，避免旧页继续改写图鉴。
 */
export function useEditLease(resourceId: string): EditLeaseState {
  const [snapshot, setSnapshot] = useState<LeaseSnapshot | null>(null)
  const [status, setStatus] = useState<EditLeaseStatus>('loading')
  const [busyHolder, setBusyHolder] = useState<string | null>(null)
  const [busyExpiresAt, setBusyExpiresAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const statusRef = useRef<EditLeaseStatus>('loading')

  useEffect(() => {
    if (!resourceId) return
    let cancelled = false
    setStatus('loading')
    statusRef.current = 'loading'
    setError(null)

    void leaseManager.retain(resourceId).then((lease) => {
      if (cancelled) return
      setSnapshot({ lease, isOurs: true, expired: false, now: Date.now() })
      setStatus('active')
      statusRef.current = 'active'
    }).catch((reason: unknown) => {
      if (cancelled) return
      if (reason instanceof LeaseBusyError) {
        setBusyHolder(reason.holder)
        setBusyExpiresAt(reason.expiresAt)
        setStatus('locked')
        statusRef.current = 'locked'
      } else {
        setError(reason instanceof Error ? reason.message : String(reason))
        setStatus('error')
        statusRef.current = 'error'
      }
    })

    const unsubscribe = leaseManager.subscribe(resourceId, (next) => {
      if (cancelled) return
      setSnapshot(next)
      const current = statusRef.current
      if (current === 'loading') return
      if (next.isOurs) {
        if (current === 'locked' || current === 'error') {
          setBusyHolder(null)
          setBusyExpiresAt(null)
          setStatus('active')
          statusRef.current = 'active'
        } else if (current !== 'active') {
          setStatus('active')
          statusRef.current = 'active'
        }
        return
      }
      // 自己原本持有，租约被别人接管（超时 / 崩溃恢复）→ 旧页降级只读
      if (current === 'active' && next.lease && next.lease.holder !== leaseManager.tabId) {
        setStatus('lost')
        statusRef.current = 'lost'
      }
      // 等待锁期间租约到期：保持锁页，但开启“接管”按钮
      if (current === 'locked' && next.expired && next.lease) {
        if (busyHolder === null) {
          setBusyHolder(next.lease.holder)
        }
        setBusyExpiresAt(next.lease.expiresAt)
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
      leaseManager.release(resourceId)
    }
  }, [resourceId, version])

  const retryAcquire = useCallback(() => setVersion((v) => v + 1), [])

  const takeover = useCallback(() => {
    setStatus('loading')
    statusRef.current = 'loading'
    void leaseManager.takeover(resourceId).then((lease) => {
      setSnapshot({ lease, isOurs: true, expired: false, now: Date.now() })
      setBusyHolder(null)
      setBusyExpiresAt(null)
      setStatus('active')
      statusRef.current = 'active'
    }).catch((reason: unknown) => {
      if (reason instanceof LeaseBusyError) {
        setBusyHolder(reason.holder)
        setBusyExpiresAt(reason.expiresAt)
        setStatus('locked')
        statusRef.current = 'locked'
      } else {
        setError(reason instanceof Error ? reason.message : String(reason))
        setStatus('error')
        statusRef.current = 'error'
      }
    })
  }, [resourceId])

  const lease = snapshot?.lease ?? null
  const canTakeover = status === 'locked'
    && !!snapshot
    && snapshot.expired
    && snapshot.lease?.holder !== leaseManager.tabId

  return {
    status,
    lease,
    busyHolder,
    busyExpiresAt: busyExpiresAt ?? snapshot?.lease?.expiresAt ?? null,
    canTakeover,
    error,
    takeover,
    retryAcquire,
  }
}
