import {randomUUID} from 'node:crypto';
import {signCommand} from '../channels/groups/contracts.mjs';
import {withTransaction,appendAudit} from '../db/transaction.mjs';
import {enqueueJob} from '../jobs/queue.mjs';

const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const timePattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;

function localParts(instant,timeZone) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(instant).map(part=>[part.type,part.value]));
  return {day:weekdays.indexOf(parts.weekday),date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};
}

function validateSchedule(schedule) {
  if(!schedule || typeof schedule!=='object' || !Number.isSafeInteger(schedule.cadenceMinutes) || schedule.cadenceMinutes<1 || schedule.cadenceMinutes>1440)throw new Error('Invalid schedule');
  if(typeof schedule.timeZone!=='string' || !schedule.timeZone || !Array.isArray(schedule.days) || !schedule.days.length || schedule.days.some(day=>!Number.isInteger(day)||day<0||day>6))throw new Error('Invalid schedule');
  if(!timePattern.test(schedule.start)||!(timePattern.test(schedule.end)||schedule.end==='24:00')||schedule.start===schedule.end)throw new Error('Invalid schedule');
  if(!Number.isSafeInteger(schedule.dailyLimit)||schedule.dailyLimit<1||schedule.dailyLimit>1440||!Array.isArray(schedule.maintenanceWindows))throw new Error('Invalid schedule');
  try {localParts(new Date(0),schedule.timeZone);} catch {throw new Error('Invalid schedule');}
  for(const window of schedule.maintenanceWindows)if(!window||typeof window!=='object'||Object.keys(window).some(key=>!['startsAt','endsAt'].includes(key))||!Number.isFinite(Date.parse(window.startsAt))||!Number.isFinite(Date.parse(window.endsAt))||Date.parse(window.startsAt)>=Date.parse(window.endsAt))throw new Error('Invalid schedule');
  return schedule;
}

export function evaluateSchedule(scheduleValue,instantValue,state={}) {
  const schedule=validateSchedule(scheduleValue),instant=new Date(instantValue);
  if(!Number.isFinite(+instant))throw new Error('Invalid schedule instant');
  const local=localParts(instant,schedule.timeZone),reasons=[];
  if(schedule.enabled!==true)reasons.push('SCHEDULE_DISABLED');
  if(state.globalPaused)reasons.push('GLOBAL_PAUSED');
  if(state.sourcePaused)reasons.push('SOURCE_PAUSED');
  if(state.archived)reasons.push('SOURCE_ARCHIVED');
  if(state.sessionHealth!==undefined&&state.sessionHealth!=='healthy')reasons.push('SESSION_UNHEALTHY');
  if(state.sessionCircuit)reasons.push('SESSION_CIRCUIT_OPEN');
  if(state.selectorHealth!==undefined&&state.selectorHealth!=='healthy')reasons.push('SELECTOR_UNHEALTHY');
  if(state.selectorCircuit)reasons.push('SELECTOR_CIRCUIT_OPEN');
  if(state.selectorSupported===false)reasons.push('UNSUPPORTED_SELECTOR');
  const within=schedule.start<schedule.end
    ? schedule.days.includes(local.day)&&local.time>=schedule.start&&local.time<schedule.end
    : (local.time>=schedule.start&&schedule.days.includes(local.day))||(local.time<schedule.end&&schedule.days.includes((local.day+6)%7));
  if(!within)reasons.push('OUTSIDE_SCHEDULE_WINDOW');
  if(schedule.maintenanceWindows.some(window=>+instant>=Date.parse(window.startsAt)&&+instant<Date.parse(window.endsAt)))reasons.push('MAINTENANCE_WINDOW');
  if((state.completedToday??0)>=schedule.dailyLimit)reasons.push('DAILY_LIMIT_REACHED');
  const slotMs=schedule.cadenceMinutes*60000,slot=new Date(Math.floor(+instant/slotMs)*slotMs).toISOString();
  return {eligible:reasons.length===0,reasons,localDay:local.date,slot};
}

function fromRow(row) {
  return {enabled:row.enabled,cadenceMinutes:row.cadence_minutes,timeZone:row.time_zone,days:row.days.map(Number),start:row.start_local,end:row.end_local,dailyLimit:row.daily_limit,maintenanceWindows:row.maintenance_windows};
}

export function createGroupScheduler({pool,signingKey,keyId,supportedSelectorVersions=[]}) {
  if(!signingKey||!keyId)throw new Error('Scheduler signing configuration required');
  return {async tick() {
    const {rows:[databaseClock]}=await pool.query('SELECT clock_timestamp() AS now');
    const now=databaseClock.now;
    const {rows:sources}=await pool.query(`SELECT s.organization_id,s.source_id FROM group_source_schedules s
      JOIN group_sources g ON g.organization_id=s.organization_id AND g.id=s.source_id ORDER BY s.organization_id,s.source_id`);
    const summary={considered:0,scheduled:0,skipped:0};
    for(const identity of sources) {
      const result=await withTransaction(pool,async tx=>{
        const {rows:[org]}=await tx.query('SELECT group_automation_paused FROM organizations WHERE id=$1 FOR UPDATE',[identity.organization_id]);
        const {rows:[row]}=await tx.query(`SELECT s.*,g.group_id,g.canonical_url,g.kill_switch,g.archived,g.session_health,g.selector_health,g.session_circuit,g.selector_circuit,g.selector_version
          FROM group_source_schedules s JOIN group_sources g ON g.organization_id=s.organization_id AND g.id=s.source_id
          WHERE s.organization_id=$1 AND s.source_id=$2 FOR UPDATE OF g`,[identity.organization_id,identity.source_id]);
        if(!row)return null;
        const schedule=fromRow(row),state={globalPaused:org.group_automation_paused,sourcePaused:row.kill_switch,archived:row.archived,sessionHealth:row.session_health,sessionCircuit:row.session_circuit,selectorHealth:row.selector_health,selectorCircuit:row.selector_circuit,selectorSupported:supportedSelectorVersions.includes(row.selector_version),completedToday:0};
        let preliminary,invalidSchedule=false;
        try {preliminary=evaluateSchedule(schedule,now,state);} catch {
          invalidSchedule=true;
          const cadence=Number.isSafeInteger(schedule.cadenceMinutes)&&schedule.cadenceMinutes>=1&&schedule.cadenceMinutes<=1440?schedule.cadenceMinutes:15;
          const slotMs=cadence*60000;
          preliminary={eligible:false,reasons:['INVALID_SCHEDULE'],localDay:now.toISOString().slice(0,10),slot:new Date(Math.floor(+now/slotMs)*slotMs).toISOString()};
        }
        if((await tx.query('SELECT 1 FROM group_schedule_receipts WHERE organization_id=$1 AND source_id=$2 AND schedule_slot=$3',[row.organization_id,row.source_id,preliminary.slot])).rowCount)return {deduplicated:true};
        const {rows:[count]}=await tx.query("SELECT count(*)::int n FROM group_schedule_receipts WHERE organization_id=$1 AND source_id=$2 AND local_day=$3 AND state='scheduled'",[row.organization_id,row.source_id,preliminary.localDay]);
        const decision=invalidSchedule?preliminary:evaluateSchedule(schedule,now,{...state,completedToday:count.n});
        const receiptId=randomUUID(),snapshot={...schedule,selectorVersion:row.selector_version};
        if(!decision.eligible) {
          await tx.query(`INSERT INTO group_schedule_receipts(id,organization_id,source_id,schedule_slot,local_day,state,reason_codes,schedule_snapshot)
            VALUES($1,$2,$3,$4,$5,'skipped',$6,$7)`,[receiptId,row.organization_id,row.source_id,decision.slot,decision.localDay,decision.reasons,JSON.stringify(snapshot)]);
          await appendAudit(tx,{organizationId:row.organization_id,action:'group.scan_skipped',entityType:'group_source',entityId:row.source_id,details:{receiptId,slot:decision.slot,reasons:decision.reasons}});
          return {scheduled:false};
        }
        const operationId=randomUUID(),command=signCommand({version:1,kind:'ScanCommand',operationId,sourceId:row.source_id,groupId:row.group_id,canonicalTarget:row.canonical_url,issuedAt:now.toISOString(),expiresAt:new Date(+now+300000).toISOString(),keyId},{key:signingKey,keyId,now});
        await tx.query("INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES($1,$2,$3,'ScanCommand',$4)",[operationId,row.organization_id,row.source_id,JSON.stringify(command)]);
        const job=await enqueueJob(tx,{organizationId:row.organization_id,kind:'group.scan',payload:{operationId,sourceId:row.source_id,scheduleSlot:decision.slot},retrySafe:true});
        await tx.query(`INSERT INTO group_schedule_receipts(id,organization_id,source_id,schedule_slot,local_day,state,reason_codes,operation_id,job_id,schedule_snapshot)
          VALUES($1,$2,$3,$4,$5,'scheduled','{}',$6,$7,$8)`,[receiptId,row.organization_id,row.source_id,decision.slot,decision.localDay,operationId,job.id,JSON.stringify(snapshot)]);
        await appendAudit(tx,{organizationId:row.organization_id,action:'group.scan_scheduled',entityType:'group_operation',entityId:operationId,details:{receiptId,sourceId:row.source_id,slot:decision.slot}});
        return {scheduled:true};
      });
      if(!result?.deduplicated)summary.considered++;
      if(result?.scheduled)summary.scheduled++;else if(result&&!result.deduplicated)summary.skipped++;
    }
    return summary;
  }};
}
