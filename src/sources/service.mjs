import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendAudit,runIdempotent,withTransaction } from '../db/transaction.mjs';
import { enqueueJob } from '../jobs/queue.mjs';
import { evaluatePolicy } from '../policy/evaluator.mjs';
import { signCommand } from '../channels/groups/contracts.mjs';
import { canonicalizeGroupUrl } from '../channels/groups/target.mjs';
import { getGroupSource,insertGroupSource,saveGroupSource,insertGroupOperation } from './repository.mjs';
import { internalSourceUpdatePatch } from '../automation/contracts.mjs';
export { canonicalizeGroupUrl };
const id=z.string().min(1).max(200);
const inputs={addGroupSource:z.strictObject({url:z.string().max(2000)}),updateGroupSource:internalSourceUpdatePatch.extend({id}),requestGroupScan:z.strictObject({id,recovery:z.boolean().optional()})};
function fail(status,message){throw Object.assign(new Error(message),{status});}
export function createSourceService(pool,{signingKey,keyId,clock=()=>new Date(),supportedSelectorVersions=[]}={}) {
  async function requireAutomaticReadiness(tx,source,now) {
    const {rows:[org]}=await tx.query('SELECT group_automation_paused FROM organizations WHERE id=$1 FOR SHARE',[source.organizationId]);
    const decision=evaluatePolicy({...source.policy,mode:'automatic'},{grounded:true,automaticEligible:true,confidence:1,sourceHealth:'connected',replyWindowOpen:true,counts:{organization:0,source:0,conversation:0}},now);
    if(source.sessionCircuit||source.selectorCircuit||!source.allowListed||source.sessionHealth!=='healthy'||source.selectorHealth!=='healthy'||!supportedSelectorVersions.includes(source.selectorVersion)||source.killSwitch||org.group_automation_paused||!source.policy.rateLimits||!source.policy.businessHours||decision.action!=='authorize') fail(409,'Automatic mode is not ready');
  }
  const service={};
  for(const action of Object.keys(inputs)) service[action]=async command=>{
    z.object({organizationId:id,actorId:id,idempotencyKey:id}).parse(command);
    const input=inputs[action].parse(command.input);
    if(action!=='addGroupSource') z.object({expectedRevision:z.number().int().positive()}).parse(command);
    const {organizationId,actorId,idempotencyKey,expectedRevision}=command;
    const response=await withTransaction(pool,async tx=>{
      const {rows:[membership]}=await tx.query('SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE',[organizationId,actorId]);
      if(!membership || !(action==='requestGroupScan'?['admin','operator']:['admin']).includes(membership.role)) fail(403,'Role does not permit this source action');
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);
      return runIdempotent(tx,{organizationId,actorId,route:`sources.${action}`,key:idempotencyKey,body:{input,expectedRevision:expectedRevision??null}},async()=>{
        let source,created;
        if(action==='addGroupSource') {
          const inserted=await insertGroupSource(tx,{id:randomUUID(),organizationId,...canonicalizeGroupUrl(input.url)});
          source=inserted.source;
          created=inserted.created;
          if(inserted.created) await appendAudit(tx,{organizationId,actorId,action:'group.source_added',entityType:'group_source',entityId:source.id,details:{revision:source.revision}});
        } else {
          source=await getGroupSource(tx,organizationId,input.id);
          if(!source) fail(404,'Source not found');
          if(source.revision!==expectedRevision) fail(409,'Revision conflict');
          if(source.archived) fail(409,'Source is archived');
          if(action==='updateGroupSource') {
            const previousMode=source.mode,{id:ignored,...patch}=input; source={...source,...patch};
            const stopping=patch.mode!=='automatic' && (patch.killSwitch===true || patch.archived===true);
            const editingPausedAutomatic=previousMode==='automatic'&&source.mode==='automatic'&&source.killSwitch&&patch.killSwitch!==false;
            if(source.mode==='automatic' && !editingPausedAutomatic && !stopping) await requireAutomaticReadiness(tx,source,clock());
            source=await saveGroupSource(tx,source);
            await appendAudit(tx,{organizationId,actorId,action:'group.source_updated',entityType:'group_source',entityId:source.id,details:{revision:source.revision,mode:source.mode,archived:source.archived}});
          } else {
            const {rows:[org]}=await tx.query('SELECT group_automation_paused FROM organizations WHERE id=$1 FOR SHARE',[organizationId]);
            if(source.killSwitch||org.group_automation_paused) fail(409,'Source automation is paused');
            if((source.sessionCircuit||source.selectorCircuit)&&!input.recovery) fail(409,'Source circuit requires explicit recovery');
            const now=clock();
            if(source.mode==='automatic'&&!input.recovery) await requireAutomaticReadiness(tx,source,now);
            const signed=signCommand({version:1,kind:'ScanCommand',operationId:randomUUID(),sourceId:source.id,groupId:source.groupId,canonicalTarget:source.canonicalUrl,issuedAt:now.toISOString(),expiresAt:new Date(+now+300000).toISOString(),keyId},{key:signingKey,keyId,now});
            await insertGroupOperation(tx,organizationId,signed,{recovery:input.recovery===true});
            await appendAudit(tx,{organizationId,actorId,action:'group.scan_requested',entityType:'group_operation',entityId:signed.operationId,details:{sourceId:source.id}});
            await enqueueJob(tx,{organizationId,kind:'group.scan',payload:{operationId:signed.operationId,sourceId:source.id},retrySafe:true});
            return {status:202,body:{operationId:signed.operationId,command:signed}};
          }
        }
        return {status:action==='addGroupSource'&&created?201:200,body:action==='addGroupSource'?{...source,created}:source};
      });
    });
    return response.body;
  };
  return service;
}
