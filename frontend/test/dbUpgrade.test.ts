import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import Dexie from 'dexie'
import { MortiseDatabase } from '../src/utils/db'

const DB_NAME = 'gbmortise-db'

/** 用老版本（仅 v2）结构建库并写入一条榫卯与构件，模拟已上线用户的浏览器 */
async function buildLegacyV2Database(): Promise<IDBFactory> {
  const factory = new IDBFactory()
  const legacy = new Dexie(DB_NAME, {
    indexedDB: factory as unknown as IDBFactory,
    IDBKeyRange,
  })
  legacy.version(1).stores({
    joints: 'id, name, family, difficulty',
    members: 'id, jointTypeId, name, part, lengthMm',
    steps: 'id, jointTypeId, seq, action',
    diagrams: 'id, jointTypeId, stepId, view',
    furniture: 'id, jointTypeId, name',
  })
  await legacy.open()
  await legacy.table('joints').put({
    id: 'joint-legacy', name: '燕尾榫', family: '出头', difficulty: '入门',
    strengthNote: '老数据', glueNeeded: false,
  })
  await legacy.table('members').put({
    id: 'member-legacy', jointTypeId: 'joint-legacy', name: '榫头', part: '出榫件',
    grainDir: '顺纹', lengthMm: 100, widthMm: 40, thicknessMm: 20, toleranceMm: 0.1,
    note: '老构件',
  })
  await legacy.close()
  return factory
}

const instances: MortiseDatabase[] = []

afterEach(async () => {
  for (const instance of instances) await instance.close()
  instances.length = 0
})

test('v2 老库升级到 v3：租约相关表就位，原有图鉴数据完整保留且执行回填迁移', async () => {
  const factory = await buildLegacyV2Database()
  const upgraded = new MortiseDatabase(DB_NAME, {
    indexedDB: factory as unknown as IDBFactory,
    IDBKeyRange,
  })
  instances.push(upgraded)
  await upgraded.open()

  assert.equal(upgraded.verno, 3)
  const joint = await upgraded.joints.get('joint-legacy')
  assert.equal(joint?.name, '燕尾榫')
  // v2 升级链回填 schemaRev
  assert.equal(joint?.schemaRev, 2)
  const member = await upgraded.members.get('member-legacy')
  assert.equal(member?.lengthMm, 100)

  // 四张新表可正常读写
  await upgraded.meta.put({ key: 'fence:joint-legacy', value: 1 })
  assert.equal((await upgraded.meta.get('fence:joint-legacy'))?.value, 1)
  assert.equal(await upgraded.leases.count(), 0)
  assert.equal(await upgraded.workspaces.count(), 0)
  assert.equal(await upgraded.stashes.count(), 0)
  assert.equal(await upgraded.commits.count(), 0)
})

test('v3 新库首次打开：空库不自动种子（由 ensureSeedData 触发），租约表结构正常', async () => {
  const fresh = new MortiseDatabase(DB_NAME, {
    indexedDB: new IDBFactory() as unknown as IDBFactory,
    IDBKeyRange,
  })
  instances.push(fresh)
  await fresh.open()
  assert.equal(fresh.verno, 3)
  assert.equal(await fresh.joints.count(), 0)
  await fresh.leases.put({
    resourceId: 'joint-x', leaseId: 'lease-1', holder: '标签页甲', fence: 1,
    expiresAt: Date.now() + 1000, acquiredAt: Date.now(), renewedAt: Date.now(),
    crashed: 0, released: 0,
  })
  const stored = await fresh.leases.get('joint-x')
  assert.equal(stored?.leaseId, 'lease-1')
})
