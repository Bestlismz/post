import { assertResultBoundToCommand, verifyCommand, verifyResult } from './contracts.mjs';
import { readBounded, transportHeaders } from './transport.mjs';

export function createGroupWorkerClient({baseUrl,keys,keyId,key,fetchImpl=fetch,timeoutMs=30000}) {
  const url=new URL(baseUrl);
  if(url.protocol!=='http:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['group-worker','localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Worker requires a configured internal URL');
  const endpoint=new URL('/commands',url).href;
  async function request(envelope,commandKind,resultKind) {
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const command=verifyCommand(envelope,{keys}); if(command.kind!==commandKind) throw new Error();
      const body=JSON.stringify(command);
      const response=await fetchImpl(endpoint,{method:'POST',body,headers:transportHeaders(body,{key,keyId}),signal:controller.signal,redirect:'error'});
      if(!response.ok||!response.body) throw new Error();
      const result=verifyResult((await readBounded(response.body)).toString('utf8'),{keys});
      if(result.kind!==resultKind) throw new Error();assertResultBoundToCommand(result,command);
      return result;
    } catch { throw new Error('Worker request failed'); } finally { clearTimeout(timer); }
  }
  return {scan:envelope=>request(envelope,'ScanCommand','ScanResult'),reply:envelope=>request(envelope,'GroupReplyCommand','GroupReplyResult'),edit:envelope=>request(envelope,'GroupEditCommand','GroupEditResult'),reconcile:envelope=>request(envelope,'ReconcileCommand','ReconcileResult')};
}
