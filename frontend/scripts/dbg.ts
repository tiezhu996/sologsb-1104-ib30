import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
;(globalThis as any).indexedDB = new IDBFactory()
;(globalThis as any).IDBKeyRange = IDBKeyRange
;(globalThis as any).window = globalThis
;(globalThis as any).addEventListener = () => {}
;(globalThis as any).BroadcastChannel = class { constructor(){} postMessage(){} addEventListener(){} removeEventListener(){} close(){} }
function ss(id:string){ const m=new Map([['gbmortise-holder-id',id],['gbmortise-holder-name',id]]); return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>m.set(k,v),removeItem(){},clear(){},key:()=>null,length:m.size} }
;(globalThis as any).sessionStorage = ss('tab-A')
const dbA = (await import('../src/utils/db.ts?a')).db
const lmA = (await import('../src/utils/leaseManager.ts?a')).leaseManager
const stA = await import('../src/utils/stageService.ts?a')
const j='joint-dovetail'
const rA = await lmA.acquire(j)
console.log('A fence', rA.lease.fence)
const seed = (await dbA.members.toArray())[0]
await stA.stageMember(j, rA.lease.fence, {...seed, widthMm: 88})
await dbA.leases.put({ ...await dbA.leases.get(rA.lease.fence), expiresAt: Date.now()-1 })

;(globalThis as any).sessionStorage = ss('tab-B')
const dbB = (await import('../src/utils/db.ts?b')).db
const lmB = (await import('../src/utils/leaseManager.ts?b')).leaseManager
const stB = await import('../src/utils/stageService.ts?b')
const rB = await lmB.acquire(j)
console.log('B acquired:', rB.status, rB.lease.fence)
console.log('leases rows after B acquire:', await dbB.leases.toArray())
const validate = await lmB.validate(j, rB.lease.fence)
console.log('B validate own fence:', validate && validate.holderId)
try {
  await stB.stageMember(j, rB.lease.fence, {...seed, widthMm: 77})
  console.log('B stage ok')
} catch (e:any) {
  console.log('B stage error:', e.name, e.message)
  console.log('leases rows after failed stage:', await dbB.leases.toArray())
}
process.exit(0)
