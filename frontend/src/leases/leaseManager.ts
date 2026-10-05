import { db, type EditLease, type PendingCommit, type PendingStash, type WorkspaceDraft } from '../utils/db'
import type { Diagram } from '../types/diagram'
import type { Furniture } from '../types/furniture'
import type { Member } from '../types/member'
import type { DisassemblyStep } from '../types/step'

/** 租约 TTL：心跳中断超过该时长（标签页崩溃 / 卡死 / 关闭）后，其他标签页可接管 */
export const LEASE_TTL_MS = 25_000
/** 心跳间隔：持有者在到期前多次续租 */
export const HEARTBEAT_MS = 8_000
/** 路由切换宽限：同一标签页在详情 / 步序 / 绘制台之间跳转不交接 */
const RELEASE_DELAY_MS = 1_500
/** 未确认编辑快照落库防抖 */
const DRAFT_FLUSH_DELAY_MS = 400

export type DraftSection = 'members' | 'steps' | 'diagrams' | 'furniture'

export class LeaseBusyError extends Error {
  readonly holder: string
  readonly expiresAt: number
  constructor(holder: string, expiresAt: number) {
    super(`该榫卯正被 ${holder} 编辑（租约 ${new Date(expiresAt).toLocaleTimeString()} 到期）`)
    this.name = 'LeaseBusyError'
    this.holder = holder
    this.expiresAt = expiresAt
  }
}

export class LeaseLostError extends Error {
  constructor(message = '编辑租约已被接管，本次写入被拒绝，未写入已入库图鉴') {
    super(message)
    this.name = 'LeaseLostError'
  }
}

export class WriteRejectedError extends Error {
  readonly cause: unknown
  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'WriteRejectedError'
    this.cause = cause
  }
}

export interface LeaseSnapshot {
  lease: EditLease | null
  isOurs: boolean
  /** 当前是否处于可被另一页接管的过期状态 */
  expired: boolean
  now: number
}

type LeaseListener = (snapshot: LeaseSnapshot) => void

interface HeldRef {
  count: number
  lease: EditLease
  heartbeat: ReturnType<typeof setInterval>
  releaseTimer: ReturnType<typeof setTimeout> | null
}

function makeTabId(): string {
  const storage = globalThis.sessionStorage
  if (storage) {
    const existing = storage.getItem('gbmortise-tab-id')
    if (existing) return existing
    const id = `标签页-${Math.random().toString(36).slice(2, 7)}`
    storage.setItem('gbmortise-tab-id', id)
    return id
  }
  return `标签页-${Math.random().toString(36).slice(2, 7)}`
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Node 测试环境下定时器不应阻止进程退出；浏览器无 unref 时忽略 */
function unrefInNode(handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null): void {
  ;(handle as unknown as { unref?: () => void } | null)?.unref?.()
}

const liveManagers = new Set<EditLeaseManager>()

/**
 * 单写者交接核心。
 *
 * 不变量：
 * 1. 同一 resourceId（榫卯类型）任意时刻至多一个活跃租约；新 fence 单调递增。
 * 2. 所有写库动作在同一 Dexie 事务里校验 leaseId，旧写者迟到保存一律拒绝。
 * 3. 接管前把旧工作区未确认修改快照写入 stashes；写入失败的操作保留在 commits 队列。
 */
export class EditLeaseManager {
  readonly tabId: string
  private held = new Map<string, HeldRef>()
  private listeners = new Map<string, Set<LeaseListener>>()
  private drafts = new Map<string, WorkspaceDraft>()
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private channel: BroadcastChannel | null = null

  constructor(tabIdOverride?: string) {
    this.tabId = tabIdOverride ?? makeTabId()
    liveManagers.add(this)
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('gbmortise-edit-lease')
      this.channel.onmessage = (event: MessageEvent<string>) => {
        const resourceId = event.data
        if (resourceId) void this.notify(resourceId)
      }
      // Node 测试环境下不要让频道阻止进程退出
      ;(this.channel as unknown as { unref?: () => void }).unref?.()
    }
    if (typeof addEventListener !== 'undefined') {
      // 切到后台先落盘未确认修改；关闭 / 刷新时立即交还租约，其他标签页不必等 TTL
      addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          for (const resourceId of this.held.keys()) void this.persistDraft(resourceId)
        }
      })
      addEventListener('pagehide', () => {
        for (const resourceId of [...this.held.keys()]) {
          void this.persistDraft(resourceId)
          void this.releaseNow(resourceId, 'graceful')
        }
      })
    }
  }

  // ---------- 订阅 ----------

  subscribe(resourceId: string, listener: LeaseListener): () => void {
    let set = this.listeners.get(resourceId)
    if (!set) {
      set = new Set()
      this.listeners.set(resourceId, set)
    }
    set.add(listener)
    if (!this.pollTimer && typeof setInterval !== 'undefined') {
      this.pollTimer = setInterval(() => {
        for (const id of this.listeners.keys()) void this.notify(id)
      }, 2_000)
      unrefInNode(this.pollTimer)
    }
    void this.notify(resourceId)
    return () => {
      set?.delete(listener)
      if (set && set.size === 0) this.listeners.delete(resourceId)
      if (this.listeners.size === 0 && this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
    }
  }

  private async notify(resourceId: string): Promise<void> {
    const lease = (await db.leases.get(resourceId)) ?? null
    const now = Date.now()
    const heldRef = this.held.get(resourceId)
    const snapshot: LeaseSnapshot = {
      lease,
      isOurs: !!heldRef && !!lease && lease.leaseId === heldRef.lease.leaseId,
      expired: !lease || lease.expiresAt <= now,
      now,
    }
    this.listeners.get(resourceId)?.forEach((listener) => listener(snapshot))
  }

  private broadcast(resourceId: string): void {
    this.channel?.postMessage(resourceId)
    void this.notify(resourceId)
  }

  // ---------- 领取 / 续租 / 交还 ----------

  /** 进入编辑页时领取租约；同一标签页重复领取只加引用计数（SPA 跳转不交接） */
  async retain(resourceId: string): Promise<EditLease> {
    const heldRef = this.held.get(resourceId)
    if (heldRef) {
      heldRef.count += 1
      if (heldRef.releaseTimer) {
        clearTimeout(heldRef.releaseTimer)
        heldRef.releaseTimer = null
      }
      return heldRef.lease
    }
    const lease = await this.acquire(resourceId)
    const heartbeat = setInterval(() => void this.heartbeat(resourceId), HEARTBEAT_MS)
    unrefInNode(heartbeat)
    this.held.set(resourceId, { count: 1, lease, heartbeat, releaseTimer: null })
    this.broadcast(resourceId)
    return lease
  }

  /** 离开编辑页：延迟交还，吸收同页内路由跳转 */
  release(resourceId: string): void {
    const heldRef = this.held.get(resourceId)
    if (!heldRef) return
    heldRef.count -= 1
    if (heldRef.count > 0) return
    heldRef.releaseTimer = setTimeout(() => {
      void this.releaseNow(resourceId, 'graceful')
    }, RELEASE_DELAY_MS)
    unrefInNode(heldRef.releaseTimer)
  }

  private async heartbeat(resourceId: string): Promise<void> {
    const heldRef = this.held.get(resourceId)
    if (!heldRef) return
    try {
      const renewed: EditLease = {
        ...heldRef.lease,
        expiresAt: Date.now() + LEASE_TTL_MS,
        renewedAt: Date.now(),
      }
      const updated = await db.transaction('rw', db.leases, async () => {
        const current = await db.leases.get(resourceId)
        if (!current || current.leaseId !== heldRef.lease.leaseId) return null
        await db.leases.put(renewed)
        return renewed
      })
      if (!updated) {
        // 租约行已被接管者覆盖 → 本页失去单写者身份
        this.loseLocal(resourceId)
        return
      }
      heldRef.lease = updated
    } catch {
      // 心跳失败（如 IndexedDB 临时不可用）下一轮再试；TTL 内未恢复则自然失效
    }
  }

  private loseLocal(resourceId: string): void {
    const heldRef = this.held.get(resourceId)
    if (heldRef) {
      clearInterval(heldRef.heartbeat)
      if (heldRef.releaseTimer) clearTimeout(heldRef.releaseTimer)
      this.held.delete(resourceId)
    }
    void this.persistDraft(resourceId)
    this.broadcast(resourceId)
  }

  /** 过期 / 崩溃后由另一页强制接管（租约仍活跃时抛 LeaseBusyError） */
  async takeover(resourceId: string): Promise<EditLease> {
    if (this.held.has(resourceId)) return this.held.get(resourceId)!.lease
    const lease = await this.acquire(resourceId)
    const heartbeat = setInterval(() => void this.heartbeat(resourceId), HEARTBEAT_MS)
    unrefInNode(heartbeat)
    this.held.set(resourceId, { count: 1, lease, heartbeat, releaseTimer: null })
    this.broadcast(resourceId)
    return lease
  }

  private async releaseNow(resourceId: string, _mode: 'graceful'): Promise<void> {
    const heldRef = this.held.get(resourceId)
    if (!heldRef) return
    clearInterval(heldRef.heartbeat)
    if (heldRef.releaseTimer) clearTimeout(heldRef.releaseTimer)
    this.held.delete(resourceId)
    await this.persistDraft(resourceId)
    await db.transaction('rw', [db.leases, db.workspaces, db.stashes], async () => {
      const current = await db.leases.get(resourceId)
      if (current && current.leaseId === heldRef.lease.leaseId) {
        // 正常交还也保留未确认修改，供下一位编辑者复核
        const stashed = await this.stashWorkspaceIfDirty(resourceId, current, 'release')
        await db.leases.put({ ...current, released: Date.now(), expiresAt: Date.now() })
        if (stashed) await db.workspaces.delete(heldRef.lease.leaseId)
      }
    })
    this.drafts.delete(resourceId)
    this.broadcast(resourceId)
  }

  /**
   * 领取 / 接管租约的唯一入口（事务内完成判定与交接）：
   * - 活跃且持有者不是本页 → 拒绝（LeaseBusyError）
   * - 已过期或持有者是本页的残留 → fence + 1 接管，旧工作区入待复核
   */
  private async acquire(resourceId: string): Promise<EditLease> {
    const now = Date.now()
    return db.transaction(
      'rw',
      [db.leases, db.workspaces, db.stashes, db.meta, db.members, db.steps, db.diagrams, db.furniture],
      async () => {
        const existing = await db.leases.get(resourceId)
        const expired = !existing || existing.expiresAt <= now
        if (existing && !expired && existing.holder !== this.tabId) {
          throw new LeaseBusyError(existing.holder, existing.expiresAt)
        }

        // 交接：旧租约名下若存在与已入库图鉴有差异的未确认修改，才留底给接管者复核
        const priorWorkspace = await db.workspaces.where('resourceId').equals(resourceId).first()
        // 每一份新租约都取单调递增 fence，迟到旧写者据此被拒
        let fence = await this.nextFence(resourceId, existing?.fence ?? 0)
        if (priorWorkspace) {
          const priorDirty = await this.diffAgainstCommitted(resourceId, priorWorkspace)
          const belongsToExpired = expired && existing && priorWorkspace.leaseId === existing.leaseId
          const orphaned = !existing
          if (priorDirty && (belongsToExpired || orphaned)) {
            await this.stashWorkspace(resourceId, priorWorkspace, priorWorkspace.holder, 'timeout', fence)
            await db.workspaces.delete(priorWorkspace.leaseId)
          }
        }

        const leaseId = createId('lease')
        const lease: EditLease = {
          resourceId,
          leaseId,
          holder: this.tabId,
          fence,
          expiresAt: now + LEASE_TTL_MS,
          acquiredAt: now,
          renewedAt: now,
          // 正常交还（released 已打标）不计崩溃次数；只有心跳超时才算崩溃接管
          crashed: expired && existing && !existing.released ? existing.crashed + 1 : (existing?.crashed ?? 0),
          released: 0,
        }
        await db.leases.put(lease)

        if (!this.drafts.has(resourceId)) {
          const draft: WorkspaceDraft = {
            leaseId,
            resourceId,
            fence,
            baseFence: fence,
            holder: this.tabId,
            updatedAt: now,
            members: await db.members.where('jointTypeId').equals(resourceId).toArray(),
            steps: await db.steps.where('jointTypeId').equals(resourceId).toArray(),
            diagrams: await db.diagrams.where('jointTypeId').equals(resourceId).toArray(),
            furniture: await db.furniture.where('jointTypeId').equals(resourceId).toArray(),
          }
          await db.workspaces.put(draft)
          this.drafts.set(resourceId, draft)
        }
        return lease
      },
    )
  }

  private async nextFence(resourceId: string, current: number): Promise<number> {
    const key = `fence:${resourceId}`
    const row = await db.meta.get(key)
    const next = Math.max(current, row?.value ?? 0) + 1
    await db.meta.put({ key, value: next })
    return next
  }

  // ---------- 未确认修改快照 ----------

  private async stashWorkspace(
    resourceId: string,
    workspace: WorkspaceDraft,
    holder: string,
    reason: PendingStash['reason'],
    fence: number,
  ): Promise<void> {
    const stash: PendingStash = {
      id: createId('stash'),
      resourceId,
      leaseId: workspace.leaseId,
      fence,
      holder,
      reason,
      createdAt: Date.now(),
      members: workspace.members,
      steps: workspace.steps,
      diagrams: workspace.diagrams,
      furniture: workspace.furniture,
      status: 'pending',
    }
    await db.stashes.put(stash)
  }

  /** 仅当工作区相对已入库数据存在未确认修改时才留底 */
  private async stashWorkspaceIfDirty(
    resourceId: string,
    lease: EditLease,
    reason: PendingStash['reason'],
  ): Promise<boolean> {
    const workspace = await db.workspaces.get(lease.leaseId)
      ?? (await db.workspaces.where('resourceId').equals(resourceId).first())
    if (!workspace) return false
    const diff = await this.diffAgainstCommitted(resourceId, workspace)
    if (!diff) return false
    await this.stashWorkspace(resourceId, workspace, lease.holder, reason, lease.fence)
    return true
  }

  async diffAgainstCommitted(
    resourceId: string,
    snapshot: Pick<WorkspaceDraft, 'members' | 'steps' | 'diagrams' | 'furniture'>,
  ): Promise<StashDiff | null> {
    const [members, steps, diagrams, furniture] = await Promise.all([
      db.members.where('jointTypeId').equals(resourceId).toArray(),
      db.steps.where('jointTypeId').equals(resourceId).toArray(),
      db.diagrams.where('jointTypeId').equals(resourceId).toArray(),
      db.furniture.where('jointTypeId').equals(resourceId).toArray(),
    ])
    const memberDiffs = diffRows(snapshot.members, members, (m) => m.id, MEMBER_FIELDS)
    const stepDiffs = diffRows(snapshot.steps, steps.sort((a, b) => a.seq - b.seq), (s) => s.id, STEP_FIELDS)
    const diagramDiffs = diffRows(snapshot.diagrams, diagrams, (d) => d.id, DIAGRAM_FIELDS)
    const furnitureDiffs = diffRows(snapshot.furniture, furniture, (f) => f.id, FURNITURE_FIELDS)
    if (memberDiffs.length + stepDiffs.length + diagramDiffs.length + furnitureDiffs.length === 0) return null
    return { members: memberDiffs, steps: stepDiffs, diagrams: diagramDiffs, furniture: furnitureDiffs }
  }

  async listPendingStashes(resourceId: string): Promise<PendingStash[]> {
    return db.stashes.where('resourceId').equals(resourceId).filter((s) => s.status === 'pending').toArray()
  }

  /** 接管者采用待复核内容：按构件 / 动作 / 内联图 / 家具关系四类选择性写回 */
  async adoptStash(stashId: string, sections: DraftSection[]): Promise<string | null> {
    let resourceId: string | null = null
    await db.transaction('rw', [db.stashes, db.commits, db.members, db.steps, db.diagrams, db.furniture], async () => {
      const stash = await db.stashes.get(stashId)
      if (!stash || stash.status !== 'pending') return
      resourceId = stash.resourceId
      if (sections.includes('members') && stash.members.length > 0) await db.members.bulkPut(stash.members)
      if (sections.includes('steps') && stash.steps.length > 0) await db.steps.bulkPut(stash.steps)
      if (sections.includes('diagrams') && stash.diagrams.length > 0) await db.diagrams.bulkPut(stash.diagrams)
      if (sections.includes('furniture') && stash.furniture.length > 0) await db.furniture.bulkPut(stash.furniture)
      // 旧租约遗留的待重试写入不能再重放（否则会覆盖刚复核采用的内容）
      const staleCommits = await db.commits
        .where('resourceId').equals(stash.resourceId)
        .filter((c) => c.status === 'pending' && c.leaseId === stash.leaseId)
        .primaryKeys()
      for (const id of staleCommits) {
        await db.commits.update(id as string, {
          status: 'rejected',
          lastError: '接管者已通过待复核面板决定该租约的内容，此笔旧写入不再重放',
        })
      }
      await db.stashes.update(stashId, { status: 'merged', resolvedAt: Date.now() })
    })
    if (resourceId) this.broadcast(resourceId)
    return resourceId
  }

  async discardStash(stashId: string): Promise<void> {
    const stash = await db.stashes.get(stashId)
    if (!stash) return
    await db.transaction('rw', [db.stashes, db.commits], async () => {
      const staleCommits = await db.commits
        .where('resourceId').equals(stash.resourceId)
        .filter((c) => c.status === 'pending' && c.leaseId === stash.leaseId)
        .primaryKeys()
      for (const id of staleCommits) {
        await db.commits.update(id as string, {
          status: 'rejected',
          lastError: '留底内容已被接管者丢弃，此笔旧写入不再重放',
        })
      }
      await db.stashes.update(stashId, { status: 'discarded', resolvedAt: Date.now() })
    })
    this.broadcast(stash.resourceId)
  }

  // ---------- 工作区（当前租约下的未确认修改） ----------

  getDraft(resourceId: string): WorkspaceDraft | undefined {
    return this.drafts.get(resourceId)
  }

  patchDraft<T extends DraftSection>(
    resourceId: string,
    section: T,
    updater: (rows: WorkspaceDraft[T]) => WorkspaceDraft[T],
  ): void {
    const draft = this.drafts.get(resourceId)
    if (!draft) return
    ;(draft as WorkspaceDraft)[section] = updater(draft[section])
    draft.updatedAt = Date.now()
    this.schedulePersist(resourceId)
  }

  private schedulePersist(resourceId: string): void {
    const existing = this.flushTimers.get(resourceId)
    if (existing) clearTimeout(existing)
    this.flushTimers.set(resourceId, setTimeout(() => void this.persistDraft(resourceId), DRAFT_FLUSH_DELAY_MS))
    unrefInNode(this.flushTimers.get(resourceId) ?? null)
  }

  async persistDraft(resourceId: string): Promise<void> {
    const timer = this.flushTimers.get(resourceId)
    if (timer) {
      clearTimeout(timer)
      this.flushTimers.delete(resourceId)
    }
    const draft = this.drafts.get(resourceId)
    if (!draft) return
    const heldRef = this.held.get(resourceId)
    const leaseId = heldRef?.lease.leaseId ?? draft.leaseId
    await db.workspaces.put({ ...draft, leaseId })
  }

  // ---------- 受 fence 保护的写入 ----------

  isHolder(resourceId: string): boolean {
    return this.held.has(resourceId)
  }

  /** 仅供自动化测试读取当前持有租约 */
  currentLeaseForTest(resourceId: string): EditLease | null {
    return this.held.get(resourceId)?.lease ?? null
  }

  /** 仅供自动化测试：停止心跳、轮询并清空内存态 */
  async dispose(): Promise<void> {
    for (const heldRef of this.held.values()) {
      clearInterval(heldRef.heartbeat)
      if (heldRef.releaseTimer) clearTimeout(heldRef.releaseTimer)
    }
    this.held.clear()
    for (const timer of this.flushTimers.values()) clearTimeout(timer)
    this.flushTimers.clear()
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.listeners.clear()
    this.drafts.clear()
    this.channel?.close()
    this.channel = null
    liveManagers.delete(this)
  }

  async commitMember(resourceId: string, member: Member): Promise<void> {
    this.patchDraft(resourceId, 'members', (rows) =>
      rows.some((row) => row.id === member.id)
        ? rows.map((row) => (row.id === member.id ? member : row))
        : [...rows, member],
    )
    await this.guardedCommit(resourceId, 'member', member, async () => {
      await db.members.put(member)
    })
  }

  async commitSteps(resourceId: string, steps: DisassemblyStep[]): Promise<void> {
    this.patchDraft(resourceId, 'steps', () => steps)
    await this.guardedCommit(resourceId, 'steps', steps, async () => {
      await db.steps.bulkPut(steps)
    })
  }

  async commitDiagram(resourceId: string, diagram: Diagram): Promise<void> {
    this.patchDraft(resourceId, 'diagrams', (rows) =>
      rows.map((item) => (item.id === diagram.id ? diagram : item)),
    )
    await this.guardedCommit(resourceId, 'diagram', diagram, async () => {
      await db.diagrams.put(diagram)
    })
  }

  /** 家具关系挂接：无编辑页租约时（反查页新建）临时领一份短租约，写完立即交还 */
  async withQuickLease<T>(resourceId: string, fn: (resourceId: string) => Promise<T>): Promise<T> {
    const lease = await this.retain(resourceId)
    try {
      return await fn(lease.resourceId)
    } finally {
      const heldRef = this.held.get(resourceId)
      if (heldRef) {
        heldRef.count = 0
        if (heldRef.releaseTimer) clearTimeout(heldRef.releaseTimer)
      }
      await this.releaseNow(resourceId, 'graceful')
    }
  }

  private async guardedCommit(
    resourceId: string,
    kind: PendingCommit['kind'],
    payload: unknown,
    mutate: () => Promise<void>,
  ): Promise<void> {
    const heldRef = this.held.get(resourceId)
    if (!heldRef) throw new LeaseLostError()
    const commit: PendingCommit = {
      id: createId('commit'),
      resourceId,
      leaseId: heldRef.lease.leaseId,
      fence: heldRef.lease.fence,
      holder: this.tabId,
      createdAt: Date.now(),
      attempts: 0,
      lastError: '',
      status: 'pending',
      kind,
      payload,
    }
    // 先入恢复队列：哪怕随后进程崩溃 / 事务失败，重开仍能找回这笔写入
    await db.commits.put(commit)
    try {
      await db.transaction('rw', [db.leases, db.members, db.steps, db.diagrams, db.furniture], async () => {
        const lease = await db.leases.get(resourceId)
        if (!lease || lease.leaseId !== heldRef.lease.leaseId) {
          throw new LeaseLostError()
        }
        await mutate()
      })
      await db.commits.update(commit.id, { status: 'applied' })
    } catch (error) {
      if (error instanceof LeaseLostError) {
        await db.commits.update(commit.id, { status: 'rejected', lastError: error.message }).catch(() => undefined)
        this.loseLocal(resourceId)
        throw error
      }
      await db.commits.update(commit.id, {
        attempts: commit.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
      throw new WriteRejectedError('写入图鉴失败，内容已保留在恢复队列，可重试', error)
    }
  }

  async listPendingCommits(resourceId: string): Promise<PendingCommit[]> {
    return db.commits.where('resourceId').equals(resourceId).filter((c) => c.status === 'pending').toArray()
  }

  /** 重开后找回失败写入：租约仍属本页则重放，租约已交接则拒绝并保留记录 */
  async retryCommit(commitId: string): Promise<void> {
    const commit = await db.commits.get(commitId)
    if (!commit || commit.status !== 'pending') return
    const heldRef = this.held.get(commit.resourceId)
    if (!heldRef || heldRef.lease.leaseId !== commit.leaseId) {
      await db.commits.update(commitId, { status: 'rejected', lastError: '租约已交接，请从待复核内容中决定是否采用' })
      throw new LeaseLostError()
    }
    try {
      await db.transaction('rw', [db.leases, db.members, db.steps, db.diagrams, db.furniture], async () => {
        const lease = await db.leases.get(commit.resourceId)
        if (!lease || lease.leaseId !== commit.leaseId) throw new LeaseLostError()
        await replayCommit(commit)
      })
      await db.commits.update(commitId, { status: 'applied', lastError: '' })
      this.broadcast(commit.resourceId)
    } catch (error) {
      if (error instanceof LeaseLostError) {
        await db.commits.update(commitId, { status: 'rejected', lastError: error.message }).catch(() => undefined)
        throw error
      }
      await db.commits.update(commitId, {
        attempts: commit.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
      throw new WriteRejectedError('重试写入仍失败，内容保留在恢复队列', error)
    }
  }

  async discardCommit(commitId: string): Promise<void> {
    await db.commits.delete(commitId)
  }
}

async function replayCommit(commit: PendingCommit): Promise<void> {
  switch (commit.kind) {
    case 'member':
      await db.members.put(commit.payload as Member)
      break
    case 'steps':
      await db.steps.bulkPut(commit.payload as DisassemblyStep[])
      break
    case 'diagram':
      await db.diagrams.put(commit.payload as Diagram)
      break
    case 'furniture':
      await db.furniture.put(commit.payload as Furniture)
      break
  }
}

// ---------- 差异计算 ----------

export interface FieldChange {
  label: string
  before: string
  after: string
}

export interface RowChange {
  key: string
  name: string
  state: 'added' | 'removed' | 'changed'
  fields: FieldChange[]
}

export interface StashDiff {
  members: RowChange[]
  steps: RowChange[]
  diagrams: RowChange[]
  furniture: RowChange[]
}

const MEMBER_FIELDS: Array<[keyof Member, string]> = [
  ['name', '名称'],
  ['lengthMm', '长(mm)'],
  ['widthMm', '宽(mm)'],
  ['thicknessMm', '厚(mm)'],
  ['toleranceMm', '公差(mm)'],
]
const STEP_FIELDS: Array<[keyof DisassemblyStep, string]> = [
  ['seq', '步序'],
  ['action', '动作'],
  ['direction', '方向'],
  ['tool', '工具'],
  ['riskNote', '风险提醒'],
  ['holdSec', '停留(秒)'],
]
const DIAGRAM_FIELDS: Array<[keyof Diagram, string]> = [['title', '标题'], ['svgMarkup', '内联 SVG']]
const FURNITURE_FIELDS: Array<[keyof Furniture, string]> = [
  ['name', '家具'],
  ['era', '年代'],
  ['position', '部位'],
  ['loadNote', '承力说明'],
]

function diffRows<T extends { id: string }>(
  stashed: T[],
  committed: T[],
  nameOf: (row: T) => string,
  fieldDefs: Array<[keyof T, string]>,
): RowChange[] {
  const committedById = new Map(committed.map((row) => [row.id, row]))
  const stashedIds = new Set(stashed.map((row) => row.id))
  const changes: RowChange[] = []
  for (const row of stashed) {
    const before = committedById.get(row.id)
    if (!before) {
      changes.push({ key: row.id, name: nameOf(row), state: 'added', fields: [] })
      continue
    }
    const fields: FieldChange[] = []
    for (const [key, label] of fieldDefs) {
      const afterValue = String(row[key])
      const beforeValue = String(before[key])
      if (afterValue !== beforeValue) {
        fields.push({
          label,
          before: key === 'svgMarkup' ? summarizeSvg(beforeValue) : beforeValue,
          after: key === 'svgMarkup' ? summarizeSvg(afterValue) : afterValue,
        })
      }
    }
    if (fields.length > 0) changes.push({ key: row.id, name: nameOf(row), state: 'changed', fields })
  }
  for (const row of committed) {
    if (!stashedIds.has(row.id)) {
      changes.push({ key: row.id, name: nameOf(row), state: 'removed', fields: [] })
    }
  }
  return changes
}

function summarizeSvg(markup: string): string {
  return markup.length > 24 ? `${markup.slice(0, 24)}…（${markup.length} 字符）` : markup
}

export const leaseManager = new EditLeaseManager()

/** 自动化测试：关闭全部 manager 实例的定时器，避免跨用例访问已关闭的数据库 */
export async function disposeAllManagersForTest(): Promise<void> {
  await Promise.all([...liveManagers].map((instance) => instance.dispose()))
}
