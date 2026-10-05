import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { EditLeaseState } from '../../hooks/useEditLease'

interface LeaseGateProps {
  lease: EditLeaseState
  resourceId: string
  jointName: string
  children: React.ReactNode
}

/** 编辑页租约闸门：未取得单写者租约时只读拦截，不渲染编辑区 */
export function LeaseGate({ lease, resourceId, jointName, children }: LeaseGateProps) {
  if (lease.status === 'active') return <>{children}</>

  if (lease.status === 'loading') {
    return (
      <div className="space-y-7" data-testid="lease-gate">
        <BackLink resourceId={resourceId} />
        <div className="panel flex items-center gap-4 p-8 text-sm text-stone-600">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-wood-300 border-t-wood-700" />
          正在领取《{jointName}》的编辑租约…
        </div>
      </div>
    )
  }

  if (lease.status === 'locked') {
    return (
      <div className="space-y-7" data-testid="lease-gate">
        <BackLink resourceId={resourceId} />
        <LockedPanel lease={lease} resourceId={resourceId} jointName={jointName} />
      </div>
    )
  }

  if (lease.status === 'lost') {
    return (
      <div className="space-y-7" data-testid="lease-gate">
        <BackLink resourceId={resourceId} />
        <section className="panel border-rose-200 p-8" data-testid="lease-lost">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-100 text-2xl" aria-hidden>⚠️</span>
          <h1 className="mt-4 text-xl font-semibold text-stone-900">本页的编辑租约已被接管</h1>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-stone-600">
            另一个标签页已在租约超时后接管《{jointName}》。本页随后的保存已被拒绝，
            <strong>不会写入已入库图鉴</strong>；本页未确认的修改已保留为待复核内容，请在新持有者页面确认。
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" className="primary-button" onClick={() => lease.retryAcquire()}>
              重新尝试领取租约
            </button>
            <Link to={`/joints/${resourceId}`} className="secondary-button">返回详情页</Link>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="space-y-7" data-testid="lease-gate">
      <BackLink resourceId={resourceId} />
      <section className="panel p-8" data-testid="lease-error">
        <h1 className="text-xl font-semibold text-stone-900">无法领取编辑租约</h1>
        <p className="mt-2 text-sm text-stone-600">{lease.error ?? '浏览器本地数据库暂不可用。'}</p>
        <div className="mt-6 flex gap-3">
          <button type="button" className="primary-button" onClick={() => lease.retryAcquire()}>重试</button>
          <Link to={`/joints/${resourceId}`} className="secondary-button">返回详情页</Link>
        </div>
      </section>
    </div>
  )
}

function LockedPanel({ lease, resourceId, jointName }: {
  lease: EditLeaseState
  resourceId: string
  jointName: string
}) {
  const [, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const seconds = lease.busyExpiresAt
    ? Math.max(0, Math.round((lease.busyExpiresAt - Date.now()) / 1000))
    : 0

  return (
    <section className="panel border-amber-200 p-8" data-testid="lease-locked">
      <div className="flex flex-wrap items-start gap-5">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-2xl" aria-hidden>🔒</span>
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="text-xl font-semibold text-stone-900">《{jointName}》正在另一页编辑</h1>
          <p className="text-sm leading-7 text-stone-600">
            当前编辑租约由 <strong className="text-wood-800">{lease.busyHolder ?? '其他标签页'}</strong> 持有。
            构件尺寸、拆装动作、内联图与家具关系都归这份租约，为避免后一次保存覆盖前一次，本页暂时只读。
          </p>
          <p className="text-sm text-stone-600">
            {lease.canTakeover
              ? '对方标签页可能已关闭或崩溃，租约已到期，你可以立即接管；对方未确认的修改会作为待复核内容保留。'
              : `若对方标签页崩溃或长时间无响应，心跳中断 ${seconds} 秒后租约到期即可接管。`}
          </p>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          className="primary-button disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="lease-takeover"
          disabled={!lease.canTakeover}
          onClick={() => lease.takeover()}
        >
          {lease.canTakeover ? '我已确认，接管编辑' : `等待租约到期（${seconds} 秒）`}
        </button>
        <Link to={`/joints/${resourceId}`} className="secondary-button">返回详情只读查看</Link>
      </div>
    </section>
  )
}

function BackLink({ resourceId }: { resourceId: string }) {
  return (
    <div>
      <Link to={`/joints/${resourceId}`} className="inline-flex items-center gap-1.5 text-sm text-wood-700 hover:underline">
        <span aria-hidden="true">←</span> 返回类型详情
      </Link>
    </div>
  )
}
