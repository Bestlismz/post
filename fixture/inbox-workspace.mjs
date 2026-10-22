import { randomUUID } from "node:crypto";

const now = "2026-10-22T07:26:00.000000Z";
const queue = [
  { id:"group_1",conversationId:"fixture-group",channel:"facebook_group",processingRevision:3,status:"needs_review",createdAt:now,participant:{id:"mint",label:"Mint Kanyarat"},source:{id:"fixture-group-source",name:"คอนโดให้เช่า กรุงเทพฯ",health:"connected"},message:{id:"fixture-post",text:"หาคอนโดใกล้ BTS อโศก งบไม่เกิน 20,000 บาท 1 ห้องนอน เลี้ยงแมวได้ค่ะ"} },
  { id:"messenger_1",conversationId:"fixture-messenger",channel:"messenger",processingRevision:2,status:"pending",createdAt:"2026-10-22T06:10:00.000000Z",participant:{id:"nat",label:"Nattapong S."},source:{id:"fixture-page",name:"Rental Radar Page",health:"connected"},message:{id:"fixture-message",text:"มีห้องว่างปลายพฤศจิกายนไหมครับ"} },
  { id:"stale_1",conversationId:"fixture-stale",channel:"facebook_group",processingRevision:7,status:"superseded",createdAt:"2026-10-22T05:05:00.000000Z",participant:{id:"ploy",label:"Ployphailin"},source:{id:"fixture-group-source",name:"คอนโดให้เช่า กรุงเทพฯ",health:"connected"},message:{id:"fixture-stale-post",text:"ขอรายละเอียดเพิ่มได้ไหมคะ"} },
];
const units=[{unitId:"life-a1207",projectName:"Life Asoke",unitCode:"A-1207",monthlyRentThb:18000,bedrooms:1,areaSqm:35,floor:12,petPolicy:"allowed",transit:["MRT เพชรบุรี 300 ม."],availableFrom:"2026-11-01",factsUpdatedAt:"2026-10-22T06:28:00.000Z",score:96}];

function detail(item) {
  if(item.channel==="messenger") return {...item,timeline:[{id:"fm1",direction:"inbound",author:item.participant.label,text:"สวัสดีครับ สนใจห้อง Life Asoke",createdAt:"2026-10-22T06:00:00.000000Z"},{id:"fm2",direction:"outbound",author:"ทีม Rental Radar",text:"ยินดีช่วยตรวจสอบให้ค่ะ ต้องการย้ายเข้าช่วงไหนคะ",createdAt:"2026-10-22T06:04:00.000000Z"},{id:"fm3",direction:"inbound",author:item.participant.label,text:item.message.text,createdAt:item.createdAt}],requirements:{district:"อโศก",budgetMax:null,bedrooms:null,requiredPetPolicy:null,moveInDate:"2026-11-25"},missingRequirements:["budgetMax","bedrooms"],matches:[],replies:[],deliveries:[],events:[]};
  return {...item,target:{kind:"post",uiId:"fp1"},timeline:[{id:"fp1",uiId:"fp1",direction:"inbound",author:item.participant.label,kind:"post",isTarget:true,text:item.message.text,createdAt:item.createdAt},{id:"fc1",uiId:"fc1",direction:"inbound",author:"Beam S.",kind:"comment",isTarget:false,text:"ลองดูแถวอโศก-เพชรบุรีค่ะ มีเยอะเลย",createdAt:"2026-10-22T07:33:00.000000Z"}],requirements:{district:"อโศก",budgetMax:20000,bedrooms:1,requiredPetPolicy:"allowed",moveInDate:null},missingRequirements:["moveInDate"],matches:units,replies:item.status==="superseded"?[]:[{id:"fixture-reply",version:1,processingRevision:item.processingRevision,text:"สวัสดีค่ะคุณมิ้นท์ ทางเรามีห้อง Life Asoke ราคา 18,000 บาทต่อเดือน เลี้ยงแมวได้ค่ะ กรุณายืนยันห้องว่างกับทีมงานอีกครั้งนะคะ"}],deliveries:[],events:[],stale:item.status==="superseded",staleReason:item.status==="superseded"?"มีข้อความหรือข้อมูลห้องที่ใหม่กว่า กรุณาโหลดข้อมูลล่าสุด":null};
}

export function createInboxWorkspaceFixture() {
  const details=new Map(queue.map(item=>[item.id,detail(item)])),streams=new Set();let position=0;
  const emit=(resourceId,resourceType,state)=>{const event={receiptId:`fixture-${++position}`,resourceId,resourceType,state};for(const response of streams)response.write(`id: ${position}\nevent: inbox\ndata: ${JSON.stringify(event)}\n\n`);return event;};
  return {
    list(){return {items:queue.map(item=>details.get(item.id)),nextCursor:null};},
    get(id){return details.get(id)??null;},
    stream(response){streams.add(response);response.write(": fixture workspace connected\n\n");response.on("close",()=>streams.delete(response));},
    prepare(id){const value=details.get(id);if(!value)return null;value.replies=[{id:`fixture-reply-${id}`,version:1,processingRevision:value.processingRevision,text:"สวัสดีค่ะ ขอบคุณที่ติดต่อมา ทีมงานกำลังตรวจสอบห้องที่ตรงกับความต้องการจากรายการปัจจุบันให้นะคะ"}];value.status="needs_review";return emit(id,"work_item","needs_review");},
    edit(replyId,text){for(const value of details.values()){const current=value.replies.find(reply=>reply.id===replyId);if(current){const reply={...current,id:`fixture-edit-${randomUUID()}`,version:current.version+1,text};value.replies.unshift(reply);return reply;}}return null;},
    approve(replyId){for(const value of details.values())if(value.replies.some(reply=>reply.id===replyId)){value.status="ready";const event=emit(`fixture-delivery-${value.id}`,"delivery_intent","queued");value.deliveries.unshift({id:event.resourceId,replyId,state:"queued"});return event;}return null;},
    handoff(id){const value=details.get(id);if(!value)return null;value.status="handoff";return emit(id,"work_item","handoff");},
  };
}
