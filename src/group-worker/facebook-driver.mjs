import {createHash} from 'node:crypto';
import {MAX_GROUP_ID_LENGTH} from '../channels/groups/target.mjs';

const actor=value=>`facebook-actor:${createHash('sha256').update(value,'utf8').digest('hex')}`;
function targetIdentity(value) {
  const match=new RegExp(`^(post|comment):([0-9]{1,${MAX_GROUP_ID_LENGTH}})(?::([0-9]{1,${MAX_GROUP_ID_LENGTH}}))?$`).exec(value??'');
  if(!match||(match[1]==='post'&&match[3])||(match[1]==='comment'&&!match[3]))throw Error('Invalid target identity');
  return {kind:match[1],postId:match[2],commentId:match[3]??null};
}
function normalizeActorHref(raw) {
  const url=new URL(raw,'https://www.facebook.com');
  if(url.origin!=='https://www.facebook.com'||url.username||url.password)throw Error('Invalid sender identity');
  if(url.pathname==='/profile.php') {const id=url.searchParams.get('id');if(!/^\d{1,100}$/.test(id??''))throw Error('Invalid sender identity');return `${url.origin}/profile.php?id=${id}`;}
  if(!/^\/[A-Za-z0-9.]{1,100}\/?$/.test(url.pathname))throw Error('Invalid sender identity');
  return `${url.origin}${url.pathname.replace(/\/$/,'')}`;
}

export function createFacebookGroupDriver(page,{clock=()=>new Date()}={}) {
  let senderId=null;
  async function locateExactTarget(command) {
    const identity=targetIdentity(command.targetId);
    const indexes=await page.locator('[role="article"]').evaluateAll((articles,{groupId,postId,commentId})=>articles.flatMap((article,index)=>{
      const owned=Array.from(article.querySelectorAll('a[href]')).filter(link=>link.closest('[role="article"]')===article);
      const matches=owned.filter(link=>{try{const url=new URL(link.href),path=url.pathname.match(/^\/groups\/(\d+)\/posts\/(\d+)\/?$/);return url.origin==='https://www.facebook.com'&&path?.[1]===groupId&&path[2]===postId&&(url.searchParams.get('comment_id')??null)===commentId;}catch{return false;}});
      return matches.length===1?[index]:[];
    }),{groupId:command.groupId,postId:identity.postId,commentId:identity.commentId});
    if(indexes.length!==1)throw Error('Exact Facebook target unavailable');
    return {canonicalTarget:command.canonicalTarget,targetId:command.targetId,scope:page.locator('[role="article"]').nth(indexes[0]),identity};
  }
  async function identifySender() {
    const hrefs=await page.locator('a[href][aria-label*="profile" i], a[href^="/profile.php?id="], a[href*="facebook.com/profile.php?id="]').evaluateAll(links=>[...new Set(links.map(link=>link.href))]);
    const normalized=[];for(const href of hrefs){try{normalized.push(normalizeActorHref(href));}catch{}}
    if(new Set(normalized).size!==1)throw Error('Facebook sender unavailable');
    senderId=actor(normalized[0]);return senderId;
  }
  async function findReplyEvidence(command) {
    const target=await locateExactTarget(command),rows=await target.scope.locator('[role="article"]').evaluateAll((articles,{groupId,postId})=>articles.flatMap(article=>{
      const owned=selector=>Array.from(article.querySelectorAll(selector)).filter(node=>node.closest('[role="article"]')===article);
      const messages=owned('[data-ad-preview="message"], [data-ad-comet-preview="message"]');if(messages.length!==1)return [];
      const links=owned('a[href]'),permalinks=links.flatMap(link=>{try{const url=new URL(link.href),path=url.pathname.match(/^\/groups\/(\d+)\/posts\/(\d+)\/?$/),comment=url.searchParams.get('comment_id');return url.origin==='https://www.facebook.com'&&path?.[1]===groupId&&path[2]===postId&&/^\d+$/.test(comment??'')?[{link,comment}]:[];}catch{return [];}});
      if(permalinks.length!==1)return [];
      const author=owned('h2 a[href], h3 a[href], strong a[href]')[0];const observedAt=permalinks[0].link.querySelector('time[datetime]')?.getAttribute('datetime');
      if(!author||!observedAt)return [];
      return [{text:messages[0].textContent??'',authorHref:author.href,observedAt,remoteId:permalinks[0].comment}];
    }),{groupId:command.groupId,postId:target.identity.postId});
    const expected=senderId??await identifySender(),evidence=[];
    for(const row of rows) {let candidate;try{candidate=actor(normalizeActorHref(row.authorHref));}catch{continue;}if(candidate!==expected||!Number.isFinite(Date.parse(row.observedAt)))continue;
      evidence.push({canonicalTarget:command.canonicalTarget,targetId:command.targetId,senderId:candidate,text:row.text,observedAt:new Date(row.observedAt).toISOString(),remoteId:row.remoteId});}
    return evidence;
  }
  async function sendExact(target,text) {
    if(!target?.scope||typeof text!=='string'||!text)throw Error('Exact Facebook send unavailable');
    senderId??=await identifySender();
    const editors=target.scope.locator('[contenteditable="true"][role="textbox"]:visible');
    if(await editors.count()!==1)throw Error('Exact Facebook composer unavailable');
    const editor=editors.first();await editor.fill(text);await editor.press('Enter');
    const deadline=Date.now()+10000;
    do {const matches=(await findReplyEvidence({groupId:new URL(target.canonicalTarget).pathname.split('/')[2],canonicalTarget:target.canonicalTarget,targetId:target.targetId})).filter(item=>item.text===text);if(matches.length===1)return {state:'sent',visible:true,remoteId:matches[0].remoteId};await page.waitForTimeout(250);} while(Date.now()<deadline);
    return {state:'unknown',visible:false,remoteId:null,possibleClick:true,observedAt:clock().toISOString()};
  }
  return {locateExactTarget,identifySender,sendExact,findReplyEvidence};
}
