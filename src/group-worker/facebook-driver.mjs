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

export async function resolveFacebookSessionIdentity(page) {
  const links=await page.locator('[data-session-owned-identity="true"][href], [role="banner"] a[href][aria-label], [role="menu"][aria-label*="account" i] a[href], [role="menu"][aria-label*="บัญชี"] a[href], form a[href][aria-label]').evaluateAll(links=>links.flatMap(link=>{
    const label=link.getAttribute('aria-label')??'';
    const explicit=link.getAttribute('data-session-owned-identity')==='true'||/profile|account|โปรไฟล์|บัญชี/i.test(label);
    return explicit?[link.href]:[];
  }));
  if(links.length)return links;
  const cookies=await page.context().cookies('https://www.facebook.com');
  const userIds=[...new Set(cookies.filter(cookie=>cookie.name==='c_user'&&/^\d{1,100}$/.test(cookie.value)).map(cookie=>cookie.value))];
  return userIds.map(id=>`https://www.facebook.com/profile.php?id=${id}`);
}

export function createFacebookGroupDriver(page,{clock=()=>new Date(),resolveSessionIdentity=resolveFacebookSessionIdentity,readEditorText=editor=>editor.textContent()}={}) {
  let senderId=null;
  async function locateExactTarget(command) {
    const identity=targetIdentity(command.targetId);
    const isExactPage=()=>{try{const current=new URL(page.url());return current.origin==='https://www.facebook.com'&&current.pathname===`/groups/${command.groupId}/posts/${identity.postId}/`&&(current.searchParams.get('comment_id')??null)===identity.commentId;}catch{return false;}};
    const locate=()=>page.locator('[role="article"]').evaluateAll((articles,{groupId,postId,commentId})=>articles.flatMap((article,index)=>{
      const owned=Array.from(article.querySelectorAll('a[href]')).filter(link=>link.closest('[role="article"]')===article);
      const matches=owned.filter(link=>{try{const url=new URL(link.href),path=url.pathname.match(/^\/groups\/(\d+)\/posts\/(\d+)\/?$/);return url.origin==='https://www.facebook.com'&&path?.[1]===groupId&&path[2]===postId&&(url.searchParams.get('comment_id')??null)===commentId;}catch{return false;}});
      return matches.length===1?[index]:[];
    }),{groupId:command.groupId,postId:identity.postId,commentId:identity.commentId});
    let indexes=await locate();
    if(indexes.length===0&&typeof page.goto==='function'&&!isExactPage()) {
      const target=new URL(`/groups/${command.groupId}/posts/${identity.postId}/`,'https://www.facebook.com');
      if(identity.commentId)target.searchParams.set('comment_id',identity.commentId);
      await page.goto(target.href,{waitUntil:'domcontentloaded'});
      await page.waitForTimeout?.(500);
      indexes=await locate();
    }
    if(indexes.length===1)return {canonicalTarget:command.canonicalTarget,targetId:command.targetId,groupId:command.groupId,scope:page.locator('[role="article"]').nth(indexes[0]),scopeKind:'article',identity};
    if(indexes.length>1||identity.kind!=='post')throw Error('Exact Facebook target unavailable');
    if(!isExactPage())throw Error('Exact Facebook target unavailable');
    const editors=page.locator('[contenteditable="true"][role="textbox"]');
    const candidates=await editors.evaluateAll(nodes=>nodes.flatMap((node,index)=>{
      const style=getComputedStyle(node),label=[node.getAttribute('aria-label'),node.getAttribute('aria-placeholder'),node.getAttribute('data-placeholder')].filter(Boolean).join(' ');
      return !node.hidden&&node.getAttribute('aria-hidden')!=='true'&&style.display!=='none'&&style.visibility!=='hidden'&&/(answer as|write a comment|comment as|ตอบในชื่อ|เขียนความคิดเห็น|แสดงความคิดเห็น)/i.test(label)?[index]:[];
    }));
    if(candidates.length!==1)throw Error('Exact Facebook target unavailable');
    const scope=editors.nth(candidates[0]).locator('xpath=ancestor::*[@role="dialog"][1]');
    if(await scope.count()!==1)throw Error('Exact Facebook target unavailable');
    const actions=await scope.locator('[aria-label^="Actions for this post"], [aria-label^="การดำเนินการสำหรับโพสต์นี้"]').evaluateAll(nodes=>nodes.filter(node=>node.closest('[role="dialog"]')===nodes[0]?.closest('[role="dialog"]')).length);
    if(actions!==1)throw Error('Exact Facebook target unavailable');
    return {canonicalTarget:command.canonicalTarget,targetId:command.targetId,groupId:command.groupId,scope,scopeKind:'dialog',identity};
  }
  async function identifySender() {
    const hrefs=await resolveSessionIdentity(page);
    const normalized=[];for(const href of hrefs){try{normalized.push(normalizeActorHref(href));}catch{}}
    if(new Set(normalized).size!==1)throw Error('Facebook sender unavailable');
    senderId=actor(normalized[0]);return senderId;
  }
  async function findReplyEvidence(command) {
    const target=await locateExactTarget(command),rows=await target.scope.locator('[role="article"]').evaluateAll((articles,{groupId,postId})=>articles.flatMap(article=>{
      const owned=selector=>Array.from(article.querySelectorAll(selector)).filter(node=>node.closest('[role="article"]')===article);
      const messages=owned('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
      if(!messages.length)messages.push(...owned('div[dir="auto"]').filter(node=>node.textContent?.trim()&&!node.closest('h1,h2,h3,button,[role="button"],[contenteditable="true"]')&&!Array.from(node.querySelectorAll('div[dir="auto"]')).some(child=>child.closest('[role="article"]')===article&&child.textContent?.trim())));
      if(messages.length!==1)return [];
      const links=owned('a[href]'),permalinks=links.flatMap(link=>{try{const url=new URL(link.href),path=url.pathname.match(/^\/groups\/(\d+)\/posts\/(\d+)\/?$/),comment=url.searchParams.get('comment_id');return url.origin==='https://www.facebook.com'&&path?.[1]===groupId&&path[2]===postId&&/^\d+$/.test(comment??'')?[{link,comment}]:[];}catch{return [];}});
      if(permalinks.length!==1)return [];
      const author=owned('h2 a[href], h3 a[href], strong a[href]')[0];const observedAt=permalinks[0].link.querySelector('time[datetime]')?.getAttribute('datetime')??null;
      if(!author)return [];
      return [{text:messages[0].textContent??'',authorHref:author.href,observedAt,remoteId:permalinks[0].comment}];
    }),{groupId:command.groupId,postId:target.identity.postId});
    const expected=senderId??await identifySender(),evidence=[];
    for(const row of rows) {let candidate;try{candidate=actor(normalizeActorHref(row.authorHref));}catch{continue;}if(candidate!==expected)continue;
      const observedAt=row.observedAt&&Number.isFinite(Date.parse(row.observedAt))?new Date(row.observedAt).toISOString():clock().toISOString();
      evidence.push({canonicalTarget:command.canonicalTarget,targetId:command.targetId,senderId:candidate,text:row.text,observedAt,remoteId:row.remoteId});}
    return evidence;
  }
  function assertActive({signal,deadline}) {
    if(signal?.aborted)throw Object.assign(new Error('Facebook reply cancelled'),{name:'AbortError'});
    if(Number.isFinite(deadline)&&Date.now()>=deadline)throw Error('Facebook reply deadline exceeded');
  }
  async function directOwned(target,selector,kind) {
    const locator=target.scope.locator(selector),indexes=await target.scope.evaluate((article,{selector,kind})=>Array.from(article.querySelectorAll(selector)).flatMap((node,index)=>{
      const owner=kind==='dialog-editor'?'[role="dialog"]':'[role="article"]';
      if(node.closest(owner)!==article)return [];
      if(kind==='reply')return /^(reply(?:\s+to\b.*)?|ตอบกลับ(?:\s+.*)?|ตอบ(?:\s+.*)?)$/i.test((node.getAttribute('aria-label')||node.textContent||'').trim())?[index]:[];
      const style=getComputedStyle(node);return !node.hidden&&node.getAttribute('aria-hidden')!=='true'&&style.display!=='none'&&style.visibility!=='hidden'?[index]:[];
    }),{selector,kind:target.scopeKind==='dialog'&&kind==='editor'?'dialog-editor':kind});
    return indexes.map(index=>locator.nth(index));
  }
  async function ownedReplyControls(target) {
    return directOwned(target,'button, [role="button"]','reply');
  }
  async function ownedEditors(target) {
    return directOwned(target,'[contenteditable="true"][role="textbox"]','editor');
  }
  async function editorRecords(target) {
    const locators=await ownedEditors(target),records=[];
    for(const locator of locators) {
      const handle=await locator.elementHandle();if(!handle)continue;
      const state=await handle.evaluate(node=>{
        const label=[node.getAttribute('aria-label'),node.getAttribute('placeholder'),node.getAttribute('data-placeholder')].filter(Boolean).join(' ').trim();
        const role=/edit|แก้ไข/i.test(label)?'edit':/reply|respond|ตอบกลับ|เขียน.*ตอบ/i.test(label)?'reply':'other';
        return {id:node.id||null,label,role,focused:document.activeElement===node};
      });
      records.push({locator,handle,...state,signature:JSON.stringify(state)});
    }
    return records;
  }
  async function priorRecord(record,before) {
    for(const prior of before) {try {if(await record.handle.evaluate((node,old)=>node===old,prior.handle))return prior;}catch{}}
    return null;
  }
  async function sendExact(target,text,{signal,deadline=Date.now()+10000}={}) {
    if(!target?.scope||typeof text!=='string'||!text)throw Error('Exact Facebook send unavailable');
    assertActive({signal,deadline});
    senderId??=await identifySender();
    let activeTarget=await locateExactTarget({groupId:target.groupId,canonicalTarget:target.canonicalTarget,targetId:target.targetId});
    let editor;
    if(activeTarget.identity?.kind==='comment') {
      const before=await editorRecords(activeTarget);
      const controls=await ownedReplyControls(activeTarget);if(controls.length!==1)throw Error('Exact Facebook Reply control unavailable');
      const controlledId=await controls[0].getAttribute('aria-controls');assertActive({signal,deadline});await controls[0].click();
      do {
        assertActive({signal,deadline});const after=await editorRecords(activeTarget),candidates=[];
        for(const record of after) {
          const prior=await priorRecord(record,before);
          if(prior)continue;
          if(controlledId&&record.id!==controlledId)continue;
          if(record.role==='reply')candidates.push(record.locator);
        }
        if(candidates.length>1)throw Error('Exact Facebook composer ambiguous');
        if(candidates.length===1){editor=candidates[0];break;}
        await page.waitForTimeout(25);
      } while(Date.now()<deadline);
      if(!editor)throw Error('Exact Facebook activated reply composer unavailable');
    } else {
      const editors=await ownedEditors(activeTarget);if(editors.length!==1)throw Error('Exact Facebook composer unavailable');editor=editors[0];
    }
    await editor.fill(text);assertActive({signal,deadline});
    activeTarget=await locateExactTarget({groupId:target.groupId,canonicalTarget:target.canonicalTarget,targetId:target.targetId});
    const stillOwned=(await ownedEditors(activeTarget));
    if(stillOwned.length!==1)throw Error('Exact Facebook composer changed');
    const finalText=await readEditorText(stillOwned[0]);
    if(finalText!==text)throw Error('Exact Facebook composer changed');
    assertActive({signal,deadline});
    try {await stillOwned[0].press('Enter');}catch(error){error.possibleClick=true;throw error;}
    try {do {assertActive({signal,deadline});const matches=(await findReplyEvidence({groupId:target.groupId,canonicalTarget:target.canonicalTarget,targetId:target.targetId})).filter(item=>item.text===text);if(matches.length===1)return {state:'sent',visible:true,remoteId:matches[0].remoteId};await page.waitForTimeout(250);} while(Date.now()<deadline);}
    catch(error) {error.possibleClick=true;throw error;}
    return {state:'unknown',visible:false,remoteId:null,possibleClick:true,observedAt:clock().toISOString()};
  }
  return {locateExactTarget,identifySender,sendExact,findReplyEvidence};
}
