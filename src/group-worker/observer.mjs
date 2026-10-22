import { createHash } from 'node:crypto';
import { assertGroupTarget, inspectSession } from './session.mjs';
import { MAX_GROUP_ID_LENGTH } from '../channels/groups/target.mjs';
import { abortable } from './cancellation.mjs';

export const SELECTOR_VERSION='facebook-dom-v2';
const clean=(value,max)=>String(value??'').normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u034f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').trim().slice(0,max);
function identity(href,groupId) {
  const url=new URL(href); const match=url.pathname.match(new RegExp(`^/groups/([0-9]{1,${MAX_GROUP_ID_LENGTH}})/posts/([0-9]{1,${MAX_GROUP_ID_LENGTH}})/?$`));
  if(url.origin!=='https://www.facebook.com'||!match||match[1]!==groupId) throw new Error('Invalid observation page');
  const commentId=url.searchParams.get('comment_id');
  if(commentId&&!new RegExp(`^[0-9]{1,${MAX_GROUP_ID_LENGTH}}$`).test(commentId)) throw new Error('Invalid observation identity');
  return {targetId:commentId?`comment:${match[2]}:${commentId}`:`post:${match[2]}`,kind:commentId?'comment':'post',postId:match[2],commentId};
}
async function readPage(page,groupId) {
  return page.evaluate(({groupId,maxIdLength})=>{
    const feed=document.querySelector('[role="feed"]');
    const cards=Array.from(feed?.querySelectorAll('[role="article"]')??[]).filter(card=>
      !card.parentElement?.closest('[role="article"]') || card.getAttribute('aria-label')?.startsWith('Comment by '));
    const items=[];
    let reason=null;
    const identityPath=new RegExp(`^/groups/([0-9]{1,${maxIdLength}})/posts/([0-9]{1,${maxIdLength}})/?$`);
    for(const card of cards.slice(0,100)) {
      const owned=selector=>Array.from(card.querySelectorAll(selector)).filter(node=>node.closest('[role="article"]')===card);
      const messages=owned('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
      if(!messages.length&&card.getAttribute('aria-label')?.startsWith('Comment by ')) messages.push(...owned('div[dir="auto"]'));
      const headings=owned('h2, h3').filter(node=>!messages.some(message=>message.contains(node)));
      if(messages.length!==1||headings.length!==1) { reason='identity_ambiguous';continue; }
      const [text]=messages,[heading]=headings;
      const timestampLinks=owned('a[href]').filter(link=>{
        if(text.contains(link)||!((link.compareDocumentPosition(text)&Node.DOCUMENT_POSITION_FOLLOWING)&&
          (heading.contains(link)||(heading.compareDocumentPosition(link)&Node.DOCUMENT_POSITION_FOLLOWING)))) return false;
        const label=(link.innerText||link.getAttribute('aria-label')||'').replace(/[\u034f\u200b-\u200f\u2060\ufeff]/g,'').trim();
        return !!link.querySelector('time, abbr')||/^\d+\s*(?:[smhdw]|minutes?|hours?|days?|weeks?)(?:\s+ago)?$/i.test(label);
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
      items.push({href:link.href.slice(0,2000),authorLabel:(heading.textContent??'').slice(0,300),text:text.textContent.slice(0,20000),providerTimestamp:link.querySelector('time[datetime]')?.getAttribute('datetime')??null});
    }
    return {selectorValid:!!feed&&cards.length>0&&items.length===cards.length,reason,items,hasMore:false,complete:false};
  },{groupId,maxIdLength:MAX_GROUP_ID_LENGTH});
}
export async function observeGroupPage(page,command,{maxItems=100,maxPasses=10,signal}={}) {
  assertGroupTarget(command.canonicalTarget);
  if(command.canonicalTarget!==`https://www.facebook.com/groups/${command.groupId}`||page.url()!==command.canonicalTarget) throw new Error('Invalid observation page');
  const observations=[],seen=new Set();
  let bytes=0;
  const batch=(coverage,health='healthy',reason=null)=>({selectorVersion:SELECTOR_VERSION,coverage,health,reason,cursor:observations.at(-1)?.targetId??null,observations});
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
    let snapshot;
    try { snapshot=await abortable(()=>readPage(page,command.groupId),signal); }
    catch { return signal?.aborted?batch(observations.length?'partial':'none','failed','scan_cancelled'):batch('partial','selector_failure','selector_changed'); }
    if(page.url()!==command.canonicalTarget||page.isClosed?.()) {const changed=await checkSession();if(changed)return changed;}
    for(const raw of snapshot.items.slice(0,100)) {
      let ids; try{ids=identity(raw.href,command.groupId);}catch{return batch('partial','failed','page_changed');}
      if(seen.has(ids.targetId))continue;
      const text=clean(raw.text,20000),authorLabel=clean(raw.authorLabel,300);
      if(!text)continue;
      const providerTimestamp=raw.providerTimestamp&&Number.isFinite(Date.parse(raw.providerTimestamp))?new Date(raw.providerTimestamp).toISOString():null;
      const item={...ids,text,authorLabel,providerTimestamp,observedAt:new Date().toISOString()};
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
