import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const image=process.env.TEST_GROUP_WORKER_IMAGE;
assert.ok(image,'Set TEST_GROUP_WORKER_IMAGE to the built Group worker image');
const volume=`rental-radar-ledger-${randomUUID()}`;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const command={version:1,kind:'GroupReplyCommand',operationId:'persistent-operation',sourceId:'source-1',groupId:'100',canonicalTarget:'https://www.facebook.com/groups/100',targetId:'post:900',text:'Exact persistent reply',textHash:'d90ac2f4458880ddad9a1ede4d7e1aced56589d338b9d6d8683e73e20a28c266',issuedAt:'2026-10-22T00:00:00.000Z',expiresAt:'2026-10-22T00:05:00.000Z',keyId:'test',signature:'0'.repeat(64)};
const source=(second)=>`import {createGroupDeliveryBoundary} from './src/group-worker/delivery.mjs';
const command=${JSON.stringify(command)};let sends=0;
const boundary=createGroupDeliveryBoundary({ledgerPath:'/data/group-operations',clock:()=>new Date('2026-10-22T00:01:00.000Z'),driver:{locateExactTarget:async value=>({canonicalTarget:value.canonicalTarget,targetId:value.targetId}),identifySender:async()=> 'sender',sendExact:async()=>{sends++;${second?"throw Error('duplicate send')":"return {state:'sent',visible:true,remoteId:'remote'}"};}}});
const result=await boundary.deliver(command);console.log(JSON.stringify({state:result.state,sends}));`;
try {
  docker(['volume','create',volume]);
  const run=code=>JSON.parse(docker(['run','--rm','--user','node','--entrypoint','node','-v',`${volume}:/data/group-operations`,image,'--input-type=module','-e',code]).split('\n').at(-1));
  assert.deepEqual(run(source(false)),{state:'sent',sends:1});
  assert.deepEqual(run(source(true)),{state:'sent',sends:0});
  process.stdout.write('Group operation ledger survived container replacement without a second send.\n');
} finally {try{docker(['volume','rm',volume]);}catch{}}
