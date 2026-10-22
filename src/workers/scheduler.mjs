import {randomUUID} from 'node:crypto';
import {appendAudit} from '../db/transaction.mjs';
import {enqueueJob} from '../jobs/queue.mjs';

const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const timePattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function groupSchedulerConfig(env=process.env) {
  const keyId=env.GROUP_COMMAND_KEY_ID,raw=env.GROUP_COMMAND_KEYS;
  if(!keyId&&!raw)return null;
  try {
    if(typeof keyId!=='string'||!keyId||keyId.length>100||typeof raw!=='string')throw new Error();
    const encoded=JSON.parse(raw);
    if(!encoded||typeof encoded!=='object'||Array.isArray(encoded)||!Object.hasOwn(encoded,keyId))throw new Error();
    const keys={};
    for(const [id,value] of Object.entries(encoded)) {
      if(!id||id.length>100||typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/u.test(value))throw new Error();
      const decoded=Buffer.from(value,'base64');if(decoded.length!==32||decoded.toString('base64')!==value)throw new Error();keys[id]=decoded;
    }
    return {keyId,key:keys[keyId],keys};
  } catch {throw new Error('Invalid group scheduler signing configuration');}
}

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

function abortError(signal) {return signal?.reason instanceof Error?signal.reason:Object.assign(Error('Scheduler aborted'),{name:'AbortError'});}
function timeoutError() {return Object.assign(Error('Scheduler tick timed out'),{code:'SCHEDULER_TICK_TIMEOUT'});}
function checkDeadline(signal,deadline) {
  if(signal?.aborted)throw abortError(signal);
  const remaining=deadline-performance.now();if(remaining<=0)throw timeoutError();
  return remaining;
}
async function acquireClient(pool,deadline,signal) {
  const pending=pool.connect(),remaining=checkDeadline(signal,deadline);let timer,onAbort;
  const boundary=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(timeoutError()),remaining);
    if(signal) {onAbort=()=>reject(abortError(signal));signal.addEventListener('abort',onAbort,{once:true});}
  });
  try {return await Promise.race([pending,boundary]);}
  catch(error) {pending.then(client=>client.release(),()=>{});throw error;}
  finally {clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
}
async function boundedTransaction(pool,deadline,signal,fn) {
  const tx=await acquireClient(pool,deadline,signal);let releaseError;
  try {
    checkDeadline(signal,deadline);await tx.query('BEGIN');
    await tx.query("SELECT set_config('statement_timeout',$1,true)",[`${Math.max(1,Math.ceil(checkDeadline(signal,deadline)))}ms`]);
    const result=await fn(tx);checkDeadline(signal,deadline);await tx.query('COMMIT');return result;
  } catch(error) {
    try {await tx.query('ROLLBACK');} catch(rollbackError) {releaseError=rollbackError;}
    throw error;
  } finally {tx.release(releaseError);}
}

export function createGroupScheduler({pool,supportedSelectorVersions=[],batchSize=50,tickTimeoutMs=30000}) {
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>500||!Number.isSafeInteger(tickTimeoutMs)||tickTimeoutMs<10||tickTimeoutMs>60000)throw Error('Invalid scheduler bounds');
  let cursor=null;
  return {async tick({signal}={}) {
    const deadline=performance.now()+tickTimeoutMs;
    const {databaseClock,sources}=await boundedTransaction(pool,deadline,signal,async tx=>{
      const {rows:[databaseClock]}=await tx.query('SELECT clock_timestamp() AS now');
      const {rows:sources}=await tx.query(`SELECT s.organization_id,s.source_id FROM group_source_schedules s
        JOIN group_sources g ON g.organization_id=s.organization_id AND g.id=s.source_id
        WHERE ($1::text IS NULL OR (s.organization_id,s.source_id)>($1,$2))
        ORDER BY s.organization_id,s.source_id LIMIT $3`,[cursor?.organizationId??null,cursor?.sourceId??'',batchSize]);
      return {databaseClock,sources};
    });
    const now=databaseClock.now;
    const summary={considered:0,scheduled:0,skipped:0};
    for(const identity of sources) {
      checkDeadline(signal,deadline);
      const result=await boundedTransaction(pool,deadline,signal,async tx=>{
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
        const job=await enqueueJob(tx,{organizationId:row.organization_id,kind:'group.scan',payload:{sourceId:row.source_id,scheduleSlot:decision.slot,scheduleReceiptId:receiptId},retrySafe:true});
        await tx.query(`INSERT INTO group_schedule_receipts(id,organization_id,source_id,schedule_slot,local_day,state,reason_codes,operation_id,job_id,schedule_snapshot)
          VALUES($1,$2,$3,$4,$5,'scheduled','{}',NULL,$6,$7)`,[receiptId,row.organization_id,row.source_id,decision.slot,decision.localDay,job.id,JSON.stringify(snapshot)]);
        await appendAudit(tx,{organizationId:row.organization_id,action:'group.scan_scheduled',entityType:'group_schedule_receipt',entityId:receiptId,details:{jobId:job.id,sourceId:row.source_id,slot:decision.slot}});
        return {scheduled:true};
      });
      if(!result?.deduplicated)summary.considered++;
      if(result?.scheduled)summary.scheduled++;else if(result&&!result.deduplicated)summary.skipped++;
    }
    cursor=sources.length===batchSize?{organizationId:sources.at(-1).organization_id,sourceId:sources.at(-1).source_id}:null;
    return summary;
  }};
}
