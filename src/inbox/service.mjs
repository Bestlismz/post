import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withTransaction, appendAudit, runIdempotent } from '../db/transaction.mjs';
import { enqueueJob } from '../jobs/queue.mjs';
import { authorizeInboxActor } from './repository.mjs';
import { validateInboxText } from './validation.mjs';
import { httpError } from '../auth/authorize.mjs';
import { inboxConflict, freshnessConflictCodes } from './errors.mjs';
import { extractRequirements, extractDeterministicRequirements, requirementConfidence } from '../replies/extractor.mjs';
import { composeSelections, composeDeterministicSelections } from '../replies/composer.mjs';
import { defaultReplyFormat, renderReply } from '../replies/renderer.mjs';
import { validateReply } from '../replies/validator.mjs';
import { matchInventory } from '../inventory/matcher.mjs';
import { getUnit, getProject, saveSnapshot } from '../inventory/repository.mjs';
import { snapshotUnitFacts } from '../inventory/facts.mjs';
import { evaluatePolicy } from '../policy/evaluator.mjs';
import { operationReceipt } from './receipts.mjs';

const fail = (message,code='INVALID_REPLY_STATE') => { throw inboxConflict(code,message); };
const sourceHealth = (source,now=new Date()) => source?.channel==='facebook_group'
  ? !source.allow_listed||source.kill_switch||source.archived ? 'unavailable'
    : source.session_circuit||source.session_health!=='healthy' ? source.session_health
    : source.selector_circuit||source.selector_health!=='healthy' ? 'selector_failure' : 'connected'
  : source?.expires_at && new Date(source.expires_at)<=now ? 'expired' : source?.health;
const policyFor = context => context.conversation.channel==='facebook_group'
  ? {...context.org.automation_policy,...context.source.policy,mode:context.source.mode}
  : context.org.automation_policy;
const sourceEvidence = source => source?.channel==='facebook_group'
  ? {id:source.id,health:sourceHealth(source),expiresAt:null,mode:source.mode,policy:source.policy,revision:source.revision,allowListed:source.allow_listed}
  : source ? {id:source.id,health:source.health,expiresAt:source.expires_at?.toISOString() ?? null} : null;
const evidence = context => ({ policyRevision: context.org.automation_policy_revision, profileRevision: context.org.profile_revision,
  formatRevision: context.org.reply_format_revision, policy: policyFor(context),
  profile: context.org.business_profile, format: context.org.reply_format ?? defaultReplyFormat(), conversationRevision: context.conversation.processing_revision,
  source: sourceEvidence(context.source) });

function assertEvidence(stored, context) {
  const current=evidence(context);
  for (const [code,label,keys] of [
    ['POLICY_CHANGED','Policy',['policyRevision','policy']],
    ['PROFILE_CHANGED','Profile',['profileRevision','profile']],
    ['FORMAT_CHANGED','Reply format',['formatRevision','format']],
    ['SOURCE_CHANGED','Source',['source']],
    ['CONVERSATION_SUPERSEDED','Conversation',['conversationRevision']],
  ]) if (keys.some(key=>!isDeepStrictEqual(stored[key],current[key]))) fail(`${label} evidence stale`,code);
}

export async function loadContext(tx, id, revision, organizationId) {
  validateInboxText(id,'work item ID');
  if (!Number.isSafeInteger(revision) || revision < 1) throw httpError(400,'Invalid processing revision');
  // Ingress and source management use the same organization -> conversation order.
  const { rows: [org] } = await tx.query('SELECT * FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);
  const { rows: [item] } = await tx.query('SELECT * FROM work_items WHERE organization_id=$1 AND id=$2 FOR UPDATE',[organizationId,id]);
  if (!org || !item) throw Object.assign(httpError(404,'Work item not found'),{code:'WORK_ITEM_NOT_FOUND'});
  const { rows: [conversation] } = await tx.query('SELECT * FROM conversations WHERE organization_id=$1 AND id=$2 FOR UPDATE',[organizationId,item.conversation_id]);
  if (conversation.processing_revision !== revision || item.processing_revision !== revision || item.status==='superseded') fail('Conversation revision superseded','CONVERSATION_SUPERSEDED');
  if (conversation.human_takeover || item.status === 'handoff') fail('Conversation superseded by human takeover','HUMAN_TAKEOVER');
  const { rows: messages } = await tx.query('SELECT id,text,processing_revision AS revision,created_at,provider_timestamp_ms FROM messages WHERE organization_id=$1 AND conversation_id=$2 ORDER BY processing_revision,id',[organizationId,conversation.id]);
  const { rows: [source] } = conversation.channel==='facebook_group'
    ? await tx.query(`SELECT *,'facebook_group' AS channel FROM group_sources WHERE organization_id=$1 AND 'facebook_group:' || group_id=$2 FOR SHARE`,[organizationId,conversation.page_id])
    : await tx.query(`SELECT id,health,expires_at,'messenger' AS channel FROM meta_page_sources WHERE organization_id=$1 AND page_id=$2 FOR SHARE`,[organizationId,conversation.page_id]);
  if(!source) fail('Conversation source unavailable','SOURCE_CHANGED');
  return { org, item, conversation, messages, source };
}

async function checkInventory(tx, organizationId, watermark) {
  const units = [];
  for (const entry of [...watermark].sort((a,b) => a.unitId.localeCompare(b.unitId))) {
    const unit = await getUnit(tx,organizationId,entry.unitId);
    if (!unit || unit.revision !== entry.unitRevision || unit.projectId !== entry.projectId || unit.status !== 'available' || !unit.publishedAt) fail('Inventory evidence stale','INVENTORY_CHANGED');
    units.push(unit);
  }
  const projects = new Map();
  for (const id of [...new Set(watermark.map(x => x.projectId))].sort()) projects.set(id,await getProject(tx,organizationId,id));
  for (const unit of units) {
    const entry = watermark.find(x => x.unitId === unit.id);
    unit.project = projects.get(unit.projectId);
    if (!unit.project || unit.project.revision !== entry.projectRevision) fail('Inventory evidence stale','INVENTORY_CHANGED');
  }
  return units;
}

export async function assertReplyFresh(tx,reply,context) {
  assertEvidence(reply.context.evidence,context);
  await checkInventory(tx,context.org.id,reply.context.snapshot.inventoryWatermark);
}

export async function assertVerifiedRetryFresh(tx,reply,context) {
  const stored=reply.context.evidence,current=evidence(context);
  const storedSource={...stored.source},currentSource={...current.source};
  delete storedSource.revision;delete currentSource.revision;
  for(const [code,label,keys] of [
    ['POLICY_CHANGED','Policy',['policyRevision','policy']],
    ['PROFILE_CHANGED','Profile',['profileRevision','profile']],
    ['FORMAT_CHANGED','Reply format',['formatRevision','format']],
    ['CONVERSATION_SUPERSEDED','Conversation',['conversationRevision']],
  ]) if(keys.some(key=>!isDeepStrictEqual(stored[key],current[key])))fail(`${label} evidence stale`,code);
  if(!isDeepStrictEqual(storedSource,currentSource))fail('Source evidence stale','SOURCE_CHANGED');
  await checkInventory(tx,context.org.id,reply.context.snapshot.inventoryWatermark);
}

// Caller retains the transaction and attempt lease while reconciling its outcome.
export async function findFreshPreparedReply(tx,{organizationId,workItemId,processingRevision}) {
  const context=await loadContext(tx,workItemId,processingRevision,organizationId);
  if (!['needs_review','ready','completed'].includes(context.item.status)) return null;
  const reply=(await tx.query('SELECT * FROM reply_versions WHERE organization_id=$1 AND work_item_id=$2 ORDER BY version DESC LIMIT 1',[organizationId,workItemId])).rows[0];
  if (!reply) return null;
  try {
    await assertReplyFresh(tx,reply,context);
    return reply;
  } catch(error) {
    if (!freshnessConflictCodes.has(error.code)) throw error;
    return null;
  }
}

async function policyContext(tx, context, reply, now) {
  const { org,conversation,source,messages } = context;
  const { rows: [counts] } = await tx.query(`SELECT count(*)::int AS organization,
    count(*) FILTER(WHERE coalesce(source_id,group_source_id)=$2)::int AS source,
    count(*) FILTER(WHERE conversation_id=$3)::int AS conversation FROM delivery_intents
    WHERE organization_id=$1 AND created_at>$4::timestamptz-interval '1 hour'`,[org.id,source?.id,conversation.id,now]);
  const last = Number(messages.at(-1)?.provider_timestamp_ms);
  return { confidence: reply.confidence, grounded: reply.content.grounded, automaticEligible: reply.content.automaticEligible,
    sourceHealth: sourceHealth(source,now),
    replyWindowOpen: conversation.channel==='facebook_group' || Number.isSafeInteger(last) && last>0 && now.valueOf()>=last && now.valueOf()-last < 24*60*60*1000,
    optOut: conversation.opted_out, humanTakeover: conversation.human_takeover, counts };
}

export function createInboxService({ pool, client, clientProvider, model, clock = () => new Date() }) {
  async function latestReply(tx,context) {
    const {org,item}=context;
    const existing=(await tx.query('SELECT * FROM reply_versions WHERE organization_id=$1 AND work_item_id=$2 ORDER BY version DESC LIMIT 1',[org.id,item.id])).rows[0];
    if (!existing) return {existing:null,reusable:null};
    const approved=(await tx.query('SELECT 1 FROM reply_authorizations WHERE organization_id=$1 AND reply_version_id=$2',[org.id,existing.id])).rowCount>0;
    if (approved) return {existing,reusable:existing};
    try {
      await assertReplyFresh(tx,existing,context);
      return {existing,reusable:existing};
    } catch(error) {
      if (!freshnessConflictCodes.has(error.code)) throw error;
      return {existing,reusable:null};
    }
  }
  async function mutation(actor,route,body,options,persist) {
    if (options===undefined) return withTransaction(pool,persist);
    if (!options || Object.keys(options).join(',')!=='idempotencyKey') throw httpError(400,'Invalid command options');
    validateInboxText(options.idempotencyKey,'idempotency key');
    validateInboxText(actor.id,'actor ID');
    const result=await withTransaction(pool,tx=>runIdempotent(tx,{
      organizationId:actor.organizationId,actorId:actor.id,route,key:options.idempotencyKey,body,
    },async()=>{
      const result=await persist(tx);
      if(!['inbox.approveAndQueue','inbox.retryUnknownDelivery','inbox.retryFailedDelivery','inbox.retryCancelledDelivery','inbox.requestHandoff','inbox.resumeHandoff'].includes(route))return {status:200,body:result};
      const operation=await operationReceipt(tx,{organizationId:actor.organizationId,
        resourceId:result.id ?? body.workItemId,resourceType:['inbox.requestHandoff','inbox.resumeHandoff'].includes(route)?'work_item':'delivery_intent',
        state:route==='inbox.requestHandoff'?'handoff':route==='inbox.resumeHandoff'?'resumed':'queued'});
      return {status:200,body:{...result,operation}};
    }));
    return result.body;
  }
  async function authorize(tx, reply, context, actor, actorKind, now = clock()) {
    const { org,item } = context;
    const existing = (await tx.query('SELECT d.* FROM delivery_intents d JOIN reply_authorizations a ON a.organization_id=d.organization_id AND a.id=d.authorization_id WHERE a.organization_id=$1 AND a.work_item_id=$2',[org.id,item.id])).rows[0];
    if (existing) {
      if (existing.reply_version_id !== reply.id) fail('Trigger already authorized','TRIGGER_AUTHORIZED');
      return existing;
    }
    if ((await tx.query('SELECT 1 FROM reply_supersessions WHERE organization_id=$1 AND reply_version_id=$2',[org.id,reply.id])).rowCount) fail('Reply superseded');
    assertEvidence(reply.context.evidence,context);
    const policy=policyFor(context);
    if (policy.mode==='observe') fail('Observe mode does not authorize delivery');
    await checkInventory(tx,org.id,reply.context.snapshot.inventoryWatermark);
    const valid = validateReply(reply.content,reply.context);
    const gates = await policyContext(tx,context,{ ...reply,confidence: reply.context.confidence },now);
    // Transport and rate gates apply to human authorization too; humans may approve free edits.
    const decision = evaluatePolicy({ ...policy, mode: 'automatic', minimumConfidence: actorKind === 'human' ? 0 : policy.minimumConfidence },
      actorKind === 'human' ? { ...gates, grounded: true, automaticEligible: true, confidence: 1 } : gates,now);
    if (decision.action !== 'authorize' || (actorKind === 'policy' && !valid.automaticEligible)) fail(`Policy gates: ${decision.reasons.join(',')}`);
    const authorizationId = randomUUID(), intentId = randomUUID();
    await tx.query(`INSERT INTO reply_authorizations(id,organization_id,work_item_id,reply_version_id,actor_kind,actor_id,evidence) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [authorizationId,org.id,item.id,reply.id,actorKind,actor?.id ?? null,JSON.stringify({ ...reply.context.evidence,inventory: reply.context.snapshot.inventoryWatermark,decision })]);
    const group=context.conversation.channel==='facebook_group';
    const { rows: [intent] } = await tx.query(`INSERT INTO delivery_intents(id,organization_id,authorization_id,reply_version_id,conversation_id,source_id,group_source_id,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [intentId,org.id,authorizationId,reply.id,item.conversation_id,group?null:context.source.id,group?context.source.id:null,JSON.stringify(reply.content)]);
    await appendAudit(tx,{ organizationId: org.id,actorId: actor?.id ?? null,action: 'reply.authorized',entityType: 'delivery_intent',entityId: intent.id,details: { authorizationId,replyVersionId: reply.id,actorKind } });
    await enqueueJob(tx,{ organizationId: org.id,kind: group?'deliver_group_reply':'deliver_reply',retrySafe: false,payload: { deliveryIntentId: intent.id } });
    await tx.query("UPDATE work_items SET status='ready',updated_at=now() WHERE organization_id=$1 AND id=$2",[org.id,item.id]);
    return intent;
  }

  async function prepareReply(workItemId, expectedRevision, actor, input) {
    if (input !== undefined) throw httpError(400,'Unexpected trusted context input');
    const organizationId = authorizeInboxActor(actor,{ write: true });
    const initial = await withTransaction(pool,async tx => {
      const context = await loadContext(tx,workItemId,expectedRevision,organizationId);
      return { context,...await latestReply(tx,context) };
    });
    if (initial.reusable) return initial.reusable;
    const before = evidence(initial.context), format = before.format;
    const providerClient = clientProvider ? await clientProvider(organizationId) : client;
    const conversation = { id: initial.context.conversation.id,revision: expectedRevision,messages: initial.context.messages.map(({id,text,revision}) => ({id,text,revision})) };
    let extraction = extractDeterministicRequirements({ conversation }), generationFailed = false;
    const deterministicExtraction = requirementConfidence(extraction.fields) > 0;
    if (!deterministicExtraction) {
      try { extraction = await extractRequirements({ conversation,businessProfile:initial.context.org.business_profile,client:providerClient,model }); }
      catch { generationFailed = true; }
    }
    const snapshot = await withTransaction(pool,async tx => {
      const context = await loadContext(tx,workItemId,expectedRevision,organizationId);
      assertEvidence(before,context);
      const ids = (await tx.query("SELECT id FROM units WHERE organization_id=$1 AND status='available' AND published_at IS NOT NULL ORDER BY id",[organizationId])).rows;
      const units = [];
      for (const {id} of ids) units.push(await getUnit(tx,organizationId,id));
      const projects = new Map();
      for (const id of [...new Set(units.map(u => u.projectId))].sort()) projects.set(id,await getProject(tx,organizationId,id));
      units.forEach(u => { u.project = projects.get(u.projectId); });
      const result = matchInventory(extraction.requirements,units);
      return saveSnapshot(tx,{ id: randomUUID(),organizationId,requirementsRevision: expectedRevision,requirements: extraction.requirements,policy: {},matcherVersion: result.matcherVersion,
        inventoryWatermark: units.map(u => ({unitId:u.id,unitRevision:u.revision,projectId:u.projectId,projectRevision:u.project.revision})),
        candidates:result.candidates,factSnapshot:result.candidates.map(c => snapshotUnitFacts(units.find(u => u.id === c.unitId))) });
    });
    let selections, content;
    try {
      if (generationFailed) throw new Error('Extraction failed');
      selections = deterministicExtraction && requirementConfidence(extraction.fields) < 1
        ? composeDeterministicSelections({snapshot,extraction})
        : await composeSelections({ snapshot,format,extraction,client:providerClient,model });
      content = renderReply(selections,snapshot,format); validateReply(content,{snapshot,selections,format});
    } catch {
      if (generationFailed) {
        selections = { units: [],templateId: 'handoff' };
        content = { ...renderReply(selections,snapshot,format),grounded:false,automaticEligible:false,editKind:'human_free_edit' };
      } else {
        selections = composeDeterministicSelections({snapshot,extraction});
        content = renderReply(selections,snapshot,format); validateReply(content,{snapshot,selections,format});
      }
    }
    const confidence = generationFailed ? 0 : selections.templateId === 'clarify' ? 1 : requirementConfidence(extraction.fields);
    return withTransaction(pool,async tx => {
      const context = await loadContext(tx,workItemId,expectedRevision,organizationId);
      const {existing,reusable}=await latestReply(tx,context);
      if (reusable) return reusable;
      assertEvidence(before,context);
      await checkInventory(tx,organizationId,snapshot.inventoryWatermark);
      const { rows:[reply] } = await tx.query(`INSERT INTO reply_versions(id,organization_id,work_item_id,conversation_id,conversation_revision,version,content,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [randomUUID(),organizationId,workItemId,context.conversation.id,expectedRevision,(existing?.version ?? 0)+1,JSON.stringify(content),JSON.stringify({ snapshot,selections,format,extraction,confidence,evidence:before })]);
      if (existing) await tx.query('INSERT INTO reply_supersessions(organization_id,reply_version_id,replacement_id) VALUES($1,$2,$3)',[organizationId,existing.id,reply.id]);
      const now=clock();
      const decision = evaluatePolicy(policyFor(context),await policyContext(tx,context,{content,confidence},now),now);
      if (decision.action === 'authorize') await authorize(tx,reply,context,null,'policy',now);
      else await tx.query("UPDATE work_items SET status=$3,updated_at=now() WHERE organization_id=$1 AND id=$2",[organizationId,workItemId,decision.action === 'observe' ? 'completed' : 'needs_review']);
      await appendAudit(tx,{ organizationId,actorId:actor.id ?? null,action:'reply.prepared',entityType:'reply_version',entityId:reply.id,details:{workItemId,decision,supersedes:existing?.id ?? null} });
      return reply;
    });
  }

  async function approveAndQueue(id,expectedRevision,actor,options) {
    const organizationId = authorizeInboxActor(actor,{write:true}); validateInboxText(id,'reply ID');
    return mutation(actor,'inbox.approveAndQueue',{id,expectedRevision},options,async tx => {
      const reply = (await tx.query('SELECT * FROM reply_versions WHERE organization_id=$1 AND id=$2',[organizationId,id])).rows[0];
      if (!reply) throw httpError(404,'Reply not found');
      const context = await loadContext(tx,reply.work_item_id,expectedRevision,organizationId);
      return authorize(tx,reply,context,actor,'human');
    });
  }

  async function retryUnknownDelivery(id,expectedRevision,actor,options) {
    const organizationId=authorizeInboxActor(actor,{write:true});validateInboxText(id,'delivery intent ID');
    return mutation(actor,'inbox.retryUnknownDelivery',{id,expectedRevision,verification:'comment_not_present'},options,async tx=>{
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);
      const {rows:[prior]}=await tx.query(`SELECT d.*,rv.work_item_id,w.processing_revision,c.processing_revision AS current_processing_revision,c.human_takeover,a.state AS attempt_state
        FROM delivery_intents d
        JOIN reply_versions rv ON rv.organization_id=d.organization_id AND rv.id=d.reply_version_id
        JOIN work_items w ON w.organization_id=rv.organization_id AND w.id=rv.work_item_id
        JOIN conversations c ON c.organization_id=w.organization_id AND c.id=w.conversation_id
        JOIN delivery_attempts a ON a.organization_id=d.organization_id AND a.delivery_intent_id=d.id
        WHERE d.organization_id=$1 AND d.id=$2 FOR UPDATE OF d,w,c,a`,[organizationId,id]);
      if(!prior)throw httpError(404,'Delivery intent not found');
      if(prior.human_takeover)fail('Conversation is assigned to a human','HUMAN_TAKEOVER');
      if(!prior.group_source_id)fail('Only Facebook Group delivery can be retried','RETRY_UNSUPPORTED');
      if(prior.processing_revision!==expectedRevision||prior.current_processing_revision!==expectedRevision)fail('Conversation revision superseded','CONVERSATION_SUPERSEDED');
      if(prior.attempt_state!=='unknown')fail('Only an unresolved delivery can be retried','RETRY_NOT_UNKNOWN');
      if((await tx.query('SELECT 1 FROM delivery_cancellations WHERE organization_id=$1 AND delivery_intent_id=$2',[organizationId,id])).rowCount)fail('Delivery was cancelled','DELIVERY_CANCELLED');
      const existing=(await tx.query('SELECT * FROM delivery_intents WHERE organization_id=$1 AND retry_of_intent_id=$2',[organizationId,id])).rows[0];
      if(existing)return existing;
      const retryId=randomUUID();
      const {rows:[intent]}=await tx.query(`INSERT INTO delivery_intents(id,organization_id,authorization_id,reply_version_id,conversation_id,source_id,group_source_id,content,retry_of_intent_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[retryId,organizationId,prior.authorization_id,prior.reply_version_id,prior.conversation_id,prior.source_id,prior.group_source_id,prior.content,id]);
      await enqueueJob(tx,{organizationId,kind:'deliver_group_reply',retrySafe:false,payload:{deliveryIntentId:intent.id}});
      await appendAudit(tx,{organizationId,actorId:actor.id,action:'delivery.retry_authorized',entityType:'delivery_intent',entityId:intent.id,
        details:{priorIntentId:id,verification:'comment_not_present'}});
      return intent;
    });
  }

  async function retryFailedDelivery(id,expectedRevision,actor,options) {
    const organizationId=authorizeInboxActor(actor,{write:true});validateInboxText(id,'delivery intent ID');
    return mutation(actor,'inbox.retryFailedDelivery',{id,expectedRevision},options,async tx=>{
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);
      const {rows:[prior]}=await tx.query(`SELECT d.*,rv.work_item_id,w.processing_revision,c.processing_revision AS current_processing_revision,c.human_takeover,a.state AS attempt_state
        FROM delivery_intents d
        JOIN reply_versions rv ON rv.organization_id=d.organization_id AND rv.id=d.reply_version_id
        JOIN work_items w ON w.organization_id=rv.organization_id AND w.id=rv.work_item_id
        JOIN conversations c ON c.organization_id=w.organization_id AND c.id=w.conversation_id
        JOIN delivery_attempts a ON a.organization_id=d.organization_id AND a.delivery_intent_id=d.id
        WHERE d.organization_id=$1 AND d.id=$2 FOR UPDATE OF d,w,c,a`,[organizationId,id]);
      if(!prior)throw httpError(404,'Delivery intent not found');
      if(prior.human_takeover)fail('Conversation is assigned to a human','HUMAN_TAKEOVER');
      if(prior.processing_revision!==expectedRevision||prior.current_processing_revision!==expectedRevision)fail('Conversation revision superseded','CONVERSATION_SUPERSEDED');
      if(prior.attempt_state!=='failed')fail('Only a failed delivery can be retried','RETRY_NOT_FAILED');
      const existing=(await tx.query('SELECT * FROM delivery_intents WHERE organization_id=$1 AND retry_of_intent_id=$2',[organizationId,id])).rows[0];
      if(existing)return existing;
      const retryId=randomUUID();
      const {rows:[intent]}=await tx.query(`INSERT INTO delivery_intents(id,organization_id,authorization_id,reply_version_id,conversation_id,source_id,group_source_id,content,retry_of_intent_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[retryId,organizationId,prior.authorization_id,prior.reply_version_id,prior.conversation_id,prior.source_id,prior.group_source_id,prior.content,id]);
      await enqueueJob(tx,{organizationId,kind:prior.group_source_id?'deliver_group_reply':'deliver_reply',retrySafe:false,payload:{deliveryIntentId:intent.id}});
      await tx.query("UPDATE work_items SET status='ready',updated_at=now() WHERE organization_id=$1 AND id=$2",[organizationId,prior.work_item_id]);
      await appendAudit(tx,{organizationId,actorId:actor.id,action:'delivery.failed_retry_authorized',entityType:'delivery_intent',entityId:intent.id,details:{priorIntentId:id}});
      return intent;
    });
  }

  async function retryCancelledDelivery(id,expectedRevision,actor,options) {
    const organizationId=authorizeInboxActor(actor,{write:true});validateInboxText(id,'delivery intent ID');
    return mutation(actor,'inbox.retryCancelledDelivery',{id,expectedRevision},options,async tx=>{
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);
      const {rows:[prior]}=await tx.query(`SELECT d.*,rv.work_item_id,w.processing_revision,c.processing_revision AS current_processing_revision,c.human_takeover,dc.delivery_intent_id AS cancellation_id,a.state AS attempt_state
        FROM delivery_intents d
        JOIN reply_versions rv ON rv.organization_id=d.organization_id AND rv.id=d.reply_version_id
        JOIN work_items w ON w.organization_id=rv.organization_id AND w.id=rv.work_item_id
        JOIN conversations c ON c.organization_id=w.organization_id AND c.id=w.conversation_id
        LEFT JOIN delivery_cancellations dc ON dc.organization_id=d.organization_id AND dc.delivery_intent_id=d.id
        LEFT JOIN delivery_attempts a ON a.organization_id=d.organization_id AND a.delivery_intent_id=d.id
        WHERE d.organization_id=$1 AND d.id=$2 FOR UPDATE OF d,w,c`,[organizationId,id]);
      if(!prior)throw httpError(404,'Delivery intent not found');
      if(prior.human_takeover)fail('Conversation is assigned to a human','HUMAN_TAKEOVER');
      if(prior.processing_revision!==expectedRevision||prior.current_processing_revision!==expectedRevision)fail('Conversation revision superseded','CONVERSATION_SUPERSEDED');
      if(!prior.cancellation_id)fail('Only a cancelled delivery can be retried','RETRY_NOT_CANCELLED');
      const cancelledBeforeProviderAttempt=!prior.attempt_state;
      if(!cancelledBeforeProviderAttempt)fail('Cancelled delivery has a provider attempt','FACEBOOK_RESULT_UNKNOWN');
      const existing=(await tx.query('SELECT * FROM delivery_intents WHERE organization_id=$1 AND retry_of_intent_id=$2',[organizationId,id])).rows[0];
      if(existing)return existing;
      const {rows:[intent]}=await tx.query(`INSERT INTO delivery_intents(id,organization_id,authorization_id,reply_version_id,conversation_id,source_id,group_source_id,content,retry_of_intent_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),organizationId,prior.authorization_id,prior.reply_version_id,prior.conversation_id,prior.source_id,prior.group_source_id,prior.content,id]);
      await enqueueJob(tx,{organizationId,kind:prior.group_source_id?'deliver_group_reply':'deliver_reply',retrySafe:false,payload:{deliveryIntentId:intent.id}});
      await tx.query("UPDATE work_items SET status='ready',updated_at=now() WHERE organization_id=$1 AND id=$2",[organizationId,prior.work_item_id]);
      await appendAudit(tx,{organizationId,actorId:actor.id,action:'delivery.cancelled_retry_authorized',entityType:'delivery_intent',entityId:intent.id,details:{priorIntentId:id}});
      return intent;
    });
  }

  async function editReply(id,expectedRevision,text,actor,options) {
    const organizationId=authorizeInboxActor(actor,{write:true}); validateInboxText(id,'reply ID');
    return mutation(actor,'inbox.editReply',{id,expectedRevision,text},options,async tx => {
      const old=(await tx.query('SELECT * FROM reply_versions WHERE organization_id=$1 AND id=$2',[organizationId,id])).rows[0];
      if (!old) throw httpError(404,'Reply not found');
      const context=await loadContext(tx,old.work_item_id,expectedRevision,organizationId);
      if ((await tx.query('SELECT 1 FROM reply_authorizations WHERE organization_id=$1 AND work_item_id=$2',[organizationId,old.work_item_id])).rowCount) fail('Approved reply is immutable');
      if ((await tx.query('SELECT 1 FROM reply_supersessions WHERE organization_id=$1 AND reply_version_id=$2',[organizationId,id])).rowCount) fail('Reply superseded');
      assertEvidence(old.context.evidence,context);
      await checkInventory(tx,organizationId,old.context.snapshot.inventoryWatermark);
      const content={...old.content,text,grounded:false,automaticEligible:false,editKind:'human_free_edit'};
      validateReply(content,old.context);
      const {rows:[reply]}=await tx.query(`INSERT INTO reply_versions(id,organization_id,work_item_id,conversation_id,conversation_revision,version,content,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),organizationId,old.work_item_id,old.conversation_id,expectedRevision,old.version+1,JSON.stringify(content),JSON.stringify(old.context)]);
      await tx.query('INSERT INTO reply_supersessions(organization_id,reply_version_id,replacement_id) VALUES($1,$2,$3)',[organizationId,id,reply.id]);
      await appendAudit(tx,{organizationId,actorId:actor.id,action:'reply.edited',entityType:'reply_version',entityId:reply.id,details:{supersedes:id}});
      return reply;
    });
  }

  async function requestHandoff(workItemId,reason,actor,options) {
    const organizationId=authorizeInboxActor(actor,{write:true}); validateInboxText(workItemId,'work item ID'); validateInboxText(reason,'handoff reason');
    const expectedRevision=options?.expectedRevision;
    return mutation(actor,'inbox.requestHandoff',{workItemId,reason,...(expectedRevision===undefined?{}:{expectedRevision})},options?{idempotencyKey:options.idempotencyKey}:undefined,async tx => {
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);
      const item=(await tx.query('SELECT * FROM work_items WHERE organization_id=$1 AND id=$2',[organizationId,workItemId])).rows[0];
      if (!item) throw httpError(404,'Work item not found');
      if(expectedRevision!==undefined) {
        const conversation=(await tx.query('SELECT processing_revision FROM conversations WHERE organization_id=$1 AND id=$2 FOR UPDATE',[organizationId,item.conversation_id])).rows[0];
        if(item.processing_revision!==expectedRevision || conversation.processing_revision!==expectedRevision) fail('Conversation revision superseded','CONVERSATION_SUPERSEDED');
      }
      const unresolved=(await tx.query(`SELECT 1 FROM (
          SELECT id,organization_id FROM delivery_intents WHERE organization_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1
        ) d JOIN LATERAL (
          SELECT a.state FROM delivery_attempts a WHERE a.organization_id=d.organization_id AND a.delivery_intent_id=d.id ORDER BY a.started_at DESC,a.id DESC LIMIT 1
        ) latest_attempt ON true WHERE latest_attempt.state IN ('attempting','unknown')`,[organizationId,item.conversation_id])).rowCount;
      if(unresolved)fail('Delivery result must be reconciled before handoff','FACEBOOK_RESULT_UNKNOWN');
      await tx.query('UPDATE conversations SET human_takeover=true,updated_at=now() WHERE organization_id=$1 AND id=$2',[organizationId,item.conversation_id]);
      await tx.query("UPDATE work_items SET status='handoff',updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND status NOT IN ('completed','superseded')",[organizationId,item.conversation_id]);
      await tx.query(`INSERT INTO delivery_cancellations(organization_id,delivery_intent_id,reason,actor_id) SELECT organization_id,id,$3,$4 FROM delivery_intents WHERE organization_id=$1 AND conversation_id=$2 ON CONFLICT DO NOTHING`,[organizationId,item.conversation_id,reason,actor.id]);
      await tx.query(`UPDATE jobs SET status='completed',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND status IN ('pending','running') AND ((kind IN ('analyze_work_item','analyze_group_work_item') AND payload->>'conversationId'=$2) OR (kind IN ('deliver_reply','deliver_group_reply') AND payload->>'deliveryIntentId' IN (SELECT id FROM delivery_intents WHERE organization_id=$1 AND conversation_id=$2)))`,[organizationId,item.conversation_id]);
      await appendAudit(tx,{organizationId,actorId:actor.id,action:'conversation.handoff',entityType:'conversation',entityId:item.conversation_id,details:{reason,workItemId}});
      return {status:'handoff'};
    });
  }

  async function resumeHandoff(workItemId,actor,options) {
    const organizationId=authorizeInboxActor(actor,{write:true});validateInboxText(workItemId,'work item ID');
    const expectedRevision=options?.expectedRevision;
    return mutation(actor,'inbox.resumeHandoff',{workItemId,expectedRevision},options?{idempotencyKey:options.idempotencyKey}:undefined,async tx=>{
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);
      const {rows:[item]}=await tx.query('SELECT * FROM work_items WHERE organization_id=$1 AND id=$2 FOR UPDATE',[organizationId,workItemId]);
      if(!item)throw httpError(404,'Work item not found');
      const {rows:[conversation]}=await tx.query('SELECT * FROM conversations WHERE organization_id=$1 AND id=$2 FOR UPDATE',[organizationId,item.conversation_id]);
      if(expectedRevision!==undefined&&(item.processing_revision!==expectedRevision||conversation.processing_revision!==expectedRevision))fail('Conversation revision superseded','CONVERSATION_SUPERSEDED');
      if(!conversation.human_takeover&&item.status!=='handoff')return {id:item.id,status:item.status};
      const {rows:[reply]}=await tx.query('SELECT id FROM reply_versions WHERE organization_id=$1 AND work_item_id=$2 ORDER BY version DESC LIMIT 1',[organizationId,item.id]);
      const {rows:[delivery]}=await tx.query(`SELECT di.*,a.state AS attempt_state FROM delivery_intents di
        JOIN reply_versions rv ON rv.organization_id=di.organization_id AND rv.id=di.reply_version_id
        LEFT JOIN LATERAL (SELECT da.state FROM delivery_attempts da WHERE da.organization_id=di.organization_id AND da.delivery_intent_id=di.id ORDER BY da.started_at DESC,da.id DESC LIMIT 1) a ON true
        WHERE di.organization_id=$1 AND rv.work_item_id=$2 ORDER BY di.created_at DESC LIMIT 1`,[organizationId,item.id]);
      if(delivery?.attempt_state==='unknown'||delivery?.attempt_state==='attempting')fail('Delivery result must be reconciled before resuming','FACEBOOK_RESULT_UNKNOWN');
      await tx.query('UPDATE conversations SET human_takeover=false,updated_at=now() WHERE organization_id=$1 AND id=$2',[organizationId,item.conversation_id]);
      await tx.query("UPDATE work_items SET status='superseded',updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND id<>$3 AND status='handoff' AND processing_revision<$4",[organizationId,item.conversation_id,item.id,item.processing_revision]);
      let status=reply?'needs_review':'preparing';
      if(delivery?.attempt_state==='sent')status='completed';
      else if(delivery?.attempt_state==='failed')status='failed';
      else if(delivery) {
        let retry=(await tx.query('SELECT * FROM delivery_intents WHERE organization_id=$1 AND retry_of_intent_id=$2',[organizationId,delivery.id])).rows[0];
        if(!retry) {
          const {rows:[created]}=await tx.query(`INSERT INTO delivery_intents(id,organization_id,authorization_id,reply_version_id,conversation_id,source_id,group_source_id,content,retry_of_intent_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),organizationId,delivery.authorization_id,delivery.reply_version_id,delivery.conversation_id,delivery.source_id,delivery.group_source_id,delivery.content,delivery.id]);
          retry=created;
          await enqueueJob(tx,{organizationId,kind:delivery.group_source_id?'deliver_group_reply':'deliver_reply',retrySafe:false,payload:{deliveryIntentId:retry.id}});
        }
        status='ready';
      }
      await tx.query('UPDATE work_items SET status=$3,updated_at=now() WHERE organization_id=$1 AND id=$2',[organizationId,item.id,status]);
      if(!reply) {
        const active=(await tx.query(`SELECT 1 FROM jobs WHERE organization_id=$1 AND kind IN ('analyze_work_item','analyze_group_work_item')
          AND payload->>'workItemId'=$2 AND status IN ('pending','running') LIMIT 1`,[organizationId,item.id])).rowCount;
        if(!active)await enqueueJob(tx,{organizationId,kind:conversation.channel==='facebook_group'?'analyze_group_work_item':'analyze_work_item',retrySafe:true,payload:{workItemId:item.id,conversationId:item.conversation_id,processingRevision:item.processing_revision}});
      }
      await appendAudit(tx,{organizationId,actorId:actor.id,action:'conversation.resumed',entityType:'conversation',entityId:item.conversation_id,details:{workItemId:item.id}});
      return {id:item.id,status};
    });
  }
  return {prepareReply,approveAndQueue,retryUnknownDelivery,retryFailedDelivery,retryCancelledDelivery,editReply,requestHandoff,resumeHandoff};
}
