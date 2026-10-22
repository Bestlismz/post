import { createHash } from 'node:crypto';
import { assertGroupTarget, inspectSession } from './session.mjs';
import { MAX_GROUP_ID_LENGTH } from '../channels/groups/target.mjs';

export const SELECTOR_VERSION='facebook-dom-v1';
const clean=(value,max)=>String(value??'').normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u034f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').trim().slice(0,max);
function identity(href,groupId) {
  const url=new URL(href); const match=url.pathname.match(new RegExp(`^/groups/([0-9]{1,${MAX_GROUP_ID_LENGTH}})/posts/([0-9]{1,${MAX_GROUP_ID_LENGTH}})/?$`));
  if(url.origin!=='https://www.facebook.com'||!match||match[1]!==groupId) throw new Error('Invalid observation page');
  const commentId=url.searchParams.get('comment_id');
  if(commentId&&!new RegExp(`^[0-9]{1,${MAX_GROUP_ID_LENGTH}}$`).test(commentId)) throw new Error('Invalid observation identity');
  return {targetId:commentId?`comment:${match[2]}:${commentId}`:`post:${match[2]}`,kind:commentId?'comment':'post',postId:match[2],commentId};
}
async function readPage(page) {
  return page.evaluate(()=>{
    const feed=document.querySelector('[role="feed"]');
    const cards=Array.from(feed?.querySelectorAll('[role="article"]')??[]);
    const items=[];
    for(const card of cards.slice(0,100)) {
      const link=card.querySelector('a[href*="/posts/"]');
      const text=card.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]')??(card.getAttribute('aria-label')?.startsWith('Comment by ')?card.querySelector('div[dir="auto"]'):null);
      if(!link||!text) continue;
      items.push({href:link.href.slice(0,2000),authorLabel:(card.querySelector('h2, h3')?.textContent??'').slice(0,300),text:text.textContent.slice(0,20000),providerTimestamp:card.querySelector('time[datetime]')?.getAttribute('datetime')??null});
    }
    return {selectorValid:!!feed&&cards.length>0&&items.length===cards.length,items,hasMore:false,complete:false};
  });
}
export async function observeGroupPage(page,command,{maxItems=100,maxPasses=10}={}) {
  assertGroupTarget(command.canonicalTarget);
  if(command.canonicalTarget!==`https://www.facebook.com/groups/${command.groupId}`||page.url()!==command.canonicalTarget) throw new Error('Invalid observation page');
  const observations=[],seen=new Set();
  let bytes=0;
  const batch=(coverage,health='healthy',reason=null)=>({selectorVersion:SELECTOR_VERSION,coverage,health,reason,cursor:observations.at(-1)?.targetId??null,observations});
  for(let pass=0;pass<Math.min(maxPasses,10);pass++) {
    if(page.url()!==command.canonicalTarget) return batch('partial','failed','page_changed');
    let session;
    try { session=await inspectSession(page); }
    catch { return batch(observations.length?'partial':'none','expired','session_unavailable'); }
    if(session.state!=='healthy') return batch(observations.length?'partial':'none',session.state,'session_unavailable');
    let snapshot;
    try { snapshot=await readPage(page); } catch { return batch('partial','selector_failure','selector_changed'); }
    if(page.url()!==command.canonicalTarget)return batch('partial','failed','page_changed');
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
    if(!snapshot.selectorValid)return batch('partial','selector_failure','selector_changed');
    if(!snapshot.hasMore)return snapshot.complete===true?batch('complete'):batch('partial','healthy','scan_limit');
  }
  return batch('partial','healthy','scan_limit');
}
