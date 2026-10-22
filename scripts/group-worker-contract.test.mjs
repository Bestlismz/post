import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { signCommand, signResult } from '../src/channels/groups/contracts.mjs';

const key = 'a'.repeat(32), keys = { current: key };
const command = () => signCommand({ version: 1, kind: 'ScanCommand', operationId: 'op-1', sourceId: 'source-1', groupId: '100', canonicalTarget: 'https://www.facebook.com/groups/100', keyId: 'current', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+60000).toISOString() }, { key, keyId: 'current' });
const load = (path) => import(`../src/${path}.mjs`);

test('private server authenticates bounded raw commands, allowlists targets, signs results, and redacts failures', async t => {
  const { createGroupWorkerServer } = await load('group-worker/server');
  const { createGroupWorkerClient } = await load('channels/groups/client');
  const { transportHeaders } = await load('channels/groups/transport');
  let calls=0, fail=false;
  const server=createGroupWorkerServer({ keys, keyId:'current', key, allowedGroups:['100'], scan:async () => { calls++; if(fail) throw new Error('cookie=secret /private/profile'); return {selectorVersion:'test-v1',coverage:'complete',health:'healthy',observations:[]}; } });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const client=createGroupWorkerClient({baseUrl,keys,keyId:'current',key});
  assert.equal((await client.scan(command())).operationId,'op-1');
  const body=JSON.stringify(command());
  for(const headers of [{}, {...transportHeaders(body,{key,keyId:'current'}),'x-group-signature':'0'.repeat(64)},transportHeaders(body,{key,keyId:'current',expiresAt:Date.now()-1})]) {
    assert.equal((await fetch(`${baseUrl}/commands`,{method:'POST',body,headers})).status,401);
  }
  const huge='x'.repeat(262145);
  assert.equal((await fetch(`${baseUrl}/commands`,{method:'POST',body:huge,headers:transportHeaders(huge,{key,keyId:'current'})})).status,413);
  const wrong=command(); wrong.groupId='101'; wrong.canonicalTarget='https://www.facebook.com/groups/101'; delete wrong.signature;
  await assert.rejects(client.scan(signCommand(wrong,{key,keyId:'current'})),/Worker request failed/);
  assert.equal(calls,1);
  fail=true; await assert.rejects(client.scan(command()),error=>!error.message.includes('secret')&&!error.message.includes('profile'));
});

test('client rejects signed results for another operation and bounds response streams and time',async()=>{
  const {createGroupWorkerClient}=await load('channels/groups/client');
  const cmd=command(); const {signature,...body}=cmd;
  const result=signResult({...body,operationId:'other',kind:'ScanResult',selectorVersion:'v1',coverage:'complete',health:'healthy',observations:[]},{key,keyId:'current'});
  const make=fetchImpl=>createGroupWorkerClient({baseUrl:'http://group-worker:3001',keys,keyId:'current',key,fetchImpl,timeoutMs:20});
  await assert.rejects(make(async()=>new Response(JSON.stringify(result))).scan(cmd),/Worker request failed/);
  await assert.rejects(make(async()=>new Response('x'.repeat(262145))).scan(cmd),/Worker request failed/);
  await assert.rejects(make(async(_url,{signal})=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('sensitive'))))).scan(cmd),/Worker request failed/);
  assert.throws(()=>createGroupWorkerClient({baseUrl:'https://evil.test',keys,keyId:'current',key}),/internal/);
});

test('page selection ignores unrelated pages and closes duplicate exact pages',async()=>{
  const {selectGroupPage,inspectSession}=await load('group-worker/session');
  const page=url=>({url:()=>url,close:async()=>{closed.push(url);},locator:()=>({count:async()=>0})});
  const closed=[], unrelated=page('https://evil.test/groups/100'), exact=page('https://www.facebook.com/groups/100'), duplicate=page('https://www.facebook.com/groups/100');
  assert.equal(await selectGroupPage({pages:()=>[unrelated,exact,duplicate]},'https://www.facebook.com/groups/100'),exact);
  assert.equal(closed.length,1);
  await assert.rejects(selectGroupPage({},'https://evil.test/groups/100'),/target/);
  assert.equal((await inspectSession(page('https://www.facebook.com/checkpoint/'))).state,'checkpoint');
  assert.equal((await inspectSession(page('https://www.facebook.com/login/'))).state,'auth_required');
  assert.equal((await inspectSession({...exact,isClosed:()=>true})).state,'expired');
});

test('profile lease excludes processes and recovers after holder death with a new fence',async t=>{
  const {acquireProfileLease}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-lease-`); t.after(()=>rm(dir,{recursive:true,force:true}));
  const holder=spawn(process.execPath,['--input-type=module','-e',`import { acquireProfileLease } from ${JSON.stringify(new URL('../src/group-worker/session.mjs',import.meta.url).href)}; await acquireProfileLease(${JSON.stringify(dir)}); console.log('ready'); setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
  t.after(()=>holder.kill('SIGKILL'));
  await once(holder.stdout,'data');
  await assert.rejects(acquireProfileLease(dir),/leased/);
  holder.kill('SIGKILL'); await once(holder,'exit');
  const lease=await acquireProfileLease(dir); assert.ok(lease.fence); await lease.assertOwned(); await lease.release();
  const next=await acquireProfileLease(dir); assert.notEqual(next.fence,lease.fence); await next.release();
});

test('observer retains stable deduplicated observations on selector drift and rejects wrong page',async()=>{
  const {observeGroupPage}=await load('group-worker/observer');
  const records=JSON.parse(await readFile(new URL('./fixtures/group-observation.json',import.meta.url),'utf8'));
  let index=0;
  const page={url:()=> 'https://www.facebook.com/groups/100',locator:()=>({count:async()=>0}),evaluate:async()=>records[index++]};
  const result=await observeGroupPage(page,command());
  assert.equal(result.coverage,'partial'); assert.equal(result.reason,'selector_changed'); assert.equal(result.observations.length,2);
  assert.equal(result.observations[0].targetId,'post:900'); assert.equal(result.observations[1].targetId,'comment:900:901');
  assert.equal(result.observations[0].text,'Room near BTS'); assert.equal(result.observations[0].authorLabel,'Mali');
  assert.equal(result.observations[0].providerTimestamp,'2026-10-20T12:00:00.000Z');
  assert.match(result.observations[0].evidenceHash,/^[a-f0-9]{64}$/);
  await assert.rejects(observeGroupPage({...page,url:()=> 'https://evil.test/groups/100'},command()),/page/);
});

test('recorded Facebook DOM extracts posts and comments without claiming complete feed coverage',async t=>{
  const {observeGroupPage}=await load('group-worker/observer');
  const candidates=[process.env.CHROMIUM_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser',chromium.executablePath()].filter(Boolean);
  let executablePath;
  for(const path of candidates) {try{await access(path);executablePath=path;break;}catch{}}
  assert.ok(executablePath,'Install Chromium to run recorded DOM contracts');
  const browser=await chromium.launch({headless:true,executablePath});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const html=await readFile(new URL('./fixtures/group-observation.html',import.meta.url),'utf8');
  await page.route('https://www.facebook.com/**',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto('https://www.facebook.com/groups/100');
  const result=await observeGroupPage(page,command());
  assert.equal(result.coverage,'partial');
  assert.deepEqual(result.observations.map(item=>item.targetId),['post:900','comment:900:901']);
  assert.deepEqual(result.observations.map(item=>item.text),['Room near BTS','Interested']);
  assert.equal(result.observations[1].authorLabel,'Ann');
});

test('observer bounds the whole envelope and preserves observed records on scan errors',async()=>{
  const {observeGroupPage}=await load('group-worker/observer');
  let pass=0;
  const page={url:()=> 'https://www.facebook.com/groups/100',locator:()=>({count:async()=>0}),evaluate:async()=>{
    if(pass++)throw new Error('HTML cookie private');
    return {selectorValid:true,hasMore:true,items:[{href:'https://www.facebook.com/groups/100/posts/900/',text:'First',authorLabel:'Mali'}]};
  }};
  const retained=await observeGroupPage(page,command());
  assert.equal(retained.observations.length,1);assert.equal(retained.reason,'selector_changed');
  page.evaluate=async()=>({selectorValid:true,hasMore:false,items:Array.from({length:100},(_,i)=>({href:`https://www.facebook.com/groups/100/posts/${i}/`,text:'ก'.repeat(20000),authorLabel:'Mali'}))});
  const bounded=await observeGroupPage(page,command());
  assert.ok(Buffer.byteLength(JSON.stringify(bounded))<200000);
  assert.equal(bounded.coverage,'partial');assert.equal(bounded.reason,'scan_limit');
  pass=0;
  page.locator=()=>({count:async()=>{if(pass)throw new Error('browser disconnected');return 0;}});
  page.evaluate=async()=>{pass++;return {selectorValid:true,hasMore:true,items:[{href:'https://www.facebook.com/groups/100/posts/900/',text:'First',authorLabel:'Mali'}]};};
  const disconnected=await observeGroupPage(page,command());
  assert.equal(disconnected.observations.length,1);assert.equal(disconnected.health,'expired');
});

test('lease fails closed without helper and simultaneous contenders have one owner',async t=>{
  const {acquireProfileLease}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-lease-`); t.after(()=>rm(dir,{recursive:true,force:true}));
  await assert.rejects(acquireProfileLease(dir,{python:'/missing/python'}),/unavailable/);
  const outcomes=await Promise.allSettled(Array.from({length:4},()=>acquireProfileLease(dir)));
  const owners=outcomes.filter(item=>item.status==='fulfilled'); assert.equal(owners.length,1);
  await owners[0].value.release();
});

test('session holds its profile through observation, rejects overlap, and reports auth without running observer',async t=>{
  const {createGroupSession}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-session-`); t.after(()=>rm(dir,{recursive:true,force:true}));
  let resume,started; const active=new Promise(resolve=>{started=resolve;});
  const page={url:()=> 'https://www.facebook.com/groups/100',locator:()=>({count:async()=>0})};
  const session=createGroupSession({profilePath:dir,launchContext:async()=>({pages:()=>[page],close:async()=>{}})});
  const scan=session.withGroup(command(),async()=>{started();await new Promise(resolve=>{resume=resolve;});return 'observed';});
  await active;
  await assert.rejects(session.withGroup(command(),()=>assert.fail('Concurrent observer ran')),/leased/);
  resume();assert.equal(await scan,'observed');
  page.locator=()=>({count:async()=>1});
  const auth=await session.withGroup(command(),()=>assert.fail('Observer ran on login page'));
  assert.equal(auth.health,'auth_required');assert.equal(auth.coverage,'none');
});
