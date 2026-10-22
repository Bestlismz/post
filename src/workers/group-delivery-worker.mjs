import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertResultBoundToCommand,canonicalSerialize,signCommand,verifyResult} from '../channels/groups/contracts.mjs';
import {appendAudit,withTransaction} from '../db/transaction.mjs';
import {loadContext,assertReplyFresh} from '../inbox/service.mjs';
import {freshnessConflictCodes,terminalPreparationCodes} from '../inbox/errors.mjs';
import {validateReply} from '../replies/validator.mjs';
import {evaluateCurrentSourceDecision} from '../policy/current-source-decision.mjs';
import {enqueueJob} from '../jobs/queue.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const outcome=row=>({state:row.state==='attempting'?'unknown':row.state,attemptId:row.id,code:row.outcome_code??'ATTEMPT_UNRESOLVED',retrySafe:false});
const reject=code=>{throw Object.assign(new Error(code),{code});};
const terminalCodes=new Set([...freshnessConflictCodes,...terminalPreparationCodes,'INVALID_AUTHORIZATION','DELIVERY_STATE_CHANGED','SOURCE_UNAVAILABLE','TARGET_CHANGED','REPLY_SUPERSEDED','LOCAL_INVALID_REQUEST','FINAL_POLICY_GATE']);

export function createGroupDeliveryWorker({pool,client,keys,signingKey,keyId,clock=()=>new Date(),policyClock,stagingSendEnabled=true,stagingAllowedGroups=null}) {
  const stagingGroups=stagingAllowedGroups===null?null:[...new Set(stagingAllowedGroups)];
  async function claimJob(intentId=null) {
    const leaseOwner=randomUUID();
    const {rows:[job]}=await pool.query(`WITH candidate AS (
      SELECT j.id FROM jobs j
      JOIN delivery_intents d ON d.organization_id=j.organization_id AND d.id=j.payload->>'deliveryIntentId'
      JOIN group_sources s ON s.organization_id=d.organization_id AND s.id=d.group_source_id
      JOIN organizations o ON o.id=j.organization_id
      WHERE j.kind='deliver_group_reply' AND $3::boolean AND ($4::text[] IS NULL OR s.group_id=ANY($4)) AND NOT o.group_automation_paused AND NOT s.kill_switch AND NOT s.archived
      AND NOT s.session_circuit AND NOT s.selector_circuit AND s.session_health='healthy' AND s.selector_health='healthy'
      AND ($2::text IS NULL OR j.payload->>'deliveryIntentId'=$2)
      AND ((j.status='pending' AND j.available_at<=now()) OR (j.status='running' AND j.lease_expires_at<=now()))
      AND NOT EXISTS (SELECT 1 FROM delivery_attempts a WHERE a.organization_id=j.organization_id AND a.delivery_intent_id=j.payload->>'deliveryIntentId')
      AND NOT EXISTS (SELECT 1 FROM delivery_cancellations c WHERE c.organization_id=j.organization_id AND c.delivery_intent_id=j.payload->>'deliveryIntentId')
      ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE jobs j SET status='running',lease_owner=$1,lease_expires_at=now()+interval '60 seconds',attempts=attempts+1,updated_at=now()
      FROM candidate WHERE j.id=candidate.id RETURNING j.*`,[leaseOwner,intentId,stagingSendEnabled,stagingGroups]);
    return job;
  }
  async function lockIntent(tx,intent) {
    await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[intent.organization_id]);
    await tx.query('SELECT id FROM delivery_intents WHERE organization_id=$1 AND id=$2 FOR UPDATE',[intent.organization_id,intent.id]);
  }
  async function existing(tx,intent) {
    const attempt=(await tx.query('SELECT * FROM delivery_attempts WHERE organization_id=$1 AND delivery_intent_id=$2 FOR UPDATE',[intent.organization_id,intent.id])).rows[0];
    if(attempt)return outcome(attempt);
    const cancelled=(await tx.query('SELECT reason FROM delivery_cancellations WHERE organization_id=$1 AND delivery_intent_id=$2',[intent.organization_id,intent.id])).rows[0];
    return cancelled?{state:'cancelled',code:cancelled.reason,retrySafe:false}:null;
  }
  async function ownsClaim(tx,claim,intent) {
    return (await tx.query(`SELECT id FROM jobs WHERE id=$1 AND organization_id=$2 AND kind='deliver_group_reply'
      AND payload->>'deliveryIntentId'=$3 AND status='running' AND lease_owner=$4 AND lease_expires_at>now() FOR UPDATE`,[claim.id,intent.organization_id,intent.id,claim.lease_owner])).rowCount>0;
  }
  async function finishJobs(tx,intent,status,code) {
    await tx.query("UPDATE jobs SET status=$3,last_error=$4,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND kind='deliver_group_reply' AND payload->>'deliveryIntentId'=$2",[intent.organization_id,intent.id,status,code]);
  }
  async function cancel(tx,intent,code) {
    await tx.query('INSERT INTO delivery_cancellations(organization_id,delivery_intent_id,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[intent.organization_id,intent.id,code]);
    await finishJobs(tx,intent,'completed',code);
    await appendAudit(tx,{organizationId:intent.organization_id,action:'delivery.cancelled',entityType:'delivery_intent',entityId:intent.id,details:{code,channel:'facebook_group'}});
    return {state:'cancelled',code,retrySafe:false};
  }
  async function receipt(tx,intent,attempt,operation,result) {
    await tx.query(`INSERT INTO group_send_receipts(operation_id,organization_id,delivery_intent_id,delivery_attempt_id,digest,kind,state,destination,target_id,sender_id,text_hash,attempt_started_at,attempt_finished_at,evidence_hash,remote_id,result)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[operation.id,intent.organization_id,intent.id,attempt.id,digest(canonicalSerialize(result)),result.kind,result.state,result.canonicalTarget,result.targetId,result.senderId,result.textHash,result.attemptStartedAt,result.attemptFinishedAt,result.evidenceHash,result.remoteId,JSON.stringify(result)]);
  }
  async function settle(intent,attemptId,operation,result,{trusted=true}={}) {
    return withTransaction(pool,async tx=>{
      await lockIntent(tx,intent);
      const attempt=(await tx.query('SELECT * FROM delivery_attempts WHERE organization_id=$1 AND delivery_intent_id=$2 FOR UPDATE',[intent.organization_id,intent.id])).rows[0];
      if(!attempt||attempt.id!==attemptId||attempt.state!=='attempting')return attempt?outcome(attempt):{state:'unknown',code:'ATTEMPT_UNRESOLVED',retrySafe:false};
      if(trusted)await receipt(tx,intent,attempt,operation,result);
      const state=result.state,code=state==='sent'?'VISIBLE_VERIFIED':state==='failed'?'DEFINITE_REJECTION':'POSSIBLE_SEND';
      const {rows:[saved]}=await tx.query('UPDATE delivery_attempts SET state=$2,outcome_code=$3,provider_message_id=$4,finished_at=$5 WHERE id=$1 RETURNING *',[attempt.id,state,code,state==='sent'?result.remoteId:null,result.attemptFinishedAt]);
      await finishJobs(tx,intent,state==='sent'?'completed':'failed',code);
      if(state==='unknown')await enqueueJob(tx,{organizationId:intent.organization_id,kind:'reconcile_group_reply',retrySafe:true,payload:{deliveryIntentId:intent.id}});
      if(state==='sent')await tx.query("UPDATE work_items SET status='completed',updated_at=now() WHERE organization_id=$1 AND id=(SELECT work_item_id FROM reply_authorizations WHERE organization_id=$1 AND id=$2) AND status='ready'",[intent.organization_id,intent.authorization_id]);
      await appendAudit(tx,{organizationId:intent.organization_id,action:`delivery.${state}`,entityType:'delivery_intent',entityId:intent.id,details:{attemptId:attempt.id,operationId:operation.id,code,channel:'facebook_group',...(result.remoteId?{providerMessageId:result.remoteId}:{})}});
      return outcome(saved);
    });
  }
  async function deliverGroupIntent(intentId,claim) {
    const intent=(await pool.query('SELECT * FROM delivery_intents WHERE id=$1',[intentId])).rows[0];
    if(!intent||!intent.group_source_id||intent.source_id)return {state:'failed',code:'INTENT_NOT_FOUND',retrySafe:false};
    await recoverInterruptedAttempts(intent.id);
    const prior=await withTransaction(pool,async tx=>{await lockIntent(tx,intent);return existing(tx,intent);});if(prior)return prior;
    claim??=await claimJob(intent.id);
    if(!claim) {
      const {rows:[availability]}=await pool.query(`SELECT o.group_automation_paused,s.kill_switch,s.archived,s.session_circuit,s.selector_circuit,s.session_health,s.selector_health
        FROM group_sources s JOIN organizations o ON o.id=s.organization_id WHERE s.organization_id=$1 AND s.id=$2`,[intent.organization_id,intent.group_source_id]);
      const unavailable=availability&&(availability.group_automation_paused||availability.kill_switch||availability.archived||availability.session_circuit||availability.selector_circuit||availability.session_health!=='healthy'||availability.selector_health!=='healthy');
      if(unavailable)return withTransaction(pool,async tx=>{await lockIntent(tx,intent);return await existing(tx,intent)??cancel(tx,intent,'SOURCE_UNAVAILABLE');});
      return {state:'failed',code:'DELIVERY_NOT_CLAIMED',retrySafe:true};
    }
    const attemptId=randomUUID(),operationId=randomUUID();let attempted=false,operation;
    try {
      const gate=await withTransaction(pool,async tx=>{
        await lockIntent(tx,intent);const prior=await existing(tx,intent);if(prior)return {prior};
        if(!await ownsClaim(tx,claim,intent))return {prior:{state:'failed',code:'DELIVERY_NOT_CLAIMED',retrySafe:true}};
        const reply=(await tx.query('SELECT * FROM reply_versions WHERE organization_id=$1 AND id=$2',[intent.organization_id,intent.reply_version_id])).rows[0];
        const authorization=(await tx.query('SELECT * FROM reply_authorizations WHERE organization_id=$1 AND id=$2',[intent.organization_id,intent.authorization_id])).rows[0];
        try {
          if(!reply||!authorization||authorization.reply_version_id!==reply.id||authorization.work_item_id!==reply.work_item_id||reply.conversation_id!==intent.conversation_id||!isDeepStrictEqual(reply.content,intent.content))reject('INVALID_AUTHORIZATION');
          const context=await loadContext(tx,reply.work_item_id,reply.conversation_revision,intent.organization_id);
          if(context.conversation.channel!=='facebook_group'||context.source.id!==intent.group_source_id)reject('SOURCE_CHANGED');
          if(context.item.status!=='ready'||context.conversation.opted_out)reject('DELIVERY_STATE_CHANGED');
          if((await tx.query('SELECT 1 FROM reply_supersessions WHERE organization_id=$1 AND reply_version_id=$2',[intent.organization_id,reply.id])).rowCount)reject('REPLY_SUPERSEDED');
          await assertReplyFresh(tx,reply,context);validateReply(reply.content,reply.context);
          if(!isDeepStrictEqual(authorization.evidence.inventory,reply.context.snapshot.inventoryWatermark))reject('INVALID_AUTHORIZATION');
          const source=context.source;
          const human=authorization.actor_kind==='human',policy=reply.context.evidence.policy;
          const {decision,evaluatedAt}=await evaluateCurrentSourceDecision(tx,{organizationId:intent.organization_id,sourceId:source.id,conversationId:intent.conversation_id,
            organizationPaused:context.org.group_automation_paused,organizationPolicy:policy,source,actorKind:human?'human':'policy',
            context:{confidence:reply.context.confidence,grounded:reply.content.grounded,automaticEligible:reply.content.automaticEligible,
              replyWindowOpen:true,optOut:context.conversation.opted_out,humanTakeover:context.conversation.human_takeover}},{clock:policyClock});
          if(decision.action!=='authorize')reject('FINAL_POLICY_GATE');
          const {rows:[target]}=await tx.query(`SELECT o.target_id,o.id FROM messages m
            JOIN group_observations o ON o.organization_id=m.organization_id AND o.id=m.raw_evidence->>'observationId'
            JOIN group_targets t ON t.organization_id=o.organization_id AND t.source_id=o.source_id AND t.target_id=o.target_id AND t.observation_id=o.id
            WHERE m.organization_id=$1 AND m.id=(SELECT message_id FROM work_items WHERE organization_id=$1 AND id=$2) AND o.source_id=$3`,[intent.organization_id,reply.work_item_id,source.id]);
          if(!target)reject('TARGET_CHANGED');
          const textHash=digest(intent.content.text);
          const command=signCommand({version:1,kind:'GroupReplyCommand',operationId,sourceId:source.id,groupId:source.group_id,canonicalTarget:source.canonical_url,targetId:target.target_id,text:intent.content.text,textHash,issuedAt:evaluatedAt.toISOString(),expiresAt:new Date(+evaluatedAt+300000).toISOString(),keyId},{key:signingKey,keyId,now:evaluatedAt});
          await tx.query('INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES($1,$2,$3,$4,$5)',[operationId,intent.organization_id,source.id,'GroupReplyCommand',JSON.stringify(command)]);
          await tx.query("INSERT INTO delivery_attempts(id,organization_id,delivery_intent_id,state,started_at) VALUES($1,$2,$3,'attempting',$4)",[attemptId,intent.organization_id,intent.id,evaluatedAt]);
          await tx.query(`INSERT INTO group_delivery_attempts(organization_id,delivery_intent_id,delivery_attempt_id,operation_id,target_id,text_hash,canonical_target,sender_id,attempt_started_at,attempt_deadline_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9)`,[intent.organization_id,intent.id,attemptId,operationId,target.target_id,textHash,source.canonical_url,evaluatedAt,command.expiresAt]);
          await tx.query("UPDATE jobs SET lease_owner=$3,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='running'",[claim.id,claim.lease_owner,attemptId]);
          await appendAudit(tx,{organizationId:intent.organization_id,action:'delivery.attempting',entityType:'delivery_intent',entityId:intent.id,details:{attemptId,operationId,replyVersionId:reply.id,channel:'facebook_group'}});
          attempted=true;return {command,operation:{id:operationId}};
        } catch(error) {
          if(!terminalCodes.has(error.code))throw error;
          return {prior:await cancel(tx,intent,error.code)};
        }
      });
      if(gate.prior)return gate.prior;operation=gate.operation;
      let result;
      try {result=verifyResult(await client.reply(gate.command),{keys,now:clock()});}
      catch {result=null;}
      try {if(!result)throw new Error();assertResultBoundToCommand(result,gate.command);}
      catch {
        return await settle(intent,attemptId,operation,{...Object.fromEntries(Object.entries(gate.command).filter(([name])=>!['signature','text'].includes(name))),kind:'GroupReplyResult',state:'unknown',senderId:'unknown',attemptStartedAt:clock().toISOString(),attemptFinishedAt:clock().toISOString(),evidenceHash:digest(`unknown:${operationId}`),remoteId:null},{trusted:false});
      }
      return await settle(intent,attemptId,operation,result);
    } catch {
      return {state:attempted?'unknown':'failed',code:attempted?'ATTEMPT_UNRESOLVED':'PRE_DISPATCH_FAILED',retrySafe:!attempted};
    }
  }
  async function reconcileGroupIntent(intentId) {
    const intent=(await pool.query('SELECT * FROM delivery_intents WHERE id=$1',[intentId])).rows[0];if(!intent?.group_source_id)throw new Error('Intent not found');
    const data=await withTransaction(pool,async tx=>{
      await lockIntent(tx,intent);
      const attempt=(await tx.query('SELECT * FROM delivery_attempts WHERE organization_id=$1 AND delivery_intent_id=$2 FOR UPDATE',[intent.organization_id,intent.id])).rows[0];
      if(!attempt||!['attempting','unknown'].includes(attempt.state))throw new Error('Unresolved attempt required');
      const initial=(await tx.query("SELECT * FROM group_send_receipts WHERE organization_id=$1 AND delivery_intent_id=$2 AND kind='GroupReplyResult' ORDER BY created_at DESC LIMIT 1",[intent.organization_id,intent.id])).rows[0];
      const seed=(await tx.query('SELECT * FROM group_delivery_attempts WHERE organization_id=$1 AND delivery_intent_id=$2',[intent.organization_id,intent.id])).rows[0];
      if(!seed)throw new Error('Attempt evidence unavailable');
      const source=(await tx.query('SELECT * FROM group_sources WHERE organization_id=$1 AND id=$2',[intent.organization_id,intent.group_source_id])).rows[0];
      const operationId=randomUUID(),now=clock();
      const command=signCommand({version:1,kind:'ReconcileCommand',operationId,attemptOperationId:seed.operation_id,sourceId:source.id,groupId:source.group_id,canonicalTarget:seed.canonical_target,targetId:seed.target_id,textHash:seed.text_hash,senderId:initial?.sender_id??seed.sender_id,
        attemptStartedAt:(initial?.attempt_started_at??seed.attempt_started_at).toISOString(),attemptFinishedAt:(initial?.attempt_finished_at??seed.attempt_deadline_at).toISOString(),issuedAt:now.toISOString(),expiresAt:new Date(+now+300000).toISOString(),keyId},{key:signingKey,keyId,now});
      await tx.query('INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES($1,$2,$3,$4,$5)',[operationId,intent.organization_id,source.id,'ReconcileCommand',JSON.stringify(command)]);
      return {attempt,command,operation:{id:operationId}};
    });
    const result=verifyResult(await client.reconcile(data.command),{keys,now:clock()});
    assertResultBoundToCommand(result,data.command);
    return withTransaction(pool,async tx=>{
      await lockIntent(tx,intent);const attempt=(await tx.query('SELECT * FROM delivery_attempts WHERE organization_id=$1 AND delivery_intent_id=$2 FOR UPDATE',[intent.organization_id,intent.id])).rows[0];
      if(!attempt||attempt.id!==data.attempt.id||!['attempting','unknown'].includes(attempt.state))return outcome(attempt);
      await receipt(tx,intent,attempt,data.operation,result);
      if(result.state!=='sent') {
        if(attempt.state==='attempting')await tx.query("UPDATE delivery_attempts SET state='unknown',outcome_code='RECONCILIATION_NOT_FOUND',finished_at=now() WHERE id=$1",[attempt.id]);
        await finishJobs(tx,intent,'failed','RECONCILIATION_NOT_FOUND');
        return {state:'unknown',attemptId:attempt.id,code:'RECONCILIATION_NOT_FOUND',retrySafe:false};
      }
      const {rows:[saved]}=await tx.query("UPDATE delivery_attempts SET state='sent',provider_message_id=$2,outcome_code='EVIDENCE_RECONCILED',finished_at=now() WHERE id=$1 RETURNING *",[attempt.id,result.remoteId]);
      await finishJobs(tx,intent,'completed','EVIDENCE_RECONCILED');
      await tx.query("UPDATE work_items SET status='completed',updated_at=now() WHERE organization_id=$1 AND id=(SELECT work_item_id FROM reply_authorizations WHERE organization_id=$1 AND id=$2) AND status='ready'",[intent.organization_id,intent.authorization_id]);
      await appendAudit(tx,{organizationId:intent.organization_id,action:'delivery.reconciled',entityType:'delivery_intent',entityId:intent.id,details:{attemptId:attempt.id,operationId:data.operation.id,providerMessageId:result.remoteId,channel:'facebook_group'}});
      return outcome(saved);
    });
  }
  async function recoverInterruptedAttempts(intentId=null) {
    const cutoff=new Date(clock().valueOf()-120000);
    const candidates=(await pool.query(`SELECT d.* FROM delivery_intents d JOIN delivery_attempts a ON a.organization_id=d.organization_id AND a.delivery_intent_id=d.id
      WHERE d.group_source_id IS NOT NULL AND ($2::text IS NULL OR d.id=$2) AND a.state='attempting' AND a.started_at<$1 ORDER BY a.started_at LIMIT 100`,[cutoff,intentId])).rows;
    let recovered=0;
    for(const intent of candidates)await withTransaction(pool,async tx=>{
      await lockIntent(tx,intent);
      const {rows:[attempt]}=await tx.query("UPDATE delivery_attempts SET state='unknown',outcome_code='ATTEMPT_INTERRUPTED',finished_at=now() WHERE organization_id=$1 AND delivery_intent_id=$2 AND state='attempting' AND started_at<$3 RETURNING id",[intent.organization_id,intent.id,cutoff]);
      if(!attempt)return;
      await finishJobs(tx,intent,'failed','ATTEMPT_INTERRUPTED');
      await enqueueJob(tx,{organizationId:intent.organization_id,kind:'reconcile_group_reply',retrySafe:true,payload:{deliveryIntentId:intent.id}});
      await appendAudit(tx,{organizationId:intent.organization_id,action:'delivery.unknown',entityType:'delivery_intent',entityId:intent.id,details:{attemptId:attempt.id,code:'ATTEMPT_INTERRUPTED',channel:'facebook_group'}});
      recovered++;
    });
    return recovered;
  }
  async function runOnce(){await recoverInterruptedAttempts();const job=await claimJob();return job?deliverGroupIntent(job.payload.deliveryIntentId,job):null;}
  async function runReconcileOnce() {
    const leaseOwner=randomUUID();
    const {rows:[job]}=await pool.query(`WITH candidate AS (
      SELECT id FROM jobs WHERE kind='reconcile_group_reply'
      AND ((status='pending' AND available_at<=now()) OR (status='running' AND retry_safe AND lease_expires_at<=now()))
      ORDER BY available_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE jobs j SET status='running',lease_owner=$1,lease_expires_at=now()+interval '60 seconds',attempts=attempts+1,updated_at=now()
      FROM candidate WHERE j.id=candidate.id RETURNING j.*`,[leaseOwner]);
    if(!job)return null;
    try {
      const result=await reconcileGroupIntent(job.payload.deliveryIntentId);
      await pool.query("UPDATE jobs SET status='completed',lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='running'",[job.id,leaseOwner]);
      return result;
    } catch {
      const status=job.attempts>=5?'failed':'pending';
      await pool.query(`UPDATE jobs SET status=$3,lease_owner=NULL,lease_expires_at=NULL,last_error='GROUP_RECONCILIATION_FAILED',
        available_at=CASE WHEN $3='pending' THEN now()+least(300,power(2,least(attempts,8))) * interval '1 second' ELSE available_at END,updated_at=now()
        WHERE id=$1 AND lease_owner=$2 AND status='running'`,[job.id,leaseOwner,status]);
      return {state:'unknown',code:'GROUP_RECONCILIATION_FAILED',retrySafe:status==='pending'};
    }
  }
  return {deliverGroupIntent,reconcileGroupIntent,recoverInterruptedAttempts,runOnce,runReconcileOnce};
}
