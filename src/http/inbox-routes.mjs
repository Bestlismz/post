import {Router} from 'express';
import {z} from 'zod';
import {authenticate,checkCsrf,checkOrigin} from '../auth/session.mjs';
import {httpError,requireRole} from '../auth/authorize.mjs';
import {commandFor,errorHandler} from './boundary.mjs';
import {createInboxQueries} from '../inbox/queries.mjs';
import {createInboxService,loadContext} from '../inbox/service.mjs';
import {withTransaction,runIdempotent} from '../db/transaction.mjs';
import {enqueueJob} from '../jobs/queue.mjs';
import {operationReceipt} from '../inbox/receipts.mjs';

const querySchema=z.strictObject({limit:z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(100)).optional(),
  channel:z.enum(['messenger','facebook_group']).optional(),sourceId:z.string().min(1).max(200).optional(),
  search:z.string().max(500).optional(),cursor:z.string().min(1).max(2048).optional()});
const empty=z.strictObject({});
const edit=z.strictObject({text:z.string().trim().min(1).max(4000)});
const receiptResponse=result=>({operation:result.operation});

export function createInboxRouter({pool,config,events={}}) {
  const router=Router(),queries=createInboxQueries({pool}),service=createInboxService({pool});
  const write=[requireRole('admin','operator'),checkOrigin(config),checkCsrf];
  router.use(['/api/inbox','/api/replies'],authenticate(pool));
  router.get('/api/inbox/events',createReceiptStream({pool,...events}));
  router.get('/api/inbox',async(req,res)=>res.json(await queries.listInbox(querySchema.parse(req.query),req.actor)));
  router.get('/api/inbox/:id',async(req,res)=>{
    const item=await queries.getInboxItem(req.params.id,req.actor);
    if(!item) throw httpError(404,'Inbox item not found');
    res.set('ETag',`"${item.processingRevision}"`).json(item);
  });
  router.post('/api/inbox/:id/prepare',...write,async(req,res)=>{
    const command=commandFor(req,empty.parse(req.body));
    if(command.idempotencyKey.length>200) throw httpError(422,'Invalid idempotency key');
    const result=await withTransaction(pool,tx=>runIdempotent(tx,{
      organizationId:req.actor.organizationId,actorId:req.actor.id,route:'inbox.prepare',key:command.idempotencyKey,
      body:{id:req.params.id,revision:command.expectedRevision},
    },async()=>{
      const context=await loadContext(tx,req.params.id,command.expectedRevision,req.actor.organizationId);
      await enqueueJob(tx,{organizationId:req.actor.organizationId,kind:'analyze_work_item',retrySafe:true,
        payload:{workItemId:context.item.id,conversationId:context.conversation.id,processingRevision:command.expectedRevision}});
      const operation=await operationReceipt(tx,{organizationId:req.actor.organizationId,resourceId:context.item.id,resourceType:'work_item'});
      return {status:202,body:{operation}};
    }));
    res.status(result.status).json(result.body);
  });
  router.post('/api/replies/:id/approve',...write,async(req,res)=>{
    const command=commandFor(req,empty.parse(req.body));
    const result=await service.approveAndQueue(req.params.id,command.expectedRevision,req.actor,{idempotencyKey:command.idempotencyKey});
    res.status(202).json(receiptResponse(result));
  });
  router.post('/api/replies/:id/edit',...write,async(req,res)=>{
    const body=edit.parse(req.body),command=commandFor(req,body);
    const reply=await service.editReply(req.params.id,command.expectedRevision,body.text,req.actor,{idempotencyKey:command.idempotencyKey});
    res.json({reply:{id:reply.id,version:reply.version,processingRevision:reply.conversation_revision,text:reply.content.text}});
  });
  router.post('/api/inbox/:id/handoff',...write,async(req,res)=>{
    const {reason}=z.strictObject({reason:z.string().trim().min(1).max(200)}).parse(req.body);
    const command=commandFor(req,{reason});
    const result=await service.requestHandoff(req.params.id,reason,req.actor,{idempotencyKey:command.idempotencyKey,expectedRevision:command.expectedRevision});
    res.status(202).json(receiptResponse(result));
  });
  router.use(['/api/inbox','/api/replies'],(_req,_res,next)=>next(httpError(404,'Resource not found')));
  router.use(errorHandler);
  return router;
}

export function createReceiptStream({pool,pollMs=1000,heartbeatMs=15000,maxConnections=100,maxConnectionsPerSession=3,maxReplay=500,signal}) {
  let active=0;const sessions=new Map();
  return async(req,res)=>{
    if(signal?.aborted)throw httpError(503,'Event service stopping');
    const raw=req.get('Last-Event-ID') ?? '0';
    if(!/^\d{1,18}$/.test(raw)) throw httpError(400,'Invalid Last-Event-ID');
    if(Object.keys(req.query).length) throw httpError(400,'Invalid event query');
    const key=req.session.id;
    if(active>=maxConnections || (sessions.get(key)??0)>=maxConnectionsPerSession) throw Object.assign(httpError(429,'Too many event streams'),{retryAfter:15});
    const org=req.actor.organizationId;
    // Read the high watermark and bounded backlog in one statement snapshot.
    const replay=async cursor=>(await pool.query(`WITH watermark AS (SELECT coalesce(max(event_position),0)::text AS high FROM outbox WHERE organization_id=$1 AND kind IN ('inbox.operation','inbox.changed'))
      SELECT high,(SELECT coalesce(jsonb_agg(row_to_json(e) ORDER BY e.event_position),'[]') FROM
        (SELECT event_position::text AS position,event_position,payload FROM outbox WHERE organization_id=$1
         AND kind IN ('inbox.operation','inbox.changed') AND event_position>$2 ORDER BY event_position LIMIT $3) e) AS events FROM watermark`,[org,cursor,maxReplay+1])).rows[0];
    active++;sessions.set(key,(sessions.get(key)??0)+1);
    let closed=false,busy=false,cursor=raw,timer,heartbeat;
    const stop=()=>{cleanup();res.end();};
    const cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);clearInterval(heartbeat);signal?.removeEventListener('abort',stop);active--;const count=sessions.get(key)-1;if(count)sessions.set(key,count);else sessions.delete(key);};
    signal?.addEventListener('abort',stop,{once:true});
    res.on('close',cleanup);res.on('error',cleanup);
    let initial;
    try {initial=await replay(raw);} catch(error){cleanup();throw error;}
    if(closed)return;
    res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});
    res.flushHeaders();
    const send=text=>{if(closed)return false;if(!res.write(text)){cleanup();res.end();return false;}return true;};
    const emit=batch=>{
      if(batch.events.length>maxReplay || BigInt(cursor)>BigInt(batch.high)) {
        cursor=batch.high;
        return send(`id: ${cursor}\nevent: reset\ndata: ${JSON.stringify({receiptId:null,resourceId:null,resourceType:'inbox',state:'refetch'})}\n\n`);
      }
      for(const row of batch.events) {
        const p=row.payload;
        cursor=row.position;
        if(!send(`id: ${cursor}\nevent: inbox\ndata: ${JSON.stringify({receiptId:p.receiptId,resourceId:p.resourceId,resourceType:p.resourceType,state:p.state})}\n\n`))return false;
      }
      return true;
    };
    if(!emit(initial))return;
    if(!initial.events.length && !send(': heartbeat\n\n'))return;
    timer=setInterval(async()=>{
      if(closed || busy)return;busy=true;
      try {
        const session=(await pool.query('SELECT 1 FROM sessions s JOIN memberships m ON m.organization_id=s.organization_id AND m.user_id=s.user_id WHERE s.id=$1 AND s.organization_id=$2 AND s.expires_at>now()',[key,org])).rowCount;
        if(!session){cleanup();res.end();return;}
        emit(await replay(cursor));
      } catch {cleanup();res.end();} finally {busy=false;}
    },pollMs);
    heartbeat=setInterval(()=>send(': heartbeat\n\n'),heartbeatMs);
    timer.unref();heartbeat.unref();
  };
}
