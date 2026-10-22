import { randomUUID } from 'node:crypto';
import { appendAudit, withTransaction } from '../db/transaction.mjs';
import { freshnessConflictCodes, terminalPreparationCodes } from '../inbox/errors.mjs';
import { findFreshPreparedReply } from '../inbox/service.mjs';

export function createAutomationWorker({ pool, service, workerId, leaseSeconds = 60, maxAttempts = 5, retryBaseSeconds = 5, maxRetrySeconds = 300 }) {
  if (typeof workerId !== 'string' || !workerId.trim() || !Number.isSafeInteger(leaseSeconds) || leaseSeconds<1) throw new Error('Valid worker and lease required');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts<1 || maxAttempts>100 || !Number.isSafeInteger(retryBaseSeconds) || retryBaseSeconds<1 || !Number.isSafeInteger(maxRetrySeconds) || maxRetrySeconds<retryBaseSeconds) throw new Error('Valid bounded retry policy required');
  async function settleFailure(job,leaseOwner,error) {
    return withTransaction(pool,async tx=>{
      // Match ingress/handoff order and fence every outcome against the current claim.
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[job.organization_id]);
      const current=(await tx.query("SELECT id FROM jobs WHERE id=$1 AND lease_owner=$2 AND status='running' FOR UPDATE",[job.id,leaseOwner])).rows[0];
      if (!current) return;
      let code=freshnessConflictCodes.has(error.code) || terminalPreparationCodes.has(error.code) ? error.code : 'PREPARATION_FAILED';
      const item=(await tx.query(`SELECT w.status,w.processing_revision,c.processing_revision AS current_revision,c.human_takeover
        FROM work_items w JOIN conversations c ON c.organization_id=w.organization_id AND c.id=w.conversation_id
        WHERE w.organization_id=$1 AND w.id=$2 FOR UPDATE OF w,c`,[job.organization_id,job.payload.workItemId])).rows[0];
      if (!item) code='WORK_ITEM_NOT_FOUND';
      else if (item.human_takeover || item.status==='handoff') code='HUMAN_TAKEOVER';
      else if (item.processing_revision!==item.current_revision || item.status==='superseded') code='CONVERSATION_SUPERSEDED';
      const terminal=terminalPreparationCodes.has(code);
      if (!terminal) {
        const prepared=await findFreshPreparedReply(tx,{organizationId:job.organization_id,workItemId:job.payload.workItemId,processingRevision:job.payload.processingRevision});
        if (prepared) {
          await tx.query("UPDATE jobs SET status='completed',lease_owner=NULL,lease_expires_at=NULL,last_error='PREPARATION_SUPERSEDED',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='running'",[job.id,leaseOwner]);
          await appendAudit(tx,{organizationId:job.organization_id,action:'reply.preparation_reconciled',entityType:'work_item',entityId:job.payload.workItemId,details:{jobId:job.id,replyVersionId:prepared.id,errorCode:code,attempts:job.attempts}});
          return;
        }
      }
      const exhausted=!terminal && job.attempts>=maxAttempts;
      if (terminal && ['CONVERSATION_SUPERSEDED','HUMAN_TAKEOVER'].includes(code)) {
        await tx.query("UPDATE work_items SET status=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 AND status NOT IN ('completed','superseded','handoff')",
          [job.organization_id,job.payload.workItemId,code==='HUMAN_TAKEOVER'?'handoff':'superseded']);
      } else if (exhausted) {
        await tx.query("UPDATE work_items SET status='failed',updated_at=now() WHERE organization_id=$1 AND id=$2 AND status IN ('pending','preparing','needs_review','failed')",[job.organization_id,job.payload.workItemId]);
        await appendAudit(tx,{organizationId:job.organization_id,action:'reply.preparation_failed',entityType:'work_item',entityId:job.payload.workItemId,details:{jobId:job.id,errorCode:code,attempts:job.attempts}});
      }
      const delay=Math.min(maxRetrySeconds,retryBaseSeconds*2**Math.min(job.attempts-1,30));
      await tx.query(`UPDATE jobs SET status=$3,lease_owner=NULL,lease_expires_at=NULL,last_error=$4,
        available_at=CASE WHEN $3='pending' THEN now()+$5*interval '1 second' ELSE available_at END,updated_at=now()
        WHERE id=$1 AND lease_owner=$2 AND status='running'`,[job.id,leaseOwner,terminal?'completed':exhausted?'failed':'pending',code,delay]);
    });
  }
  async function runOnce() {
    const leaseOwner=`${workerId}:${randomUUID()}`;
    const {rows:[job]}=await pool.query(`WITH candidate AS (
      SELECT j.id FROM jobs j WHERE j.kind IN ('analyze_work_item','analyze_group_work_item')
      AND ((j.status='pending' AND j.available_at<=now()) OR (j.status='running' AND j.retry_safe AND j.lease_expires_at<=now()))
      AND NOT EXISTS (SELECT 1 FROM jobs earlier WHERE earlier.organization_id=j.organization_id AND earlier.kind=j.kind
        AND earlier.payload->>'conversationId'=j.payload->>'conversationId' AND earlier.status IN ('pending','running')
        AND (earlier.payload->>'processingRevision')::int<(j.payload->>'processingRevision')::int)
      ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE jobs j SET status='running',lease_owner=$1,lease_expires_at=now()+$2*interval '1 second',attempts=attempts+1,updated_at=now()
      FROM candidate WHERE j.id=candidate.id RETURNING j.*`,[leaseOwner,leaseSeconds]);
    if (!job) return null;
    // A heartbeat keeps a slow provider call from overlapping a healthy worker.
    const heartbeat=setInterval(() => {
      pool.query("UPDATE jobs SET lease_expires_at=now()+$3*interval '1 second',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='running'",[job.id,leaseOwner,leaseSeconds]).catch(()=>{});
    },Math.max(100,Math.floor(leaseSeconds*1000/3)));
    heartbeat.unref();
    try {
      await service.prepareReply(job.payload.workItemId,job.payload.processingRevision,{organizationId:job.organization_id,role:'operator',id:null});
      await finish('completed');
    } catch(error) {
      await settleFailure(job,leaseOwner,error);
    } finally {clearInterval(heartbeat);}
    return job.id;
    async function finish(status) {
      await pool.query('UPDATE jobs SET status=$3,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status=\'running\'',[job.id,leaseOwner,status]);
    }
  }
  return {runOnce};
}
