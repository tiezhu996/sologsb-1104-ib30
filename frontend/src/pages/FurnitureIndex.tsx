import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { BlankPanel } from '../components/common/BlankPanel'
import { LeaseBar } from '../components/common/LeaseBar'
import { PendingReviewPanel } from '../components/common/PendingReviewPanel'
import { useJointLease } from '../hooks/useJointLease'
import { useJointWorkspace } from '../hooks/useJointWorkspace'
import { useJointStore } from '../stores/jointStore'
import { useStageStore } from '../stores/stageStore'
import type { FurnitureName } from '../types/furniture'
import { LeaseExpiredError } from '../utils/leaseManager'

interface FurnitureFormState {
  name: FurnitureName
  era: string
  position: string
  loadNote: string
}

const initialForm: FurnitureFormState = {
  name: '圈椅',
  era: '明式',
  position: '',
  loadNote: '',
}

export default function FurnitureIndex() {
  const joints = useJointStore((state) => state.joints)
  const allFurniture = useJointStore((state) => state.furniture)
  const loading = useJointStore((state) => state.loading)
  const loadAll = useJointStore((state) => state.loadAll)
  const stageFurnitureRelation = useJointStore((state) => state.stageFurnitureRelation)

  const [selectedJointId, setSelectedJointId] = useState('')
  // 家具页是跨榫卯登记页：切换下拉只观察租约，真正打开登记表单时才领取
  const lease = useJointLease(selectedJointId, { autoTakeover: false, autoAcquire: false })
  const workspace = useJointWorkspace(selectedJointId)
  const commit = useStageStore((state) => state.commit)
  const discard = useStageStore((state) => state.discard)
  const adopt = useStageStore((state) => state.adopt)

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FurnitureFormState>(initialForm)
  const [writeError, setWriteError] = useState<string | null>(null)
  const stagesMap = useStageStore((state) => state.stages)
  const loadAllStages = useStageStore((state) => state.loadAll)

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    void loadAllStages()
  }, [loadAllStages])

  useEffect(() => {
    if (!selectedJointId && joints[0]) {
      setSelectedJointId(joints[0]?.id ?? '')
    }
  }, [selectedJointId, joints])

  useEffect(() => {
    if (lease.status === 'held') setWriteError(null)
  }, [lease.status])

  // 列表合并：正表家具 + 所有暂存榫卯里待确认的家具关系
  const furniture = useMemo(() => {
    const stagedFurniture = Object.values(stagesMap)
      .flatMap((stage) => stage?.entries ?? [])
      .filter((entry) => !entry.refId && !entry.fromLateSave && entry.kind === 'furniture')
      .map((entry) => (entry.kind === 'furniture' ? entry.furniture : null))
      .filter((item): item is NonNullable<typeof item> => item !== null)
    const stagedIds = new Set(stagedFurniture.map((item) => item.id))
    return [...allFurniture.filter((item) => !stagedIds.has(item.id)), ...stagedFurniture]
  }, [allFurniture, stagesMap])

  // 打开登记表单时才尝试领取当前榫卯的租约；他人持有则表单保持禁用并提示
  const openForm = () => {
    setShowForm(true)
    setWriteError(null)
    if (selectedJointId && lease.status !== 'held') {
      void lease.acquire().then((ok) => {
        if (!ok) setWriteError('该榫卯正由其他标签页编辑，等待其交接或租约超时后即可接管。')
      })
    }
  }

  const submitFurniture = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.name.trim() || !form.position.trim() || !form.loadNote.trim()) return
    let fence = lease.lease?.fence ?? null
    if (lease.status !== 'held') {
      const ok = await lease.acquire()
      fence = ok ? (await lease.refresh())?.fence ?? null : null
      if (!ok || fence === null) {
        setWriteError('本页未持有该榫卯的编辑租约，请等待交接或租约超时后接管再登记。')
        return
      }
    }
    setWriteError(null)
    if (fence === null) return
    try {
      await stageFurnitureRelation(selectedJointId, fence, {
        jointTypeId: selectedJointId,
        name: form.name.trim() as FurnitureName,
        era: form.era.trim() || '未标注年代',
        position: form.position.trim(),
        loadNote: form.loadNote.trim(),
      })
      setForm(initialForm)
      setShowForm(false)
    } catch (error) {
      setWriteError(error instanceof LeaseExpiredError
        ? error.message
        : '家具关系暂存失败，请重试。')
      if (error instanceof LeaseExpiredError) await lease.refresh().catch(() => {})
    }
  }

  const groups = furniture.reduce<Array<{ name: FurnitureName; items: typeof furniture }>>((result, item) => {
    const existing = result.find((group) => group.name === item.name)
    if (existing) existing.items.push(item)
    else result.push({ name: item.name, items: [item] })
    return result
  }, [])

  const stagedJointIds = Object.values(stagesMap)
    .filter((stage): stage is NonNullable<typeof stage> => Boolean(stage))
    .filter((stage) => stage.entries.some((entry) => entry.kind === 'furniture'))
    .map((stage) => stage.jointTypeId)

  return (
    <div className="space-y-7">
      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 text-xs font-semibold tracking-[0.24em] text-wood-500">FURNITURE INDEX</p>
          <h1 className="text-3xl font-bold tracking-tight text-wood-900 sm:text-4xl">家具榫卯反查</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-stone-600">
            从家具部位反查所用榫卯，并记录承力方式与年代特征。登记关系同样受单写者租约保护，先暂存后入库。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-xl border border-wood-100 bg-white px-4 py-2.5 text-sm text-stone-600 shadow-sm">
            家具关联 <span className="mx-1 text-lg font-bold text-wood-700" data-testid="count-furniture">{furniture.length}</span> 条
          </div>
          <button
            type="button"
            className="primary-button"
            data-testid="new-furniture"
            disabled={joints.length === 0}
            onClick={openForm}
          >
            <span className="text-lg leading-none">＋</span>
            新建家具关联
          </button>
        </div>
      </section>

      {selectedJointId ? (
        <LeaseBar
          lease={lease}
          jointName={joints.find((joint) => joint.id === selectedJointId)?.name}
          onTakeOver={() => void lease.acquire()}
        />
      ) : null}
      {writeError ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" data-testid="write-error">
          {writeError}
        </div>
      ) : null}

      {selectedJointId ? (
        <PendingReviewPanel
          jointTypeId={selectedJointId}
          pending={workspace.stageEntries.filter((entry) => !entry.refId && !entry.fromLateSave)}
          review={workspace.reviewEntries}
          canCommit={lease.status === 'held'}
          fence={lease.lease?.fence ?? null}
          onCommit={(fence) => commit(selectedJointId, fence)}
          onDiscard={(entryId) => discard(selectedJointId, entryId)}
          onAdopt={(entryId) => adopt(selectedJointId, entryId)}
          onReload={workspace.reload}
        />
      ) : null}

      {showForm ? (
        <form className="panel grid gap-5 p-5 sm:p-6" data-testid="form-furniture" onSubmit={(event) => void submitFurniture(event)}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-wood-900">登记家具使用部位</h2>
              <p className="mt-1 text-xs text-stone-500">
                把家具名称、年代、使用部位和承力说明挂接到榫卯类型；保存先进暂存，确认后写入图鉴。
              </p>
            </div>
            <button type="button" className="rounded-lg px-3 py-2 text-sm text-stone-500 hover:bg-stone-100" onClick={() => setShowForm(false)}>收起</button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium text-stone-700">对应榫卯</span>
              <select
                required
                className="input-field"
                data-testid="field-jointTypeId"
                value={selectedJointId}
                onChange={(event) => setSelectedJointId(event.target.value)}
              >
                {joints.map((joint) => <option key={joint.id} value={joint.id}>{joint.name}</option>)}
              </select>
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium text-stone-700">家具名称</span>
              <input
                required
                className="input-field"
                data-testid="field-name"
                list="furniture-name-options"
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value as FurnitureName }))}
              />
              <datalist id="furniture-name-options">
                <option value="圈椅" />
                <option value="条案" />
                <option value="架子床" />
                <option value="官帽椅" />
                <option value="方桌" />
                <option value="柜架" />
              </datalist>
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium text-stone-700">年代</span>
              <input
                required
                className="input-field"
                data-testid="field-era"
                value={form.era}
                onChange={(event) => setForm((current) => ({ ...current, era: event.target.value }))}
                placeholder="例如：明式"
              />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium text-stone-700">使用部位</span>
              <input
                required
                className="input-field"
                data-testid="field-position"
                value={form.position}
                onChange={(event) => setForm((current) => ({ ...current, position: event.target.value }))}
                placeholder="例如：扶手与腿足交接处"
              />
            </label>
            <label className="space-y-1.5 text-sm md:col-span-2">
              <span className="font-medium text-stone-700">承力说明</span>
              <textarea
                required
                rows={3}
                className="input-field resize-y"
                data-testid="field-loadNote"
                value={form.loadNote}
                onChange={(event) => setForm((current) => ({ ...current, loadNote: event.target.value }))}
                placeholder="说明该部位长期承受的拉力、压力或扭力"
              />
            </label>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" className="secondary-button" onClick={() => setShowForm(false)}>取消</button>
            <button
              type="submit"
              className="primary-button"
              data-testid="submit-furniture"
              disabled={lease.status !== 'held'}
            >
              暂存家具关联
            </button>
          </div>
        </form>
      ) : null}

      {furniture.length === 0 && !loading ? (
        <BlankPanel title="尚无可反查家具" description="先建立榫卯类型，再登记家具的使用部位和承力方式。" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {groups.map((group) => (
            <section key={group.name} className="panel overflow-hidden" data-testid="row-furniture">
              <header className="flex items-center justify-between border-b border-wood-100 bg-wood-50/70 px-5 py-4">
                <div>
                  <h2 className="text-xl font-bold text-wood-900">{group.name}</h2>
                  <p className="mt-1 text-xs text-stone-500">{group.items.length} 个关联部位</p>
                </div>
                <svg aria-hidden="true" viewBox="0 0 48 48" className="h-10 w-10 text-wood-500" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M8 38h32M12 34V19h24v15M16 19v-6h16v6M18 25h12M18 30h12" />
                </svg>
              </header>
              <div className="divide-y divide-stone-100">
                {group.items.map((item) => {
                  const joint = joints.find((candidate) => candidate.id === item.jointTypeId)
                  const isPending = stagesMap[item.jointTypeId]?.entries.some(
                    (entry) => !entry.refId && !entry.fromLateSave
                      && entry.kind === 'furniture' && entry.furniture.id === item.id,
                  )
                  return (
                    <article key={item.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-wood-50 px-2.5 py-1 text-xs text-wood-700">{item.era}</span>
                        <span className="text-sm font-medium text-stone-900">{item.position}</span>
                        {isPending ? (
                          <span className="rounded-full bg-sky-100 px-2.5 py-1 text-[11px] text-sky-900">待确认入库</span>
                        ) : null}
                        {joint ? (
                          <Link className="ml-auto text-xs font-semibold text-wood-700 underline-offset-4 hover:underline" to={`/joints/${joint.id}`}>
                            榫卯：{joint.name}
                          </Link>
                        ) : null}
                      </div>
                      <p className="mt-2 text-sm leading-6 text-stone-600">{item.loadNote}</p>
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {stagedJointIds.length > 0 ? (
        <p className="text-xs text-stone-500">
          另有榫卯存在家具关系的待复核暂存，可进入对应类型详情处理：
          {' '}
          {stagedJointIds.map((jointId) => (
            <Link key={jointId} to={`/joints/${jointId}`} className="mx-1 text-wood-700 underline underline-offset-2">
              {joints.find((joint) => joint.id === jointId)?.name ?? jointId}
            </Link>
          ))}
        </p>
      ) : null}
    </div>
  )
}
