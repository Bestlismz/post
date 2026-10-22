import {randomUUID} from 'node:crypto';
import {verifyCommand} from '../channels/groups/contracts.mjs';
import {prepareGroupScanDispatch} from './group-scan-dispatch.mjs';

export function createGroupScanWorker({pool,client,results,keys,keyId,signingKey,workerId,maxAttempts=5}) {
  if(!pool||!client||typeof client.scan!=='function'||!results||typeof results.acceptScanResult!=='function'||typeof workerId!=='string'||!workerId||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>100)throw Error('Invalid Group scan worker');
  async function claim() {
    const leaseOwner=`${workerId}:${randomUUID()}`;
    const {rows:[job]}=await pool.query(`WITH candidate AS (
      SELECT j.id FROM jobs j JOIN group_sources s ON s.organization_id=j.organization_id AND s.id=j.payload->>'sourceId'
      JOIN organizations o ON o.id=j.organization_id
      WHERE j.kind='group.scan' AND NOT o.group_automation_paused AND NOT s.kill_switch AND NOT s.archived
      AND (NOT (j.payload ? 'scheduleSlot') OR (s.session_health='healthy' AND s.selector_health='healthy' AND NOT s.session_circuit AND NOT s.selector_circuit))
      AND ((j.status='pending' AND j.available_at<=now()) OR (j.status='running' AND j.retry_safe AND j.lease_expires_at<=now()))
      ORDER BY j.available_at,j.created_at,j.id LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE jobs j SET status='running',lease_owner=$1,lease_expires_at=now()+interval '60 seconds',attempts=attempts+1,updated_at=now()
      FROM candidate WHERE j.id=candidate.id RETURNING j.*`,[leaseOwner]);
    return job;
  }
  async function commandFor(job) {
    if(job.payload.scheduleSlot)return prepareGroupScanDispatch({pool,jobId:job.id,leaseOwner:job.lease_owner,signingKey,keyId,keys});
    const {rows:[operation]}=await pool.query(`SELECT o.command FROM group_operations o JOIN group_sources s ON s.organization_id=o.organization_id AND s.id=o.source_id
      WHERE o.organization_id=$1 AND o.id=$2 AND o.source_id=$3 AND o.kind='ScanCommand'`,[job.organization_id,job.payload.operationId,job.payload.sourceId]);
    if(!operation)throw Error('Scan operation unavailable');return verifyCommand(operation.command,{keys});
  }
  async function settle(job,status,code=null) {
    await pool.query(`UPDATE jobs SET status=$3,lease_owner=NULL,lease_expires_at=NULL,last_error=$4,
      available_at=CASE WHEN $3='pending' THEN now()+least(300,power(2,least(attempts,8))) * interval '1 second' ELSE available_at END,updated_at=now()
      WHERE id=$1 AND lease_owner=$2 AND status='running'`,[job.id,job.lease_owner,status,code]);
  }
  return {async runOnce(){
    const job=await claim();if(!job)return null;
    try {const command=await commandFor(job),result=await client.scan(command);await results.acceptScanResult(result);await settle(job,'completed');}
    catch {await settle(job,job.attempts>=maxAttempts?'failed':'pending','GROUP_SCAN_FAILED');}
    return job.id;
  }};
}
