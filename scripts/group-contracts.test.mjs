import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { signCommand, verifyCommand, signResult, verifyResult, canonicalSerialize, assertResultBoundToCommand } from '../src/channels/groups/contracts.mjs';
const now=new Date('2026-10-22T12:00:00Z');
const options={keyId:'test',key:'s'.repeat(32),now};
const verify={keys:{test:options.key},now};
const base={version:1,kind:'ScanCommand',operationId:'op-1',sourceId:'source-1',groupId:'123',canonicalTarget:'https://www.facebook.com/groups/123',issuedAt:now.toISOString(),expiresAt:'2026-10-22T12:05:00.000Z',keyId:'test'};
test('command group IDs preserve leading zeros and accept at most 100 digits',()=>{
  for(const groupId of ['1'.repeat(100),'0'.repeat(99)+'1','000123']) {
    const signed=signCommand({...base,groupId,canonicalTarget:`https://www.facebook.com/groups/${groupId}`},options);
    assert.equal(verifyCommand(signed,verify).groupId,groupId);
  }
  for(const groupId of ['1'.repeat(101),'0'.repeat(100)+'1']) {
    assert.throws(()=>signCommand({...base,groupId,canonicalTarget:`https://www.facebook.com/groups/${groupId}`},options));
  }
});
test('signed commands authenticate strict versioned canonical payloads',()=>{
  const signed=signCommand(base,options); assert.deepEqual(verifyCommand(JSON.stringify(signed),verify),signed);
  assert.equal(canonicalSerialize({z:1,a:{y:2,b:3}}),'{"a":{"b":3,"y":2},"z":1}');
  const reordered=Object.fromEntries(Object.entries(signed).reverse()); assert.deepEqual(verifyCommand(reordered,verify),signed);
  for(const patch of [{groupId:'456'},{operationId:'op-2'},{signature:'0'.repeat(64)},{keyId:'unknown'},{version:2},{cookies:'secret'},{canonicalTarget:'https://evil.test/groups/123'}]) assert.throws(()=>verifyCommand({...signed,...patch},verify));
  assert.throws(()=>verifyCommand(signed,{...verify,now:new Date('2026-10-22T12:06:00Z')}),/expired/i);
  assert.throws(()=>signCommand({...base,issuedAt:'2026-10-22T13:00:00Z',expiresAt:'2026-10-22T13:01:00Z'},options),/time|future/i);
  assert.throws(()=>signCommand({...base,expiresAt:'2026-10-23T12:00:00Z'},options),/time|lifetime/i);
  assert.throws(()=>verifyCommand(' '.repeat(262145),verify),/size/i);
  assert.throws(()=>verifyCommand(signed,{...verify,keys:{}}),/Unknown/);
  assert.throws(()=>signCommand({...base,expiresAt:base.issuedAt},options),/time|lifetime/i);
  assert.throws(()=>signCommand({...base,version:2},options));
});
test('reply command preserves exact text and verifies its hash without admitting private data',()=>{
  const text='ห้องว่าง\nExact text';
  const reply={...base,kind:'GroupReplyCommand',targetId:'post-1',text,textHash:createHash('sha256').update(text).digest('hex')};
  const signed=signCommand(reply,options); assert.equal(verifyCommand(signed,verify).text,text);
  assert.throws(()=>signCommand({...reply,textHash:'0'.repeat(64)},options),/hash/i);
  assert.throws(()=>signCommand({...reply,inventory:[{rent:100}]},options));
  const reconcile={...base,kind:'ReconcileCommand',attemptOperationId:'reply-op',targetId:'post-1',textHash:reply.textHash,senderId:'sender-1',attemptStartedAt:base.issuedAt,attemptFinishedAt:base.issuedAt};
  assert.equal(verifyCommand(signCommand(reconcile,options),verify).kind,'ReconcileCommand');
});
test('signed results bind observations and delivery evidence to operation and destination',()=>{
  const scan={...base,kind:'ScanResult',selectorVersion:'v1',coverage:'partial',health:'healthy',observations:[{targetId:'post-1',text:'Want a room',observedAt:base.issuedAt,evidenceHash:'a'.repeat(64)}]};
  const signed=signResult(scan,options); assert.deepEqual(verifyResult(signed,verify),signed);
  assert.throws(()=>verifyResult({...signed,observations:[]},verify));
  assert.throws(()=>signResult({...scan,token:'private'},options));
  assert.throws(()=>signResult({...scan,observations:[{...scan.observations[0],observedAt:'2026-10-22T13:00:00.000Z'}]},options),/time/i);
  const result={...base,kind:'GroupReplyResult',targetId:'post-1',state:'unknown',senderId:'sender',textHash:'a'.repeat(64),attemptStartedAt:base.issuedAt,attemptFinishedAt:base.issuedAt,evidenceHash:'b'.repeat(64),remoteId:null};
  assert.equal(verifyResult(signResult(result,options),verify).state,'unknown');
  const reconcile={...result,kind:'ReconcileResult',attemptOperationId:'reply-op',state:'not_found'};
  assert.equal(verifyResult(signResult(reconcile,options),verify).state,'not_found');
});

test('delivery result binding rejects wrong evidence fields, impossible remote IDs, and attempt times outside the command',()=>{
  const text='Exact';const reply=signCommand({...base,kind:'GroupReplyCommand',targetId:'post:1',text,textHash:createHash('sha256').update(text).digest('hex')},options);
  const body={...Object.fromEntries(Object.entries(reply).filter(([name])=>!['signature','text'].includes(name))),kind:'GroupReplyResult',state:'sent',senderId:'sender',attemptStartedAt:base.issuedAt,attemptFinishedAt:base.issuedAt,evidenceHash:'b'.repeat(64),remoteId:'remote'};
  const result=signResult(body,options);assert.doesNotThrow(()=>assertResultBoundToCommand(result,reply));
  for(const patch of [{targetId:'post:2'},{textHash:'0'.repeat(64)},{attemptStartedAt:'2026-10-22T11:00:00.000Z',attemptFinishedAt:base.issuedAt}]) assert.throws(()=>assertResultBoundToCommand({...result,...patch},reply),/binding/i);
  assert.throws(()=>signResult({...body,remoteId:null},options));
  assert.throws(()=>signResult({...body,state:'unknown',remoteId:'remote'},options));
});
