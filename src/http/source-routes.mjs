import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {z} from 'zod';
import {authenticate,checkCsrf,checkOrigin,readSessionToken,tokenHash} from '../auth/session.mjs';
import {httpError,requireRole} from '../auth/authorize.mjs';
import {appendAudit,withTransaction} from '../db/transaction.mjs';
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

export function createSourceRouter({pool,config,recovery,registry,proxyHttp}) {
  const router=Router(),write=[requireRole('admin'),checkOrigin(config),checkCsrf];
  router.use('/api/sources',authenticate(pool));
  async function sourceFor(request,lock=false,tx=pool) {
    const {rows:[source]}=await tx.query(`SELECT id,group_id,kill_switch,session_health,selector_health,session_circuit,selector_circuit
      FROM group_sources WHERE organization_id=$1 AND id=$2 AND NOT archived${lock?' FOR UPDATE':''}`,[request.actor.organizationId,request.params.id]);
    if(!source)throw httpError(404,'Source not found');return source;
  }
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
