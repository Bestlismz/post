import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_GROUP_ID_LENGTH } from '../channels/groups/target.mjs';
import { abortable, closeContext, settleWithin } from './cancellation.mjs';

export function assertGroupTarget(target) {
  if(typeof target!=='string'||!new RegExp(`^https://www\\.facebook\\.com/groups/[0-9]{1,${MAX_GROUP_ID_LENGTH}}$`).test(target)) throw new Error('Invalid group target');
}
export async function selectGroupPage(context,target,{signal}={}) {
  assertGroupTarget(target);
  const matches=context.pages().filter(page=>!page.isClosed?.()&&page.url()===target);
  if(matches.length) { const [selected,...duplicates]=matches; await abortable(()=>Promise.all(duplicates.map(page=>page.close().catch(()=>{}))),signal); return selected; }
  const page=await abortable(()=>context.newPage(),signal,page=>page.close());
  await abortable(()=>page.goto(target,{waitUntil:'domcontentloaded',timeout:30000}),signal);
  return page;
}
export async function inspectSession(page) {
  if(page.isClosed?.()) return {state:'expired'};
  const url=new URL(page.url());
  if(url.hostname!=='www.facebook.com'||url.protocol!=='https:') throw new Error('Invalid session page');
  if(url.pathname.startsWith('/checkpoint')) return {state:'checkpoint'};
  if(url.pathname.startsWith('/login')||await page.locator('input[name="email"], input[name="pass"]').count()) return {state:'auth_required'};
  return {state:'healthy'};
}

// The OS owns stale recovery. A dead holder releases flock even after SIGKILL.
const lockHolder=`import fcntl, os, sys, select
f=open(sys.argv[1], 'a+')
try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: sys.exit(73)
print('locked', flush=True)
parent=int(sys.argv[2])
while os.getppid()==parent:
 if select.select([sys.stdin], [], [], .1)[0]:
  if not sys.stdin.read(1): break
`;
export async function acquireProfileLease(profilePath,{python='python3'}={}) {
  await mkdir(profilePath,{recursive:true,mode:0o700});
  const canonical=await realpath(profilePath),fence=randomUUID();
  const child=spawn(python,['-c',lockHolder,join(canonical,'.group-worker.lock'),String(process.pid)],{stdio:['pipe','pipe','ignore']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const ownership=new AbortController();
  child.once('exit',()=>ownership.abort(new Error('Profile lease lost')));
  child.stdin.on('error',()=>{});
  await new Promise((resolve,reject)=>{ child.once('error',()=>reject(new Error('Profile lease unavailable'))); child.once('exit',()=>reject(new Error('Profile already leased'))); child.stdout.once('data',()=>resolve()); });
  let released=false,releasing;
  const stopped=()=>child.exitCode!==null||child.signalCode!==null;
  async function waitForExit(ms) {
    if(stopped())return;
    let timer;
    try { await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,ms);})]); }
    finally { clearTimeout(timer); }
  }
  return {fence,signal:ownership.signal,async assertOwned(){ if(released||stopped()) throw new Error('Profile lease lost'); },release(){
    if(releasing)return releasing;
    released=true;
    releasing=(async()=>{
      if(stopped())return;
      child.stdin.end();await waitForExit(100);
      if(!stopped()) {child.kill('SIGKILL');await waitForExit(100);}
      if(!stopped())throw new Error('Profile lease release failed');
    })();
    return releasing;
  }};
}

export function createGroupSession({profilePath,launchContext,commandTimeoutMs=30000,cleanupTimeoutMs=200}) {
  let state='healthy';
  return {getHealth(){return {state};},async withGroup(command,run,{signal:parentSignal}={}) {
    assertGroupTarget(command.canonicalTarget);
    if(state==='quarantined')throw new Error('Profile quarantined');
    if(state!=='healthy') throw new Error('Profile already leased'); state='busy';
    let lease,context,acquiring,launching;
    const controller=new AbortController(),signal=controller.signal;
    const cancel=()=>controller.abort(parentSignal.reason??new Error('Operation cancelled'));
    parentSignal?.addEventListener('abort',cancel,{once:true});if(parentSignal?.aborted)cancel();
    const timer=setTimeout(()=>controller.abort(new Error('Operation deadline exceeded')),Math.max(0,Math.min(commandTimeoutMs,Date.parse(command.expiresAt)-Date.now())));
    const lost=()=>controller.abort(lease.signal.reason);
    try {
      if(signal.aborted)throw signal.reason;
      acquiring=acquireProfileLease(profilePath);
      lease=await abortable(()=>acquiring,signal);
      lease.signal.addEventListener('abort',lost,{once:true});if(lease.signal.aborted)lost();
      if(signal.aborted)throw signal.reason;
      launching=Promise.resolve().then(()=>launchContext(profilePath,{signal,timeout:Math.max(1,Math.min(commandTimeoutMs,Date.parse(command.expiresAt)-Date.now()))}));
      context=await abortable(()=>launching,signal);
      await lease.assertOwned();
      const page=await selectGroupPage(context,command.canonicalTarget,{signal});
      const health=await abortable(()=>inspectSession(page),signal);
      if(health.state!=='healthy') return {selectorVersion:'facebook-dom-v2',coverage:'none',health:health.state,reason:'session_unavailable',cursor:null,observations:[]};
      const result=await abortable(()=>run(page,command,{signal}),signal); await lease.assertOwned(); return result;
    } finally {
      clearTimeout(timer);parentSignal?.removeEventListener('abort',cancel);
      lease?.signal.removeEventListener('abort',lost);
      const cleanup=(async()=>{
        const owner=lease??await acquiring?.catch(()=>null);
        const browserContext=context??await launching?.catch(()=>null);
        await closeContext(browserContext,cleanupTimeoutMs);
        await owner?.release();
        state='healthy';return true;
      })().catch(()=>{state='quarantined';return false;});
      if(!await settleWithin(cleanup,cleanupTimeoutMs*2+220,false)) {
        state='quarantined';throw new Error('Profile quarantined');
      }
    }
  }};
}
