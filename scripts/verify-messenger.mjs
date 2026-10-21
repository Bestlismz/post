import assert from "node:assert/strict"; import crypto from "node:crypto";
const base=process.env.BASE_URL||"http://127.0.0.1:3000",pageId=process.env.META_PAGE_ID||"fixture-page",secret=process.env.META_APP_SECRET||"fixture-secret",sender=`verify-${Date.now()}`;
await api("/api/messenger/enable",{method:"POST",body:{}});const initial=(await api("/fixture/api/messenger/sends")).sends.length;
const payload={object:"page",entry:[{id:pageId,messaging:[{sender:{id:sender},recipient:{id:pageId},timestamp:Date.now(),message:{mid:"verify-mid-1",text:"หาคอนโดใกล้ BTS อ่อนนุช งบ 15,000 บาท"}}]}]};
await signed(payload);await signed(payload);await waitFor(async()=>((await api("/fixture/api/messenger/sends")).sends.length===initial+1));
const sends=(await api("/fixture/api/messenger/sends")).sends;assert.equal(sends.at(-1).recipientId,sender);assert.match(sends.at(-1).text,/ขอบคุณ|Thanks/);
await signed({object:"page",entry:[{id:pageId,messaging:[{sender:{id:pageId},recipient:{id:sender},timestamp:Date.now(),message:{mid:"echo",is_echo:true,text:sends.at(-1).text}}]}]});
await api(`/api/messenger/threads/${sender}`,{method:"PATCH",body:{status:"human_handoff"}});await signed({object:"page",entry:[{id:pageId,messaging:[{sender:{id:sender},recipient:{id:pageId},timestamp:Date.now(),message:{mid:"verify-mid-2",text:"มีห้องไหม"}}]}]});await new Promise(r=>setTimeout(r,100));
assert.equal((await api("/fixture/api/messenger/sends")).sends.length,initial+1);console.log(JSON.stringify({ok:true,duplicateSends:1,echoLoop:false,handoffSuppressed:true}));
async function signed(value){const raw=JSON.stringify(value),signature=`sha256=${crypto.createHmac("sha256",secret).update(raw).digest("hex")}`;const response=await fetch(`${base}/webhooks/meta`,{method:"POST",headers:{"Content-Type":"application/json","X-Hub-Signature-256":signature},body:raw});assert.equal(response.status,200)}
async function api(path,options={}){const response=await fetch(base+path,{...options,headers:{"Content-Type":"application/json"},body:options.body===undefined?undefined:JSON.stringify(options.body)});const data=await response.json();if(!response.ok)throw new Error(`${path}: ${data.error}`);return data}
async function waitFor(check){for(let i=0;i<40;i++){if(await check())return;await new Promise(r=>setTimeout(r,50))}throw new Error("Messenger worker did not finish")}
