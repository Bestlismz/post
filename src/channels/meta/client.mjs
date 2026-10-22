// Meta's Send API accepts a Page token and a Page-scoped recipient ID.
// Provider response bodies and exception messages never cross this boundary.
export function validMetaSend({pageId,recipientId,text,token,attemptId}) {
  return [pageId,recipientId,token,attemptId].every(value=>typeof value==='string' && value.length>0 && value.length<=4096 && !/[\x00-\x20\x7f]/.test(value))
    && !['.','..'].includes(pageId) && typeof text==='string' && text.trim().length>0 && text.length<=2000;
}

export function createMetaSendClient({fetchImpl=fetch,graphVersion='v24.0',timeoutMs=10000,maxResponseBytes=16384,baseUrl='https://graph.facebook.com'}={}) {
  if (!/^v[1-9]\d*\.\d+$/.test(graphVersion) || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1 || maxResponseBytes>1048576) throw new Error('Invalid Meta client configuration');
  const base=new URL(baseUrl);
  if (base.origin!=='https://graph.facebook.com' || base.username || base.password || base.search || base.hash || base.pathname!=='/') throw new Error('Invalid Meta endpoint');
  return {async sendText(input) {
    if (!validMetaSend(input)) return {state:'failed',code:'LOCAL_INVALID_REQUEST',dispatched:false,retrySafe:true};
    const {pageId,recipientId,text,token,attemptId}=input;
    const controller=new AbortController();
    let timer;
    const uncertain=code=>({state:'unknown',code,dispatched:true,retrySafe:false});
    try {
      // Race the entire response read as well as fetch. Some injected transports
      // and stalled streams do not implement AbortSignal cancellation.
      return await Promise.race([
        (async()=>{
          const response=await fetchImpl(`${base.origin}/${graphVersion}/${encodeURIComponent(pageId)}/messages`,{
            method:'POST',redirect:'error',signal:controller.signal,
            headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
            body:JSON.stringify({recipient:{id:recipientId},messaging_type:'RESPONSE',message:{text,metadata:attemptId}}),
          });
          const reader=response.body?.getReader();
          if (!reader) return uncertain('PROVIDER_MALFORMED');
          const chunks=[];let size=0;
          try {
            while(true) {
              const {done,value}=await reader.read();if(done) break;
              size+=value.byteLength;
              if(size>maxResponseBytes) {await reader.cancel();return uncertain('PROVIDER_MALFORMED');}
              chunks.push(Buffer.from(value));
            }
          } finally {reader.releaseLock();}
          let body;try {body=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {return uncertain('PROVIDER_MALFORMED');}
          if(response.status>=500 || response.status===408 || body?.error?.is_transient===true) return uncertain('PROVIDER_UNCERTAIN');
          if(response.status>=400 && response.status<500) {
            if(!Number.isSafeInteger(body?.error?.code)) return uncertain('PROVIDER_MALFORMED');
            const code=response.status===401 || body?.error?.code===190 ? 'PROVIDER_AUTH'
              : response.status===429 || [4,17,32,613].includes(body?.error?.code) ? 'PROVIDER_RATE_LIMIT'
              : response.status===403 || [10,200].includes(body?.error?.code) ? 'PROVIDER_PERMISSION' : 'PROVIDER_INVALID_REQUEST';
            return {state:'failed',code,httpStatus:response.status,dispatched:true,retrySafe:false};
          }
          if(!response.ok || typeof body?.message_id!=='string' || !body.message_id || body.message_id.length>512 || /[\x00-\x20\x7f]/.test(body.message_id) || [token,recipientId,text].some(secret=>body.message_id.includes(secret))) return uncertain('PROVIDER_MALFORMED');
          return {state:'sent',code:'PROVIDER_ACCEPTED',messageId:body.message_id,dispatched:true,retrySafe:false};
        })(),
        new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(uncertain('PROVIDER_TIMEOUT'));},timeoutMs);}),
      ]);
    } catch {return uncertain('PROVIDER_NETWORK');}
    finally {clearTimeout(timer);controller.abort();}
  }};
}
