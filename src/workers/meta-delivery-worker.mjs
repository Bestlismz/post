import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {withTransaction,appendAudit} from '../db/transaction.mjs';
import {loadContext,assertReplyFresh} from '../inbox/service.mjs';
import {freshnessConflictCodes,terminalPreparationCodes} from '../inbox/errors.mjs';
import {evaluatePolicy} from '../policy/evaluator.mjs';
import {validateReply} from '../replies/validator.mjs';
import {validMetaSend,createMetaSendClient} from '../channels/meta/client.mjs';
import {authorizeInboxActor} from '../inbox/repository.mjs';

const outcome=row=>({state:row.state==='attempting'?'unknown':row.state,attemptId:row.id,code:row.outcome_code??'ATTEMPT_UNRESOLVED',retrySafe:false});
const reject=code=>{throw Object.assign(new Error(code),{code});};
const finalGateCodes=new Set(['INVALID_AUTHORIZATION','DELIVERY_STATE_CHANGED','OPT_OUT','REPLY_SUPERSEDED','CREDENTIAL_CHANGED','FINAL_POLICY_GATE','LOCAL_INVALID_REQUEST']);

export function createMetaDeliveryWorker({pool,credentials,client=createMetaSendClient(),clock=()=>new Date()}) {
  async function lockIntent(tx,intent) {
    await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[intent.organization_id]);
    await tx.query('SELECT id FROM delivery_intents WHERE organization_id=$1 AND id=$2 FOR UPDATE',[intent.organization_id,intent.id]);
  }
  async function existing(tx,intent) {
    const attempt=(await tx.query('SELECT * FROM delivery_attempts WHERE organization_id=$1 AND delivery_intent_id=$2 FOR UPDATE',[intent.organization_id,intent.id])).rows[0];
    if(attempt) return outcome(attempt);
    const cancellation=(await tx.query('SELECT reason FROM delivery_cancellations WHERE organization_id=$1 AND delivery_intent_id=$2',[intent.organization_id,intent.id])).rows[0];
    return cancellation?{state:'cancelled',code:'DELIVERY_CANCELLED',retrySafe:false}:null;
  }
  async function finishJobs(tx,intent,status,code) {
    await tx.query("UPDATE jobs SET status=$3,last_error=$4,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND kind='deliver_reply' AND payload->>'deliveryIntentId'=$2",[intent.organization_id,intent.id,status,code]);
  }
  async function cancel(tx,intent,code) {
    await tx.query('INSERT INTO delivery_cancellations(organization_id,delivery_intent_id,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[intent.organization_id,intent.id,code]);
    await finishJobs(tx,intent,'completed',code);
    await appendAudit(tx,{organizationId:intent.organization_id,action:'delivery.cancelled',entityType:'delivery_intent',entityId:intent.id,details:{code}});
    return {state:'cancelled',code,retrySafe:false};
  }
  async function settle(intent,attemptId,result) {
    return withTransaction(pool,async tx=>{
      await lockIntent(tx,intent);
      const current=(await tx.query('SELECT * FROM delivery_attempts WHERE organization_id=$1 AND delivery_intent_id=$2 FOR UPDATE',[intent.organization_id,intent.id])).rows[0];
      if(current.id!==attemptId || !['attempting','unknown'].includes(current.state)) return outcome(current);
      const messageId=result.state==='sent'?result.messageId:null;
      const {rows:[saved]}=await tx.query('UPDATE delivery_attempts SET state=$2,outcome_code=$3,provider_message_id=$4,finished_at=now() WHERE id=$1 RETURNING *',[attemptId,result.state,result.code,messageId]);
      await finishJobs(tx,intent,result.state==='sent'?'completed':'failed',result.code);
      if(result.state==='sent') await tx.query("UPDATE work_items SET status='completed',updated_at=now() WHERE organization_id=$1 AND id=(SELECT work_item_id FROM reply_authorizations WHERE organization_id=$1 AND id=$2) AND status='ready'",[intent.organization_id,intent.authorization_id]);
      await appendAudit(tx,{organizationId:intent.organization_id,action:`delivery.${result.state}`,entityType:'delivery_intent',entityId:intent.id,details:{attemptId,code:result.code,...(messageId?{providerMessageId:messageId}:{})}});
      return outcome(saved);
    });
  }
  async function deliverMessengerIntent(intentId) {
    const intent=(await pool.query('SELECT * FROM delivery_intents WHERE id=$1',[intentId])).rows[0];
    if(!intent) return {state:'failed',code:'INTENT_NOT_FOUND',retrySafe:false};
    const prior=await withTransaction(pool,async tx=>{await lockIntent(tx,intent);return existing(tx,intent);});
    if(prior) return prior;
    const source=(await pool.query('SELECT health FROM meta_page_sources WHERE organization_id=$1 AND id=$2',[intent.organization_id,intent.source_id])).rows[0];
    if(source?.health!=='connected') return withTransaction(pool,async tx=>{await lockIntent(tx,intent);return await existing(tx,intent)??cancel(tx,intent,'SOURCE_UNAVAILABLE');});
    let attempted=false;
    try {
      return await credentials.withPageToken(intent.organization_id,intent.source_id,async token=>{
        const attemptId=randomUUID();
        const gate=await withTransaction(pool,async tx=>{
          await lockIntent(tx,intent);
          const prior=await existing(tx,intent);if(prior) return {prior};
          const reply=(await tx.query('SELECT * FROM reply_versions WHERE organization_id=$1 AND id=$2',[intent.organization_id,intent.reply_version_id])).rows[0];
          const authorization=(await tx.query('SELECT * FROM reply_authorizations WHERE organization_id=$1 AND id=$2',[intent.organization_id,intent.authorization_id])).rows[0];
          let context;
          try {
            if(!reply || !authorization || authorization.reply_version_id!==reply.id || authorization.work_item_id!==reply.work_item_id || reply.conversation_id!==intent.conversation_id || !isDeepStrictEqual(reply.content,intent.content)) reject('INVALID_AUTHORIZATION');
            context=await loadContext(tx,reply.work_item_id,reply.conversation_revision,intent.organization_id);
            if(context.source?.id!==intent.source_id) reject('SOURCE_CHANGED');
            if(context.item.status!=='ready' || context.conversation.opted_out) reject(context.conversation.opted_out?'OPT_OUT':'DELIVERY_STATE_CHANGED');
            if((await tx.query('SELECT 1 FROM reply_supersessions WHERE organization_id=$1 AND reply_version_id=$2',[intent.organization_id,reply.id])).rowCount) reject('REPLY_SUPERSEDED');
            await assertReplyFresh(tx,reply,context);
            validateReply(reply.content,reply.context);
            if(!isDeepStrictEqual(authorization.evidence.inventory,reply.context.snapshot.inventoryWatermark)) reject('INVALID_AUTHORIZATION');
            const now=clock();
            // Source rotation uses the same organization lock. Recheck expiry
            // and token within the final transaction before committing attempting.
            await credentials.withPageToken(intent.organization_id,intent.source_id,latest=>{if(latest!==token) reject('CREDENTIAL_CHANGED');},{db:tx,now:now.valueOf()});
            const {rows:[counts]}=await tx.query(`SELECT count(*)::int AS organization,
              count(*) FILTER(WHERE d.source_id=$2)::int AS source,
              count(*) FILTER(WHERE d.conversation_id=$3)::int AS conversation
              FROM delivery_attempts a JOIN delivery_intents d ON d.organization_id=a.organization_id AND d.id=a.delivery_intent_id
              WHERE a.organization_id=$1 AND a.started_at>$4::timestamptz-interval '1 hour'`,[intent.organization_id,intent.source_id,intent.conversation_id,now]);
            const timestamp=Number(context.messages.at(-1)?.provider_timestamp_ms);
            const human=authorization.actor_kind==='human', policy=context.org.automation_policy;
            if(policy.mode==='observe') reject('POLICY_CHANGED');
            const decision=evaluatePolicy({...policy,mode:'automatic',...(human?{minimumConfidence:0}:{})},{
              confidence:human?1:reply.context.confidence,grounded:human?true:reply.content.grounded,automaticEligible:human?true:reply.content.automaticEligible,
              sourceHealth:context.source.health,replyWindowOpen:Number.isSafeInteger(timestamp)&&timestamp>0&&now.valueOf()>=timestamp&&now.valueOf()-timestamp<86400000,
              optOut:context.conversation.opted_out,humanTakeover:context.conversation.human_takeover,counts,
            },now);
            if(decision.action!=='authorize') reject('FINAL_POLICY_GATE');
            if(!validMetaSend({pageId:context.conversation.page_id,recipientId:context.conversation.psid,text:intent.content.text,token,attemptId})) reject('LOCAL_INVALID_REQUEST');
          } catch(error) {
            if(!freshnessConflictCodes.has(error.code)&&!terminalPreparationCodes.has(error.code)&&!finalGateCodes.has(error.code)) throw error;
            return {prior:await cancel(tx,intent,error.code)};
          }
          await tx.query("INSERT INTO delivery_attempts(id,organization_id,delivery_intent_id,state) VALUES($1,$2,$3,'attempting')",[attemptId,intent.organization_id,intent.id]);
          await tx.query("UPDATE jobs SET status='running',lease_owner=$3,lease_expires_at=NULL,attempts=attempts+1,updated_at=now() WHERE organization_id=$1 AND kind='deliver_reply' AND payload->>'deliveryIntentId'=$2",[intent.organization_id,intent.id,attemptId]);
          await appendAudit(tx,{organizationId:intent.organization_id,action:'delivery.attempting',entityType:'delivery_intent',entityId:intent.id,details:{attemptId,replyVersionId:reply.id}});
          // COMMIT acknowledgement can be lost after PostgreSQL commits. Treat
          // that as uncertain too, even though remote I/O has not started.
          attempted=true;
          return {pageId:context.conversation.page_id,recipientId:context.conversation.psid};
        });
        if(gate.prior) return gate.prior;
        let result;
        try {result=await client.sendText({...gate,token,text:intent.content.text,attemptId});}
        catch {result={state:'unknown',code:'PROVIDER_NETWORK'};}
        if(!['sent','failed','unknown'].includes(result?.state) || (result.state==='sent' && (typeof result.messageId!=='string'||!result.messageId))) result={state:'unknown',code:'PROVIDER_MALFORMED'};
        return settle(intent,attemptId,result);
      });
    } catch {
      // A failed persistence operation after dispatch leaves attempting durable.
      // Re-entry returns unknown and never sends again.
      if(!attempted) await withTransaction(pool,async tx=>{
        await lockIntent(tx,intent);
        if(await existing(tx,intent)) return;
        // Local credential/configuration failures back off without monopolizing
        // the queue. This path cannot run after an attempt has been committed.
        await tx.query(`UPDATE jobs SET status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,
          attempts=attempts+1,available_at=now()+interval '30 seconds',last_error='PRE_DISPATCH_FAILED',
          lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE organization_id=$1 AND kind='deliver_reply' AND payload->>'deliveryIntentId'=$2`,[intent.organization_id,intent.id]);
      });
      return {state:attempted?'unknown':'failed',code:attempted?'ATTEMPT_UNRESOLVED':'PRE_DISPATCH_FAILED',retrySafe:!attempted};
    }
  }
  async function reconcileAttempt(intentId,{actor,evidence,providerMessageId,...extra}={}) {
    const organizationId=authorizeInboxActor(actor,{write:true});
    if(Object.keys(extra).length || typeof evidence!=='string' || !evidence.trim() || evidence.length>1000 || typeof providerMessageId!=='string' || !/^[^\s\x00-\x1f\x7f]{1,512}$/.test(providerMessageId)) throw new Error('Human evidence and provider message ID required');
    return withTransaction(pool,async tx=>{
      const intent=(await tx.query('SELECT * FROM delivery_intents WHERE organization_id=$1 AND id=$2',[organizationId,intentId])).rows[0];
      if(!intent) throw new Error('Intent not found');
      await lockIntent(tx,intent);
      const member=(await tx.query("SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2 AND role IN ('admin','operator') FOR SHARE",[organizationId,actor.id])).rowCount;
      if(!member) throw new Error('Human operator required');
      const attempt=(await tx.query('SELECT * FROM delivery_attempts WHERE organization_id=$1 AND delivery_intent_id=$2 FOR UPDATE',[organizationId,intentId])).rows[0];
      if(!attempt || !['attempting','unknown'].includes(attempt.state)) throw new Error('Unresolved attempt required');
      const {rows:[saved]}=await tx.query("UPDATE delivery_attempts SET state='sent',provider_message_id=$2,outcome_code='HUMAN_CONFIRMED',finished_at=now() WHERE id=$1 RETURNING *",[attempt.id,providerMessageId]);
      await finishJobs(tx,intent,'completed','HUMAN_CONFIRMED');
      await tx.query("UPDATE work_items SET status='completed',updated_at=now() WHERE organization_id=$1 AND id=(SELECT work_item_id FROM reply_authorizations WHERE organization_id=$1 AND id=$2) AND status='ready'",[organizationId,intent.authorization_id]);
      // Free text evidence may contain customer details. Keep only confirmation.
      await appendAudit(tx,{organizationId,actorId:actor.id,action:'delivery.reconciled',entityType:'delivery_intent',entityId:intentId,details:{attemptId:attempt.id,providerMessageId,evidenceProvided:true}});
      return outcome(saved);
    });
  }
  async function runOnce() {
    await recoverInterruptedAttempts();
    const job=(await pool.query("SELECT payload FROM jobs WHERE kind='deliver_reply' AND status='pending' AND available_at<=now() ORDER BY created_at,id LIMIT 1")).rows[0];
    return job?deliverMessengerIntent(job.payload.deliveryIntentId):null;
  }
  async function recoverInterruptedAttempts() {
    // The client timeout is capped at 60 seconds. Wait twice that duration,
    // then record uncertainty only. Recovery never creates another attempt.
    const cutoff=new Date(clock().valueOf()-120000);
    const candidates=(await pool.query("SELECT d.* FROM delivery_intents d JOIN delivery_attempts a ON a.organization_id=d.organization_id AND a.delivery_intent_id=d.id WHERE a.state='attempting' AND a.started_at<$1 ORDER BY a.started_at LIMIT 100",[cutoff])).rows;
    let recovered=0;
    for(const intent of candidates) await withTransaction(pool,async tx=>{
      await lockIntent(tx,intent);
      const {rows:[row]}=await tx.query("UPDATE delivery_attempts SET state='unknown',outcome_code='ATTEMPT_INTERRUPTED',finished_at=now() WHERE organization_id=$1 AND delivery_intent_id=$2 AND state='attempting' AND started_at<$3 RETURNING id",[intent.organization_id,intent.id,cutoff]);
      if(!row) return;
      await finishJobs(tx,intent,'failed','ATTEMPT_INTERRUPTED');
      await appendAudit(tx,{organizationId:intent.organization_id,action:'delivery.unknown',entityType:'delivery_intent',entityId:intent.id,details:{attemptId:row.id,code:'ATTEMPT_INTERRUPTED'}});
      recovered++;
    });
    return recovered;
  }
  return {deliverMessengerIntent,reconcileAttempt,recoverInterruptedAttempts,runOnce};
}
