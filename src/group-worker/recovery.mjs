import {MAX_GROUP_ID_LENGTH} from '../channels/groups/target.mjs';

const idPattern=/^[A-Za-z0-9_-]{1,200}$/;
const groupPattern=new RegExp(`^[0-9]{1,${MAX_GROUP_ID_LENGTH}}$`);

export function createRecoveryGate({clock=Date.now,maxTtlMs=10*60_000}={}) {
  if(typeof clock!=='function'||!Number.isSafeInteger(maxTtlMs)||maxTtlMs<1)throw new Error('Invalid recovery configuration');
  let active=null;
  function current() {
    if(active&&clock()>=active.expiresAt)active=null;
    return active;
  }
  return {
    start({sourceId,groupId,ttlMs}) {
      if(!idPattern.test(sourceId??'')||!groupPattern.test(groupId??'')||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>maxTtlMs)throw new Error('Invalid recovery request');
      if(current())throw Object.assign(new Error('Recovery already active'),{status:409});
      active={sourceId,groupId,expiresAt:clock()+ttlMs};
      return {state:'recovery',sourceId,expiresAt:new Date(active.expiresAt).toISOString()};
    },
    stop({sourceId}={}) {
      if(!idPattern.test(sourceId??''))throw new Error('Invalid recovery request');
      if(active&&active.sourceId!==sourceId)throw Object.assign(new Error('Recovery source mismatch'),{status:409});
      active=null;return {state:'available'};
    },
    permitsAutomation(){return !current();},
    status(){const value=current();return value?{state:'recovery',sourceId:value.sourceId,expiresAt:new Date(value.expiresAt).toISOString()}:{state:'available'};},
  };
}
