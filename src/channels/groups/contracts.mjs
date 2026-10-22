import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const id=z.string().min(1).max(200), hash=z.string().regex(/^[a-f0-9]{64}$/), timestamp=z.iso.datetime();
const common={version:z.literal(1),operationId:id,sourceId:id,groupId:z.string().regex(/^[0-9]+$/).max(100),canonicalTarget:z.string().max(200),issuedAt:timestamp,expiresAt:timestamp,keyId:id};
const scan=z.strictObject({...common,kind:z.literal('ScanCommand')});
const reply=z.strictObject({...common,kind:z.literal('GroupReplyCommand'),targetId:id,text:z.string().min(1).max(10000),textHash:hash});
const reconcile=z.strictObject({...common,kind:z.literal('ReconcileCommand'),targetId:id,textHash:hash,senderId:id,attemptStartedAt:timestamp,attemptFinishedAt:timestamp});
export const ScanCommand=scan, GroupReplyCommand=reply, ReconcileCommand=reconcile;
export const commandSchema=z.discriminatedUnion('kind',[scan,reply,reconcile]);
const evidence={targetId:id,senderId:id,textHash:hash,attemptStartedAt:timestamp,attemptFinishedAt:timestamp,evidenceHash:hash,remoteId:id.nullable()};
export const resultSchema=z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.literal('ScanResult'),selectorVersion:id,coverage:z.enum(['complete','partial','none']),health:z.enum(['healthy','auth_required','selector_failure','failed']),observations:z.array(z.strictObject({targetId:id,text:z.string().max(20000),observedAt:timestamp,evidenceHash:hash})).max(1000)}),
  z.strictObject({...common,...evidence,kind:z.literal('GroupReplyResult'),state:z.enum(['sent','failed','unknown'])}),
  z.strictObject({...common,...evidence,kind:z.literal('ReconcileResult'),state:z.enum(['sent','not_found','unknown'])}),
]);
export function canonicalSerialize(value) {
  if(Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`;
  if(value!==null && typeof value==='object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalSerialize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const maxBytes=262144;
function bounded(value) {
  const raw=typeof value==='string'?value:JSON.stringify(value);
  if(typeof raw!=='string'||Buffer.byteLength(raw)>maxBytes) throw new Error('Envelope size exceeds limit');
  return JSON.parse(raw);
}
function validate(value,schema,now) {
  const parsed=schema.parse(value);
  if(parsed.canonicalTarget!==`https://www.facebook.com/groups/${parsed.groupId}`) throw new Error('Invalid canonical target');
  const issued=Date.parse(parsed.issuedAt),expiry=Date.parse(parsed.expiresAt),time=+now;
  if(!Number.isFinite(time)||issued>time+30000||expiry<=issued||expiry-issued>600000) throw new Error('Invalid envelope time or lifetime');
  if(expiry<=time) throw new Error('Envelope expired');
  if(parsed.kind==='GroupReplyCommand' && createHash('sha256').update(parsed.text,'utf8').digest('hex')!==parsed.textHash) throw new Error('Reply text hash mismatch');
  if(parsed.attemptStartedAt && (Date.parse(parsed.attemptFinishedAt)<Date.parse(parsed.attemptStartedAt)||Date.parse(parsed.attemptFinishedAt)>time+30000)) throw new Error('Invalid attempt time');
  if(parsed.kind==='ScanResult' && parsed.observations.some(item=>Date.parse(item.observedAt)>time+30000)) throw new Error('Invalid observation time');
  return parsed;
}
function signingKey(key) {
  if((typeof key!=='string'&&!Buffer.isBuffer(key))||Buffer.byteLength(key)<32) throw new Error('Signing key must have at least 32 bytes');
  return key;
}
function sign(value,schema,{key,keyId,now=new Date()}) {
  const parsed=validate(bounded(value),schema,now);
  if(parsed.keyId!==keyId) throw new Error('Signing key ID mismatch');
  const signature=createHmac('sha256',signingKey(key)).update(canonicalSerialize(parsed)).digest('hex');
  const result={...parsed,signature}; bounded(result); return result;
}
function verify(value,schema,{keys,now=new Date()}) {
  const envelope=bounded(value);
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)) throw new Error('Invalid envelope');
  const {signature,...body}=envelope;
  if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid signature');
  if(!Object.hasOwn(keys??{},body.keyId)) throw new Error('Unknown signing key');
  const expected=createHmac('sha256',signingKey(keys[body.keyId])).update(canonicalSerialize(body)).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex'))) throw new Error('Invalid signature');
  return {...validate(body,schema,now),signature};
}
export const signCommand=(value,options)=>sign(value,commandSchema,options);
export const verifyCommand=(value,options)=>verify(value,commandSchema,options);
export const signResult=(value,options)=>sign(value,resultSchema,options);
export const verifyResult=(value,options)=>verify(value,resultSchema,options);
