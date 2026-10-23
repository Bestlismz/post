import {createHash,randomUUID} from 'node:crypto';
import {httpError} from '../auth/authorize.mjs';
import {appendAudit,withTransaction} from '../db/transaction.mjs';
import {signCommand} from '../channels/groups/contracts.mjs';

const digest=value=>createHash('sha256').update(value,'utf8').digest('hex');

export function createGroupCommentEditService({pool,client,signingKey,keyId,clock=()=>new Date()}) {
  return {async edit({organizationId,actorId,deliveryIntentId,text,idempotencyKey,expectedRevision}) {
    const {rows:[existing]}=await pool.query('SELECT * FROM group_comment_edits WHERE organization_id=$1 AND idempotency_key=$2',[organizationId,idempotencyKey]);
    if(existing)return {id:existing.id,state:existing.state,text:existing.text,providerMessageId:existing.provider_message_id};
    const {rows:[row]}=await pool.query(`SELECT di.id,di.group_source_id,a.state,a.provider_message_id,s.group_id,s.canonical_url,o.post_id,w.processing_revision
      FROM delivery_intents di
      JOIN delivery_attempts a ON a.organization_id=di.organization_id AND a.delivery_intent_id=di.id
      JOIN group_sources s ON s.organization_id=di.organization_id AND s.id=di.group_source_id
      JOIN reply_versions rv ON rv.organization_id=di.organization_id AND rv.id=di.reply_version_id
      JOIN work_items w ON w.organization_id=rv.organization_id AND w.id=rv.work_item_id
      JOIN messages m ON m.organization_id=w.organization_id AND m.id=w.message_id
      JOIN group_observations o ON o.organization_id=m.organization_id AND o.id=m.raw_evidence->>'observationId'
      WHERE di.organization_id=$1 AND di.id=$2`,[organizationId,deliveryIntentId]);
    if(!row)throw httpError(404,'Delivery not found');
    if(row.processing_revision!==expectedRevision)throw httpError(409,'Conversation revision superseded');
    if(row.state!=='sent'||!row.provider_message_id)throw httpError(409,'Only a verified Facebook comment can be edited');
    const operationId=randomUUID(),editId=randomUUID(),now=clock(),targetId=`comment:${row.post_id}:${row.provider_message_id}`;
    const command=signCommand({version:1,kind:'GroupEditCommand',operationId,sourceId:row.group_source_id,groupId:row.group_id,canonicalTarget:row.canonical_url,targetId,text,textHash:digest(text),issuedAt:now.toISOString(),expiresAt:new Date(+now+300000).toISOString(),keyId},{key:signingKey,keyId,now});
    try {
      await withTransaction(pool,async tx=>{
        await tx.query('INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES($1,$2,$3,$4,$5)',[operationId,organizationId,row.group_source_id,'GroupEditCommand',JSON.stringify(command)]);
        await tx.query(`INSERT INTO group_comment_edits(id,organization_id,delivery_intent_id,operation_id,idempotency_key,text,state,provider_message_id)
          VALUES($1,$2,$3,$4,$5,$6,'attempting',$7)`,[editId,organizationId,deliveryIntentId,operationId,idempotencyKey,text,row.provider_message_id]);
        await appendAudit(tx,{organizationId,actorId,action:'group.comment_edit_attempting',entityType:'delivery_intent',entityId:deliveryIntentId,details:{editId,operationId,providerMessageId:row.provider_message_id}});
      });
    } catch(error) {
      if(error.code==='23505') {
        const replay=(await pool.query('SELECT * FROM group_comment_edits WHERE organization_id=$1 AND idempotency_key=$2',[organizationId,idempotencyKey])).rows[0];
        if(replay)return {id:replay.id,state:replay.state,text:replay.text,providerMessageId:replay.provider_message_id};
      }
      throw error;
    }
    let result;
    try {result=await client.edit(command);} catch {result={state:'unknown',remoteId:row.provider_message_id};}
    const state=['sent','failed','unknown'].includes(result.state)?result.state:'unknown';
    const code=state==='sent'?'VISIBLE_VERIFIED':state==='failed'?'EDIT_REJECTED':'POSSIBLE_EDIT';
    await withTransaction(pool,async tx=>{
      await tx.query(`UPDATE group_comment_edits SET state=$3,outcome_code=$4,finished_at=now()
        WHERE organization_id=$1 AND id=$2 AND state='attempting'`,[organizationId,editId,state,code]);
      await appendAudit(tx,{organizationId,actorId,action:`group.comment_edit_${state}`,entityType:'delivery_intent',entityId:deliveryIntentId,details:{editId,operationId,providerMessageId:row.provider_message_id,code}});
    });
    return {id:editId,state,text,providerMessageId:row.provider_message_id};
  }};
}
