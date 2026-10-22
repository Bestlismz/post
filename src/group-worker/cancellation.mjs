export function abortable(run,signal,onLate) {
  if(signal?.aborted)return Promise.reject(signal.reason??new Error('Operation aborted'));
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason??new Error('Operation aborted'));
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(run).then(value=>{
      signal?.removeEventListener('abort',abort);
      if(signal?.aborted) {Promise.resolve().then(()=>onLate?.(value)).catch(()=>{});return;}
      resolve(value);
    },error=>{signal?.removeEventListener('abort',abort);reject(error);});
  });
}

export async function settleWithin(promise,ms,fallback=null) {
  let timer;
  try { return await Promise.race([Promise.resolve(promise).catch(()=>fallback),new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),ms);})]); }
  finally {clearTimeout(timer);}
}

export function closeContext(context,ms=200) {
  if(!context)return Promise.resolve();
  return new Promise(resolve=>{
    let fallbackStarted=false;
    const confirmed=()=>{clearTimeout(timer);resolve();};
    const fallback=()=>{
      if(fallbackStarted)return;fallbackStarted=true;
      Promise.resolve().then(()=>{
        const browser=context.browser?.();
        if(typeof browser?.close!=='function')return;
        return Promise.resolve(browser.close()).then(confirmed);
      }).catch(()=>{});
    };
    const timer=setTimeout(fallback,ms);
    Promise.resolve().then(()=>context.close()).then(confirmed,fallback);
  });
}
