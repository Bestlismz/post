import OpenAI from 'openai';
import {createPool} from './db/pool.mjs';
import {createInboxService} from './inbox/service.mjs';
import {createAutomationWorker} from './workers/automation-worker.mjs';
import {createMetaDeliveryWorker} from './workers/meta-delivery-worker.mjs';
import {createMetaCredentialRepository} from './channels/meta/credentials.mjs';
import {metaConnectionConfig} from './channels/meta/oauth.mjs';
import {runApplicationRuntimes} from './workers/runner.mjs';
import {createGroupScheduler,groupSchedulerConfig} from './workers/scheduler.mjs';
import {createGroupWorkerClient} from './channels/groups/client.mjs';
import {createGroupResultService} from './workers/group-results.mjs';
import {createGroupScanWorker} from './workers/group-scan-worker.mjs';
import {createGroupDeliveryWorker} from './workers/group-delivery-worker.mjs';

const controller=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>controller.abort());
let pool;
try {
  pool=createPool({databaseUrl:process.env.DATABASE_URL});
  const {rows:[role]}=await pool.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relowner=r.oid) AS owns_objects
    FROM pg_roles r WHERE r.rolname=current_user`);
  if(!role || Object.values(role).some(Boolean))throw Error('Restricted runtime database role required');
  const tokenConfig=metaConnectionConfig();
  if(!tokenConfig.keys[tokenConfig.keyVersion] || tokenConfig.keys[tokenConfig.keyVersion].length!==32)throw Error('Worker provider configuration required');
  const credentials=createMetaCredentialRepository({pool,keys:tokenConfig.keys,keyVersion:tokenConfig.keyVersion});
  const environmentClient=process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:30000,maxRetries:0}):null;
  const clientProvider=async organizationId=>credentials.withCredential(organizationId,`${organizationId}:provider:openai`,({apiKey})=>new OpenAI({apiKey,timeout:30000,maxRetries:0}),{kind:'openai'}).catch(error=>{
    if(environmentClient)return environmentClient;
    throw error;
  });
  const service=createInboxService({pool,client:environmentClient,clientProvider,model:process.env.OPENAI_MODEL ?? 'gpt-5-mini'});
  const automation=createAutomationWorker({pool,service,workerId:`messenger-${process.pid}`});
  const delivery=createMetaDeliveryWorker({pool,credentials});
  const groupSigning=groupSchedulerConfig(process.env);if(!groupSigning)throw Error('Group signing configuration required');
  const groupClient=createGroupWorkerClient({baseUrl:process.env.GROUP_WORKER_URL??'http://group-worker:3001',...groupSigning});
  const groupResults=createGroupResultService(pool,{keys:groupSigning.keys,signingKey:groupSigning.key,keyId:groupSigning.keyId,supportedSelectorVersions:(process.env.GROUP_SUPPORTED_SELECTOR_VERSIONS??'facebook-dom-v3').split(',').map(value=>value.trim()).filter(Boolean)});
  const groupScan=createGroupScanWorker({pool,client:groupClient,results:groupResults,keys:groupSigning.keys,keyId:groupSigning.keyId,signingKey:groupSigning.key,workerId:`group-scan-${process.pid}`});
  const stagingAllowedGroups=(process.env.STAGING_FACEBOOK_SOURCE_ALLOWLIST??'').split(',').map(value=>value.trim()).filter(Boolean);
  const groupDelivery=createGroupDeliveryWorker({pool,client:groupClient,keys:groupSigning.keys,signingKey:groupSigning.key,keyId:groupSigning.keyId,stagingSendEnabled:process.env.STAGING_FACEBOOK_SEND==='true',stagingAllowedGroups});
  const groupReconciliation={runOnce:()=>groupDelivery.runReconcileOnce()};
  const running=runApplicationRuntimes({workers:[automation,delivery,groupScan,groupDelivery,groupReconciliation],controller,env:process.env,createScheduler:config=>createGroupScheduler({pool,supportedSelectorVersions:config.supportedSelectorVersions,batchSize:config.schedulerBatchSize,tickTimeoutMs:config.schedulerTickTimeoutMs}),
    onWorkerError:code=>process.stderr.write(code+'\n'),onSchedulerEvent:event=>{
      const line=event.code==='SCHEDULER_TICK_COMPLETED'?{code:event.code,scheduled:event.scheduled,skipped:event.skipped,considered:event.considered}:event;
      (event.code==='SCHEDULER_TICK_FAILED'?process.stderr:process.stdout).write(JSON.stringify(line)+'\n');
    }});
  process.stdout.write('Messenger worker started.\n');
  process.stdout.write('Group scheduler started.\n');
  process.stdout.write('Group scan, delivery, and reconciliation workers started.\n');
  await running;
} catch {
  process.stderr.write('Application worker startup failed. Check runtime permissions and provider configuration.\n');
  process.exitCode=1;
} finally {await pool?.end();}
