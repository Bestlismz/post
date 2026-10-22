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

export async function closeContext(context,ms=200) {
  if(!context)return;
  const pending=Promise.resolve().then(()=>context.close());
  const closed=await settleWithin(pending.then(()=>true),ms,false);
  if(!closed)await settleWithin(Promise.resolve().then(()=>context.browser?.()?.close()),ms);
}
