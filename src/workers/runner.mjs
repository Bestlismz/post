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
