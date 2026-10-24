import { createHash } from 'node:crypto';
import { assertGroupTarget, inspectSession } from './session.mjs';
import { MAX_GROUP_ID_LENGTH } from '../channels/groups/target.mjs';
import { abortable } from './cancellation.mjs';

export const SELECTOR_VERSION='facebook-dom-v3';
const clean=(value,max)=>String(value??'').normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u034f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').trim().slice(0,max);
const digest=value=>createHash('sha256').update(value).digest('hex');
function normalizeRolelessCard(scopes) {
  const metadata=/^(?:Facebook|\u00b7|Author|Admin|Like|Comment|Reply|Share|Send|Follow|Shared post|Actions for this post|(?:Answer|Comment) as .+|\d+|\d+[smhdw]|\d+\s+(?:comments?|replies?|shares?)|\d+\s*(?:min|mins|minute|minutes|hour|hours|day|days)(?:\s+ago)?|(?:a|an)\s+(?:minute|hour|day|week)\s+ago|(?:today|yesterday)(?:\s+at\s+\d{1,2}:\d{2})?)$/i;
  for(const raw of scopes) {
    const lines=String(raw??'').split('\n').map(line=>({text:line.replace(/[\u034f\u200b-\u200f\u2060\ufeff]/g,'').trim(),obfuscated:/[\u034f\u200b-\u200f\u2060\ufeff]/.test(line)}))
      .filter(line=>line.text&&!(line.obfuscated&&line.text.length===1)&&!metadata.test(line.text)).map(line=>line.text);
    if(lines.length<2)continue;
    const authorLabel=lines[0],text=lines.slice(1).join('\n').trim();
    if(authorLabel&&text)return {authorLabel,text};
  }
  return null;
}
function identity(href,groupId) {
  const url=new URL(href); const match=url.pathname.match(new RegExp(`^/groups/([0-9]{1,${MAX_GROUP_ID_LENGTH}})/posts/([0-9]{1,${MAX_GROUP_ID_LENGTH}})/?$`));
  if(url.origin!=='https://www.facebook.com'||!match||match[1]!==groupId) throw new Error('Invalid observation page');
  const commentId=url.searchParams.get('comment_id');
  if(commentId&&!new RegExp(`^[0-9]{1,${MAX_GROUP_ID_LENGTH}}$`).test(commentId)) throw new Error('Invalid observation identity');
  return {targetId:commentId?`comment:${match[2]}:${commentId}`:`post:${match[2]}`,kind:commentId?'comment':'post',postId:match[2],commentId};
}
export async function expandVisibleComments(page,{maxClicks=24,signal}={}) {
  if(typeof page.locator!=='function')return 0;
  const label=/^(?:View (?:all |more |previous )?(?:\d+ )?(?:comments?|replies?)|See more|ดูความคิดเห็น(?:ทั้งหมด|เพิ่มเติม|ก่อนหน้า)?(?:อีก \d+ รายการ)?|ดูการตอบกลับ(?:ทั้งหมด|เพิ่มเติม)?(?:อีก \d+ รายการ)?|ดู(?:ข้อความ)?เพิ่มเติม)$/i;
  let clicks=0;
  while(clicks<maxClicks&&!signal?.aborted) {
    const controls=page.locator('button, [role="button"]').filter({hasText:label});
    const count=Math.min(await controls.count(),50);let clicked=false;
    for(let index=0;index<count;index++) {
      const control=controls.nth(index);
      if(!await control.isVisible().catch(()=>false))continue;
      try {await control.click({timeout:3000});} catch {continue;}
      clicks++;clicked=true;
      if(typeof page.waitForTimeout==='function')await page.waitForTimeout(120);
      break;
    }
    if(!clicked)break;
  }
  return clicks;
}
async function readPage(page,groupId) {
  return page.evaluate(({groupId,maxIdLength})=>{
    const countFrom=value=>{
      const raw=String(value??'').replace(/,/g,'').trim();
      const match=raw.match(/(\d+(?:\.\d+)?)\s*([KMB]|พัน|หมื่น|แสน|ล้าน)?/i);if(!match)return null;
      const factor={k:1000,m:1000000,b:1000000000,'พัน':1000,'หมื่น':10000,'แสน':100000,'ล้าน':1000000}[String(match[2]??'').toLowerCase()]??1;
      const count=Math.round(Number(match[1])*factor);return Number.isSafeInteger(count)&&count>=0?count:null;
    };
    const groupName=(document.querySelector('main h1, [role="main"] h1, h1')?.textContent??'').slice(0,300);
    const accessLevel=document.querySelector('a[href*="/admin_assistant/"], a[href*="/member-requests/"], a[href*="/admin_activities/"], a[href*="/edit/"]')?'admin':'reader';
    const feed=document.querySelector('[role="feed"]');
    const commentArticleLabel=/^(?:Comment by |Reply by |ความคิดเห็นจาก |ข้อความตอบกลับจาก )/i;
    const cards=Array.from(feed?.querySelectorAll('[role="article"]')??[]).filter(card=>
      !card.parentElement?.closest('[role="article"]') || commentArticleLabel.test(card.getAttribute('aria-label')??''));
    const items=[];
    let reason=null;
    const visibleText=root=>{
      let value='';
      const visit=node=>{
        if(node.nodeType===Node.TEXT_NODE){value+=node.nodeValue??'';return;}
        if(node.nodeType!==Node.ELEMENT_NODE)return;
        const tag=node.tagName;
        if(tag==='IMG'){value+=node.getAttribute('alt')??'';return;}
        if(tag==='BR'){value+='\n';return;}
        const block=node!==root&&/^(?:DIV|P|LI)$/.test(tag),start=value.length;
        for(const child of node.childNodes)visit(child);
        if(block&&value.length>start&&!value.endsWith('\n'))value+='\n';
      };
      visit(root);
      return value.replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
    };
    const identityPath=new RegExp(`^/groups/([0-9]{1,${maxIdLength}})/posts/([0-9]{1,${maxIdLength}})/?$`);
    for(const card of cards.slice(0,100)) {
      const owned=selector=>Array.from(card.querySelectorAll(selector)).filter(node=>node.closest('[role="article"]')===card);
      const messages=owned('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
      if(!messages.length) {
        const candidates=owned('div[dir="auto"], span[dir="auto"]').filter(node=>
          node.textContent?.trim()&&!node.closest('a,h1,h2,h3,button,[role="button"],[role="link"],[contenteditable="true"]'));
        const byText=new Map();
        for(const node of candidates) {
          const value=node.textContent.trim();
          if(!byText.has(value))byText.set(value,node);
        }
        const longest=[...byText.entries()].sort((a,b)=>b[0].length-a[0].length)[0]?.[1];
        if(longest)messages.push(longest);
      }
      const headings=owned('h2, h3').filter(node=>!messages.some(message=>message.contains(node)));
      const isComment=commentArticleLabel.test(card.getAttribute('aria-label')??'');
      const authorLabels=[...new Set((headings.length?headings: isComment?owned('a[href]').filter(link=>{
        try {const url=new URL(link.href);return url.origin==='https://www.facebook.com'&&(/\/groups\/\d+\/user\/\d+\/?$/.test(url.pathname)||url.pathname==='/profile.php');} catch{return false;}
      }):[]).map(node=>(node.textContent??'').trim()).filter(Boolean))];
      if(!messages.length)continue;
      if(messages.length!==1||authorLabels.length!==1) { reason='identity_ambiguous';continue; }
      const [text]=messages,[authorLabel]=authorLabels;
      const timestampLinks=owned('a[href]').filter(link=>{
        if(text.contains(link))return false;
        try { return identityPath.test(new URL(link.href).pathname); } catch { return false; }
      });
      const targets=new Map();let invalid=false;
      for(const link of timestampLinks) {
        const url=new URL(link.href),match=url.pathname.match(identityPath),comment=url.searchParams.get('comment_id');
        if(url.origin!=='https://www.facebook.com'||url.username||url.password||!match||match[1]!==groupId||
          url.searchParams.getAll('comment_id').length>1||(comment&&!new RegExp(`^[0-9]{1,${maxIdLength}}$`).test(comment))) { invalid=true;continue; }
        targets.set(`${match[2]}:${comment??''}`,link);
      }
      if(targets.size!==1||invalid) {
        const failure=targets.size>1||(targets.size&&invalid)?'identity_ambiguous':'identity_missing';
        if(reason!=='identity_ambiguous')reason=failure;
        continue;
      }
      const [link]=targets.values();
      const labels=owned('[aria-label], button, [role="button"]').map(node=>`${node.getAttribute('aria-label')??''} ${node.textContent??''}`.trim());
      const reactionLabel=labels.find(value=>/reaction|ถูกใจ|การตอบสนอง/i.test(value));
      const commentCountLabel=labels.find(value=>/comments?|ความคิดเห็น/i.test(value));
      items.push({href:link.href.slice(0,2000),authorLabel:authorLabel.slice(0,300),text:visibleText(text).slice(0,20000),providerTimestamp:link.querySelector('time[datetime]')?.getAttribute('datetime')??null,reactionCount:countFrom(reactionLabel),commentCount:countFrom(commentCountLabel)});
    }
    return {groupName,accessLevel,selectorValid:!!feed&&items.length>0&&!reason,reason,items,hasMore:false,complete:false};
  },{groupId,maxIdLength:MAX_GROUP_ID_LENGTH});
}
async function readRolelessPosts(page,groupId,canonicalTarget,{maxItems=100}={}) {
  const rawCards=await page.locator('[aria-label^="Actions for this post"], [aria-label^="การดำเนินการสำหรับโพสต์นี้"]').evaluateAll((buttons,expectedGroupId)=>buttons.map(button=>{
    const scopes=[],timestampHrefs=[];let node=button;
    for(let depth=0;depth<18&&node;depth++,node=node.parentElement) {
      scopes.push((node.innerText??'').trim());
      for(const link of node.querySelectorAll('a[href]')) {
        const url=new URL(link.href),label=(link.innerText||link.getAttribute('aria-label')||'').replace(/[\u034f\u200b-\u200f\u2060\ufeff]/g,'').trim();
        const opaque=url.pathname.replace(/\/$/,'')===`/groups/${expectedGroupId}`&&url.searchParams.has('__cft__[0]')&&url.hash.startsWith('#?');
        if(opaque||/^\d+[smhdw]$/i.test(label)||/^\d+\s+(?:minutes?|hours?|days?)\s+ago$/i.test(label)) {
          const href=link.getAttribute('href');if(href&&!timestampHrefs.includes(href))timestampHrefs.push(href);
        }
      }
    }
    return {scopes,timestampHrefs};
  }),groupId);
  const cards=[];
  for(const raw of rawCards) {
    const content=normalizeRolelessCard(raw.scopes);
    if(!content||raw.timestampHrefs.length!==1)continue;
    const card={...content,timestampHref:raw.timestampHrefs[0],fingerprint:digest(`${content.authorLabel}\n${content.text}`)};
    if(!cards.some(item=>item.timestampHref===card.timestampHref&&item.fingerprint===card.fingerprint))cards.push(card);
  }
  const items=[];let reason=rawCards.length?'identity_missing':'selector_changed';
  for(const card of cards.slice(0,Math.min(maxItems,100))) {
    const candidates=page.locator(`a[href=${JSON.stringify(card.timestampHref)}]`).filter({visible:true});
    if(await candidates.count()!==1) {reason='identity_ambiguous';continue;}
    const isExpected=url=>{try{return identity(url.href,groupId).kind==='post';}catch{return false;}};
    const navigation=page.waitForURL(isExpected,{timeout:8000}).catch(()=>null);
    try {await candidates.click({timeout:5000});} catch {continue;}
    const opened=await navigation||isExpected(new URL(page.url()));
    if(!opened) {await page.goto(canonicalTarget,{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});continue;}
    const href=page.url();
    items.push({href,authorLabel:card.authorLabel,text:card.text,providerTimestamp:null});
    reason=null;
    await page.goto(canonicalTarget,{waitUntil:'domcontentloaded',timeout:30000});
  }
  return {selectorValid:rawCards.length>0&&cards.length>0&&items.length===cards.length,reason,items,hasMore:false,complete:false};
}
export async function observeGroupPage(page,command,{maxItems=100,maxPasses=10,signal}={}) {
  assertGroupTarget(command.canonicalTarget);
  if(command.canonicalTarget!==`https://www.facebook.com/groups/${command.groupId}`||page.url()!==command.canonicalTarget) throw new Error('Invalid observation page');
  const observations=[],seen=new Set();
  let groupName=null,accessLevel='unknown';
  let bytes=0;
  const batch=(coverage,health='healthy',reason=null)=>({selectorVersion:SELECTOR_VERSION,coverage,health,reason,groupName,accessLevel,cursor:observations.at(-1)?.targetId??null,observations});
  async function checkSession() {
    if(!page.isClosed?.()&&!page.url().startsWith('https://www.facebook.com/')) return batch('partial','failed','page_changed');
    let session;
    try { session=await abortable(()=>inspectSession(page),signal); }
    catch { return batch(observations.length?'partial':'none',signal?.aborted?'failed':'expired',signal?.aborted?'scan_cancelled':'session_unavailable'); }
    if(session.state!=='healthy') return batch(observations.length?'partial':'none',session.state,'session_unavailable');
    if(page.url()!==command.canonicalTarget)return batch('partial','failed','page_changed');
    return null;
  }
  for(let pass=0;pass<Math.min(maxPasses,10);pass++) {
    const before=await checkSession();if(before)return before;
    // Facebook hydrates feed cards after DOMContentLoaded. Reading immediately can see only the first post
    // and falsely report a healthy partial scan before its visible comments are attached.
    if(pass===0&&typeof page.waitForTimeout==='function')await abortable(()=>page.waitForTimeout(1000),signal);
    try {await abortable(()=>expandVisibleComments(page,{signal}),signal);} catch {if(signal?.aborted)return batch(observations.length?'partial':'none','failed','scan_cancelled');}
    let snapshot;
    try { snapshot=await abortable(()=>readPage(page,command.groupId),signal); }
    catch {
      if(signal?.aborted)return batch(observations.length?'partial':'none','failed','scan_cancelled');
      const health=await checkSession();if(health)return health.health==='expired'?{...health,reason:'session_lost'}:health;
      return batch('partial','selector_failure','selector_changed');
    }
    groupName=clean(snapshot.groupName,300)||groupName;
    accessLevel=['reader','admin'].includes(snapshot.accessLevel)?snapshot.accessLevel:accessLevel;
    if(page.url()!==command.canonicalTarget||page.isClosed?.()) {const changed=await checkSession();if(changed)return changed;}
    if(!snapshot.items.length) {
      try {
        const roleless=await abortable(()=>readRolelessPosts(page,command.groupId,command.canonicalTarget,{maxItems:Math.min(maxItems-observations.length,100)}),signal);
        snapshot={...snapshot,...roleless};
      } catch {
        if(signal?.aborted)return batch(observations.length?'partial':'none','failed','scan_cancelled');
        const health=await checkSession();if(health)return health.health==='expired'?{...health,reason:'session_lost'}:health;
        return batch('partial','selector_failure','selector_changed');
      }
    }
    if(page.url()!==command.canonicalTarget||page.isClosed?.()) {const changed=await checkSession();if(changed)return changed;}
    for(const raw of snapshot.items.slice(0,100)) {
      let ids; try{ids=identity(raw.href,command.groupId);}catch{return batch('partial','failed','page_changed');}
      if(seen.has(ids.targetId))continue;
      const text=clean(raw.text,20000),authorLabel=clean(raw.authorLabel,300);
      if(!text)continue;
      const providerTimestamp=raw.providerTimestamp&&Number.isFinite(Date.parse(raw.providerTimestamp))?new Date(raw.providerTimestamp).toISOString():null;
      const reactionCount=Number.isSafeInteger(raw.reactionCount)&&raw.reactionCount>=0?raw.reactionCount:null;
      const commentCount=Number.isSafeInteger(raw.commentCount)&&raw.commentCount>=0?raw.commentCount:null;
      const item={...ids,text,authorLabel,providerTimestamp,reactionCount,commentCount,observedAt:new Date().toISOString()};
      item.evidenceHash=createHash('sha256').update(JSON.stringify([command.groupId,ids.targetId,authorLabel,text,providerTimestamp])).digest('hex');
      bytes+=Buffer.byteLength(JSON.stringify(item));
      if(bytes>180000)return batch('partial','healthy','scan_limit');
      seen.add(ids.targetId); observations.push(item);
      if(observations.length>=Math.min(maxItems,100))return batch('partial','healthy','scan_limit');
    }
    const after=await checkSession();if(after)return after;
    if(!snapshot.selectorValid)return batch('partial','selector_failure',snapshot.reason??'selector_changed');
    if(!snapshot.hasMore)return snapshot.complete===true?batch('complete'):batch('partial','healthy','scan_limit');
  }
  return batch('partial','healthy','scan_limit');
}
