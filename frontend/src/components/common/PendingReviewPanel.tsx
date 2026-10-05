import { useState } from 'react'
import type { StageEntry } from '../../types/lease'
import { leaseManager } from '../../utils/leaseManager'

interface PendingReviewPanelProps {
  jointTypeId: string
  /** 待确认的正式条目 */
  pending: StageEntry[]
  /** 交接备份与迟到条目 */
  review: StageEntry[]
  canCommit: boolean
  fence: number | null
  onCommit: (fence: number) => Promise<{ ok: boolean; committed: number; message?: string }>
  onDiscard: (entryId: string) => Promise<void>
  onAdopt: (entryId: string) => Promise<void>
  onReload: () => Promise<void>
}

const kindLabel: Record<StageEntry['kind'], string> = {
  member: '构件尺寸',
  'step-order': '拆装动作',
  diagram: '内联图',
  furniture: '家具关系',
}

function describeEntry(entry: StageEntry): string {
  if (entry.kind === 'member') {
    const { name, lengthMm, widthMm, thicknessMm } = entry.member
    return `${name} ${lengthMm}×${widthMm}×${thicknessMm} mm`
  }
  if (entry.kind === 'step-order') {
    return `${entry.steps.length} 步拆装顺序重排`
  }
  if (entry.kind === 'diagram') {
    return `《${entry.diagram.title}》SVG 源修改`
  }
  return `${entry.furniture.name} · ${entry.furniture.position}`
}

function originTag(entry: StageEntry): { text: string; tone: string } {
  const mine = entry.authorId === leaseManager.holder.id
  if (entry.fromLateSave) {
    return { text: '迟到保存 · 未入库', tone: 'bg-rose-100 text-rose-800' }
  }
  if (entry.refId) {
    return { text: mine ? '本页上一版备份' : `${entry.authorName} 交接`, tone: 'bg-amber-100 text-amber-900' }
  }
  return { text: mine ? '本页修改' : `${entry.authorName} 待复核`, tone: 'bg-sky-100 text-sky-900' }
}

export function PendingReviewPanel({
  jointTypeId: _jointTypeId,
  pending,
  review,
  canCommit,
  fence,
  onCommit,
  onDiscard,
  onAdopt,
  onReload,
}: PendingReviewPanelProps) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  if (pending.length === 0 && review.length === 0) return null

  const submit = async () => {
    if (fence === null || busy) return
    setBusy(true)
    setNotice(null)
    const result = await onCommit(fence)
    if (result.ok) {
      setNotice({ ok: true, text: `已把 ${result.committed} 项修改写入图鉴。` })
      await onReload()
    } else {
      setNotice({
        ok: false,
        text: result.message ?? '入库失败：写入已回滚，未确认修改仍保留，重开页面也能找回。',
      })
    }
    setBusy(false)
  }

  return (
    <section className="panel space-y-5 p-5" data-testid="pending-review">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-wood-900">待确认修改</h2>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            修改先停在租约暂存区，确认入库后才写入图鉴；交接与崩溃重开都不会丢，迟到保存会被拦下等待复核。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-600">
            待入库 {pending.length} · 待复核 {review.length}
          </span>
          <button
            type="button"
            className="primary-button px-3 py-1.5 text-xs"
            disabled={!canCommit || fence === null || busy || pending.length === 0}
            onClick={() => void submit()}
            data-testid="commit-stage"
          >
            {busy ? '入库中…' : '确认写入图鉴'}
          </button>
        </div>
      </div>

      {notice ? (
        <p
          className={`rounded-lg px-3 py-2 text-xs ${
            notice.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'
          }`}
          data-testid="commit-notice"
        >
          {notice.text}
        </p>
      ) : null}

      {!canCommit && pending.length > 0 ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          本页未持有编辑租约，无法确认入库；待租约空闲后接管即可继续。
        </p>
      ) : null}

      {pending.length > 0 ? (
        <ul className="space-y-2">
          {pending.map((entry) => {
            const tag = originTag(entry)
            return (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-stone-100 bg-white px-4 py-3 text-sm"
                data-testid="pending-entry"
                data-pending-kind={entry.kind}
              >
                <span className="rounded-md bg-wood-50 px-2 py-0.5 text-xs font-medium text-wood-700">
                  {kindLabel[entry.kind]}
                </span>
                <span className="text-stone-800">{describeEntry(entry)}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${tag.tone}`}>{tag.text}</span>
                <button
                  type="button"
                  className="ml-auto text-xs text-stone-500 hover:text-rose-700"
                  onClick={() => void onDiscard(entry.id)}
                  data-testid="discard-pending"
                >
                  放弃修改
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}

      {review.length > 0 ? (
        <div className="space-y-2 rounded-xl bg-stone-50 p-3">
          <p className="text-xs font-semibold text-stone-600">交接留存与迟到保存（不会自动写入图鉴）</p>
          {review.map((entry) => {
            const tag = originTag(entry)
            return (
              <div
                key={entry.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-100 bg-white px-3 py-2.5 text-sm"
                data-testid="review-entry"
                data-review-late={entry.fromLateSave}
              >
                <span className="rounded-md bg-wood-50 px-2 py-0.5 text-xs font-medium text-wood-700">
                  {kindLabel[entry.kind]}
                </span>
                <span className="text-stone-700">{describeEntry(entry)}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${tag.tone}`}>{tag.text}</span>
                {entry.note ? <span className="w-full text-[11px] text-rose-700">{entry.note}</span> : null}
                <span className="ml-auto flex items-center gap-3">
                  <button
                    type="button"
                    className="text-xs font-medium text-wood-700 hover:underline"
                    disabled={!canCommit}
                    onClick={() => void onAdopt(entry.id)}
                    data-testid="adopt-review"
                  >
                    采纳为待确认
                  </button>
                  <button
                    type="button"
                    className="text-xs text-stone-500 hover:text-rose-700"
                    onClick={() => void onDiscard(entry.id)}
                    data-testid="discard-review"
                  >
                    丢弃
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
