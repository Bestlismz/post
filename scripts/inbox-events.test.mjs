import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReceiptStream} from '../src/http/inbox-routes.mjs';

function response({backpressure=false}={}) {
  const res=new EventEmitter();res.frames=[];res.status=()=>res;res.set=()=>res;res.flushHeaders=()=>{};
  res.write=frame=>{res.frames.push(frame);return !backpressure;};res.end=()=>{res.ended=true;res.emit('close');};
  return res;
}
const request=(cursor='0')=>({actor:{organizationId:'tenant'},session:{id:'session'},query:{},get:()=>cursor});

test('concurrent initial replay cannot exceed the session stream limit',async()=>{
  let release,entered;const waiting=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
  const pool={async query(){entered();await blocked;return {rows:[{high:'0',events:[]}]};}};
  const stream=createReceiptStream({pool,maxConnectionsPerSession:1});
  const first=response(),second=response();const started=stream(request(),first);await waiting;
  let rejected=false;const attempt=stream(request(),second).catch(error=>{assert.equal(error.status,429);rejected=true;});
  await new Promise(resolve=>setTimeout(resolve,5));release();await Promise.all([started,attempt]);
  first.emit('close');second.emit('close');assert.equal(rejected,true);
});

test('slow consumers disconnect and release their slot without retaining a timer',async()=>{
  const pool={async query(){return {rows:[{high:'1',events:[{position:'1',payload:{receiptId:'receipt',resourceId:'resource',resourceType:'work_item',state:'queued',text:'secret'}}]}]};}};
  const stream=createReceiptStream({pool,maxConnectionsPerSession:1});
  const slow=response({backpressure:true});await stream(request(),slow);assert.equal(slow.ended,true);assert.ok(!slow.frames.join('').includes('secret'));
  const next=response();await stream(request(),next);assert.equal(next.ended,undefined);next.emit('close');
});

test('large or invalid replay cursors recover with a bounded refetch receipt',async()=>{
  const pool={async query(){return {rows:[{high:'3',events:[1,2,3].map(id=>({position:String(id),payload:{}}))}]};}};
  const stream=createReceiptStream({pool,maxReplay:2});
  const res=response();await stream(request(),res);assert.equal(res.frames.length,1);
  assert.match(res.frames[0],/id: 3\nevent: reset\ndata: .*"state":"refetch"/);res.emit('close');
  const future=response();await createReceiptStream({pool:{async query(){return {rows:[{high:'0',events:[]}]};}}})(request('99'),future);
  assert.match(future.frames[0],/event: reset/);future.emit('close');
});

test('session revocation closes an active stream',async()=>{
  let calls=0;
  const pool={async query(){if(++calls>1)return {rowCount:0};return {rows:[{high:'0',events:[]}]};}};
  const res=response();const closed=new Promise(resolve=>res.once('close',resolve));
  await createReceiptStream({pool,pollMs:5})(request(),res);
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Stream did not close')),200))]);
  assert.equal(res.ended,true);
});

test('server shutdown closes idle SSE connections and releases their slots',async()=>{
  const controller=new AbortController();
  const pool={async query(){return {rows:[{high:'0',events:[]}]};}};
  const stream=createReceiptStream({pool,signal:controller.signal});
  const res=response();await stream(request(),res);controller.abort();assert.equal(res.ended,true);
  await assert.rejects(stream(request(),response()),error=>error.status===503);
});
