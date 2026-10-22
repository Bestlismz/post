import {chromium} from 'playwright-core';
import {createGroupWorkerServer} from './server.mjs';
import {createGroupSession,probeBrowserHealth} from './session.mjs';
import {observeGroupPage} from './observer.mjs';
import {createRecoveryGate} from './recovery.mjs';
import {MAX_GROUP_ID_LENGTH} from '../channels/groups/target.mjs';
import {groupCommandKeyConfig} from '../channels/groups/keys.mjs';
import {createGroupDeliveryBoundary} from './delivery.mjs';
import {createFacebookGroupDriver} from './facebook-driver.mjs';

function csv(value) {return [...new Set((value??'').split(',').map(item=>item.trim()).filter(Boolean))];}
const {keyId,keys:allKeys,key}=groupCommandKeyConfig(process.env);
const allowedGroups=csv(process.env.GROUP_SOURCE_ALLOWLIST),stagingAllowedGroups=csv(process.env.STAGING_FACEBOOK_SOURCE_ALLOWLIST);
if(!keyId||!Buffer.isBuffer(key)||key.length!==32||!allowedGroups.length||allowedGroups.some(value=>!new RegExp(`^\\d{1,${MAX_GROUP_ID_LENGTH}}$`).test(value))||stagingAllowedGroups.some(value=>!allowedGroups.includes(value)))throw new Error('Invalid group worker configuration');

const recoveryGate=createRecoveryGate();
const session=createGroupSession({profilePath:process.env.BROWSER_PROFILE_PATH??'/data/chromium',launchContext:async()=>{
  const browser=await chromium.connectOverCDP(process.env.CHROME_CDP_URL??'http://127.0.0.1:9222');
  const context=browser.contexts()[0];if(!context){await browser.close();throw new Error('Browser context unavailable');}
  return {pages:()=>context.pages(),newPage:()=>context.newPage(),close:()=>browser.close(),browser:()=>browser};
}});
const ledgerPath=process.env.GROUP_OPERATION_LEDGER_PATH??'/data/group-operations';
const deliver=(method)=>(command,options)=>session.withGroup(command,(page)=>createGroupDeliveryBoundary({ledgerPath,driver:createFacebookGroupDriver(page)})[method](command,options),options);
const cdpUrl=process.env.CHROME_CDP_URL??'http://127.0.0.1:9222';
const server=createGroupWorkerServer({keys:allKeys,keyId,key,allowedGroups,recoveryGate,sessionHealth:()=>probeBrowserHealth({cdpUrl,ownership:session.getHealth()}),stagingSendEnabled:process.env.STAGING_FACEBOOK_SEND==='true',stagingAllowedGroups,
  scan:(command,options)=>session.withGroup(command,observeGroupPage,options),reply:deliver('deliver'),reconcile:deliver('reconcile')});
server.listen(Number(process.env.PORT??3001),'0.0.0.0',()=>process.stdout.write('Group browser worker listening.\n'));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>process.exit()));
