import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BlankPanel } from '../components/common/BlankPanel'
import { LeaseBar } from '../components/common/LeaseBar'
import { PendingReviewPanel } from '../components/common/PendingReviewPanel'
import { SizeField } from '../components/common/SizeField'
import { SvgCanvas } from '../components/common/SvgCanvas'
import { useJointLease } from '../hooks/useJointLease'
import { useJointWorkspace } from '../hooks/useJointWorkspace'
import { useDiagramStore } from '../stores/diagramStore'
import { useJointStore } from '../stores/jointStore'
import { useStageStore } from '../stores/stageStore'
import { LeaseExpiredError } from '../utils/leaseManager'
import type { HitArea } from '../types/diagram'
import type { MemberName } from '../types/member'

function parseHitAreas(svgMarkup: string, fallback: HitArea[]): HitArea[] {
  if (!svgMarkup) return []
  const documentNode = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml')
  const groups = Array.from(documentNode.querySelectorAll('g[data-member-id]'))
  return groups.map((group, index) => {
    const memberId = group.getAttribute('data-member-id') ?? ''
    const existing = fallback[index]
    const polygon = group.querySelector('polygon')
    return {
      id: group.getAttribute('data-hit-id') ?? existing?.id ?? `hit-${index}`,
      memberId,
      label: group.getAttribute('data-label') ?? existing?.label ?? memberId,
      points: polygon?.getAttribute('points') ?? existing?.points ?? '',
    }
  }).filter((area) => area.memberId.length > 0)
}

export default function DiagramEditor() {
  const { id: idParam } = useParams()
  const id = idParam ?? ''
  const joints = useJointStore((state) => state.joints)
  const renameMember = useJointStore((state) => state.renameMember)
  const updateMemberDimensions = useJointStore((state) => state.updateMemberDimensions)
  const lease = useJointLease(id)
  const workspace = useJointWorkspace(id)
  const commit = useStageStore((state) => state.commit)
  const discard = useStageStore((state) => state.discard)
  const adopt = useStageStore((state) => state.adopt)
  const selectedMemberId = useDiagramStore((state) => state.selectedMemberId)
  const setSelectedMember = useDiagramStore((state) => state.setSelectedMember)
  const saveDraft = useDiagramStore((state) => state.saveDraft)

  const diagrams = workspace.diagrams
  const [selectedDiagramId, setSelectedDiagramId] = useState<string | null>(diagrams[0]?.id ?? null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSvgMarkup, setDraftSvgMarkup] = useState('')
  const [draftDirty, setDraftDirty] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)

  useEffect(() => {
    if (lease.status === 'held') setWriteError(null)
  }, [lease.status])

  const selected = useMemo(
    () => diagrams.find((diagram) => diagram.id === selectedDiagramId) ?? diagrams[0],
    [diagrams, selectedDiagramId],
  )

  // 来源内容变化（切换示意图、接管到上一版暂存、他页入库后刷新）时同步草稿，
  // 用户正在编辑（draftDirty）期间不覆盖输入；保存成功后同样等来源更新。
  const sourceKey = selected ? `${selected.id}:${selected.svgMarkup.length}:${selected.title}` : ''
  useEffect(() => {
    if (!selected) {
      setDraftTitle('')
      setDraftSvgMarkup('')
      setDraftDirty(false)
      return
    }
    if (draftDirty) return
    setDraftTitle(selected.title)
    setDraftSvgMarkup(selected.svgMarkup)
  }, [sourceKey, draftDirty, selected])

  const joint = joints.find((item) => item.id === id)
  const jointMembers = workspace.members
  const selectedMember = jointMembers.find((member) => member.id === selectedMemberId)
  const hitAreas = selected ? parseHitAreas(draftSvgMarkup, selected.hitAreas) : []
  const editable = lease.status === 'held'

  const guardMemberEdit = async (run: () => Promise<void>) => {
    if (!editable || lease.lease === null) return
    setWriteError(null)
    try {
      await run()
    } catch (error) {
      setWriteError(error instanceof LeaseExpiredError
        ? error.message
        : '构件修改暂存失败，请重试。')
      if (error instanceof LeaseExpiredError) await lease.refresh().catch(() => {})
    }
  }

  const save = async () => {
    if (!selected || lease.lease === null || !editable) return
    setWriteError(null)
    try {
      const saved = await saveDraft(id, lease.lease.fence, selected, draftTitle, draftSvgMarkup)
      setDraftDirty(false)
      setDraftTitle(saved.title)
      setDraftSvgMarkup(saved.svgMarkup)
    } catch (error) {
      setWriteError(error instanceof LeaseExpiredError
        ? error.message
        : '示意图保存失败，已保留你当前编辑内容，请重试。')
      if (error instanceof LeaseExpiredError) await lease.refresh().catch(() => {})
    }
  }

  const pendingDiagram = workspace.stageEntries.some(
    (entry) => !entry.refId && !entry.fromLateSave && entry.kind === 'diagram',
  )

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
          <p className="mb-2 text-xs font-semibold tracking-[0.24em] text-wood-500">DIAGRAM WORKBENCH</p>
          <h1 className="text-3xl font-bold tracking-tight text-wood-900 sm:text-4xl">{joint?.name ?? '榫卯'} · 示意图绘制台</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-stone-600">
            点击内联 SVG 中的木构件回填名称与尺寸，也可以直接调整 SVG 源并保存。修改归属本页编辑租约，确认后才入图鉴。
          </p>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={!selected || !editable}
          onClick={() => void save()}
          data-testid="save-diagram"
        >
          暂存示意图修改
        </button>
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

      {diagrams.length === 0 ? (
        <BlankPanel title="当前类型没有示意图" description="示意图数据尚未建立，暂时无法进入热区标定。" />
      ) : (
        <>
          <section className="flex flex-wrap gap-2">
            {diagrams.map((diagram) => {
              const isPending = workspace.stageEntries.some(
                (entry) => !entry.refId && !entry.fromLateSave
                  && entry.kind === 'diagram' && entry.diagram.id === diagram.id,
              )
              return (
                <button
                  key={diagram.id}
                  type="button"
                  className={`rounded-lg border px-4 py-2 text-sm transition ${
                    selected?.id === diagram.id
                      ? 'border-wood-700 bg-wood-700 text-white'
                      : 'border-wood-100 bg-white text-wood-700 hover:border-wood-500'
                  }`}
                  onClick={() => {
                    setSelectedDiagramId(diagram.id)
                    setSelectedMember(null)
                    setDraftDirty(false)
                  }}
                >
                  {diagram.title}{isPending ? ' · 待确认' : ''}
                </button>
              )
            })}
          </section>
          {pendingDiagram ? (
            <p className="text-xs text-sky-800" data-testid="diagram-pending-hint">
              示意图已有未确认修改，入库前其他标签页看到的仍是图鉴旧版。
            </p>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.8fr)]">
            <div className="space-y-5">
              <div className="panel p-4">
                <label className="space-y-1.5 text-sm">
                  <span className="font-medium text-stone-700">示意图标题</span>
                  <input
                    className="input-field"
                    value={draftTitle}
                    disabled={!editable}
                    onChange={(event) => {
                      setDraftTitle(event.target.value)
                      setDraftDirty(true)
                    }}
                  />
                </label>
              </div>
              <SvgCanvas
                svgMarkup={draftSvgMarkup}
                title={draftTitle || '示意图预览'}
                hitAreas={hitAreas}
                selectedMemberId={selectedMemberId}
                onSelectMember={editable ? (memberId) => setSelectedMember(memberId) : undefined}
              />
            </div>

            <aside className="space-y-5">
              <section className="panel p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-wood-900">构件回填</h2>
                    <p className="mt-1 text-xs text-stone-500">
                      {editable ? '点击 SVG 热区或下方标签选择构件' : '只读中：接管租约后可编辑尺寸'}
                    </p>
                  </div>
                  <span className={`h-2.5 w-2.5 rounded-full ${selectedMember ? 'bg-emerald-500' : 'bg-stone-300'}`} />
                </div>
                {selectedMember ? (
                  <div className="mt-5 space-y-5">
                    <label className="space-y-1.5 text-sm">
                      <span className="font-medium text-stone-700">构件名称</span>
                      <input
                        className="input-field"
                        value={selectedMember.name}
                        disabled={!editable}
                        onChange={(event) => {
                          void guardMemberEdit(() =>
                            renameMember(id, selectedMember.id, event.target.value as MemberName),
                          )
                        }}
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-4">
                      <SizeField label="长度" valueMm={selectedMember.lengthMm} toleranceMm={selectedMember.toleranceMm} readOnly={!editable}
                        onChange={(value) => void guardMemberEdit(() => updateMemberDimensions(id, selectedMember.id, {
                          lengthMm: value,
                          widthMm: selectedMember.widthMm,
                          thicknessMm: selectedMember.thicknessMm,
                          toleranceMm: selectedMember.toleranceMm,
                        }))} />
                      <SizeField label="宽度" valueMm={selectedMember.widthMm} toleranceMm={selectedMember.toleranceMm} readOnly={!editable}
                        onChange={(value) => void guardMemberEdit(() => updateMemberDimensions(id, selectedMember.id, {
                          lengthMm: selectedMember.lengthMm,
                          widthMm: value,
                          thicknessMm: selectedMember.thicknessMm,
                          toleranceMm: selectedMember.toleranceMm,
                        }))} />
                      <SizeField label="厚度" valueMm={selectedMember.thicknessMm} toleranceMm={selectedMember.toleranceMm} readOnly={!editable}
                        onChange={(value) => void guardMemberEdit(() => updateMemberDimensions(id, selectedMember.id, {
                          lengthMm: selectedMember.lengthMm,
                          widthMm: selectedMember.widthMm,
                          thicknessMm: value,
                          toleranceMm: selectedMember.toleranceMm,
                        }))} />
                      <SizeField label="配合公差" valueMm={selectedMember.toleranceMm} toleranceMm={selectedMember.toleranceMm} readOnly={!editable}
                        onChange={(value) => void guardMemberEdit(() => updateMemberDimensions(id, selectedMember.id, {
                          lengthMm: selectedMember.lengthMm,
                          widthMm: selectedMember.widthMm,
                          thicknessMm: selectedMember.thicknessMm,
                          toleranceMm: value,
                        }))} />
                    </div>
                    <dl className="grid grid-cols-2 gap-3 rounded-xl bg-wood-50 p-4 text-xs">
                      <div><dt className="text-stone-500">归属</dt><dd className="mt-1 font-medium text-wood-900">{selectedMember.part}</dd></div>
                      <div><dt className="text-stone-500">纹理</dt><dd className="mt-1 font-medium text-wood-900">{selectedMember.grainDir}</dd></div>
                    </dl>
                    <p className="text-xs leading-5 text-stone-500">{selectedMember.note}</p>
                  </div>
                ) : (
                  <div className="mt-5 rounded-xl border border-dashed border-wood-100 bg-wood-50/60 px-4 py-8 text-center text-sm text-stone-500">
                    尚未选择构件
                  </div>
                )}
              </section>

              <section className="panel p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-wood-900">SVG 源</h2>
                    <p className="mt-1 text-xs text-stone-500">保留 data-member-id 才能继续点击回填</p>
                  </div>
                  <span className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] text-stone-500">内联</span>
                </div>
                <textarea
                  rows={12}
                  spellCheck={false}
                  disabled={!editable}
                  className="mt-4 w-full resize-y rounded-xl border border-wood-100 bg-stone-950 p-3 font-mono text-xs leading-5 text-stone-100 outline-none focus:border-wood-500 disabled:opacity-60"
                  value={draftSvgMarkup}
                  onChange={(event) => {
                    setDraftSvgMarkup(event.target.value)
                    setDraftDirty(true)
                  }}
                />
              </section>

              <section className="rounded-xl border border-wood-100 bg-wood-50 p-4 text-xs leading-6 text-stone-600">
                该类型共有 {jointMembers.length} 件构件、{diagrams.length} 张示意图。尺寸与 SVG 修改先进入租约暂存，确认入库后才写入浏览器本地数据库。
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  )
}
