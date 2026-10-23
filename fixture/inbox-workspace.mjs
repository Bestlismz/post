import { randomUUID } from "node:crypto";

const now = "2026-10-22T07:26:00.000000Z";
const seededQueue = [
  { id:"group_1",conversationId:"fixture-group",channel:"facebook_group",processingRevision:3,status:"needs_review",createdAt:now,participant:{id:"mint",label:"Mint Kanyarat"},source:{id:"fixture-group-source",name:"คอนโดให้เช่า กรุงเทพฯ",health:"connected"},message:{id:"fixture-post",text:"หาคอนโดใกล้ BTS อโศก งบไม่เกิน 20,000 บาท 1 ห้องนอน เลี้ยงแมวได้ค่ะ"},summary:{location:"อโศก",budgetMax:20000,assignee:null} },
  { id:"messenger_1",conversationId:"fixture-messenger",channel:"messenger",processingRevision:2,status:"pending",createdAt:"2026-10-22T06:10:00.000000Z",participant:{id:"nat",label:"Nattapong S."},source:{id:"61595791349401",name:"BestRedar",health:"connected"},message:{id:"fixture-message",text:"มีห้องว่างปลายพฤศจิกายนไหมครับ"},summary:{location:"อโศก",budgetMax:null,assignee:null} },
  { id:"stale_1",conversationId:"fixture-stale",channel:"facebook_group",processingRevision:7,status:"superseded",createdAt:"2026-10-22T05:05:00.000000Z",participant:{id:"ploy",label:"Ployphailin"},source:{id:"fixture-group-source",name:"คอนโดให้เช่า กรุงเทพฯ",health:"connected"},message:{id:"fixture-stale-post",text:"ขอรายละเอียดเพิ่มได้ไหมคะ"},summary:{location:null,budgetMax:null,assignee:null} },
];
const units=[{unitId:"life-a1207",projectName:"Life Asoke",unitCode:"A-1207",monthlyRentThb:18000,bedrooms:1,areaSqm:35,floor:12,petPolicy:"allowed",transit:["MRT เพชรบุรี 300 ม."],availableFrom:"2026-11-01",factsUpdatedAt:"2026-10-22T06:28:00.000Z",score:96}];

function detail(item) {
  if(item.channel==="messenger") return {...item,timeline:[{id:"fm1",direction:"inbound",author:item.participant.label,text:"สวัสดีครับ สนใจห้อง Life Asoke",createdAt:"2026-10-22T06:00:00.000000Z"},{id:"fm2",direction:"outbound",author:"ทีม Rental Radar",text:"ยินดีช่วยตรวจสอบให้ค่ะ ต้องการย้ายเข้าช่วงไหนคะ",createdAt:"2026-10-22T06:04:00.000000Z"},{id:"fm3",direction:"inbound",author:item.participant.label,text:item.message.text,createdAt:item.createdAt}],requirements:{district:"อโศก",budgetMax:null,bedrooms:null,requiredPetPolicy:null,moveInDate:"2026-11-25"},missingRequirements:["budgetMax","bedrooms"],matches:[],replies:[],deliveries:[],events:[]};
  if(item.scanOrigin) return {...item,target:{kind:"post",uiId:item.message.id},timeline:[{id:item.message.id,uiId:item.message.id,direction:"inbound",author:item.participant.label,kind:"post",isTarget:true,text:item.message.text,createdAt:item.createdAt}],requirements:{district:item.summary.location,budgetMax:item.summary.budgetMax,bedrooms:null,requiredPetPolicy:null,moveInDate:null},missingRequirements:[...(item.summary.location?[]:["district"]),...(item.summary.budgetMax?[]:["budgetMax"]),"bedrooms","moveInDate"],matches:[],replies:[],deliveries:[],events:[]};
  return {...item,target:{kind:"post",uiId:"fp1"},timeline:[{id:"fp1",uiId:"fp1",direction:"inbound",author:item.participant.label,kind:"post",isTarget:true,text:item.message.text,createdAt:item.createdAt},{id:"fc1",uiId:"fc1",direction:"inbound",author:"Beam S.",kind:"comment",isTarget:false,text:"ลองดูแถวอโศก-เพชรบุรีค่ะ มีเยอะเลย",createdAt:"2026-10-22T07:33:00.000000Z"}],requirements:{district:"อโศก",budgetMax:20000,bedrooms:1,requiredPetPolicy:"allowed",moveInDate:null},missingRequirements:["moveInDate"],matches:units,replies:item.status==="superseded"?[]:[{id:"fixture-reply",version:1,processingRevision:item.processingRevision,text:"สวัสดีค่ะคุณมิ้นท์ ทางเรามีห้อง Life Asoke ราคา 18,000 บาทต่อเดือน เลี้ยงแมวได้ค่ะ กรุณายืนยันห้องว่างกับทีมงานอีกครั้งนะคะ"}],deliveries:[],events:[],stale:item.status==="superseded",staleReason:item.status==="superseded"?"มีข้อความหรือข้อมูลห้องที่ใหม่กว่า กรุณาโหลดข้อมูลล่าสุด":null};
}

export function createInboxWorkspaceFixture() {
  const queue=structuredClone(seededQueue);
  const details=new Map(queue.map(item=>[item.id,detail(item)])),streams=new Set();let position=0;
  const emit=(resourceId,resourceType,state)=>{const event={receiptId:`fixture-${++position}`,resourceId,resourceType,state};for(const response of streams)response.write(`id: ${position}\nevent: inbox\ndata: ${JSON.stringify(event)}\n\n`);return event;};
  return {
    list(query={}){const normalized={...query,search:query.q??query.search??""};const filtered=queue.map(item=>details.get(item.id)).filter(item=>{
      const budget=item.summary?.budgetMax,haystack=`${item.participant?.label??""} ${item.message?.text??""} ${item.source?.name??""}`.toLocaleLowerCase("th");
      return (!normalized.channel||item.channel===normalized.channel)
        && (!normalized.status||(normalized.status==="pending_or_updated"?["pending","superseded"].includes(item.status):item.status===normalized.status))
        && (!normalized.location||(item.summary?.location??"").toLocaleLowerCase("th").includes(String(normalized.location).toLocaleLowerCase("th")))
        && (!normalized.budgetMin||(budget!=null&&budget>=Number(normalized.budgetMin)))
        && (!normalized.budgetMax||(budget!=null&&budget<=Number(normalized.budgetMax)))
        && (!normalized.assignee||normalized.assignee==="unassigned"&&item.summary?.assignee==null)
        && (!normalized.search||haystack.includes(String(normalized.search).toLocaleLowerCase("th")));
    });
      const limit=Math.max(1,Math.min(100,Number(query.limit)||100));
      const scope=JSON.stringify([normalized.channel??null,normalized.status??null,normalized.location??"",normalized.budgetMin??null,normalized.budgetMax??null,normalized.assignee??null,normalized.search??""]);
      let offset=0;
      if(query.cursor){const position=JSON.parse(Buffer.from(String(query.cursor),"base64url").toString("utf8"));if(position.scope!==scope||!Number.isSafeInteger(position.offset)||position.offset<0)throw new Error("Invalid Inbox cursor");offset=position.offset;}
      const items=filtered.slice(offset,offset+limit),nextOffset=offset+items.length;
      return {items,resultCount:filtered.length,nextCursor:nextOffset<filtered.length?Buffer.from(JSON.stringify({offset:nextOffset,scope})).toString("base64url"):null};},
    get(id){return details.get(id)??null;},
    stream(response){streams.add(response);response.write(": fixture workspace connected\n\n");response.on("close",()=>streams.delete(response));},
    ingestGroupObservation(observation){
      const id=`scan_${observation.groupId}_${observation.remoteId}`;
      const prior=details.get(id);
      if(prior?.message.text===observation.text)return {created:false,item:prior};
      const item={
        id,
        conversationId:`fixture-group-${observation.groupId}-${observation.remoteId}`,
        channel:"facebook_group",
        processingRevision:(prior?.processingRevision??0)+1,
        status:"pending",
        createdAt:observation.observedAt,
        participant:{id:observation.authorId,label:observation.authorName},
        source:{id:observation.sourceId,name:observation.sourceName,health:"connected"},
        message:{id:`fixture-post-${observation.groupId}-${observation.remoteId}`,text:observation.text},
        summary:structuredClone(observation.summary),
        scanOrigin:true,
      };
      const value=detail(item);
      if(prior){
        const index=queue.findIndex(candidate=>candidate.id===id);
        queue[index]=item;
      }else queue.unshift(item);
      details.set(id,value);
      emit(id,"work_item","pending");
      return {created:!prior,item:value};
    },
    prepare(id){const value=details.get(id);if(!value)return null;value.replies=[{id:`fixture-reply-${id}`,version:1,processingRevision:value.processingRevision,text:"สวัสดีค่ะ ขอบคุณที่ติดต่อมา ทีมงานกำลังตรวจสอบห้องที่ตรงกับความต้องการจากรายการปัจจุบันให้นะคะ"}];value.status="needs_review";return emit(id,"work_item","needs_review");},
    edit(replyId,text){for(const value of details.values()){const current=value.replies.find(reply=>reply.id===replyId);if(current){const reply={...current,id:`fixture-edit-${randomUUID()}`,version:current.version+1,text};value.replies.unshift(reply);return reply;}}return null;},
    approve(replyId){for(const value of details.values())if(value.replies.some(reply=>reply.id===replyId)){value.status="ready";const event=emit(`fixture-delivery-${value.id}`,"delivery_intent","queued");value.deliveries.unshift({id:event.resourceId,replyId,state:"queued"});return event;}return null;},
    handoff(id){const value=details.get(id);if(!value)return null;value.status="handoff";return emit(id,"work_item","handoff");},
  };
}
