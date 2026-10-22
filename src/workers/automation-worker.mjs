import { randomUUID } from 'node:crypto';

export function createAutomationWorker({ pool, service, workerId, leaseSeconds = 60 }) {
  if (typeof workerId !== 'string' || !workerId.trim() || !Number.isSafeInteger(leaseSeconds) || leaseSeconds<1) throw new Error('Valid worker and lease required');
  async function runOnce() {
    const leaseOwner=`${workerId}:${randomUUID()}`;
    const {rows:[job]}=await pool.query(`WITH candidate AS (
      SELECT j.id FROM jobs j WHERE j.kind='analyze_work_item'
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
      if (error.status===409 || error.status===404) await finish('completed');
      else await pool.query("UPDATE jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL,available_at=now()+interval '30 seconds',last_error='Preparation failed',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='running'",[job.id,leaseOwner]);
    } finally {clearInterval(heartbeat);}
    return job.id;
    async function finish(status) {
      await pool.query('UPDATE jobs SET status=$3,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status=\'running\'',[job.id,leaseOwner,status]);
    }
  }
  return {runOnce};
}
