import { useEffect, useState } from 'react'
import { LeaseLostError, leaseManager } from '../../leases/leaseManager'
import type { PendingCommit } from '../../utils/db'
import type { Diagram } from '../../types/diagram'
import type { Member } from '../../types/member'

const KIND_LABELS: Record<PendingCommit['kind'], string> = {
  member: '构件尺寸',
  steps: '拆装动作',
  diagram: '内联图',
  furniture: '家具关系',
}

function commitTarget(commit: PendingCommit): string {
  switch (commit.kind) {
    case 'member': {
      const member = commit.payload as Member
      return `${member.name}（${member.part}）`
    }
    case 'steps': {
      const steps = commit.payload as Array<{ seq?: number }>
      return `整组步序 ${steps.length} 步`
    }
    case 'diagram': {
      const diagram = commit.payload as Diagram
      return diagram.title
    }
    case 'furniture':
      return '家具关联'
  }
}

/** 写入失败恢复队列：提交失败 / 进程崩溃后，重开编辑仍能找回并重试 */
export function RecoveryPanel({ resourceId, refreshKey = 0 }: { resourceId: string; refreshKey?: number }) {
  const [commits, setCommits] = useState<PendingCommit[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = () => leaseManager.listPendingCommits(resourceId).then(setCommits)

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId, refreshKey])

  if (commits.length === 0) return null

  const retry = async (commitId: string) => {
    setBusyId(commitId)
    setNotice(null)
    try {
      await leaseManager.retryCommit(commitId)
      await load()
    } catch (error) {
      setNotice(error instanceof LeaseLostError
        ? '租约已交接，该笔写入被拒绝；其内容已随待复核留底保留，请在复核面板中决定。'
        : '重试仍失败，内容继续保留在队列中。')
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const discard = async (commitId: string) => {
    await leaseManager.discardCommit(commitId)
    await load()
  }

  return (
    <section className="panel border-rose-200 p-5" data-testid="recovery-panel">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-rose-100 text-lg" aria-hidden>↺</span>
        <div>
          <h2 className="font-semibold text-rose-900">待找回的写入（{commits.length}）</h2>
          <p className="mt-0.5 text-xs text-stone-600">
            以下修改已通过本页租约提交但写入图鉴失败（可能是浏览器存储异常或进程中断），重开页面后仍可找回。
          </p>
        </div>
      </div>
      {notice && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{notice}</p>}
      <ul className="mt-4 divide-y divide-stone-100">
        {commits.map((commit) => (
          <li key={commit.id} className="flex flex-wrap items-center gap-3 py-3 text-sm" data-testid={`recovery-${commit.id}`}>
            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-700">{KIND_LABELS[commit.kind]}</span>
            <strong className="text-stone-900">{commitTarget(commit)}</strong>
            <span className="text-xs text-stone-400">{new Date(commit.createdAt).toLocaleString('zh-CN')}</span>
            {commit.lastError && (
              <span className="w-full text-xs text-rose-700">上次失败原因：{commit.lastError}</span>
            )}
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                className="rounded-lg border border-wood-200 px-3 py-1.5 text-xs font-medium text-wood-800 hover:bg-wood-50 disabled:opacity-50"
                data-testid={`recovery-${commit.id}-retry`}
                disabled={busyId === commit.id}
                onClick={() => void retry(commit.id)}
              >
                重新写入
              </button>
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-xs text-stone-500 hover:bg-stone-100 disabled:opacity-50"
                data-testid={`recovery-${commit.id}-discard`}
                disabled={busyId === commit.id}
                onClick={() => void discard(commit.id)}
              >
                放弃
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
