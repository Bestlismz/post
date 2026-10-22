import {randomUUID} from 'node:crypto';
import {signCommand,verifyCommand} from '../channels/groups/contracts.mjs';
import {appendAudit,withTransaction} from '../db/transaction.mjs';

const unavailable=source=>source.kill_switch||source.archived||source.session_circuit||source.selector_circuit||source.session_health!=='healthy'||source.selector_health!=='healthy'||source.group_automation_paused;

export async function prepareGroupScanDispatch({pool,jobId,leaseOwner,signingKey,keyId,keys,clock=()=>new Date(),minimumValidityMs=30000}) {
  if(typeof jobId!=='string'||!jobId||typeof leaseOwner!=='string'||!leaseOwner||!Number.isSafeInteger(minimumValidityMs)||minimumValidityMs<0||minimumValidityMs>300000)throw Error('Invalid scan dispatch');
  const outcome=await withTransaction(pool,async tx=>{
    const {rows:[identity]}=await tx.query("SELECT organization_id,payload FROM jobs WHERE id=$1 AND kind='group.scan'",[jobId]);
    if(!identity?.payload?.sourceId||!identity.payload.scheduleSlot||!identity.payload.scheduleReceiptId)throw Error('Scheduled scan job required');
    await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[identity.organization_id]);
    const {rows:[source]}=await tx.query(`SELECT s.*,o.group_automation_paused FROM group_sources s JOIN organizations o ON o.id=s.organization_id
      WHERE s.organization_id=$1 AND s.id=$2 FOR UPDATE OF s`,[identity.organization_id,identity.payload.sourceId]);
    const {rows:[job]}=await tx.query("SELECT * FROM jobs WHERE id=$1 AND organization_id=$2 AND kind='group.scan' AND status='running' AND lease_owner=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE",[jobId,identity.organization_id,leaseOwner]);
    if(!source||!job)throw Error('Scan lease unavailable');
    if(unavailable(source)) {
      await tx.query("UPDATE jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2",[job.id,leaseOwner]);
      return {sourceUnavailable:true};
    }
    const {rows:[receipt]}=await tx.query("SELECT * FROM group_schedule_receipts WHERE organization_id=$1 AND job_id=$2 AND state='scheduled'",[identity.organization_id,job.id]);
    if(!receipt||receipt.id!==identity.payload.scheduleReceiptId||receipt.source_id!==source.id||receipt.schedule_slot.toISOString()!==identity.payload.scheduleSlot)throw Error('Schedule receipt mismatch');
    const {rows:[latest]}=await tx.query(`SELECT d.*,o.command FROM group_scan_dispatches d JOIN group_operations o ON o.organization_id=d.organization_id AND o.id=d.operation_id
      WHERE d.organization_id=$1 AND d.job_id=$2 ORDER BY d.dispatch_sequence DESC LIMIT 1`,[identity.organization_id,job.id]);
    const now=clock();if(!Number.isFinite(+now))throw Error('Invalid dispatch time');
    if(latest) {
      try {const command=verifyCommand(latest.command,{keys,now});if(Date.parse(command.expiresAt)>+now+minimumValidityMs)return command;} catch { /* Refresh below. */ }
    }
    const predecessor=latest?.operation_id??receipt.operation_id??null;
    if(!latest&&predecessor) {
      const {rows:[original]}=await tx.query('SELECT command FROM group_operations WHERE organization_id=$1 AND id=$2 AND source_id=$3',[identity.organization_id,predecessor,source.id]);
      if(!original)throw Error('Scheduled operation unavailable');
      try {
        const command=verifyCommand(original.command,{keys,now});
        if(Date.parse(command.expiresAt)>+now+minimumValidityMs) {
          await tx.query(`INSERT INTO group_scan_dispatches(id,organization_id,job_id,schedule_receipt_id,operation_id,predecessor_operation_id,dispatch_sequence,reason_code)
            VALUES($1,$2,$3,$4,$5,NULL,1,'COMMAND_CURRENT')`,[randomUUID(),identity.organization_id,job.id,receipt.id,predecessor]);
          return command;
        }
      } catch { /* Replace expired or invalid bounded envelope from durable source identity. */ }
    }
    const operationId=randomUUID(),reason=predecessor?'COMMAND_REFRESHED':'COMMAND_FRESH',command=signCommand({version:1,kind:'ScanCommand',operationId,sourceId:source.id,groupId:source.group_id,canonicalTarget:source.canonical_url,issuedAt:now.toISOString(),expiresAt:new Date(+now+300000).toISOString(),keyId},{key:signingKey,keyId,now});
    await tx.query("INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES($1,$2,$3,'ScanCommand',$4)",[operationId,identity.organization_id,source.id,JSON.stringify(command)]);
    const sequence=(latest?.dispatch_sequence??0)+1;
    await tx.query(`INSERT INTO group_scan_dispatches(id,organization_id,job_id,schedule_receipt_id,operation_id,predecessor_operation_id,dispatch_sequence,reason_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),identity.organization_id,job.id,receipt.id,operationId,predecessor,sequence,reason]);
    await appendAudit(tx,{organizationId:identity.organization_id,action:'group.scan_command_prepared',entityType:'group_operation',entityId:operationId,details:{jobId:job.id,scheduleReceiptId:receipt.id,predecessorOperationId:predecessor,dispatchSequence:sequence,reason}});
    return command;
  });
  if(outcome?.sourceUnavailable)throw Object.assign(Error('Source unavailable'),{code:'SOURCE_UNAVAILABLE'});
  return outcome;
}
