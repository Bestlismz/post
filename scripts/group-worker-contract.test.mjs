import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import {createHash} from 'node:crypto';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { signCommand, signResult, verifyResult } from '../src/channels/groups/contracts.mjs';

const key = Buffer.alloc(32,97), keys = { current: key };
const command = () => signCommand({ version: 1, kind: 'ScanCommand', operationId: 'op-1', sourceId: 'source-1', groupId: '100', canonicalTarget: 'https://www.facebook.com/groups/100', keyId: 'current', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+60000).toISOString() }, { key, keyId: 'current' });
const load = (path) => import(`../src/${path}.mjs`);
async function fixturePage(t,html) {
  const candidates=[process.env.CHROMIUM_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser',chromium.executablePath()].filter(Boolean);
  let executablePath;
  for(const path of candidates) {try{await access(path);executablePath=path;break;}catch{}}
  assert.ok(executablePath,'Install Chromium to run recorded DOM contracts');
  const browser=await chromium.launch({headless:true,executablePath});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('https://www.facebook.com/**',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto('https://www.facebook.com/groups/100');return page;
}
async function killLeaseHelper(dir) {
  const lines=execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n');
  const row=lines.find(line=>line.includes(`${dir}/.group-worker.lock`)&&Number(line.trim().split(/\s+/)[1])===process.pid);
  assert.ok(row,'Profile lease helper exists');
  const pid=Number(row.trim().split(/\s+/)[0]);process.kill(pid,'SIGKILL');
  for(let i=0;i<100;i++) {try{process.kill(pid,0);}catch{return;}await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('Lease helper did not exit');
}
async function within(promise,ms=500) {
  let timer;
  try{return await Promise.race([promise,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(new Error('Operation did not finish')),ms);})]);}
  finally{clearTimeout(timer);}
}

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

test('private server and client carry only signed exact group reply and reconciliation commands',async t=>{
  const {createGroupWorkerServer}=await load('group-worker/server');
  const {createGroupWorkerClient}=await load('channels/groups/client');
  const now=new Date(),base={version:1,operationId:'reply-op',sourceId:'source-1',groupId:'100',canonicalTarget:'https://www.facebook.com/groups/100',targetId:'comment:900:901',textHash:createHash('sha256').update('Exact reply').digest('hex'),keyId:'current',issuedAt:now.toISOString(),expiresAt:new Date(+now+60000).toISOString()};
  const reply=signCommand({...base,kind:'GroupReplyCommand',text:'Exact reply'},{key,keyId:'current'});
  const reconcile=signCommand({...base,operationId:'reconcile-op',kind:'ReconcileCommand',attemptOperationId:'reply-op',senderId:'sender-1',attemptStartedAt:now.toISOString(),attemptFinishedAt:now.toISOString()},{key,keyId:'current'});
  const server=createGroupWorkerServer({keys,keyId:'current',key,allowedGroups:['100'],stagingSendEnabled:true,stagingAllowedGroups:['100'],scan:async()=>assert.fail('scan ran'),
    reply:async command=>({state:'sent',targetId:command.targetId,textHash:command.textHash,senderId:'sender-1',attemptStartedAt:now.toISOString(),attemptFinishedAt:now.toISOString(),evidenceHash:'b'.repeat(64),remoteId:'remote-1'}),
    reconcile:async command=>({state:'not_found',targetId:command.targetId,textHash:command.textHash,senderId:command.senderId,attemptStartedAt:command.attemptStartedAt,attemptFinishedAt:command.attemptFinishedAt,evidenceHash:'c'.repeat(64),remoteId:null})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const client=createGroupWorkerClient({baseUrl:`http://127.0.0.1:${server.address().port}`,keys,keyId:'current',key});
  assert.equal((await client.reply(reply)).remoteId,'remote-1');
  assert.equal((await client.reconcile(reconcile)).state,'not_found');
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

test('active CDP health probe distinguishes ready login checkpoint and restart gaps',async()=>{
  const {probeBrowserHealth}=await load('group-worker/session');
  const reply=pages=>async()=>Response.json(pages.map(page=>({type:'page',...page}))),inspectPage=async page=>({state:page.session});
  assert.deepEqual(await probeBrowserHealth({cdpUrl:'http://127.0.0.1:9222',ownership:{state:'healthy'},fetchImpl:reply([{url:'https://www.facebook.com/groups/100',session:'healthy'}]),inspectPage}),{state:'healthy'});
  assert.deepEqual(await probeBrowserHealth({cdpUrl:'http://127.0.0.1:9222',ownership:{state:'healthy'},fetchImpl:reply([{url:'https://www.facebook.com/',session:'auth_required'}]),inspectPage}),{state:'auth_required'});
  assert.deepEqual(await probeBrowserHealth({cdpUrl:'http://127.0.0.1:9222',ownership:{state:'healthy'},fetchImpl:reply([{url:'https://www.facebook.com/checkpoint/',session:'checkpoint'}]),inspectPage}),{state:'checkpoint'});
  assert.deepEqual(await probeBrowserHealth({cdpUrl:'http://127.0.0.1:9222',ownership:{state:'healthy'},fetchImpl:async()=>{throw Error('restart');}}),{state:'unavailable'});
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
  const html=await readFile(new URL('./fixtures/group-observation.html',import.meta.url),'utf8');
  const page=await fixturePage(t,html);
  const result=await observeGroupPage(page,command());
  assert.equal(result.coverage,'partial');
  assert.deepEqual(result.observations.map(item=>item.targetId),['post:900','comment:900:901']);
  assert.deepEqual(result.observations.map(item=>item.text),['Room near BTS','Interested']);
  assert.equal(result.observations[1].authorLabel,'Ann');
});

test('observer discovers the group name and whether the connected account has admin tools',async t=>{
  const {observeGroupPage}=await load('group-worker/observer');
  const page=await fixturePage(t,'<main><h1>autopost</h1><a href="/groups/100/admin_assistant/">Admin Assist</a><div role="feed"><div role="article"><h2>Best</h2><a href="/groups/100/posts/900/"><time datetime="2026-10-22T11:58:00.000Z">2m</time></a><div data-ad-preview="message">Room</div></div></div></main>');
  const result=await observeGroupPage(page,command());
  assert.equal(result.groupName,'autopost');
  assert.equal(result.accessLevel,'admin');
});

test('recorded Facebook DOM driver locates an exact target sends once and reconciles bound evidence',async t=>{
  const {createFacebookGroupDriver}=await import('../src/group-worker/facebook-driver.mjs');
  const page=await fixturePage(t,`<header role="banner"><a aria-label="Your profile" href="/profile.php?id=42">Me</a></header><div role="feed"><div role="article"><h3><a href="/profile.php?id=777">Poster</a></h3><a href="/groups/100/posts/900/"><time datetime="2026-10-22T11:58:00.000Z">2m</time></a><div data-ad-preview="message">Room</div>
    <div role="article" id="other"><h3><a href="/profile.php?id=778">Other</a></h3><a href="/groups/100/posts/900/?comment_id=899"><time datetime="2026-10-22T11:58:30.000Z">1m</time></a><div data-ad-preview="message">Other</div><button>Reply</button><div contenteditable="true" role="textbox">wrong editor</div></div>
    <div role="article" id="target"><h3><a href="/profile.php?id=779">Ann</a></h3><a href="/groups/100/posts/900/?comment_id=901"><time datetime="2026-10-22T11:59:00.000Z">1m</time></a><div data-ad-preview="message">Interested</div><button aria-label="Reply to Ann">Reply</button></div>
    </div></div><script>document.querySelector('#target button').addEventListener('click',event=>{window.clicked=event.currentTarget.closest('[role=article]').id;const editor=document.createElement('div');editor.contentEditable='true';editor.setAttribute('role','textbox');editor.setAttribute('aria-label','Reply to Ann');event.currentTarget.closest('[role=article]').append(editor);editor.addEventListener('keydown',event=>{if(event.key!=='Enter')return;event.preventDefault();const text=event.currentTarget.textContent;const item=document.createElement('div');item.setAttribute('role','article');item.innerHTML='<h3><a href="/profile.php?id=42">Me</a></h3><a href="/groups/100/posts/900/?comment_id=902"><time datetime="2026-10-22T12:00:00.000Z">now</time></a><div data-ad-preview="message"></div>';item.querySelector('[data-ad-preview]').textContent=text;event.currentTarget.closest('[role=article]').append(item);});});</script>`);
  const driver=createFacebookGroupDriver(page,{clock:()=>new Date('2026-10-22T12:00:00.000Z')}),replyCommand={...command(),targetId:'comment:900:901'};
  const target=await driver.locateExactTarget(replyCommand);assert.equal(target.targetId,replyCommand.targetId);
  const sender=await driver.identifySender();assert.match(sender,/^facebook-actor:[a-f0-9]{64}$/);
  assert.deepEqual(await driver.sendExact(target,'Exact reply'),{state:'sent',visible:true,remoteId:'902'});
  assert.equal(await page.evaluate(()=>window.clicked),'target');
  const evidence=await driver.findReplyEvidence({...replyCommand,textHash:createHash('sha256').update('Exact reply').digest('hex')});
  assert.equal(evidence.length,1);assert.equal(evidence[0].text,'Exact reply');assert.equal(evidence[0].senderId,sender);assert.equal(evidence[0].remoteId,'902');
});

test('comment reply fails closed for missing or ambiguous owned Reply controls and cancellation/deadline',async t=>{
  const {createFacebookGroupDriver}=await import('../src/group-worker/facebook-driver.mjs');
  const html=buttons=>`<header role="banner"><a aria-label="Your profile" href="/me">Me</a></header><div role="article"><a href="/groups/100/posts/900/"></a><div role="article"><a href="/groups/100/posts/900/?comment_id=901"></a><div data-ad-preview="message">Interested</div>${buttons}</div></div>`;
  for(const buttons of ['', '<button>Reply</button><button aria-label="Reply to Ann">Reply</button>']) {
    const page=await fixturePage(t,html(buttons)),driver=createFacebookGroupDriver(page),target=await driver.locateExactTarget({...command(),targetId:'comment:900:901'});
    await assert.rejects(driver.sendExact(target,'No send',{deadline:Date.now()+250}),/Reply control/);
  }
  const page=await fixturePage(t,html('<button>Reply</button>')),driver=createFacebookGroupDriver(page),target=await driver.locateExactTarget({...command(),targetId:'comment:900:901'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(driver.sendExact(target,'No send',{signal:controller.signal,deadline:Date.now()+250}),/cancel/i);
  await assert.rejects(driver.sendExact(target,'No send',{deadline:Date.now()-1}),/deadline/i);
  const ambiguousEditor=await fixturePage(t,html('<button onclick="this.insertAdjacentHTML(\'afterend\',\'<div contenteditable=true role=textbox aria-label=Reply></div><div contenteditable=true role=textbox aria-label=Reply></div>\')">Reply</button>'));
  const ambiguousDriver=createFacebookGroupDriver(ambiguousEditor),ambiguousTarget=await ambiguousDriver.locateExactTarget({...command(),targetId:'comment:900:901'});
  await assert.rejects(ambiguousDriver.sendExact(ambiguousTarget,'No send',{deadline:Date.now()+250}),/composer ambiguous/);
  const cancelledPage=await fixturePage(t,html('<button>Reply</button>')),cancelledDriver=createFacebookGroupDriver(cancelledPage),cancelledTarget=await cancelledDriver.locateExactTarget({...command(),targetId:'comment:900:901'});
  const waiting=new AbortController();setTimeout(()=>waiting.abort(),30);
  await assert.rejects(cancelledDriver.sendExact(cancelledTarget,'No send',{signal:waiting.signal,deadline:Date.now()+500}),/cancel/i);
});

test('a no-op Reply never reuses or types into a pre-existing card-owned textbox',async t=>{
  const {createFacebookGroupDriver}=await import('../src/group-worker/facebook-driver.mjs');
  const page=await fixturePage(t,`<header role="banner"><a aria-label="Your profile" href="/me">Me</a></header><div role="article"><a href="/groups/100/posts/900/"></a><div role="article"><a href="/groups/100/posts/900/?comment_id=901"></a><div data-ad-preview="message">Interested</div><button>Reply</button><div contenteditable="true" role="textbox" aria-label="Reply to Ann"></div></div></div><script>window.keydowns=0;document.querySelector('[contenteditable]').addEventListener('keydown',()=>window.keydowns++);</script>`);
  const driver=createFacebookGroupDriver(page),target=await driver.locateExactTarget({...command(),targetId:'comment:900:901'});
  await assert.rejects(driver.sendExact(target,'Must never be typed',{deadline:Date.now()+250}));
  assert.equal(await page.locator('[contenteditable]').textContent(),'');assert.equal(await page.evaluate(()=>window.keydowns),0);
  const editPage=await fixturePage(t,`<header role="banner"><a aria-label="Your profile" href="/me">Me</a></header><div role="article"><a href="/groups/100/posts/900/"></a><div role="article"><a href="/groups/100/posts/900/?comment_id=901"></a><button id="edit-reply">Reply</button></div></div><script>document.querySelector('#edit-reply').onclick=event=>{const editor=document.createElement('div');editor.contentEditable='true';editor.setAttribute('role','textbox');editor.setAttribute('aria-label','Edit comment');event.currentTarget.after(editor);};</script>`);
  const editDriver=createFacebookGroupDriver(editPage),editTarget=await editDriver.locateExactTarget({...command(),targetId:'comment:900:901'});
  await assert.rejects(editDriver.sendExact(editTarget,'Must never be typed',{deadline:Date.now()+250}));assert.ok((await editPage.locator('[contenteditable]').allTextContents()).every(text=>text===''));
  const unrelatedPage=await fixturePage(t,`<header role="banner"><a aria-label="Your profile" href="/me">Me</a></header><button id="unrelated">Other</button><div role="article"><a href="/groups/100/posts/900/"></a><div role="article"><a href="/groups/100/posts/900/?comment_id=901"></a><button onclick="document.querySelector('#unrelated').focus()">Reply</button><div contenteditable="true" role="textbox" aria-label="Reply to Ann"></div></div></div>`);
  const unrelatedDriver=createFacebookGroupDriver(unrelatedPage),unrelatedTarget=await unrelatedDriver.locateExactTarget({...command(),targetId:'comment:900:901'});
  await assert.rejects(unrelatedDriver.sendExact(unrelatedTarget,'Must never be typed',{deadline:Date.now()+250}));assert.equal(await unrelatedPage.locator('[contenteditable]').textContent(),'');
});

test('visible pre-click editors can never be promoted by Reply/Edit/Write relabel and focus',async t=>{
  const {createFacebookGroupDriver}=await import('../src/group-worker/facebook-driver.mjs');
  for(const label of ['Reply to Ann','Edit comment','Write a comment']) {
    const page=await fixturePage(t,`<header role="banner"><a aria-label="Your profile" href="/me">Me</a></header><div role="article"><a href="/groups/100/posts/900/"></a><div role="article"><a href="/groups/100/posts/900/?comment_id=901"></a><button id="reply">Reply</button><div id="old" contenteditable="true" role="textbox" aria-label="${label}"></div></div></div><script>window.keydowns=0;const old=document.querySelector('#old');old.addEventListener('keydown',()=>window.keydowns++);document.querySelector('#reply').onclick=()=>{old.setAttribute('aria-label','Reply to Ann');old.focus();};</script>`);
    const driver=createFacebookGroupDriver(page),target=await driver.locateExactTarget({...command(),targetId:'comment:900:901'});
    await assert.rejects(driver.sendExact(target,'Never type here',{deadline:Date.now()+250}));
    assert.equal(await page.locator('#old').textContent(),'');assert.equal(await page.evaluate(()=>window.keydowns),0,label);
  }
});

test('a previously hidden card reply editor may activate, but abort during final text read prevents Enter',async t=>{
  const {createFacebookGroupDriver}=await import('../src/group-worker/facebook-driver.mjs');
  const html=`<header role="banner"><a aria-label="Your profile" href="/me">Me</a></header><div role="article"><a href="/groups/100/posts/900/"></a><div role="article"><a href="/groups/100/posts/900/?comment_id=901"></a><button id="reply">Reply</button><div id="hidden" style="display:none" contenteditable="true" role="textbox" aria-label="Reply to Ann"></div></div></div><script>window.keydowns=0;const editor=document.querySelector('#hidden');editor.addEventListener('keydown',event=>{window.keydowns++;if(event.key!=='Enter')return;const item=document.createElement('div');item.setAttribute('role','article');item.innerHTML='<h3><a href="/me">Me</a></h3><a href="/groups/100/posts/900/?comment_id=902"><time datetime="2026-10-22T12:00:00.000Z">now</time></a><div data-ad-preview="message"></div>';item.querySelector('[data-ad-preview]').textContent=editor.textContent;editor.closest('[role=article]').append(item);});document.querySelector('#reply').onclick=()=>{editor.style.display='block';editor.focus();};</script>`;
  const validPage=await fixturePage(t,html),validDriver=createFacebookGroupDriver(validPage),validTarget=await validDriver.locateExactTarget({...command(),targetId:'comment:900:901'});
  assert.equal((await validDriver.sendExact(validTarget,'Hidden editor',{deadline:Date.now()+1000})).state,'sent');assert.equal(await validPage.evaluate(()=>window.keydowns),1);
  const abortedPage=await fixturePage(t,html),controller=new AbortController();
  const abortedDriver=createFacebookGroupDriver(abortedPage,{readEditorText:async editor=>{controller.abort();return editor.textContent();}}),abortedTarget=await abortedDriver.locateExactTarget({...command(),targetId:'comment:900:901'});
  await assert.rejects(abortedDriver.sendExact(abortedTarget,'Never dispatch',{signal:controller.signal,deadline:Date.now()+1000}),/cancel/i);
  assert.equal(await abortedPage.evaluate(()=>window.keydowns),0);
});

test('page close during Enter is a possible send and the durable ledger prevents automatic retry',async t=>{
  const {createFacebookGroupDriver}=await import('../src/group-worker/facebook-driver.mjs');
  const {createGroupDeliveryBoundary}=await import('../src/group-worker/delivery.mjs');
  const page=await fixturePage(t,`<header role="banner"><a aria-label="Your profile" href="/me">Me</a></header><div role="article"><a href="/groups/100/posts/900/"></a><div role="article"><a href="/groups/100/posts/900/?comment_id=901"></a><div data-ad-preview="message">Interested</div><button onclick="const e=document.createElement('div');e.contentEditable='true';e.setAttribute('role','textbox');e.setAttribute('aria-label','Reply to Ann');this.after(e);e.focus();e.addEventListener('keydown',event=>{if(event.key==='Enter')window.closeFixture();})">Reply</button></div></div>`);
  await page.exposeFunction('closeFixture',()=>page.close());
  const now=new Date(),input=signCommand({version:1,kind:'GroupReplyCommand',operationId:'close-on-enter',sourceId:'source-1',groupId:'100',canonicalTarget:'https://www.facebook.com/groups/100',targetId:'comment:900:901',text:'Exact reply',textHash:createHash('sha256').update('Exact reply').digest('hex'),keyId:'current',issuedAt:now.toISOString(),expiresAt:new Date(+now+60000).toISOString()},{key,keyId:'current'});
  const directory=await mkdtemp(`${tmpdir()}/group-close-enter-`);t.after(()=>rm(directory,{recursive:true,force:true}));let retrySends=0;
  const boundary=createGroupDeliveryBoundary({ledgerPath:directory,driver:createFacebookGroupDriver(page)});
  const result=await boundary.deliver(input);assert.equal(result.state,'unknown');assert.equal(result.code,'POSSIBLE_SEND');
  const restarted=createGroupDeliveryBoundary({ledgerPath:directory,driver:{sendExact:async()=>{retrySends++;}}});
  assert.equal((await restarted.deliver(input)).state,'unknown');assert.equal(retrySends,0);
  const cancelPage=await fixturePage(t,`<header role="banner"><a aria-label="Your profile" href="/me">Me</a></header><div role="article"><a href="/groups/100/posts/900/"></a><div role="article"><a href="/groups/100/posts/900/?comment_id=901"></a><button onclick="const e=document.createElement('div');e.contentEditable='true';e.setAttribute('role','textbox');e.setAttribute('aria-label','Reply to Ann');this.after(e);e.focus();e.addEventListener('keydown',event=>{if(event.key==='Enter')window.cancelAfterEnter();})">Reply</button></div></div>`);
  const cancelController=new AbortController();await cancelPage.exposeFunction('cancelAfterEnter',()=>cancelController.abort());
  const cancelInput=signCommand({...Object.fromEntries(Object.entries(input).filter(([name])=>name!=='signature')),operationId:'cancel-on-enter'},{key,keyId:'current'});
  const cancelled=await createGroupDeliveryBoundary({ledgerPath:directory,driver:createFacebookGroupDriver(cancelPage)}).deliver(cancelInput,{signal:cancelController.signal});
  assert.equal(cancelled.state,'unknown');assert.equal(cancelled.code,'POSSIBLE_SEND');
});

test('sender identity comes only from an unambiguous session-owned account surface',async t=>{
  const {createFacebookGroupDriver}=await import('../src/group-worker/facebook-driver.mjs');
  const numeric=await fixturePage(t,'<header role="banner"><a aria-label="Your profile" href="/profile.php?id=42">Me</a></header><div role="article"><h3><a href="/profile.php?id=777">Author</a></h3></div>');
  const expected=await createFacebookGroupDriver(numeric).identifySender();
  assert.notEqual(expected,`facebook-actor:${createHash('sha256').update('https://www.facebook.com/profile.php?id=777').digest('hex')}`);
  const pageIdentity=await fixturePage(t,'<header role="banner"><a aria-label="Page profile" href="/AcmeRentals">Acme Rentals</a></header><a href="/profile.php?id=777">Author</a>');
  assert.match(await createFacebookGroupDriver(pageIdentity).identifySender(),/^facebook-actor:[a-f0-9]{64}$/);
  const ambiguous=await fixturePage(t,'<div role="menu" aria-label="Account menu"><a href="/me">Me</a><a href="/AcmeRentals">Page</a></div>');
  await assert.rejects(createFacebookGroupDriver(ambiguous).identifySender(),/sender unavailable/);
  const authorOnly=await fixturePage(t,'<div role="article"><a aria-label="profile" href="/profile.php?id=777">Author</a></div>');
  await assert.rejects(createFacebookGroupDriver(authorOnly).identifySender(),/sender unavailable/);
});

test('card identity ignores hostile body permalinks and nested shared-post headers',async t=>{
  const {observeGroupPage}=await load('group-worker/observer');
  const page=await fixturePage(t,`<div role="feed"><div role="article"><h3>Mali</h3>
    <a href="/groups/100/posts/900/"><time>2h</time></a>
    <div data-ad-preview="message">Own text <a href="/groups/100/posts/666/">2h</a></div>
    <div role="article"><h3>Shared author</h3><a href="/groups/100/posts/777/"><time>1h</time></a><div data-ad-preview="message">Shared text</div></div>
    </div></div>`);
  const result=await observeGroupPage(page,command());
  assert.deepEqual(result.observations.map(item=>item.targetId),['post:900']);
  assert.equal(result.observations[0].authorLabel,'Mali');
  assert.equal(result.observations[0].text,'Own text 2h');
});

test('opaque timestamps and body-only permalinks never assign body text to a foreign identity',async t=>{
  const {observeGroupPage}=await load('group-worker/observer');
  const page=await fixturePage(t,`<div role="feed">
    <div role="article"><h3>Safe</h3><a href="/groups/100/posts/900/"><time>2h</time></a><div data-ad-preview="message">Retained</div></div>
    <div role="article"><h3>Mali</h3><a href="/groups/100?__cft__[0]=opaque#?trigger"><time>1h</time></a><div data-ad-preview="message">Hostile <a href="/groups/100/posts/666/">2h</a></div></div>
    </div>`);
  const result=await observeGroupPage(page,command());
  assert.deepEqual(result.observations.map(item=>item.targetId),['post:900']);
  assert.equal(result.coverage,'partial');assert.equal(result.reason,'identity_missing');
});

test('conflicting card-owned timestamp identities fail closed while retaining earlier cards',async t=>{
  const {observeGroupPage}=await load('group-worker/observer');
  const page=await fixturePage(t,`<div role="feed">
    <div role="article"><h3>Safe</h3><a href="/groups/100/posts/900/"><time>2h</time></a><div data-ad-preview="message">Retained</div></div>
    <div role="article"><h3>Mali</h3><a href="/groups/100/posts/901/"><time>1h</time></a><a href="/groups/101/posts/666/"><time>1h</time></a><div data-ad-preview="message">Conflicted</div></div>
    </div>`);
  const result=await observeGroupPage(page,command());
  assert.deepEqual(result.observations.map(item=>item.targetId),['post:900']);
  assert.equal(result.coverage,'partial');assert.equal(result.reason,'identity_ambiguous');
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

test('release after helper death finishes and another lease acquires the profile',async t=>{
  const {acquireProfileLease}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-killed-helper-`); t.after(()=>rm(dir,{recursive:true,force:true}));
  const lease=await acquireProfileLease(dir);await killLeaseHelper(dir);
  await within(lease.release());await within(lease.release());
  const replacement=await acquireProfileLease(dir);await replacement.release();
});

test('helper loss clears session busy even when ownership fails at the end of observation',async t=>{
  const {createGroupSession}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-session-loss-`);t.after(()=>rm(dir,{recursive:true,force:true}));
  const page={url:()=> 'https://www.facebook.com/groups/100',locator:()=>({count:async()=>0})};
  const session=createGroupSession({profilePath:dir,launchContext:async()=>({pages:()=>[page],close:async()=>{}})});
  await assert.rejects(within(session.withGroup(command(),async()=>{await killLeaseHelper(dir);return 'lost';})),/lease lost/);
  assert.equal(await within(session.withGroup(command(),async()=> 'next scan')),'next scan');
});

test('mid-scan login checkpoint and closed pages preserve observations with actionable session health',async()=>{
  const {observeGroupPage}=await load('group-worker/observer');
  for(const [destination,want] of [['https://www.facebook.com/login/','auth_required'],['https://www.facebook.com/checkpoint/','checkpoint'],['closed','expired']]) {
    let url='https://www.facebook.com/groups/100',pass=0,closed=false;
    const page={url:()=>url,isClosed:()=>closed,locator:()=>({count:async()=>0}),evaluate:async()=>{
      if(pass++) {if(destination==='closed')closed=true;else url=destination;return {selectorValid:false,hasMore:false,items:[]};}
      return {selectorValid:true,hasMore:true,items:[{href:'https://www.facebook.com/groups/100/posts/900/',text:'Retained',authorLabel:'Mali'}]};
    }};
    const result=await observeGroupPage(page,command());
    assert.equal(result.health,want,destination);assert.equal(result.coverage,'partial');
    assert.equal(result.reason,'session_unavailable');assert.equal(result.observations[0].text,'Retained');
  }
});

test('server deadline cancels a hung browser evaluation, releases the profile, and emits only signed timeout',async t=>{
  const {createGroupWorkerServer}=await load('group-worker/server');
  const {createGroupSession,acquireProfileLease}=await load('group-worker/session');
  const {observeGroupPage}=await load('group-worker/observer');
  const {transportHeaders}=await load('channels/groups/transport');
  const dir=await mkdtemp(`${tmpdir()}/group-deadline-`);t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>killLeaseHelper(dir).catch(()=>{}));
  let closeCount=0,finishEvaluation,evaluations=0;
  const page={url:()=> 'https://www.facebook.com/groups/100',locator:()=>({count:async()=>0}),evaluate:()=>{evaluations++;return new Promise(resolve=>{finishEvaluation=resolve;});}};
  const session=createGroupSession({profilePath:dir,launchContext:async()=>({pages:()=>[page],close:async()=>{closeCount++;}})});
  const server=createGroupWorkerServer({keys,keyId:'current',key,allowedGroups:['100'],commandTimeoutMs:70,scan:(cmd,options)=>session.withGroup(cmd,observeGroupPage,options)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const body=JSON.stringify(command());
  const response=await within(fetch(`http://127.0.0.1:${server.address().port}/commands`,{method:'POST',body,headers:transportHeaders(body,{key,keyId:'current'})}),1000);
  const result=verifyResult(await response.text(),{keys});
  assert.equal(result.reason,'scan_timeout');assert.equal(result.coverage,'none');assert.equal(closeCount,1);
  const lease=await acquireProfileLease(dir);await lease.release();
  finishEvaluation({selectorValid:true,complete:true,items:[{href:'https://www.facebook.com/groups/100/posts/666/',text:'Late body',authorLabel:'Mali'}]});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(evaluations,1);assert.equal(result.observations.length,0);
});

test('client abort cancels observation and a later scan acquires the same profile',async t=>{
  const {createGroupWorkerServer}=await load('group-worker/server');
  const {createGroupSession}=await load('group-worker/session');
  const {observeGroupPage}=await load('group-worker/observer');
  const {transportHeaders}=await load('channels/groups/transport');
  const dir=await mkdtemp(`${tmpdir()}/group-client-abort-`);t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>killLeaseHelper(dir).catch(()=>{}));
  let started,closed;const active=new Promise(resolve=>{started=resolve;}),stopped=new Promise(resolve=>{closed=resolve;});
  const page={url:()=> 'https://www.facebook.com/groups/100',locator:()=>({count:async()=>0}),evaluate:()=>{started();return new Promise(()=>{});}};
  const session=createGroupSession({profilePath:dir,launchContext:async()=>({pages:()=>[page],close:async()=>{closed();}})});
  const server=createGroupWorkerServer({keys,keyId:'current',key,allowedGroups:['100'],commandTimeoutMs:5000,scan:(cmd,options)=>session.withGroup(cmd,observeGroupPage,options)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const controller=new AbortController(),body=JSON.stringify(command());
  const response=fetch(`http://127.0.0.1:${server.address().port}/commands`,{method:'POST',body,headers:transportHeaders(body,{key,keyId:'current'}),signal:controller.signal});
  const rejected=assert.rejects(response);await within(active);controller.abort();await rejected;await within(stopped);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(await within(session.withGroup(command(),async()=> 'next scan')),'next scan');
});

test('session cancellation bounds late launch and navigation, and closes late contexts without observing',async t=>{
  const {createGroupSession}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-launch-abort-`);t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>killLeaseHelper(dir).catch(()=>{}));
  let finishLaunch,started,closed=0;
  const active=new Promise(resolve=>{started=resolve;});
  const session=createGroupSession({profilePath:dir,cleanupTimeoutMs:20,launchContext:()=>{started();return new Promise(resolve=>{finishLaunch=resolve;});}});
  const controller=new AbortController();
  const scan=session.withGroup(command(),()=>assert.fail('Late launch observed'),{signal:controller.signal});
  await active;controller.abort();await assert.rejects(within(scan),/quarantined/);
  finishLaunch({close:async()=>{closed++;}});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(closed,1);
  const navigationStarted=Promise.withResolvers();
  const page={url:()=> 'about:blank',goto:()=>{navigationStarted.resolve();return new Promise(()=>{});}};
  const next=createGroupSession({profilePath:dir,launchContext:async()=>({pages:()=>[],newPage:async()=>page,close:async()=>{closed++;}})});
  const navController=new AbortController();const navigating=next.withGroup(command(),()=>assert.fail('Hung navigation observed'),{signal:navController.signal});
  await navigationStarted.promise;navController.abort();await assert.rejects(within(navigating));assert.equal(closed,2);
});

test('aborted sessions never launch and hung context cleanup falls back to closing its browser',async t=>{
  const {createGroupSession,acquireProfileLease}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-cleanup-bound-`);t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>killLeaseHelper(dir).catch(()=>{}));
  let launches=0,browserCloses=0;
  const page={url:()=> 'https://www.facebook.com/groups/100',locator:()=>({count:async()=>0})};
  const session=createGroupSession({profilePath:dir,cleanupTimeoutMs:20,launchContext:async()=>{launches++;return {pages:()=>[page],close:()=>new Promise(()=>{}),browser:()=>({close:async()=>{browserCloses++;}})};}});
  const controller=new AbortController();controller.abort();
  await assert.rejects(within(session.withGroup(command(),()=>assert.fail('Aborted observer ran'),{signal:controller.signal})));
  assert.equal(launches,0);
  assert.equal(await within(session.withGroup(command(),async()=> 'done')),'done');
  assert.equal(browserCloses,1);
  const lease=await acquireProfileLease(dir);await lease.release();
});

test('helper death aborts a hung observation and closes its browser before the next scan',async t=>{
  const {createGroupSession}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-hung-helper-loss-`);t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>killLeaseHelper(dir).catch(()=>{}));
  let started,closed=0;const active=new Promise(resolve=>{started=resolve;});
  const page={url:()=> 'https://www.facebook.com/groups/100',locator:()=>({count:async()=>0})};
  const session=createGroupSession({profilePath:dir,launchContext:async()=>({pages:()=>[page],close:async()=>{closed++;}})});
  const scan=session.withGroup(command(),()=>{started();return new Promise(()=>{});});
  const stopped=assert.rejects(within(scan),/lease lost/);await active;await killLeaseHelper(dir);await stopped;
  assert.equal(closed,1);assert.equal(await within(session.withGroup(command(),async()=> 'next')),'next');
});

test('unconfirmed context and browser closure quarantines the profile until termination is confirmed',async t=>{
  const {createGroupSession,acquireProfileLease}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-quarantine-close-`);t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>killLeaseHelper(dir).catch(()=>{}));
  const contextClosed=Promise.withResolvers(),browserClosed=Promise.withResolvers();
  const page={url:()=> 'https://www.facebook.com/groups/100',locator:()=>({count:async()=>0})};
  const session=createGroupSession({profilePath:dir,cleanupTimeoutMs:20,launchContext:async()=>({pages:()=>[page],close:()=>contextClosed.promise,browser:()=>({close:()=>browserClosed.promise})})});
  await assert.rejects(within(session.withGroup(command(),async()=> 'observed')),/quarantined/);
  assert.deepEqual(session.getHealth(),{state:'quarantined'});
  await assert.rejects(session.withGroup(command(),()=>assert.fail('Quarantined observer ran')),/quarantined/);
  const contender=acquireProfileLease(dir);t.after(async()=>{const lease=await contender.catch(()=>null);await lease?.release();});
  await assert.rejects(contender,/leased/);
  browserClosed.resolve();
  for(let i=0;i<100&&session.getHealth().state!=='healthy';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(session.getHealth(),{state:'healthy'});
  const next=await acquireProfileLease(dir);await next.release();
});

test('an unresolved launch quarantines and retains its profile through late launch termination',async t=>{
  const {createGroupSession,acquireProfileLease}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-quarantine-launch-`);t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>killLeaseHelper(dir).catch(()=>{}));
  const launch=Promise.withResolvers(),active=Promise.withResolvers(),closed=Promise.withResolvers();
  const session=createGroupSession({profilePath:dir,cleanupTimeoutMs:20,launchContext:()=>{active.resolve();return launch.promise;}});
  const controller=new AbortController();const scan=session.withGroup(command(),()=>assert.fail('Late observer ran'),{signal:controller.signal});
  await active.promise;controller.abort();await assert.rejects(within(scan),/quarantined/);
  assert.deepEqual(session.getHealth(),{state:'quarantined'});
  let attempt=acquireProfileLease(dir);t.after(async()=>{const lease=await attempt.catch(()=>null);await lease?.release();});
  await assert.rejects(attempt,/leased/);
  await assert.rejects(session.withGroup(command(),()=>assert.fail('Quarantined launch restarted')),/quarantined/);
  launch.resolve({close:()=>closed.promise});await new Promise(resolve=>setTimeout(resolve,30));
  attempt=acquireProfileLease(dir);await assert.rejects(attempt,/leased/);
  closed.resolve();
  for(let i=0;i<100&&session.getHealth().state!=='healthy';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(session.getHealth(),{state:'healthy'});
  const next=await acquireProfileLease(dir);await next.release();
});

test('evaluation failure probes auth checkpoint closed and live-selector states while retaining observations',async()=>{
  const {observeGroupPage}=await load('group-worker/observer');
  for(const [failure,want] of [['login','auth_required'],['checkpoint','checkpoint'],['closed','expired'],['disconnected','expired'],['selector','selector_failure']]) {
    let url='https://www.facebook.com/groups/100',pass=0,closed=false,disconnected=false;
    const page={url:()=>url,isClosed:()=>closed,locator:()=>({count:async()=>{if(disconnected)throw new Error('Target closed');return 0;}}),evaluate:async()=>{
      if(pass++) {if(failure==='login')url='https://www.facebook.com/login/';if(failure==='checkpoint')url='https://www.facebook.com/checkpoint/';if(failure==='closed')closed=true;if(failure==='disconnected')disconnected=true;throw new Error('Execution context was destroyed');}
      return {selectorValid:true,hasMore:true,items:[{href:'https://www.facebook.com/groups/100/posts/900/',text:'Retained',authorLabel:'Mali'}]};
    }};
    const result=await observeGroupPage(page,command());
    assert.equal(result.health,want,failure);assert.equal(result.coverage,'partial');assert.equal(result.observations[0].text,'Retained');
    if(want==='expired')assert.equal(result.reason,'session_lost');
  }
});

test('quarantined ownership survives across processes and kernel cleanup releases it on worker death',async t=>{
  const {acquireProfileLease}=await load('group-worker/session');
  const dir=await mkdtemp(`${tmpdir()}/group-quarantine-process-`);t.after(()=>rm(dir,{recursive:true,force:true}));
  const holder=spawn(process.execPath,['--input-type=module','-e',`
    import {createGroupSession} from ${JSON.stringify(new URL('../src/group-worker/session.mjs',import.meta.url).href)};
    const page={url:()=> 'https://www.facebook.com/groups/100',locator:()=>({count:async()=>0})};
    const session=createGroupSession({profilePath:${JSON.stringify(dir)},cleanupTimeoutMs:20,launchContext:async()=>({pages:()=>[page],close:()=>new Promise(()=>{})})});
    await session.withGroup({canonicalTarget:'https://www.facebook.com/groups/100',expiresAt:new Date(Date.now()+60000).toISOString()},async()=> 'observed').catch(()=>{});
    console.log(session.getHealth().state);
    setInterval(()=>{},1000);
  `],{stdio:['ignore','pipe','pipe']});
  t.after(()=>holder.kill('SIGKILL'));
  const [ready]=await within(once(holder.stdout,'data'),1500);assert.equal(ready.toString().trim(),'quarantined');
  const contender=acquireProfileLease(dir);t.after(async()=>{const lease=await contender.catch(()=>null);await lease?.release();});
  await assert.rejects(contender,/leased/);
  holder.kill('SIGKILL');await once(holder,'exit');
  const recovered=await acquireProfileLease(dir);await recovered.release();
});
