import type { JointLease } from '../../hooks/useJointLease'

interface LeaseBarProps {
  lease: JointLease
  jointName?: string
  onTakeOver?: () => void
}

function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${seconds} 秒`
}

/**
 * 单写者租约状态栏：本页持有时可编辑；他页持有时只读并显示接管倒计时；
 * 租约失效后可立即接管。
 */
export function LeaseBar({ lease, jointName, onTakeOver }: LeaseBarProps) {
  if (lease.status === 'loading') {
    return (
      <div className="panel flex items-center gap-3 border-stone-200 px-5 py-3 text-sm text-stone-500" data-testid="lease-bar">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-stone-300" />
        正在确认「{jointName ?? '该榫卯'}」的编辑租约…
      </div>
    )
  }

  if (lease.status === 'held') {
    return (
      <div
        className="panel flex flex-wrap items-center gap-3 border-emerald-200 bg-emerald-50/70 px-5 py-3 text-sm"
        data-testid="lease-bar"
        data-lease-status="held"
      >
        <span className="flex h-2.5 w-2.5 items-center rounded-full bg-emerald-500" />
        <strong className="text-emerald-900">本页持有编辑租约</strong>
        <span className="text-emerald-800/80">
          构件尺寸、拆装动作、内联图与家具关系都在本页单写者名下；心跳每 5 秒续期，离开页面自动交接。
        </span>
      </div>
    )
  }

  if (lease.status === 'locked') {
    return (
      <div
        className="panel flex flex-wrap items-center gap-3 border-amber-200 bg-amber-50/80 px-5 py-3 text-sm"
        data-testid="lease-bar"
        data-lease-status="locked"
      >
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
        <strong className="text-amber-900">{lease.holderName} 正在编辑</strong>
        <span className="text-amber-900/80">
          当前为只读，等待单写者交接；对方心跳停止后，租约约 {formatCountdown(lease.remainingMs)} 后可接管。
        </span>
      </div>
    )
  }

  return (
    <div
      className="panel flex flex-wrap items-center gap-3 border-sky-200 bg-sky-50/80 px-5 py-3 text-sm"
      data-testid="lease-bar"
      data-lease-status="reclaim"
    >
      <span className="h-2.5 w-2.5 rounded-full bg-sky-500" />
      <strong className="text-sky-900">编辑租约空闲</strong>
      <span className="text-sky-900/80">
        上一编辑页已超时或关闭，接管后可继续编辑；上一版未确认修改已保留在待复核区。
      </span>
      <button type="button" className="primary-button ml-auto px-3 py-1.5 text-xs" onClick={onTakeOver}>
        接管编辑
      </button>
    </div>
  )
}
