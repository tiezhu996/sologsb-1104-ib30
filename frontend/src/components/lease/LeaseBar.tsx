import { useEffect, useState } from 'react'
import { LEASE_TTL_MS } from '../../leases/leaseManager'
import type { EditLease } from '../../utils/db'

interface LeaseBarProps {
  lease: EditLease
  resourceId: string
  /** 本页是否存在未确认修改（只影响提示文案） */
  dirty?: boolean
}

/** 编辑页顶部状态条：展示单写者身份、心跳倒计时，提醒只能由本页保存 */
export function LeaseBar({ lease, resourceId: _resourceId, dirty = false }: LeaseBarProps) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const remaining = Math.max(0, Math.round((lease.expiresAt - now) / 1000))
  const ttlSeconds = Math.round(LEASE_TTL_MS / 1000)

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-wood-100 bg-white px-5 py-3 text-xs text-stone-600 shadow-sm"
      data-testid="lease-bar"
    >
      <span className="inline-flex items-center gap-2 font-medium text-wood-800">
        <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
        本页持有编辑租约
      </span>
      <span>
        写者：<strong>{lease.holder}</strong>
      </span>
      <span>
        心跳剩余 <strong className={remaining < 8 ? 'text-amber-700' : 'text-wood-700'}>{remaining}</strong> 秒
        <span className="ml-1 text-stone-400">（{ttlSeconds} 秒无心跳自动失效）</span>
      </span>
      {lease.crashed > 0 && (
        <span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-800">
          第 {lease.crashed} 次接管 · 请留意下方待复核内容
        </span>
      )}
      {dirty && (
        <span className="rounded-full bg-wood-50 px-2.5 py-1 text-wood-700">有未确认修改，已自动留底</span>
      )}
    </div>
  )
}
