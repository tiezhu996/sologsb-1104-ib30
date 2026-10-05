import { useEffect, useState } from 'react'
import {
  leaseManager,
  type DraftSection,
  type RowChange,
  type StashDiff,
} from '../../leases/leaseManager'
import type { PendingStash } from '../../utils/db'

const SECTION_LABELS: Record<DraftSection, string> = {
  members: '构件尺寸',
  steps: '拆装动作',
  diagrams: '内联图',
  furniture: '家具关系',
}

/** 交接留底：旧租约下未确认修改的复核面板，接管者可见、可分类采用或丢弃 */
export function StashPanel({ resourceId, refreshKey = 0, onChanged }: {
  resourceId: string
  refreshKey?: number
  onChanged?: () => void | Promise<void>
}) {
  const [stashes, setStashes] = useState<PendingStash[]>([])
  const [diffs, setDiffs] = useState<Record<string, StashDiff | null>>({})
  const [selected, setSelected] = useState<Record<string, Set<DraftSection>>>({})
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void leaseManager.listPendingStashes(resourceId).then(async (rows) => {
      if (cancelled) return
      setStashes(rows)
      const computed: Record<string, StashDiff | null> = {}
      for (const stash of rows) {
        computed[stash.id] = await leaseManager.diffAgainstCommitted(resourceId, stash)
      }
      if (cancelled) return
      setDiffs(computed)
      setSelected(() => {
        const next: Record<string, Set<DraftSection>> = {}
        for (const stash of rows) {
          const diff = computed[stash.id]
          next[stash.id] = new Set(diff ? sectionsWithChanges(diff) : [])
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [resourceId, refreshKey])

  if (stashes.length === 0) return null

  const toggle = (stashId: string, section: DraftSection) => {
    setSelected((current) => {
      const nextSet = new Set(current[stashId] ?? [])
      if (nextSet.has(section)) nextSet.delete(section)
      else nextSet.add(section)
      return { ...current, [stashId]: nextSet }
    })
  }

  const adopt = async (stashId: string) => {
    const sections = [...(selected[stashId] ?? [])]
    if (sections.length === 0) return
    setBusy(stashId)
    try {
      await leaseManager.adoptStash(stashId, sections)
      const rows = await leaseManager.listPendingStashes(resourceId)
      setStashes(rows)
      await onChanged?.()
    } finally {
      setBusy(null)
    }
  }

  const discard = async (stashId: string) => {
    setBusy(stashId)
    try {
      await leaseManager.discardStash(stashId)
      setStashes((rows) => rows.filter((row) => row.id !== stashId))
      await onChanged?.()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-4" data-testid="stash-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-amber-900">交接待复核内容</h2>
          <p className="mt-1 text-sm text-stone-600">
            上一位写者（超时 / 崩溃 / 正常交还）留下了尚未确认的修改，请核对后选择采用或丢弃；未处理前不会自动写入图鉴。
          </p>
        </div>
        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
          {stashes.length} 份留底
        </span>
      </div>

      <div className="space-y-4">
        {stashes.map((stash) => {
          const diff = diffs[stash.id] ?? null
          const checked = selected[stash.id] ?? new Set<DraftSection>()
          return (
            <article key={stash.id} className="panel border-amber-200 p-5" data-testid={`stash-${stash.id}`}>
              <header className="flex flex-wrap items-center gap-3 text-sm">
                <span className="rounded-full bg-amber-50 px-3 py-1 font-medium text-amber-800">
                  {stash.reason === 'timeout' ? '租约超时 / 标签页崩溃接管' : '上一位写者正常交还'}
                </span>
                <span className="text-stone-600">持有者：<strong>{stash.holder}</strong></span>
                <span className="text-stone-400">{new Date(stash.createdAt).toLocaleString('zh-CN')}</span>
              </header>

              {diff ? (
                <div className="mt-4 space-y-3">
                  {(['members', 'steps', 'diagrams', 'furniture'] as DraftSection[]).map((section) => {
                    const changes = diff[section]
                    if (changes.length === 0) return null
                    return (
                      <div key={section} className="rounded-xl border border-stone-100">
                        <label className="flex cursor-pointer items-center gap-2.5 border-b border-stone-100 bg-stone-50 px-4 py-2.5 text-sm font-medium text-stone-800">
                          <input
                            type="checkbox"
                            data-testid={`stash-${stash.id}-pick-${section}`}
                            checked={checked.has(section)}
                            onChange={() => toggle(stash.id, section)}
                          />
                          {SECTION_LABELS[section]}
                          <span className="text-xs text-stone-500">{changes.length} 项差异</span>
                        </label>
                        <ul className="divide-y divide-stone-50">
                          {changes.map((change) => (
                            <ChangeRow key={`${section}-${change.key}`} change={change} />
                          ))}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="mt-4 text-sm text-stone-500">留底内容与已入库图鉴一致，无差异。</p>
              )}

              <div className="mt-5 flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  className="secondary-button"
                  data-testid={`stash-${stash.id}-discard`}
                  disabled={busy === stash.id}
                  onClick={() => void discard(stash.id)}
                >
                  丢弃这份留底
                </button>
                <button
                  type="button"
                  className="primary-button disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid={`stash-${stash.id}-adopt`}
                  disabled={busy === stash.id || checked.size === 0}
                  onClick={() => void adopt(stash.id)}
                >
                  采用所选{checked.size > 0 ? ` ${checked.size} 类` : ''}内容
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function sectionsWithChanges(diff: StashDiff): DraftSection[] {
  return (['members', 'steps', 'diagrams', 'furniture'] as DraftSection[])
    .filter((section) => diff[section].length > 0)
}

function ChangeRow({ change }: { change: RowChange }) {
  const stateLabel = change.state === 'added' ? '新增' : change.state === 'removed' ? '已删除（留底保留）' : '修改'
  const stateClass = change.state === 'added'
    ? 'bg-emerald-50 text-emerald-800'
    : change.state === 'removed'
      ? 'bg-rose-50 text-rose-800'
      : 'bg-amber-50 text-amber-800'
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-stone-900">{change.name}</strong>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${stateClass}`}>{stateLabel}</span>
      </div>
      {change.fields.length > 0 && (
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-stone-600 sm:grid-cols-2">
          {change.fields.map((field) => (
            <div key={field.label} className="flex flex-wrap gap-1.5">
              <dt className="text-stone-500">{field.label}：</dt>
              <dd><span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-800 line-through">{field.before || '空'}</span></dd>
              <dd aria-hidden className="text-stone-400">→</dd>
              <dd><span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">{field.after || '空'}</span></dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}
