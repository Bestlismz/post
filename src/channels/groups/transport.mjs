import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_ENVELOPE_BYTES=262144;
function signature(raw,key,version,keyId,expiresAt) {
  if(typeof key!=='string'||Buffer.byteLength(key)<32) throw new Error('Invalid transport key');
  return createHmac('sha256',key).update(`${version}\n${keyId}\n${expiresAt}\n`).update(raw).digest('hex');
}
export function transportHeaders(raw,{key,keyId,expiresAt=Date.now()+60000}) {
  return {'content-type':'application/json','x-group-version':'1','x-group-key-id':keyId,'x-group-expires':String(expiresAt),'x-group-signature':signature(raw,key,'1',keyId,String(expiresAt))};
}
export function verifyTransport(raw,headers,{keys,now=Date.now()}) {
  const version=headers['x-group-version'],keyId=headers['x-group-key-id'],expiry=headers['x-group-expires'],actual=headers['x-group-signature'];
  if(raw.length>MAX_ENVELOPE_BYTES||version!=='1'||typeof keyId!=='string'||!Object.hasOwn(keys,keyId)||typeof expiry!=='string'||!/^\d{13}$/.test(expiry)||+expiry<=now||+expiry>now+600000||typeof actual!=='string'||!/^[a-f0-9]{64}$/.test(actual)) throw new Error('Untrusted command');
  if(!timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(signature(raw,keys[keyId],version,keyId,expiry),'hex'))) throw new Error('Untrusted command');
}
export async function readBounded(stream) {
  let size=0; const chunks=[];
  for await(const chunk of stream) { size+=Buffer.byteLength(chunk); if(size>MAX_ENVELOPE_BYTES) { const error=new Error('Envelope too large'); error.status=413; throw error; } chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
