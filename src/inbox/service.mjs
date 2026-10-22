import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withTransaction, appendAudit, runIdempotent } from '../db/transaction.mjs';
import { enqueueJob } from '../jobs/queue.mjs';
import { authorizeInboxActor } from './repository.mjs';
import { validateInboxText } from './validation.mjs';
import { httpError } from '../auth/authorize.mjs';
import { inboxConflict, freshnessConflictCodes } from './errors.mjs';
import { extractRequirements } from '../replies/extractor.mjs';
import { composeSelections } from '../replies/composer.mjs';
import { defaultReplyFormat, renderReply } from '../replies/renderer.mjs';
import { validateReply } from '../replies/validator.mjs';
import { matchInventory } from '../inventory/matcher.mjs';
import { getUnit, getProject, saveSnapshot } from '../inventory/repository.mjs';
import { snapshotUnitFacts } from '../inventory/facts.mjs';
import { evaluatePolicy } from '../policy/evaluator.mjs';

const fail = (message,code='INVALID_REPLY_STATE') => { throw inboxConflict(code,message); };
const evidence = context => ({ policyRevision: context.org.automation_policy_revision, profileRevision: context.org.profile_revision,
  formatRevision: context.org.reply_format_revision, policy: context.org.automation_policy,
  profile: context.org.business_profile, format: context.org.reply_format ?? defaultReplyFormat(), conversationRevision: context.conversation.processing_revision,
  source: context.source ? {id:context.source.id,health:context.source.health,expiresAt:context.source.expires_at?.toISOString() ?? null} : null });

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
  const { rows: [source] } = await tx.query('SELECT id,health,expires_at FROM meta_page_sources WHERE organization_id=$1 AND page_id=$2 FOR SHARE',[organizationId,conversation.page_id]);
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
    count(*) FILTER(WHERE source_id=$2)::int AS source,
    count(*) FILTER(WHERE conversation_id=$3)::int AS conversation FROM delivery_intents
    WHERE organization_id=$1 AND created_at>$4::timestamptz-interval '1 hour'`,[org.id,source?.id,conversation.id,now]);
  const last = Number(messages.at(-1)?.provider_timestamp_ms);
  return { confidence: reply.confidence, grounded: reply.content.grounded, automaticEligible: reply.content.automaticEligible,
    sourceHealth: source?.expires_at && new Date(source.expires_at) <= now ? 'expired' : source?.health,
    replyWindowOpen: Number.isSafeInteger(last) && last>0 && now.valueOf()>=last && now.valueOf()-last < 24*60*60*1000,
    optOut: conversation.opted_out, humanTakeover: conversation.human_takeover, counts };
}

export function createInboxService({ pool, client, model, clock = () => new Date() }) {
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
    },async()=>({status:200,body:await persist(tx)})));
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
    if (org.automation_policy.mode==='observe') fail('Observe mode does not authorize delivery');
    await checkInventory(tx,org.id,reply.context.snapshot.inventoryWatermark);
    const valid = validateReply(reply.content,reply.context);
    const gates = await policyContext(tx,context,{ ...reply,confidence: reply.context.confidence },now);
    // Transport and rate gates apply to human authorization too; humans may approve free edits.
    const decision = evaluatePolicy({ ...org.automation_policy, mode: 'automatic', minimumConfidence: actorKind === 'human' ? 0 : org.automation_policy.minimumConfidence },
      actorKind === 'human' ? { ...gates, grounded: true, automaticEligible: true, confidence: 1 } : gates,now);
    if (decision.action !== 'authorize' || (actorKind === 'policy' && !valid.automaticEligible)) fail(`Policy gates: ${decision.reasons.join(',')}`);
    const authorizationId = randomUUID(), intentId = randomUUID();
    await tx.query(`INSERT INTO reply_authorizations(id,organization_id,work_item_id,reply_version_id,actor_kind,actor_id,evidence) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [authorizationId,org.id,item.id,reply.id,actorKind,actor?.id ?? null,JSON.stringify({ ...reply.context.evidence,inventory: reply.context.snapshot.inventoryWatermark,decision })]);
    const { rows: [intent] } = await tx.query(`INSERT INTO delivery_intents(id,organization_id,authorization_id,reply_version_id,conversation_id,source_id,content) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [intentId,org.id,authorizationId,reply.id,item.conversation_id,context.source.id,JSON.stringify(reply.content)]);
    await appendAudit(tx,{ organizationId: org.id,actorId: actor?.id ?? null,action: 'reply.authorized',entityType: 'delivery_intent',entityId: intent.id,details: { authorizationId,replyVersionId: reply.id,actorKind } });
    await enqueueJob(tx,{ organizationId: org.id,kind: 'deliver_reply',retrySafe: false,payload: { deliveryIntentId: intent.id } });
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
    let extraction, generationFailed = false;
    try { extraction = await extractRequirements({ conversation: { id: initial.context.conversation.id,revision: expectedRevision,messages: initial.context.messages.map(({id,text,revision}) => ({id,text,revision})) },businessProfile:initial.context.org.business_profile,client,model }); }
    catch { generationFailed = true; extraction = { requirements: {},fields: {} }; }
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
      selections = await composeSelections({ snapshot,format,extraction,client,model });
      content = renderReply(selections,snapshot,format); validateReply(content,{snapshot,selections,format});
    } catch {
      generationFailed = true; selections = { units: [],templateId: 'handoff' };
      content = { ...renderReply(selections,snapshot,format),grounded:false,automaticEligible:false,editKind:'human_free_edit' };
    }
    const known = Object.values(extraction.fields).filter(f => f.status === 'known').length;
    const confidence = generationFailed ? 0 : known / 6;
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
      const decision = evaluatePolicy(context.org.automation_policy,await policyContext(tx,context,{content,confidence},now),now);
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

  async function requestHandoff(workItemId,reason,actor) {
    const organizationId=authorizeInboxActor(actor,{write:true}); validateInboxText(workItemId,'work item ID'); validateInboxText(reason,'handoff reason');
    return withTransaction(pool,async tx => {
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);
      const item=(await tx.query('SELECT * FROM work_items WHERE organization_id=$1 AND id=$2',[organizationId,workItemId])).rows[0];
      if (!item) throw httpError(404,'Work item not found');
      await tx.query('UPDATE conversations SET human_takeover=true,updated_at=now() WHERE organization_id=$1 AND id=$2',[organizationId,item.conversation_id]);
      await tx.query("UPDATE work_items SET status='handoff',updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND status NOT IN ('completed','superseded')",[organizationId,item.conversation_id]);
      await tx.query(`INSERT INTO delivery_cancellations(organization_id,delivery_intent_id,reason,actor_id) SELECT organization_id,id,$3,$4 FROM delivery_intents WHERE organization_id=$1 AND conversation_id=$2 ON CONFLICT DO NOTHING`,[organizationId,item.conversation_id,reason,actor.id]);
      await tx.query(`UPDATE jobs SET status='completed',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND status IN ('pending','running') AND ((kind='analyze_work_item' AND payload->>'conversationId'=$2) OR (kind='deliver_reply' AND payload->>'deliveryIntentId' IN (SELECT id FROM delivery_intents WHERE organization_id=$1 AND conversation_id=$2)))`,[organizationId,item.conversation_id]);
      await appendAudit(tx,{organizationId,actorId:actor.id,action:'conversation.handoff',entityType:'conversation',entityId:item.conversation_id,details:{reason,workItemId}});
      return {status:'handoff'};
    });
  }
  return {prepareReply,approveAndQueue,editReply,requestHandoff};
}
