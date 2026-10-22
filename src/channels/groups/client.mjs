import { verifyCommand, verifyResult } from './contracts.mjs';
import { readBounded, transportHeaders } from './transport.mjs';

export function createGroupWorkerClient({baseUrl,keys,keyId,key,fetchImpl=fetch,timeoutMs=30000}) {
  const url=new URL(baseUrl);
  if(url.protocol!=='http:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['group-worker','localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Worker requires a configured internal URL');
  const endpoint=new URL('/commands',url).href;
  return {async scan(envelope) {
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const command=verifyCommand(envelope,{keys}); if(command.kind!=='ScanCommand') throw new Error();
      const body=JSON.stringify(command);
      const response=await fetchImpl(endpoint,{method:'POST',body,headers:transportHeaders(body,{key,keyId}),signal:controller.signal,redirect:'error'});
      if(!response.ok||!response.body) throw new Error();
      const result=verifyResult((await readBounded(response.body)).toString('utf8'),{keys});
      for(const field of ['operationId','sourceId','groupId','canonicalTarget']) if(result[field]!==command[field]) throw new Error();
      if(result.kind!=='ScanResult') throw new Error();
      return result;
    } catch { throw new Error('Worker request failed'); } finally { clearTimeout(timer); }
  }};
}
