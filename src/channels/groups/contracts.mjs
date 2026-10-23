import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { MAX_GROUP_ID_LENGTH } from './target.mjs';

const id=z.string().min(1).max(200), hash=z.string().regex(/^[a-f0-9]{64}$/), timestamp=z.iso.datetime();
const common={version:z.literal(1),operationId:id,sourceId:id,groupId:z.string().regex(/^[0-9]+$/).max(MAX_GROUP_ID_LENGTH),canonicalTarget:z.string().max(200),issuedAt:timestamp,expiresAt:timestamp,keyId:id};
const scan=z.strictObject({...common,kind:z.literal('ScanCommand')});
const reply=z.strictObject({...common,kind:z.literal('GroupReplyCommand'),targetId:id,text:z.string().min(1).max(10000),textHash:hash});
const edit=z.strictObject({...common,kind:z.literal('GroupEditCommand'),targetId:id,text:z.string().min(1).max(4000),textHash:hash});
const reconcile=z.strictObject({...common,kind:z.literal('ReconcileCommand'),attemptOperationId:id,targetId:id,textHash:hash,senderId:id.nullable(),attemptStartedAt:timestamp,attemptFinishedAt:timestamp});
export const ScanCommand=scan, GroupReplyCommand=reply, GroupEditCommand=edit, ReconcileCommand=reconcile;
export const commandSchema=z.discriminatedUnion('kind',[scan,reply,edit,reconcile]);
const evidence={targetId:id,senderId:id,textHash:hash,attemptStartedAt:timestamp,attemptFinishedAt:timestamp,evidenceHash:hash,remoteId:id.nullable()};
const resultUnion=z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.literal('ScanResult'),selectorVersion:id,coverage:z.enum(['complete','partial','none']),health:z.enum(['healthy','auth_required','checkpoint','expired','quarantined','selector_failure','failed']),reason:z.enum(['selector_changed','identity_missing','identity_ambiguous','scan_limit','page_changed','session_unavailable','session_lost','scan_failed','scan_timeout','scan_cancelled']).nullable().optional(),groupName:z.string().min(1).max(300).nullable().optional(),accessLevel:z.enum(['unknown','reader','admin']).optional(),cursor:id.nullable().optional(),observations:z.array(z.strictObject({targetId:id,text:z.string().max(20000),observedAt:timestamp,evidenceHash:hash,kind:z.enum(['post','comment']).optional(),postId:z.string().regex(/^\d+$/).max(MAX_GROUP_ID_LENGTH).optional(),commentId:z.string().regex(/^\d+$/).max(MAX_GROUP_ID_LENGTH).nullable().optional(),authorLabel:z.string().max(300).optional(),providerTimestamp:timestamp.nullable().optional(),reactionCount:z.number().int().nonnegative().max(1000000000).nullable().optional(),commentCount:z.number().int().nonnegative().max(1000000000).nullable().optional()})).max(1000)}),
  z.strictObject({...common,...evidence,kind:z.literal('GroupReplyResult'),state:z.enum(['sent','failed','unknown'])}),
  z.strictObject({...common,...evidence,kind:z.literal('GroupEditResult'),state:z.enum(['sent','failed','unknown'])}),
  z.strictObject({...common,...evidence,attemptOperationId:id,kind:z.literal('ReconcileResult'),state:z.enum(['sent','not_found','unknown'])}),
]);
export const resultSchema=resultUnion.superRefine((value,context)=>{
  if(value.kind==='ScanResult')return;
  const needsRemote=value.state==='sent';
  if(needsRemote?!value.remoteId:value.remoteId!==null)context.addIssue({code:'custom',message:'Remote evidence does not match delivery state'});
});
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
  if(['GroupReplyCommand','GroupEditCommand'].includes(parsed.kind) && createHash('sha256').update(parsed.text,'utf8').digest('hex')!==parsed.textHash) throw new Error('Reply text hash mismatch');
  if(parsed.attemptStartedAt && (Date.parse(parsed.attemptFinishedAt)<Date.parse(parsed.attemptStartedAt)||Date.parse(parsed.attemptFinishedAt)>time+30000)) throw new Error('Invalid attempt time');
  if(parsed.kind==='ScanResult' && parsed.observations.some(item=>Date.parse(item.observedAt)>time+30000)) throw new Error('Invalid observation time');
  return parsed;
}
function signingKey(key) {
  if((typeof key!=='string'&&!Buffer.isBuffer(key))||Buffer.byteLength(key)!==32) throw new Error('Signing key must have exactly 32 bytes');
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
export function assertResultBoundToCommand(resultValue,commandValue) {
  const {signature:_resultSignature,...result}=resultValue,{signature:_commandSignature,...command}=commandValue;
  const expected=command.kind==='ScanCommand'?'ScanResult':command.kind==='GroupReplyCommand'?'GroupReplyResult':command.kind==='GroupEditCommand'?'GroupEditResult':'ReconcileResult';
  if(result.kind!==expected||['operationId','sourceId','groupId','canonicalTarget'].some(field=>result[field]!==command[field]))throw new Error('Result command binding mismatch');
  if(command.kind!=='ScanCommand'&&['targetId','textHash'].some(field=>result[field]!==command[field]))throw new Error('Result evidence binding mismatch');
  if(command.kind==='GroupReplyCommand'||command.kind==='GroupEditCommand') {
    if(Date.parse(result.attemptStartedAt)<Date.parse(command.issuedAt)-30000||Date.parse(result.attemptFinishedAt)>Date.parse(command.expiresAt)+30000)throw new Error('Result attempt binding mismatch');
  }
  if(command.kind==='ReconcileCommand') {
    if(result.attemptOperationId!==command.attemptOperationId||command.senderId!==null&&result.senderId!==command.senderId||Date.parse(result.attemptStartedAt)<Date.parse(command.attemptStartedAt)||Date.parse(result.attemptFinishedAt)>Date.parse(command.attemptFinishedAt))throw new Error('Reconciliation evidence binding mismatch');
  }
  return true;
}
