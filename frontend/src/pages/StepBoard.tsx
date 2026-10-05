import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BlankPanel } from '../components/common/BlankPanel'
import { LeaseBar } from '../components/common/LeaseBar'
import { PendingReviewPanel } from '../components/common/PendingReviewPanel'
import { StepRail } from '../components/common/StepRail'
import { SvgCanvas } from '../components/common/SvgCanvas'
import { useJointWorkspace } from '../hooks/useJointWorkspace'
import { useJointStore } from '../stores/jointStore'
import { useStageStore } from '../stores/stageStore'
import { useStepStore } from '../stores/stepStore'
import { LeaseExpiredError } from '../utils/leaseManager'
import { useJointLease } from '../hooks/useJointLease'
import { useDiagramStore } from '../stores/diagramStore'

export default function StepBoard() {
  const { id: idParam } = useParams()
  const id = idParam ?? ''
  const joints = useJointStore((state) => state.joints)
  const lease = useJointLease(id)
  const workspace = useJointWorkspace(id)
  const commit = useStageStore((state) => state.commit)
  const discard = useStageStore((state) => state.discard)
  const adopt = useStageStore((state) => state.adopt)
  const currentStepIndex = useStepStore((state) => state.currentStepIndex)
  const setCurrentStep = useStepStore((state) => state.setCurrentStep)
  const selectedMemberId = useDiagramStore((state) => state.selectedMemberId)
  const setSelectedMember = useDiagramStore((state) => state.setSelectedMember)
  const [writeError, setWriteError] = useState<string | null>(null)

  useEffect(() => {
    if (lease.status === 'held') setWriteError(null)
  }, [lease.status])

  const joint = joints.find((item) => item.id === id)
  const steps = workspace.steps
  const editable = lease.status === 'held'
  const currentStep = steps[currentStepIndex]
  const currentDiagram = workspace.diagrams.find((diagram) => diagram.stepId === currentStep?.id)
    ?? workspace.diagrams[0]

  const move = async (from: number, to: number) => {
    if (!editable || lease.lease === null) return
    setWriteError(null)
    try {
      await useStepStore.getState().moveStep(id, lease.lease.fence, steps, from, to)
    } catch (error) {
      setWriteError(error instanceof LeaseExpiredError
        ? error.message
        : '步序暂存失败，已回滚，请重试。')
      if (error instanceof LeaseExpiredError) await lease.refresh().catch(() => {})
    }
  }

  return (
    <div className="space-y-7">
      <div>
        <Link to={`/joints/${id}`} className="inline-flex items-center gap-1.5 text-sm text-wood-700 hover:underline">
          <span aria-hidden="true">←</span> 返回类型详情
        </Link>
      </div>

      <LeaseBar lease={lease} jointName={joint?.name} onTakeOver={() => void lease.acquire()} />
      {writeError ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" data-testid="write-error">
          {writeError}
        </div>
      ) : null}

      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 text-xs font-semibold tracking-[0.24em] text-wood-500">STEP SEQUENCE</p>
          <h1 className="text-3xl font-bold tracking-tight text-wood-900 sm:text-4xl">{joint?.name ?? '榫卯'} · 拆装步序编排</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-stone-600">
            拖动左侧步骤调整真实顺序，右侧同步查看每一步的示意图和风险提醒。调序先进租约暂存，确认后写入图鉴。
          </p>
        </div>
        <div className="rounded-xl border border-wood-100 bg-white px-5 py-3 text-sm text-stone-600 shadow-sm">
          {steps.length} 步 · 总停留 <strong className="text-wood-700">{workspace.steps.reduce((total, step) => total + step.holdSec, 0)}</strong> 秒
        </div>
      </section>

      <PendingReviewPanel
        jointTypeId={id}
        pending={workspace.stageEntries.filter((entry) => !entry.refId && !entry.fromLateSave)}
        review={workspace.reviewEntries}
        canCommit={editable}
        fence={lease.lease?.fence ?? null}
        onCommit={(fence) => commit(id, fence)}
        onDiscard={(entryId) => discard(id, entryId)}
        onAdopt={(entryId) => adopt(id, entryId)}
        onReload={workspace.reload}
      />

      {steps.length === 0 ? (
        <BlankPanel title="当前类型尚无步骤" description="没有可编排的拆装动作，请先补充步骤数据。" />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <section className="panel max-h-[720px] overflow-y-auto p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-wood-900">步骤轨道</h2>
                <p className="mt-1 text-xs text-stone-500">
                  {editable ? '拖动任意步骤到目标位置' : '只读中：等待编辑租约交接'}
                </p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs ${editable ? 'bg-emerald-50 text-emerald-700' : 'bg-stone-100 text-stone-500'}`}>
                {editable ? '暂存后确认' : '只读'}
              </span>
            </div>
            <StepRail
              steps={steps}
              currentIndex={currentStepIndex}
              onSelect={setCurrentStep}
              onMove={(from, to) => {
                if (!editable) return
                void move(from, to)
              }}
            />
          </section>

          <section className="space-y-5">
            <div className="panel p-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-wood-700 text-lg font-bold text-white">
                  {currentStep?.seq ?? 0}
                </span>
                <div>
                  <h2 className="text-xl font-semibold text-wood-900">{currentStep?.action ?? '步骤'} · {currentStep?.direction ?? '方向'}</h2>
                  <p className="mt-1 text-xs text-stone-500">使用工具：{currentStep?.tool ?? '待补充'} · 停留 {currentStep?.holdSec ?? 0} 秒</p>
                </div>
              </div>
              <div className="mt-5 rounded-xl border border-amber-100 bg-amber-50/70 px-4 py-3">
                <p className="text-xs font-semibold text-amber-900">易损部位提醒</p>
                <p className="mt-1 text-sm leading-6 text-amber-900/80">{currentStep?.riskNote ?? '暂无提醒'}</p>
              </div>
            </div>

            <SvgCanvas
              svgMarkup={currentDiagram?.svgMarkup ?? ''}
              title={currentDiagram?.title ?? '步骤预览'}
              hitAreas={currentDiagram?.hitAreas ?? []}
              selectedMemberId={selectedMemberId}
              onSelectMember={editable ? setSelectedMember : () => {}}
              emptyMessage="该步骤暂未绑定示意图"
            />
          </section>
        </div>
      )}
    </div>
  )
}
