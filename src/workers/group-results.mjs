import { createHash, randomUUID } from 'node:crypto';
import { appendAudit, withTransaction } from '../db/transaction.mjs';
import { enqueueJob } from '../jobs/queue.mjs';
import { canonicalSerialize, signCommand, verifyCommand, verifyResult } from '../channels/groups/contracts.mjs';
import { insertGroupOperation } from '../sources/repository.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
function conflict(message) {return Object.assign(new Error(message),{status:409});}
function clean(value,max) {
  return String(value??'').toWellFormed().normalize('NFC').replace(/<[^>]*>/g,'').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u034f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').trim().slice(0,max).toWellFormed();
}
function normalizeObservation(item) {
  const match=/^(post|comment):([0-9]{1,100})(?::([0-9]{1,100}))?$/.exec(item.targetId);
  if(!match||!item.postId||item.postId!==match[2]||item.kind!==match[1]||
    (item.kind==='comment'?(!match[3]||item.commentId!==match[3]):(match[3]||item.commentId))) throw new Error('Invalid observation identity');
  const text=clean(item.text,20000),authorLabel=clean(item.authorLabel,300);
  if(!text) throw new Error('Empty observation text');
  return {...item,text,authorLabel,contentHash:hash(canonicalSerialize([text,authorLabel,item.providerTimestamp??null]))};
}

export function createGroupResultService(pool,{keys,signingKey,keyId,clock=()=>new Date(),supportedSelectorVersions=[]}={}) {
  async function acceptScanResult(envelope) {
    // Route exclusively through the immutable operation. Untrusted tenant/source fields are never used in queries.
    const raw=typeof envelope==='string'?JSON.parse(envelope):envelope;
    if(!raw||typeof raw.operationId!=='string'||raw.operationId.length>200) throw new Error('Invalid result operation');
    const outcome=await withTransaction(pool,async tx=>{
      const {rows:[operation]}=await tx.query('SELECT * FROM group_operations WHERE id=$1',[raw.operationId]);
      if(!operation) throw new Error('Unknown result operation');
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[operation.organization_id]);
      const {rows:[source]}=await tx.query('SELECT * FROM group_sources WHERE organization_id=$1 AND id=$2 FOR UPDATE',[operation.organization_id,operation.source_id]);
      const {rows:[existing]}=await tx.query('SELECT * FROM group_scan_receipts WHERE operation_id=$1',[operation.id]);
      // Commands are immutable historical authorization. Verify at their issuance; require unexpired command and result on first acceptance.
      const command=verifyCommand(operation.command,{keys,now:existing?new Date(operation.command.issuedAt):clock()});
      const result=verifyResult(envelope,{keys,now:existing?new Date(raw.issuedAt):clock()});
      if(operation.kind!=='ScanCommand'||command.kind!=='ScanCommand'||result.kind!=='ScanResult'||command.operationId!==operation.id||command.sourceId!==source.id||command.groupId!==source.group_id||command.canonicalTarget!==source.canonical_url||
        ['operationId','sourceId','groupId','canonicalTarget'].some(field=>result[field]!==command[field])||Date.parse(result.issuedAt)<Date.parse(command.issuedAt)||Date.parse(result.issuedAt)>Date.parse(command.expiresAt)) throw new Error('Result command binding mismatch');
      const digest=hash(canonicalSerialize(result));
      if(existing) {
        if(existing.digest===digest) return {response:existing.response};
        await appendAudit(tx,{organizationId:operation.organization_id,action:'group.result_conflict',entityType:'group_operation',entityId:operation.id,details:{acceptedDigest:existing.digest,conflictingDigest:digest}});
        return {error:conflict('Conflicting result for immutable operation')};
      }
      const observations=result.observations.map(normalizeObservation);
      if(new Set(observations.map(item=>item.targetId)).size!==observations.length) throw new Error('Duplicate observation identity');
      const response={receiptId:randomUUID(),operationId:operation.id,acceptedCount:observations.length,coverage:result.coverage};
      await tx.query(`INSERT INTO group_scan_receipts(operation_id,organization_id,source_id,digest,selector_version,coverage,health,reason,cursor,response)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[operation.id,operation.organization_id,source.id,digest,result.selectorVersion,result.coverage,result.health,result.reason??null,result.cursor??null,JSON.stringify(response)]);
      for(const item of observations) await persistObservation(tx,operation,source,result,item);
      if(BigInt(operation.operation_order)>BigInt(source.last_result_order)) {
        const sessionBlocked=['auth_required','checkpoint','expired','quarantined'].includes(result.health)||['session_unavailable','session_lost'].includes(result.reason);
        const genuineSelector=result.health==='selector_failure'&&['selector_changed','identity_missing','identity_ambiguous'].includes(result.reason);
        const healthy=result.health==='healthy'&&supportedSelectorVersions.includes(result.selectorVersion);
        const canRecover=healthy&&operation.recovery;
        const failures=healthy?0:genuineSelector?source.selector_failures+1:source.selector_failures;
        const sessionCircuit=(source.session_circuit||sessionBlocked)&&!canRecover;
        const selectorCircuit=(source.selector_circuit||failures>=3)&&!canRecover;
        await tx.query(`UPDATE group_sources SET session_health=$2,selector_health=$3,selector_version=$4,
          session_circuit=$5,selector_circuit=$6,selector_failures=$7,last_result_order=$8,updated_at=now() WHERE id=$1`,
        [source.id,sessionCircuit?'auth_required':result.health==='healthy'?'healthy':'failed',selectorCircuit?'failed':healthy?'healthy':'failed',result.selectorVersion,sessionCircuit,selectorCircuit,failures,operation.operation_order]);
        const retryable=(genuineSelector||result.health==='failed'&&['scan_failed','scan_timeout'].includes(result.reason))&&!sessionCircuit&&!selectorCircuit;
        const {rows:[org]}=await tx.query('SELECT group_automation_paused FROM organizations WHERE id=$1',[operation.organization_id]);
        if(retryable&&operation.retry_attempt<2&&!source.kill_switch&&!source.archived&&!org.group_automation_paused&&signingKey&&keyId) {
          const retryAttempt=operation.retry_attempt+1,retryRootId=operation.retry_root_id??operation.id;
          const availableAt=new Date(+clock()+5000*2**operation.retry_attempt);
          const retry=signCommand({version:1,kind:'ScanCommand',operationId:randomUUID(),sourceId:source.id,groupId:source.group_id,canonicalTarget:source.canonical_url,issuedAt:clock().toISOString(),expiresAt:new Date(+availableAt+300000).toISOString(),keyId},{key:signingKey,keyId,now:clock()});
          await insertGroupOperation(tx,operation.organization_id,retry,{retryRootId,retryAttempt,recovery:operation.recovery});
          await enqueueJob(tx,{organizationId:operation.organization_id,kind:'group.scan',retrySafe:true,availableAt:availableAt.toISOString(),payload:{operationId:retry.operationId,sourceId:source.id,retryRootId,retryAttempt}});
        }
      }
      await appendAudit(tx,{organizationId:operation.organization_id,action:'group.scan_received',entityType:'group_operation',entityId:operation.id,details:{receiptId:response.receiptId,digest,coverage:result.coverage,count:observations.length}});
      return {response};
    });
    if(outcome.error) throw outcome.error;
    return outcome.response;
  }
  return {acceptScanResult};
}

async function persistObservation(tx,operation,source,result,item) {
  const organizationId=operation.organization_id,observationId=randomUUID();
  await tx.query(`INSERT INTO group_observations(id,organization_id,source_id,operation_id,target_id,post_id,comment_id,kind,text,author_label,observed_at,provider_timestamp,evidence_hash,content_hash,selector_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[observationId,organizationId,source.id,operation.id,item.targetId,item.postId,item.commentId??null,item.kind,item.text,item.authorLabel,item.observedAt,item.providerTimestamp??null,item.evidenceHash,item.contentHash,result.selectorVersion]);
  await tx.query(`INSERT INTO group_targets(organization_id,source_id,target_id,observation_id,operation_order) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(organization_id,source_id,target_id) DO UPDATE SET observation_id=EXCLUDED.observation_id,operation_order=EXCLUDED.operation_order
    WHERE group_targets.operation_order<EXCLUDED.operation_order`,[organizationId,source.id,item.targetId,observationId,operation.operation_order]);
  await tx.query(`INSERT INTO conversations(id,organization_id,channel,page_id,psid) VALUES($1,$2,'facebook_group',$3,$4)
    ON CONFLICT(organization_id,page_id,psid) DO NOTHING`,[randomUUID(),organizationId,source.group_id,item.postId]);
  const {rows:[conversation]}=await tx.query('SELECT * FROM conversations WHERE organization_id=$1 AND page_id=$2 AND psid=$3 FOR UPDATE',[organizationId,source.group_id,item.postId]);
  if(conversation.channel!=='facebook_group') throw conflict('Conversation channel binding conflict');
  const revision=conversation.processing_revision+1,messageId=randomUUID();
  const inserted=await tx.query(`INSERT INTO messages(id,organization_id,conversation_id,page_id,mid,text,provider_timestamp_ms,processing_revision,raw_evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(organization_id,page_id,mid) DO NOTHING RETURNING id`,[messageId,organizationId,conversation.id,source.group_id,item.targetId,item.text,item.providerTimestamp?Date.parse(item.providerTimestamp):null,revision,JSON.stringify({observationId,evidenceHash:item.evidenceHash,contentHash:item.contentHash,selectorVersion:result.selectorVersion})]);
  if(!inserted.rowCount) return;
  await tx.query('UPDATE conversations SET processing_revision=$2,updated_at=now() WHERE id=$1',[conversation.id,revision]);
  const workItemId=randomUUID();
  await tx.query('INSERT INTO work_items(id,organization_id,conversation_id,message_id,processing_revision) VALUES($1,$2,$3,$4,$5)',[workItemId,organizationId,conversation.id,messageId,revision]);
  await enqueueJob(tx,{organizationId,kind:'analyze_group_work_item',retrySafe:true,payload:{workItemId,conversationId:conversation.id,messageId,processingRevision:revision}});
}
