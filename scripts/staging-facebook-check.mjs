import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {signCommand} from '../src/channels/groups/contracts.mjs';
import {createGroupWorkerClient} from '../src/channels/groups/client.mjs';
import {MAX_GROUP_ID_LENGTH} from '../src/channels/groups/target.mjs';
import {groupCommandKeyConfig} from '../src/channels/groups/keys.mjs';

function parseArgs(args) {
  let mode='no-send',source=null;
  for(let index=0;index<args.length;index++) {
    const arg=args[index];
    if(arg==='--no-send')mode='no-send';
    else if(arg==='--send')mode='send-check';
    else if(arg==='--source')source=args[++index]??null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if(source!==null&&!new RegExp(`^\\d{1,${MAX_GROUP_ID_LENGTH}}$`).test(source))throw new Error('Source must be an exact numeric Facebook group ID');
  if(mode==='send-check'&&!source)throw new Error('--source is required for send readiness');
  return {mode,source};
}

export async function runStagingCheck({args=[],env=process.env,fetchImpl=fetch,scanClient=null}={}) {
  const {mode,source}=parseArgs(args),base=new URL(env.GROUP_WORKER_URL??'http://127.0.0.1:3001');
  if(base.protocol!=='http:'||base.username||base.password||base.pathname!=='/'||!['group-worker','localhost','127.0.0.1','[::1]'].includes(base.hostname))throw new Error('GROUP_WORKER_URL must be private');
  let response,worker;
  try {response=await fetchImpl(new URL('/health',base),{signal:AbortSignal.timeout(3000),redirect:'error'});worker=await response.json();}catch{throw new Error('Group worker health check failed');}
  if(!response.ok||worker?.ok!==true||!['available','recovery'].includes(worker?.recovery?.state))throw new Error('Group worker is unhealthy');
  if(mode==='no-send') {
    let scanEvidence={performed:false};
    if(source) {
      const allowed=new Set((env.GROUP_SOURCE_ALLOWLIST??'').split(',').map(value=>value.trim()).filter(Boolean));
      if(!allowed.has(source))throw new Error('Read-only source is not allow-listed');
      let signing;try{signing=groupCommandKeyConfig(env);}catch{throw new Error('Invalid Group command keys');}
      const {keyId,key,keys}=signing;
      const client=scanClient??createGroupWorkerClient({baseUrl:base.href,keys,keyId,key,fetchImpl});
      const now=new Date(),command=signCommand({version:1,kind:'ScanCommand',operationId:randomUUID(),sourceId:`staging:${source}`,groupId:source,canonicalTarget:`https://www.facebook.com/groups/${source}`,issuedAt:now.toISOString(),expiresAt:new Date(+now+300_000).toISOString(),keyId},{key,keyId,now});
      const result=await client.scan(command),hashes=result.observations?.map(item=>item.evidenceHash)??[];
      if(!['complete','partial','none'].includes(result.coverage)||!Array.isArray(result.observations)||hashes.some(value=>!/^[a-f0-9]{64}$/.test(value)))throw new Error('Invalid scan evidence');
      scanEvidence={performed:true,coverage:result.coverage,health:result.health,selectorVersion:result.selectorVersion,observationCount:result.observations.length,evidenceHashes:hashes};
    }
    return {ok:true,mode,worker,scanEvidence,sendEligible:false};
  }
  const allowlist=new Set((env.STAGING_FACEBOOK_SOURCE_ALLOWLIST??'').split(',').map(value=>value.trim()).filter(Boolean));
  if(env.STAGING_FACEBOOK_SEND!=='true'||!allowlist.has(source))throw new Error('Both staging send gates are required for this exact source');
  if(worker.recovery.state!=='available')throw new Error('Browser recovery is active');
  if(worker.session?.state!=='healthy')throw new Error('Browser session is not ready');
  return {ok:true,mode,source,worker,sendEligible:true,actionPerformed:false};
}

if(import.meta.url===pathToFileURL(process.argv[1]).href) {
  runStagingCheck({args:process.argv.slice(2)}).then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
