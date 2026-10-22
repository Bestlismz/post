import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {z} from 'zod';
import {authenticate,checkCsrf,checkOrigin} from '../auth/session.mjs';
import {httpError,requireRole} from '../auth/authorize.mjs';
import {appendAudit,runIdempotent,withTransaction} from '../db/transaction.mjs';
import {evaluateSourceDecision} from '../policy/source-decision.mjs';
import {evaluateSchedule} from '../workers/scheduler.mjs';
import {errorHandler} from './boundary.mjs';
import {readFormat} from '../replies/contracts.mjs';
import {defaultReplyFormat} from '../replies/renderer.mjs';

const pauseInput=z.strictObject({paused:z.boolean()});
const sample=z.strictObject({grounded:z.boolean(),automaticEligible:z.boolean(),confidence:z.number().min(0).max(1),replyWindowOpen:z.boolean(),optOut:z.boolean().optional(),humanTakeover:z.boolean().optional()});
const previewInput=z.strictObject({sourceId:z.string().min(1).max(200),sample});
const businessHours=z.strictObject({timeZone:z.string().min(1).max(100),days:z.array(z.number().int().min(0).max(6)).min(1),start:z.string(),end:z.string()});
const limits=z.strictObject({organization:z.number().int().positive(),source:z.number().int().positive(),conversation:z.number().int().positive()});
const policy=z.strictObject({mode:z.enum(['observe','approval','automatic']),minimumConfidence:z.number().min(0).max(1).optional(),rateLimits:limits.optional(),businessHours:businessHours.optional()});
const storedPolicy=z.strictObject({mode:z.enum(['observe','approval','automatic']),minimumConfidence:z.number().min(0).max(1),rateLimits:limits,businessHours});
const maintenance=z.strictObject({startsAt:z.iso.datetime(),endsAt:z.iso.datetime()});
const scheduleInput=z.strictObject({enabled:z.boolean(),cadenceMinutes:z.number().int().min(1).max(1440),timeZone:z.string().min(1).max(100),days:z.array(z.number().int().min(0).max(6)).min(1).max(7),start:z.string(),end:z.string(),dailyLimit:z.number().int().min(1).max(1440),maintenanceWindows:z.array(maintenance).max(100)});

function key(request) {
  const value=request.get('Idempotency-Key');
  if(!value?.trim()||value.length>200)throw httpError(422,'Invalid idempotency key');
  return value;
}
function revision(request) {
  const match=/^"?(0|[1-9]\d*)"?$/.exec(request.get('If-Match')??'');
  if(!match||!Number.isSafeInteger(Number(match[1])))throw httpError(409,'Current If-Match revision is required');
  return Number(match[1]);
}

export function createAutomationRouter({pool,config}) {
  const router=Router(),write=[requireRole('admin'),checkOrigin(config),checkCsrf];
  router.use('/api/automation',authenticate(pool));
  router.get('/api/automation',requireRole('admin','operator','viewer'),async(req,res)=>{
    const {rows:[organization]}=await pool.query('SELECT group_automation_paused,automation_policy,automation_policy_revision,reply_format,reply_format_revision FROM organizations WHERE id=$1',[req.actor.organizationId]);
    const [{rows:sources},{rows:receipts}]=await Promise.all([pool.query(`SELECT g.id,g.canonical_url,g.mode,g.policy,g.revision source_revision,g.kill_switch,g.session_health,g.selector_health,g.session_circuit,g.selector_circuit,
      s.enabled,s.cadence_minutes,s.time_zone,s.days,s.start_local,s.end_local,s.daily_limit,s.maintenance_windows,s.revision
      FROM group_sources g LEFT JOIN group_source_schedules s ON s.organization_id=g.organization_id AND s.source_id=g.id
      WHERE g.organization_id=$1 AND NOT g.archived ORDER BY g.created_at,g.id`,[req.actor.organizationId]),pool.query(`SELECT id,scope,source_id,paused,reason_code,created_at FROM automation_control_receipts WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25`,[req.actor.organizationId])]);
    res.json({actorRole:req.actor.role,paused:organization.group_automation_paused,policy:{value:organization.automation_policy,revision:organization.automation_policy_revision},replyFormat:{value:organization.reply_format??defaultReplyFormat(),revision:organization.reply_format_revision},sources:sources.map(row=>({id:row.id,label:row.canonical_url,mode:row.mode,policy:row.policy,revision:row.source_revision,paused:row.kill_switch,health:{session:row.session_health,selector:row.selector_health,sessionCircuit:row.session_circuit,selectorCircuit:row.selector_circuit},schedule:row.revision?{enabled:row.enabled,cadenceMinutes:row.cadence_minutes,timeZone:row.time_zone,days:row.days.map(Number),start:row.start_local,end:row.end_local,dailyLimit:row.daily_limit,maintenanceWindows:row.maintenance_windows,revision:row.revision}:null})),receipts:receipts.map(row=>({id:row.id,scope:row.scope,sourceId:row.source_id,paused:row.paused,reasonCode:row.reason_code,createdAt:row.created_at?.toISOString?.()??row.created_at}))});
  });
  router.post('/api/automation/policy-preview',requireRole('admin','operator'),async(req,res)=>{
    const input=previewInput.parse(req.body);
    const result=await withTransaction(pool,async tx=>{
      const {rows:[organization]}=await tx.query('SELECT group_automation_paused,automation_policy FROM organizations WHERE id=$1 FOR SHARE',[req.actor.organizationId]);
      const {rows:[source]}=await tx.query('SELECT * FROM group_sources WHERE organization_id=$1 AND id=$2 AND NOT archived FOR SHARE',[req.actor.organizationId,input.sourceId]);
      if(!source)throw httpError(404,'Source not found');
      const {rows:[counts]}=await tx.query(`SELECT count(*)::int organization,
        count(*) FILTER(WHERE coalesce(d.source_id,d.group_source_id)=$2)::int source
        FROM delivery_attempts a JOIN delivery_intents d ON d.organization_id=a.organization_id AND d.id=a.delivery_intent_id
        WHERE a.organization_id=$1 AND a.started_at>clock_timestamp()-interval '1 hour'`,[req.actor.organizationId,source.id]);
      const decision=evaluateSourceDecision({organizationPaused:organization.group_automation_paused,organizationPolicy:organization.automation_policy,source,context:{...input.sample,counts:{organization:counts.organization,source:counts.source,conversation:0}},now:new Date()});
      return {...decision,source:{id:source.id,label:source.canonical_url}};
    });
    res.json(result);
  });
  router.post('/api/automation/pause',...write,async(req,res)=>{
    const input=pauseInput.parse(req.body),idempotencyKey=key(req);
    const result=await withTransaction(pool,async tx=>runIdempotent(tx,{organizationId:req.actor.organizationId,actorId:req.actor.id,route:'automation.pause',key:idempotencyKey,body:input},async()=>{
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[req.actor.organizationId]);
      await tx.query('UPDATE organizations SET group_automation_paused=$2 WHERE id=$1',[req.actor.organizationId,input.paused]);
      const receiptId=randomUUID(),reasonCode=input.paused?'GLOBAL_PAUSED':'GLOBAL_RESUMED';
      await tx.query("INSERT INTO automation_control_receipts(id,organization_id,scope,paused,reason_code,actor_id) VALUES($1,$2,'organization',$3,$4,$5)",[receiptId,req.actor.organizationId,input.paused,reasonCode,req.actor.id]);
      await appendAudit(tx,{organizationId:req.actor.organizationId,actorId:req.actor.id,action:'automation.pause_changed',entityType:'organization',entityId:req.actor.organizationId,details:{paused:input.paused,reasonCode,receiptId}});
      return {status:200,body:{paused:input.paused,receiptId,reasonCode}};
    }));
    res.status(result.status).json(result.body);
  });
  for(const [route,column,revisionColumn,validate,action] of [
    ['policy','automation_policy','automation_policy_revision',value=>storedPolicy.parse(value),'automation.policy_changed'],
    ['reply-format','reply_format','reply_format_revision',value=>readFormat(value),'automation.reply_format_changed'],
  ]) router.put(`/api/automation/${route}`,...write,async(req,res)=>{
    const expectedRevision=revision(req),idempotencyKey=key(req);let value;
    try {value=validate(req.body);} catch(error){throw httpError(422,'Invalid automation configuration');}
    const result=await withTransaction(pool,async tx=>runIdempotent(tx,{organizationId:req.actor.organizationId,actorId:req.actor.id,route:`automation.${route}`,key:idempotencyKey,body:{value,expectedRevision}},async()=>{
      const {rows:[current]}=await tx.query(`SELECT ${revisionColumn} revision FROM organizations WHERE id=$1 FOR UPDATE`,[req.actor.organizationId]);
      if(current.revision!==expectedRevision)throw httpError(409,'Revision conflict');
      const next=expectedRevision+1;
      await tx.query(`UPDATE organizations SET ${column}=$2,${revisionColumn}=$3 WHERE id=$1`,[req.actor.organizationId,JSON.stringify(value),next]);
      await appendAudit(tx,{organizationId:req.actor.organizationId,actorId:req.actor.id,action,entityType:'organization',entityId:req.actor.organizationId,details:{revision:next}});
      return {status:200,body:{value,revision:next}};
    }));
    res.set('ETag',`"${result.body.revision}"`).status(result.status).json(result.body);
  });
  router.post('/api/automation/sources/:id/pause',...write,async(req,res)=>{
    const input=pauseInput.parse(req.body),idempotencyKey=key(req);
    const result=await withTransaction(pool,async tx=>runIdempotent(tx,{organizationId:req.actor.organizationId,actorId:req.actor.id,route:'automation.source.pause',key:idempotencyKey,body:{sourceId:req.params.id,...input}},async()=>{
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[req.actor.organizationId]);
      const {rows:[source]}=await tx.query('SELECT id FROM group_sources WHERE organization_id=$1 AND id=$2 AND NOT archived FOR UPDATE',[req.actor.organizationId,req.params.id]);
      if(!source)throw httpError(404,'Source not found');
      const {rows:[updated]}=await tx.query('UPDATE group_sources SET kill_switch=$3,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING revision,updated_at',[req.actor.organizationId,source.id,input.paused]);
      const receiptId=randomUUID(),reasonCode=input.paused?'SOURCE_PAUSED':'SOURCE_RESUMED';
      await tx.query("INSERT INTO automation_control_receipts(id,organization_id,scope,source_id,paused,reason_code,actor_id) VALUES($1,$2,'source',$3,$4,$5,$6)",[receiptId,req.actor.organizationId,source.id,input.paused,reasonCode,req.actor.id]);
      await appendAudit(tx,{organizationId:req.actor.organizationId,actorId:req.actor.id,action:'automation.source_pause_changed',entityType:'group_source',entityId:source.id,details:{paused:input.paused,reasonCode,receiptId}});
      return {status:200,body:{sourceId:source.id,paused:input.paused,revision:updated.revision,updatedAt:updated.updated_at.toISOString(),receiptId,reasonCode}};
    }));
    res.status(result.status).json(result.body);
  });
  router.put('/api/automation/sources/:id/schedule',...write,async(req,res)=>{
    const input=scheduleInput.parse(req.body),expectedRevision=revision(req),idempotencyKey=key(req);
    try {evaluateSchedule(input,new Date(),{completedToday:0});} catch {throw httpError(422,'Invalid schedule');}
    const result=await withTransaction(pool,async tx=>runIdempotent(tx,{organizationId:req.actor.organizationId,actorId:req.actor.id,route:'automation.source.schedule',key:idempotencyKey,body:{sourceId:req.params.id,input,expectedRevision}},async()=>{
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[req.actor.organizationId]);
      const {rows:[source]}=await tx.query('SELECT id FROM group_sources WHERE organization_id=$1 AND id=$2 AND NOT archived FOR UPDATE',[req.actor.organizationId,req.params.id]);
      if(!source)throw httpError(404,'Source not found');
      const {rows:[current]}=await tx.query('SELECT revision FROM group_source_schedules WHERE organization_id=$1 AND source_id=$2 FOR UPDATE',[req.actor.organizationId,source.id]);
      if((current?.revision??0)!==expectedRevision)throw httpError(409,'Revision conflict');
      const next=expectedRevision+1;
      await tx.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit,maintenance_windows,revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(organization_id,source_id) DO UPDATE SET enabled=EXCLUDED.enabled,cadence_minutes=EXCLUDED.cadence_minutes,time_zone=EXCLUDED.time_zone,days=EXCLUDED.days,start_local=EXCLUDED.start_local,end_local=EXCLUDED.end_local,daily_limit=EXCLUDED.daily_limit,maintenance_windows=EXCLUDED.maintenance_windows,revision=EXCLUDED.revision,updated_at=now()`,
        [req.actor.organizationId,source.id,input.enabled,input.cadenceMinutes,input.timeZone,input.days,input.start,input.end,input.dailyLimit,JSON.stringify(input.maintenanceWindows),next]);
      await appendAudit(tx,{organizationId:req.actor.organizationId,actorId:req.actor.id,action:'automation.schedule_changed',entityType:'group_source',entityId:source.id,details:{revision:next}});
      return {status:200,body:{sourceId:source.id,schedule:input,revision:next}};
    }));
    res.set('ETag',`"${result.body.revision}"`).status(result.status).json(result.body);
  });
  router.use('/api/automation',(_req,_res,next)=>next(httpError(404,'Resource not found')));
  router.use(errorHandler);
  return router;
}
