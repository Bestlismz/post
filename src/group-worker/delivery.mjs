import {createHash} from 'node:crypto';
import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {canonicalSerialize, commandSchema} from '../channels/groups/contracts.mjs';

const digest=value=>createHash('sha256').update(value,'utf8').digest('hex');
const plainCommand=value=>{const {signature,...body}=value;return commandSchema.parse(body);};
const pathFor=(root,id)=>join(root,`${digest(id)}.json`);

async function durableCreate(path,value) {
  const file=await open(path,'wx',0o600);
  try {await file.writeFile(JSON.stringify(value));await file.sync();} finally {await file.close();}
}
async function durableReplace(path,value) {
  const temporary=`${path}.${process.pid}.${Date.now()}.tmp`,file=await open(temporary,'wx',0o600);
  try {await file.writeFile(JSON.stringify(value));await file.sync();} finally {await file.close();}
  await rename(temporary,path);
}
async function readRecord(path) {try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function syncDirectory(path) {const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}}
function common(command,now) {
  return {version:1,operationId:command.operationId,sourceId:command.sourceId,groupId:command.groupId,canonicalTarget:command.canonicalTarget,
    targetId:command.targetId,textHash:command.textHash,issuedAt:now.toISOString(),expiresAt:new Date(+now+60000).toISOString(),keyId:command.keyId};
}
function resultEvidence(command,{state,senderId,started,finished,remoteId=null,code}) {
  const body={...common(command,finished),kind:'GroupReplyResult',state,senderId,textHash:command.textHash,
    attemptStartedAt:started.toISOString(),attemptFinishedAt:finished.toISOString(),remoteId};
  body.evidenceHash=digest(canonicalSerialize([body.canonicalTarget,body.targetId,body.senderId,body.textHash,body.attemptStartedAt,body.attemptFinishedAt,body.remoteId,body.state]));
  return {...body,code};
}

export function createGroupDeliveryBoundary({ledgerPath,driver,clock=()=>new Date()}) {
  if(typeof ledgerPath!=='string'||!ledgerPath||!driver)throw new Error('Durable delivery ledger and driver required');
  async function reserve(command) {
    await mkdir(ledgerPath,{recursive:true,mode:0o700});
    const path=pathFor(ledgerPath,command.operationId),commandHash=digest(canonicalSerialize(command));
    try {await durableCreate(path,{commandHash,state:'attempting'});await syncDirectory(ledgerPath);return {path,commandHash,existing:null};}
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      const existing=await readRecord(path);
      if(!existing||existing.commandHash!==commandHash)throw new Error('Operation identity conflict');
      return {path,commandHash,existing};
    }
  }
  async function deliver(input) {
    const command=plainCommand(input);if(command.kind!=='GroupReplyCommand')throw new Error('Group reply command required');
    const reservation=await reserve(command);
    if(reservation.existing) {
      if(reservation.existing.result)return reservation.existing.result;
      const now=clock(),result=resultEvidence(command,{state:'unknown',senderId:reservation.existing.senderId??'unknown',started:new Date(reservation.existing.attemptStartedAt??now),finished:new Date(reservation.existing.attemptFinishedAt??now),code:'ATTEMPT_INTERRUPTED'});
      await durableReplace(reservation.path,{...reservation.existing,state:'unknown',phase:'terminal',attemptFinishedAt:result.attemptFinishedAt,result});await syncDirectory(ledgerPath);return result;
    }
    const started=clock();let senderId='unknown';
    const finish=async result=>{await durableReplace(reservation.path,{commandHash:reservation.commandHash,state:result.state,phase:'terminal',senderId,attemptStartedAt:result.attemptStartedAt,attemptFinishedAt:result.attemptFinishedAt,result});await syncDirectory(ledgerPath);return result;};
    try {
      const target=await driver.locateExactTarget(command);
      if(target?.canonicalTarget!==command.canonicalTarget||target?.targetId!==command.targetId) return finish(resultEvidence(command,{state:'failed',senderId,started,finished:clock(),code:'TARGET_MISMATCH'}));
      senderId=await driver.identifySender(command);
      if(typeof senderId!=='string'||!senderId||senderId.length>200) return finish(resultEvidence(command,{state:'failed',senderId:'unknown',started,finished:clock(),code:'SENDER_UNAVAILABLE'}));
      const possible={commandHash:reservation.commandHash,state:'attempting',phase:'possible_send',senderId,attemptStartedAt:started.toISOString(),attemptDeadlineAt:command.expiresAt};
      await durableReplace(reservation.path,possible);await syncDirectory(ledgerPath);
      const sent=await driver.sendExact(target,command.text);
      if(sent?.state==='sent'&&sent.visible===true&&typeof sent.remoteId==='string'&&sent.remoteId) return finish(resultEvidence(command,{state:'sent',senderId,started,finished:clock(),remoteId:sent.remoteId,code:'VISIBLE_VERIFIED'}));
      if(sent?.state==='failed'&&sent.possibleClick!==true) return finish(resultEvidence(command,{state:'failed',senderId,started,finished:clock(),code:'SEND_REJECTED'}));
      return finish(resultEvidence(command,{state:'unknown',senderId,started,finished:clock(),code:'POSSIBLE_SEND'}));
    } catch(error) {
      if(error?.abrupt)throw error;
      return finish(resultEvidence(command,{state:error?.possibleClick?'unknown':'failed',senderId,started,finished:clock(),code:error?.possibleClick?'POSSIBLE_SEND':'SEND_REJECTED'}));
    }
  }
  async function reconcile(input) {
    const command=plainCommand(input);if(command.kind!=='ReconcileCommand')throw new Error('Reconcile command required');
    const attempt=await readRecord(pathFor(ledgerPath,command.attemptOperationId));
    const senderId=attempt?.senderId??command.senderId??await driver.identifySender?.(command);
    if(typeof senderId!=='string'||!senderId)throw new Error('Attempt sender unavailable');
    const attemptStartedAt=attempt?.attemptStartedAt??command.attemptStartedAt,attemptFinishedAt=attempt?.attemptFinishedAt??command.attemptFinishedAt;
    const candidates=await driver.findReplyEvidence(command);
    const start=Date.parse(attemptStartedAt),finish=Date.parse(attemptFinishedAt);
    const match=Array.isArray(candidates)&&candidates.find(item=>item?.canonicalTarget===command.canonicalTarget&&item?.targetId===command.targetId&&item?.senderId===senderId&&
      typeof item.text==='string'&&digest(item.text)===command.textHash&&Number.isFinite(Date.parse(item.observedAt))&&Date.parse(item.observedAt)>=start&&Date.parse(item.observedAt)<=finish);
    const now=clock(),state=match?'sent':'not_found',remoteId=match?.remoteId??null;
    const body={...common(command,now),kind:'ReconcileResult',attemptOperationId:command.attemptOperationId,state,senderId,attemptStartedAt,attemptFinishedAt,remoteId};
    body.evidenceHash=digest(canonicalSerialize([body.canonicalTarget,body.targetId,body.senderId,body.textHash,body.attemptStartedAt,body.attemptFinishedAt,body.remoteId,body.state]));
    return body;
  }
  return {deliver,reconcile};
}
