import { useEffect } from 'react'
import { useDiagramStore } from '../../stores/diagramStore'
import { useJointStore } from '../../stores/jointStore'
import { useStepStore } from '../../stores/stepStore'
import { editBus } from '../../utils/editBus'
import { leaseManager } from '../../utils/leaseManager'

/**
 * 全局同步：其他标签页确认入库后，本页重新读取正表，
 * 保证图鉴总览等只读页面看到最新数据（入库本身只允许单写者）。
 */
export function RemoteCatalogSync() {
  const loadAll = useJointStore((state) => state.loadAll)

  useEffect(() => editBus.subscribe((message) => {
    if (message.type !== 'catalog-committed') return
    if (message.byHolderId === leaseManager.holder.id) return
    void loadAll()
    void useStepStore.getState().loadSteps(message.jointTypeId)
    void useDiagramStore.getState().loadDiagrams(message.jointTypeId)
  }), [loadAll])

  return null
}
