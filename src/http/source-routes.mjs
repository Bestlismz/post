import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {z} from 'zod';
import {authenticate,checkCsrf,checkOrigin,readSessionToken,tokenHash} from '../auth/session.mjs';
import {httpError,requireRole} from '../auth/authorize.mjs';
import {appendAudit,withTransaction} from '../db/transaction.mjs';
import {publicSourceUpdatePatch} from '../automation/contracts.mjs';
import {errorHandler} from './boundary.mjs';

const recoveryInput=z.strictObject({ttlSeconds:z.number().int().min(30).max(600)});

export function createRecoveryRegistry({clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,onExpire=()=>{}}={}) {
  const sessions=new Map();
  const key=(sourceId,sessionId)=>`${sourceId}:${sessionId}`;
  const publicRecord=record=>({organizationId:record.organizationId,sourceId:record.sourceId,sessionId:record.sessionId,expiresAt:record.expiresAt});
  function close(record,expired=false) {
    if(!record||!sessions.delete(key(record.sourceId,record.sessionId)))return false;
    clearTimer(record.timer);
    for(const socket of record.sockets)socket.destroy();
    record.sockets.clear();
    if(expired)Promise.resolve(onExpire(publicRecord(record))).catch(()=>{});
    return true;
  }
  function lookup({organizationId,sourceId,sessionId}) {
    const record=sessions.get(key(sourceId,sessionId));
    if(!record||record.organizationId!==organizationId)return null;
    if(Date.parse(record.expiresAt)<=clock()){close(record,true);return null;}
    return record;
  }
  return {
    start({organizationId,sourceId,expiresAt}) {
      const expiry=Date.parse(expiresAt),now=clock();
      if(!organizationId||!sourceId||!Number.isFinite(expiry)||expiry<=now)throw new Error('Invalid recovery lease');
      const sessionId=randomUUID(),record={organizationId,sourceId,sessionId,expiresAt:new Date(expiry).toISOString(),sockets:new Set()};
      record.timer=setTimer(()=>close(record,true),Math.max(0,expiry-now));record.timer?.unref?.();sessions.set(key(sourceId,sessionId),record);
      return publicRecord(record);
    },
    get({organizationId,sourceId,sessionId}) {
      const record=lookup({organizationId,sourceId,sessionId});return record?publicRecord(record):null;
    },
    close(input) {return close(lookup(input));},
    attachSocket(input,socket) {
      const record=lookup(input);if(!record||!socket||typeof socket.destroy!=='function'||typeof socket.once!=='function')return false;
      record.sockets.add(socket);socket.once('close',()=>{record.sockets.delete(socket);if(sessions.has(key(record.sourceId,record.sessionId))&&record.sockets.size===0)close(record,true);});return true;
    },
    closeAll(){for(const record of [...sessions.values()])close(record,true);},
  };
}

export async function authorizeRecoveryUpgrade({pool,registry,request}) {
  const url=new URL(request.url??'','http://internal');
  const match=/^\/api\/sources\/([^/]+)\/recovery\/([^/]+)\/novnc\/websockify$/.exec(url.pathname);
  if(!match)throw httpError(404,'Recovery tunnel not found');
  const token=readSessionToken(request);if(!token)throw httpError(401,'Authentication required');
  const {rows:[actor]}=await pool.query(`SELECT s.organization_id,m.role FROM sessions s JOIN memberships m ON m.organization_id=s.organization_id AND m.user_id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now()`,[tokenHash(token)]);
  if(!actor)throw httpError(401,'Authentication required');if(actor.role!=='admin')throw httpError(403,'Role does not permit this action');
  const sourceId=decodeURIComponent(match[1]),sessionId=decodeURIComponent(match[2]);
  if(!registry.get({organizationId:actor.organization_id,sourceId,sessionId}))throw httpError(404,'Recovery session not found');
  return {targetPath:'/websockify',identity:{organizationId:actor.organization_id,sourceId,sessionId}};
}

function publicGroup(row) {
  const receipt=value=>value?{
    operationId:value.operationId??value.operation_id,
    coverage:value.coverage,
    health:value.health,
    reason:value.reason??null,
    createdAt:(value.createdAt??value.created_at)?.toISOString?.()??value.createdAt??value.created_at,
  }:null;
  return {
    id:row.id,
    canonicalUrl:row.canonical_url,
    mode:row.mode,
    allowListed:row.allow_listed,
    policy:row.policy,
    health:{session:row.session_health,selector:row.selector_health,sessionCircuit:row.session_circuit,selectorCircuit:row.selector_circuit},
    paused:row.kill_switch,
    revision:row.revision,
    latestOperation:row.operation_id?{operationId:row.operation_id,state:row.operation_completed?'completed':row.operation_stuck?'stuck':'queued',createdAt:row.operation_created_at?.toISOString?.()??row.operation_created_at}:null,
    latestReceipt:receipt(row.receipt_operation_id?{operationId:row.receipt_operation_id,coverage:row.receipt_coverage,health:row.receipt_health,reason:row.receipt_reason,createdAt:row.receipt_created_at}:null),
    receiptHistory:(row.receipt_history??[]).map(receipt),
    session:{owner:'group-worker',state:row.session_health==='healthy'?'available':row.session_health},
  };
}

function publicSource(entity) {
  return {id:entity.id,canonicalUrl:entity.canonicalUrl,mode:entity.mode,allowListed:entity.allowListed,policy:entity.policy,
    health:{session:entity.sessionHealth,selector:entity.selectorHealth,sessionCircuit:entity.sessionCircuit,selectorCircuit:entity.selectorCircuit},paused:entity.killSwitch,revision:entity.revision};
}

export function createSourceRouter({pool,config,recovery,registry,proxyHttp,sourceService}) {
  const router=Router(),write=[requireRole('admin'),checkOrigin(config),checkCsrf],scanWrite=[requireRole('admin','operator'),checkOrigin(config),checkCsrf];
  router.use('/api/sources',authenticate(pool));
  async function sourceFor(request,lock=false,tx=pool) {
    const {rows:[source]}=await tx.query(`SELECT id,group_id,kill_switch,session_health,selector_health,session_circuit,selector_circuit
      FROM group_sources WHERE organization_id=$1 AND id=$2 AND NOT archived${lock?' FOR UPDATE':''}`,[request.actor.organizationId,request.params.id]);
    if(!source)throw httpError(404,'Source not found');return source;
  }
  router.get('/api/sources',requireRole('admin','operator','viewer'),async(request,response,next)=>{
    try {
      const [{rows:pages},{rows:groups}]=await Promise.all([
        pool.query(`SELECT id,name,health,expires_at,updated_at FROM meta_page_sources WHERE organization_id=$1 ORDER BY updated_at DESC,id`,[request.actor.organizationId]),
        pool.query(`SELECT g.*,op.id operation_id,op.created_at operation_created_at,(op_receipt.operation_id IS NOT NULL) operation_completed,
          (op_receipt.operation_id IS NULL AND op.created_at<clock_timestamp()-interval '10 minutes') operation_stuck,
          receipt.operation_id receipt_operation_id,receipt.coverage receipt_coverage,receipt.health receipt_health,receipt.reason receipt_reason,receipt.created_at receipt_created_at,
          coalesce(history.items,'[]'::jsonb) receipt_history
          FROM group_sources g
          LEFT JOIN LATERAL (SELECT id,created_at FROM group_operations WHERE organization_id=g.organization_id AND source_id=g.id AND kind='ScanCommand' ORDER BY operation_order DESC LIMIT 1) op ON true
          LEFT JOIN group_scan_receipts op_receipt ON op_receipt.organization_id=g.organization_id AND op_receipt.operation_id=op.id
          LEFT JOIN LATERAL (SELECT r.* FROM group_scan_receipts r JOIN group_operations ro ON ro.organization_id=r.organization_id AND ro.id=r.operation_id
            WHERE r.organization_id=g.organization_id AND r.source_id=g.id ORDER BY ro.operation_order DESC LIMIT 1) receipt ON true
          LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('operationId',h.operation_id,'coverage',h.coverage,'health',h.health,'reason',h.reason,'createdAt',h.created_at) ORDER BY h.operation_order DESC) items
            FROM (SELECT r.*,ro.operation_order FROM group_scan_receipts r JOIN group_operations ro ON ro.organization_id=r.organization_id AND ro.id=r.operation_id
              WHERE r.organization_id=g.organization_id AND r.source_id=g.id ORDER BY ro.operation_order DESC LIMIT 5) h) history ON true
          WHERE g.organization_id=$1 AND NOT g.archived ORDER BY g.created_at,g.id`,[request.actor.organizationId]),
      ]);
      response.json({actorRole:request.actor.role,pages:pages.map(row=>({id:row.id,name:row.name,health:row.health,expiresAt:row.expires_at?.toISOString?.()??row.expires_at,updatedAt:row.updated_at?.toISOString?.()??row.updated_at})),groups:groups.map(publicGroup)});
    } catch(error){next(error);}
  });
  router.post('/api/sources/groups',...write,async(request,response,next)=>{
    try {
      if(!sourceService)throw httpError(503,'Group source service unavailable');
      const url=z.strictObject({url:z.string().max(2000)}).parse(request.body).url;
      let entity;
      try {entity=await sourceService.addGroupSource({organizationId:request.actor.organizationId,actorId:request.actor.id,idempotencyKey:request.get('Idempotency-Key'),input:{url}});}
      catch(error){if(/group URL/i.test(error.message))throw httpError(422,'Invalid group URL');throw error;}
      response.status(201).json(publicSource(entity));
    } catch(error){next(error);}
  });
  router.patch('/api/sources/groups/:id',...write,async(request,response,next)=>{
    try {
      if(!sourceService)throw httpError(503,'Group source service unavailable');
      const match=/^"?(0|[1-9]\d*)"?$/.exec(request.get('If-Match')??'');
      if(!match)throw httpError(409,'Current If-Match revision is required');
      const patch=publicSourceUpdatePatch.parse(request.body);
      const entity=await sourceService.updateGroupSource({organizationId:request.actor.organizationId,actorId:request.actor.id,idempotencyKey:request.get('Idempotency-Key'),expectedRevision:Number(match[1]),input:{id:request.params.id,...patch}});
      response.json(publicSource(entity));
    } catch(error){next(error);}
  });
  router.post('/api/sources/groups/:id/scans',...scanWrite,async(request,response,next)=>{
    try {
      if(!sourceService)throw httpError(503,'Group source service unavailable');
      const match=/^"?([1-9]\d*)"?$/.exec(request.get('If-Match')??'');
      if(!match)throw httpError(409,'Current If-Match revision is required');
      const input=z.strictObject({recovery:z.boolean().optional()}).parse(request.body??{});
      const result=await sourceService.requestGroupScan({organizationId:request.actor.organizationId,actorId:request.actor.id,idempotencyKey:request.get('Idempotency-Key'),expectedRevision:Number(match[1]),input:{id:request.params.id,...input}});
      response.status(202).json({operationId:result.operationId,state:'queued'});
    } catch(error){next(error);}
  });
  router.get('/api/sources/:id/browser-health',requireRole('admin','operator','viewer'),async(request,response,next)=>{
    try {const source=await sourceFor(request),browser=await recovery.health();response.json({sourceId:source.id,sourceHealth:{session:source.session_health,selector:source.selector_health,sessionCircuit:source.session_circuit,selectorCircuit:source.selector_circuit,paused:source.kill_switch},browser});}catch(error){next(error);}
  });
  router.post('/api/sources/:id/recovery',...write,async(request,response,next)=>{
    let started;
    try {
      const input=recoveryInput.parse(request.body),source=await sourceFor(request);
      started=await recovery.start({sourceId:source.id,groupId:source.group_id,ttlSeconds:input.ttlSeconds});
      await withTransaction(pool,async tx=>{
        const locked=await sourceFor(request,true,tx);
        if(locked.group_id!==source.group_id)throw httpError(409,'Source changed');
        await tx.query('UPDATE group_sources SET kill_switch=true,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2',[request.actor.organizationId,source.id]);
        await appendAudit(tx,{organizationId:request.actor.organizationId,actorId:request.actor.id,action:'group.recovery_started',entityType:'group_source',entityId:source.id,details:{expiresAt:started.expiresAt,reasonCode:'MANUAL_SESSION_RECOVERY'}});
      });
      const local=registry.start({organizationId:request.actor.organizationId,sourceId:source.id,expiresAt:started.expiresAt});
      const socketPath=`/api/sources/${encodeURIComponent(source.id)}/recovery/${local.sessionId}/novnc/websockify`;
      response.status(201).json({sourceId:source.id,sessionId:local.sessionId,expiresAt:local.expiresAt,tunnelUrl:`/api/sources/${encodeURIComponent(source.id)}/recovery/${local.sessionId}/novnc/vnc.html?autoconnect=1&resize=scale&path=${encodeURIComponent(socketPath)}`});
    } catch(error) {if(started)await recovery.stop({sourceId:request.params.id}).catch(()=>{});next(error);}
  });
  router.delete('/api/sources/:id/recovery/:sessionId',...write,async(request,response,next)=>{
    try {
      await sourceFor(request);const identity={organizationId:request.actor.organizationId,sourceId:request.params.id,sessionId:request.params.sessionId};
      if(!registry.get(identity))throw httpError(404,'Recovery session not found');
      registry.close(identity);await recovery.stop({sourceId:request.params.id});
      await withTransaction(pool,tx=>appendAudit(tx,{organizationId:request.actor.organizationId,actorId:request.actor.id,action:'group.recovery_closed',entityType:'group_source',entityId:request.params.id,details:{reasonCode:'MANUAL_RECOVERY_CLOSED'}}));
      response.status(204).end();
    } catch(error){next(error);}
  });
  router.use('/api/sources/:id/recovery/:sessionId/novnc',requireRole('admin'),async(request,response,next)=>{
    try {
      await sourceFor(request);const identity={organizationId:request.actor.organizationId,sourceId:request.params.id,sessionId:request.params.sessionId};
      if(!registry.get(identity))throw httpError(404,'Recovery session not found');
      if(typeof proxyHttp!=='function')throw httpError(503,'Recovery tunnel unavailable');
      request.url=request.originalUrl.replace(/^\/api\/sources\/[^/]+\/recovery\/[^/]+\/novnc/,'')||'/';
      proxyHttp(request,response,next);
    } catch(error){next(error);}
  });
  router.use('/api/sources',(_request,_response,next)=>next(httpError(404,'Resource not found')));
  router.use(errorHandler);
  return router;
}
