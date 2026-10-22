import {readBounded,transportHeaders} from './transport.mjs';

export function createGroupRecoveryClient({baseUrl,keyId,key,fetchImpl=fetch,timeoutMs=5000}) {
  const url=new URL(baseUrl);
  if(url.protocol!=='http:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['group-worker','localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Recovery requires a configured internal URL');
  async function request(action,input) {
    const body=JSON.stringify(input),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(new URL(`/recovery/${action}`,url),{method:'POST',body,headers:transportHeaders(body,{key,keyId}),signal:controller.signal,redirect:'error'});
      if(!response.ok||!response.body)throw new Error();
      const result=JSON.parse((await readBounded(response.body)).toString('utf8'));
      if(result?.state!=='available'&&!(result?.state==='recovery'&&typeof result.sourceId==='string'&&Number.isFinite(Date.parse(result.expiresAt))))throw new Error();
      return result;
    } catch {throw new Error('Recovery request failed');} finally {clearTimeout(timer);}
  }
  return {start:input=>request('start',input),stop:input=>request('stop',input)};
}
