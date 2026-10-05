import { db } from './db'
import { editBus } from './editBus'
import type { LeaseChannelMessage, LeaseRecord } from '../types/lease'

/** 租约时长 15 秒；心跳 5 秒续期一次，连续丢两次心跳即超时 */
export const LEASE_TTL_MS = 15_000
const HEARTBEAT_MS = 5_000

export type LeaseAcquireOutcome =
  | { status: 'acquired'; lease: LeaseRecord; tookOver: boolean }
  | { status: 'held-by-other'; lease: LeaseRecord }

export class LeaseExpiredError extends Error {
  constructor() {
    super('编辑租约已超时或已被接管，本页的迟到保存不会写入图鉴，已转入待复核暂存。')
    this.name = 'LeaseExpiredError'
  }
}

function makeHolder(): { id: string; name: string } {
  const storedId = sessionStorage.getItem('gbmortise-holder-id')
  const storedName = sessionStorage.getItem('gbmortise-holder-name')
  if (storedId && storedName) return { id: storedId, name: storedName }
  const id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const name = `标签页 ${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  sessionStorage.setItem('gbmortise-holder-id', id)
  sessionStorage.setItem('gbmortise-holder-name', name)
  return { id, name }
}

type LeaseListener = (jointTypeId: string, lease: LeaseRecord | null) => void

/**
 * 单写者租约管理器（模块级单例，跨页面共享）。
 * 租约状态以 IndexedDB 为准，BroadcastChannel 只负责即时唤醒其他标签页。
 */
class LeaseManager {
  readonly holder = makeHolder()
  private heartbeats = new Map<string, ReturnType<typeof setInterval>>()
  private pendingReleases = new Map<string, ReturnType<typeof setTimeout>>()
  private listeners = new Set<LeaseListener>()
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor() {
    editBus.subscribe((message) => {
      void this.handleChannelMessage(message)
    })
    // 周期性清理本页名下已过期的租约记录（例如本机时钟跳变后）
    this.sweeper = setInterval(() => {
      void this.sweepExpired()
    }, LEASE_TTL_MS)
  }

  /** 订阅租约变化（含跨标签页通知触发的状态变化） */
  onLeaseChange(listener: LeaseListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 订阅其他标签页发出的全部编辑事件 */
  onRemoteMessage(listener: (message: LeaseChannelMessage) => void): () => void {
    return editBus.subscribe(listener)
  }

  private notify(jointTypeId: string, lease: LeaseRecord | null): void {
    this.listeners.forEach((listener) => listener(jointTypeId, lease))
  }

  private post(message: LeaseChannelMessage): void {
    editBus.post(message)
  }

  private async handleChannelMessage(message: LeaseChannelMessage): Promise<void> {
    if (message.type === 'lease-released') {
      const fresh = await this.getActiveLease(message.jointTypeId)
      if (this.heartbeats.has(message.jointTypeId) && !fresh) {
        // 本页租约记录被清掉（异常情况），停掉心跳
        this.stopHeartbeat(message.jointTypeId)
      }
      this.notify(message.jointTypeId, fresh)
      return
    }
    if (
      message.type === 'lease-acquired'
      || message.type === 'lease-taken'
      || message.type === 'lease-heartbeat'
    ) {
      // 通知的是本页自己，忽略；其他页拉一次最新租约
      if (message.holderId === this.holder.id) return
      const fresh = await this.getActiveLease(message.jointTypeId)
      this.notify(message.jointTypeId, fresh)
    }
  }

  /** 读取当前仍有效的租约（过期记录会被顺手回收） */
  async getActiveLease(jointTypeId: string): Promise<LeaseRecord | null> {
    const now = Date.now()
    const candidates = await db.leases
      .where('jointTypeId')
      .equals(jointTypeId)
      .toArray()
    const expired = candidates.filter((lease) => lease.expiresAt <= now)
    if (expired.length > 0) {
      await db.leases.bulkDelete(expired.map((lease) => lease.fence))
    }
    const active = candidates
      .filter((lease) => lease.expiresAt > now)
      .sort((a, b) => b.fence - a.fence)
    return active[0] ?? null
  }

  private async sweepExpired(): Promise<void> {
    const now = Date.now()
    const expired = await db.leases.where('expiresAt').belowOrEqual(now).primaryKeys()
    if (expired.length > 0) await db.leases.bulkDelete(expired)
  }

  /**
   * 领取或接管租约。
   * - 本页已持有：原子续期（fence 不变，守卫据此认可迟到心跳窗口内的保存）
   * - 他人持有且未过期：held-by-other
   * - 无租约 / 他人租约已过期：插入新记录，自增主键生成更大 fence（接管）
   */
  async acquire(jointTypeId: string, options: { force?: boolean } = {}): Promise<LeaseAcquireOutcome> {
    // 同标签页再次进入编辑：撤销离开时挂起的延迟释放
    this.cancelScheduledRelease(jointTypeId)
    const now = Date.now()
    return db.transaction('rw', db.leases, async () => {
      const candidates = await db.leases.where('jointTypeId').equals(jointTypeId).toArray()
      const active = candidates
        .filter((lease) => lease.expiresAt > now)
        .sort((a, b) => b.fence - a.fence)[0]

      if (active && active.holderId === this.holder.id) {
        const renewed: LeaseRecord = { ...active, expiresAt: now + LEASE_TTL_MS }
        await db.leases.put(renewed)
        this.startHeartbeat(jointTypeId)
        this.notify(jointTypeId, renewed)
        this.post({
          type: 'lease-heartbeat',
          jointTypeId,
          holderId: this.holder.id,
          expiresAt: renewed.expiresAt,
        })
        return { status: 'acquired', lease: renewed, tookOver: false }
      }

      if (active && !options.force) {
        return { status: 'held-by-other', lease: active }
      }

      // 过期租约全部清掉，再换发新一代租约
      const stale = candidates.filter((lease) => lease.fence !== active?.fence)
      await db.leases.bulkDelete([
        ...expiredIds(candidates, now),
        ...stale.map((lease) => lease.fence),
      ])
      if (active) await db.leases.delete(active.fence)

      // ++fence 自增主键：省略 fence 才会触发自增
      const lease: Omit<LeaseRecord, 'fence'> = {
        jointTypeId,
        holderId: this.holder.id,
        holderName: this.holder.name,
        acquiredAt: now,
        expiresAt: now + LEASE_TTL_MS,
      }
      const fence = Number(await db.leases.add(lease as LeaseRecord))
      const granted: LeaseRecord = { ...lease, fence }

      const tookOver = Boolean(active) || candidates.length > 0
      this.startHeartbeat(jointTypeId)
      this.notify(jointTypeId, granted)
      this.post({
        type: tookOver ? 'lease-taken' : 'lease-acquired',
        jointTypeId,
        holderId: this.holder.id,
        holderName: this.holder.name,
        fence: granted.fence,
        acquiredAt: granted.acquiredAt,
        expiresAt: granted.expiresAt,
      })
      return { status: 'acquired', lease: granted, tookOver }
    })
  }

  /** 仅当本页确实是持有者时释放 */
  async release(jointTypeId: string): Promise<void> {
    this.cancelScheduledRelease(jointTypeId)
    const active = await this.getActiveLease(jointTypeId)
    if (!active || active.holderId !== this.holder.id) {
      this.stopHeartbeat(jointTypeId)
      return
    }
    await db.leases.delete(active.fence)
    this.stopHeartbeat(jointTypeId)
    this.notify(jointTypeId, null)
    this.post({ type: 'lease-released', jointTypeId, holderId: this.holder.id })
  }

  /**
   * 路由离开编辑页时延迟释放：同标签页内立即进入另一编辑页（例如
   * 详情→步序）可取消，避免租约被别的标签页瞬间抢走；真正离开后释放。
   */
  scheduleRelease(jointTypeId: string, delayMs = 300): void {
    this.cancelScheduledRelease(jointTypeId)
    const timer = setTimeout(() => {
      this.pendingReleases.delete(jointTypeId)
      void this.release(jointTypeId)
    }, delayMs)
    this.pendingReleases.set(jointTypeId, timer)
  }

  /** 同标签页马上又进入编辑：撤销待执行的释放 */
  cancelScheduledRelease(jointTypeId: string): void {
    const timer = this.pendingReleases.get(jointTypeId)
    if (timer) {
      clearTimeout(timer)
      this.pendingReleases.delete(jointTypeId)
    }
  }

  /** 关闭标签页/刷新时尽力释放本页名下全部租约 */
  async releaseAll(): Promise<void> {
    const now = Date.now()
    const mine = await db.leases.where('holderId').equals(this.holder.id).toArray()
    const live = mine.filter((lease) => lease.expiresAt > now)
    if (live.length > 0) {
      await db.leases.bulkDelete(live.map((lease) => lease.fence))
    }
    this.heartbeats.forEach((timer) => clearInterval(timer))
    this.heartbeats.clear()
    this.pendingReleases.forEach((timer) => clearTimeout(timer))
    this.pendingReleases.clear()
  }

  /**
   * 守卫：校验某次保存仍持有租约。
   * 返回 null 表示租约已被接管/超时——这次保存必须被拦下。
   */
  async validate(jointTypeId: string, fence: number): Promise<LeaseRecord | null> {
    const lease = await db.leases.get(fence)
    if (!lease) return null
    if (lease.jointTypeId !== jointTypeId || lease.holderId !== this.holder.id) return null
    if (lease.expiresAt <= Date.now()) {
      await db.leases.delete(lease.fence)
      this.stopHeartbeat(jointTypeId)
      this.notify(jointTypeId, null)
      return null
    }
    return lease
  }

  isMine(lease: LeaseRecord | null | undefined): boolean {
    return Boolean(lease && lease.holderId === this.holder.id)
  }

  /**
   * 切换当前持有者身份（仅供无窗口测试环境模拟第二个标签页使用；
   * 真实浏览器中每个标签页是独立运行时，身份由 sessionStorage 固定）。
   */
  __setHolderForTests(id: string, name: string): void {
    (this.holder as { id: string; name: string }).id = id
    ;(this.holder as { id: string; name: string }).name = name
  }

  private startHeartbeat(jointTypeId: string): void {
    this.stopHeartbeat(jointTypeId)
    const timer = setInterval(() => {
      void this.heartbeat(jointTypeId)
    }, HEARTBEAT_MS)
    this.heartbeats.set(jointTypeId, timer)
  }

  private stopHeartbeat(jointTypeId: string): void {
    const timer = this.heartbeats.get(jointTypeId)
    if (timer) {
      clearInterval(timer)
      this.heartbeats.delete(jointTypeId)
    }
  }

  private async heartbeat(jointTypeId: string): Promise<void> {
    try {
      await db.transaction('rw', db.leases, async () => {
        const now = Date.now()
        const candidates = await db.leases.where('jointTypeId').equals(jointTypeId).toArray()
        const mine = candidates
          .filter((lease) => lease.holderId === this.holder.id && lease.expiresAt > now)
          .sort((a, b) => b.fence - a.fence)[0]
        if (!mine) {
          // 租约已被他人接管或超时：停心跳，等待 UI 切换到只读
          this.stopHeartbeat(jointTypeId)
          const active = candidates
            .filter((lease) => lease.expiresAt > now)
            .sort((a, b) => b.fence - a.fence)[0] ?? null
          this.notify(jointTypeId, active)
          return
        }
        const renewed: LeaseRecord = { ...mine, expiresAt: now + LEASE_TTL_MS }
        await db.leases.put(renewed)
        this.notify(jointTypeId, renewed)
        this.post({
          type: 'lease-heartbeat',
          jointTypeId,
          holderId: this.holder.id,
          expiresAt: renewed.expiresAt,
        })
      })
    } catch {
      // IndexedDB 临时不可用时不主动放弃，下一次心跳再试
    }
  }
}

function expiredIds(records: LeaseRecord[], now: number): number[] {
  return records.filter((lease) => lease.expiresAt <= now).map((lease) => lease.fence)
}

export const leaseManager = new LeaseManager()

if (typeof window !== 'undefined') {
  const flush = () => {
    // pagehide 时 IndexedDB 事务未必来得及，sendBeacon 无法承载；
    // 尽力同步发起一次释放，没完成也无妨——TTL 到期后他页自然接管。
    void leaseManager.releaseAll()
  }
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
}
