import {setTimeout as delay} from 'node:timers/promises';

function boundedInteger(value,fallback,min,max) {
  const raw=value===undefined?String(fallback):value;
  if(typeof raw!=='string'||!/^\d+$/u.test(raw))throw Error('Invalid application runtime configuration');
  const parsed=Number(raw);if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)throw Error('Invalid application runtime configuration');
  return parsed;
}

export function applicationRuntimeConfig(env=process.env) {
  const supportedSelectorVersions=(env.GROUP_SUPPORTED_SELECTOR_VERSIONS??'facebook-dom-v3').split(',').map(value=>value.trim()).filter(Boolean);
  if(!supportedSelectorVersions.length||supportedSelectorVersions.length>50||supportedSelectorVersions.some(value=>value.length>200))throw Error('Invalid application runtime configuration');
  return {
    workerPollMs:boundedInteger(env.WORKER_POLL_MS,1000,1,60000),
    schedulerPollMs:boundedInteger(env.GROUP_SCHEDULER_POLL_MS,15000,1,60000),
    schedulerBatchSize:boundedInteger(env.GROUP_SCHEDULER_BATCH_SIZE,50,1,500),
    schedulerTickTimeoutMs:boundedInteger(env.GROUP_SCHEDULER_TICK_TIMEOUT_MS,30000,10,60000),
    supportedSelectorVersions
  };
}

export async function runWorkers({automation,delivery,workers=null,signal,pollMs=1000,onError=()=>{}}) {
  if(!Number.isSafeInteger(pollMs) || pollMs<1 || pollMs>60000)throw Error('Invalid poll interval');
  const stages=workers??[automation,delivery];
  if(!Array.isArray(stages)||!stages.length||stages.some(worker=>!worker||typeof worker.runOnce!=='function'))throw Error('Invalid application workers');
  while(!signal.aborted) {
    let worked=false;
    for(const worker of stages) {
      if(signal.aborted)break;
      try {worked=Boolean(await worker.runOnce()) || worked;}
      catch {onError('WORKER_POLL_FAILED');}
    }
    if(!worked && !signal.aborted)await delay(pollMs,undefined,{signal}).catch(error=>{if(error.name!=='AbortError')throw error;});
  }
}

export async function runScheduler({scheduler,signal,pollMs=15000,onEvent=()=>{}}) {
  if(!scheduler || typeof scheduler.tick!=='function')throw Error('Scheduler is required');
  if(!signal || !Number.isSafeInteger(pollMs)||pollMs<1||pollMs>60000)throw Error('Invalid scheduler runtime');
  const emit=event=>{try {onEvent(event);} catch { /* Observability must not stop scheduling. */ }};
  while(!signal.aborted) {
    try {
      const result=await scheduler.tick({signal});
      emit({code:'SCHEDULER_TICK_COMPLETED',scheduled:result?.scheduled??0,skipped:result?.skipped??0,considered:result?.considered??0});
    } catch {if(!signal.aborted)emit({code:'SCHEDULER_TICK_FAILED'});}
    if(!signal.aborted)await delay(pollMs,undefined,{signal}).catch(error=>{if(error.name!=='AbortError')throw error;});
  }
}

export async function superviseRuntimes({controller,factories}) {
  if(!controller||!Array.isArray(factories)||factories.length<2||factories.some(factory=>typeof factory!=='function'))throw Error('Invalid runtime supervision');
  const watched=factories.map(factory=>Promise.resolve().then(factory).then(value=>{
    if(!controller.signal.aborted)throw Error('Application runtime stopped unexpectedly');
    return value;
  }));
  let primary;
  try {await Promise.race(watched);} catch(error) {primary=error;}
  if(!controller.signal.aborted)controller.abort(primary);
  const settled=await Promise.allSettled(watched);
  if(primary)throw primary;
  const rejected=settled.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
}

export function runApplicationRuntimes({automation,delivery,workers=null,createScheduler,controller,env=process.env,onWorkerError=()=>{},onSchedulerEvent=()=>{}}) {
  const config=applicationRuntimeConfig(env);
  if(typeof createScheduler!=='function')throw Error('Invalid application runtime configuration');
  const scheduler=createScheduler(config);
  return superviseRuntimes({controller,factories:[
    ()=>runWorkers({automation,delivery,workers,signal:controller.signal,pollMs:config.workerPollMs,onError:onWorkerError}),
    ()=>runScheduler({scheduler,signal:controller.signal,pollMs:config.schedulerPollMs,onEvent:onSchedulerEvent})
  ]});
}
