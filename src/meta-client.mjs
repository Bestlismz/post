import {randomUUID} from 'node:crypto';
import {createMetaSendClient} from './channels/meta/client.mjs';

// Compatibility boundary for the legacy JSON-backed worker.
export function createMetaClient({pageAccessToken,pageId='me',...options}={}) {
  const client=createMetaSendClient(options);
  return {async sendText({recipientId,text,metadata}) {
    const result=await client.sendText({pageId,recipientId,text,token:pageAccessToken,attemptId:metadata??randomUUID()});
    return {...result,state:result.state==='failed'?'rejected':result.state,detail:result.code};
  }};
}
