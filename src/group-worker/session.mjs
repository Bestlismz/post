import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_GROUP_ID_LENGTH } from '../channels/groups/target.mjs';

export function assertGroupTarget(target) {
  if(typeof target!=='string'||!new RegExp(`^https://www\\.facebook\\.com/groups/[0-9]{1,${MAX_GROUP_ID_LENGTH}}$`).test(target)) throw new Error('Invalid group target');
}
export async function selectGroupPage(context,target) {
  assertGroupTarget(target);
  const matches=context.pages().filter(page=>!page.isClosed?.()&&page.url()===target);
  if(matches.length) { const [selected,...duplicates]=matches; await Promise.all(duplicates.map(page=>page.close().catch(()=>{}))); return selected; }
  const page=await context.newPage();
  await page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});
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
  await new Promise((resolve,reject)=>{ child.once('error',()=>reject(new Error('Profile lease unavailable'))); child.once('exit',()=>reject(new Error('Profile already leased'))); child.stdout.once('data',()=>resolve()); });
  let released=false;
  return {fence,async assertOwned(){ if(released||child.exitCode!==null||child.signalCode!==null) throw new Error('Profile lease lost'); },async release(){if(released)return;released=true;const stopped=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();await stopped;}};
}

export function createGroupSession({profilePath,launchContext}) {
  let busy=false;
  return {async withGroup(command,run) {
    assertGroupTarget(command.canonicalTarget);
    if(busy) throw new Error('Profile already leased'); busy=true;
    let lease,context;
    try {
      lease=await acquireProfileLease(profilePath);
      context=await launchContext(profilePath);
      await lease.assertOwned();
      const page=await selectGroupPage(context,command.canonicalTarget);
      const health=await inspectSession(page);
      if(health.state!=='healthy') return {selectorVersion:'facebook-dom-v1',coverage:'none',health:health.state,reason:'session_unavailable',cursor:null,observations:[]};
      const result=await run(page,command); await lease.assertOwned(); return result;
    } finally { await context?.close().catch(()=>{}); await lease?.release(); busy=false; }
  }};
}
