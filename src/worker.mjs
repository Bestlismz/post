import OpenAI from 'openai';
import {createPool} from './db/pool.mjs';
import {createInboxService} from './inbox/service.mjs';
import {createAutomationWorker} from './workers/automation-worker.mjs';
import {createMetaDeliveryWorker} from './workers/meta-delivery-worker.mjs';
import {createMetaCredentialRepository} from './channels/meta/credentials.mjs';
import {metaConnectionConfig} from './channels/meta/oauth.mjs';
import {runWorkers} from './workers/runner.mjs';

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
  if(!tokenConfig.keys[tokenConfig.keyVersion] || tokenConfig.keys[tokenConfig.keyVersion].length!==32 || !process.env.OPENAI_API_KEY)throw Error('Worker provider configuration required');
  const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:30000,maxRetries:0});
  const service=createInboxService({pool,client,model:process.env.OPENAI_MODEL ?? 'gpt-5-mini'});
  const automation=createAutomationWorker({pool,service,workerId:`messenger-${process.pid}`});
  const credentials=createMetaCredentialRepository({pool,keys:tokenConfig.keys,keyVersion:tokenConfig.keyVersion});
  const delivery=createMetaDeliveryWorker({pool,credentials});
  process.stdout.write('Messenger worker started.\n');
  await runWorkers({automation,delivery,signal:controller.signal,onError:code=>process.stderr.write(code+'\n')});
} catch {
  process.stderr.write('Messenger worker startup failed. Check runtime permissions and provider configuration.\n');
  process.exitCode=1;
} finally {await pool?.end();}
