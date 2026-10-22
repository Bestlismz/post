import {setTimeout as delay} from 'node:timers/promises';

export async function runWorkers({automation,delivery,signal,pollMs=1000,onError=()=>{}}) {
  if(!Number.isSafeInteger(pollMs) || pollMs<1 || pollMs>60000)throw Error('Invalid poll interval');
  while(!signal.aborted) {
    let worked=false;
    for(const worker of [automation,delivery]) {
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
      const result=await scheduler.tick();
      emit({code:'SCHEDULER_TICK_COMPLETED',scheduled:result?.scheduled??0,skipped:result?.skipped??0,considered:result?.considered??0});
    } catch {emit({code:'SCHEDULER_TICK_FAILED'});}
    if(!signal.aborted)await delay(pollMs,undefined,{signal}).catch(error=>{if(error.name!=='AbortError')throw error;});
  }
}
