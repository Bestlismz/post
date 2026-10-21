import { analyzeDeterministically } from "./relevance.mjs";

const groupId = "9999999999999999";

export function seedCustomerDemo(state, now = new Date().toISOString()) {
  const created = !state.groups[groupId];
  state.groups[groupId] = {
    ...state.groups[groupId],
    id: groupId,
    url: `https://www.facebook.com/groups/${groupId}`,
    name: "Bangkok Condo Leads · Demo",
    enabled: false,
    lastScanAt: now,
    lastScanState: "completed",
    lastScanDetail: "3 demo scenarios",
    createdAt: now,
    demo: true,
  };

  const targets = [
    demoTarget("tenant", "Beam", "Looking for a pet-friendly studio near BTS Ari. Budget 18,000 THB, moving next month.", now),
    demoTarget("owner", "คุณเมย์", "เป็นเจ้าของคอนโด 1 ห้องนอนใกล้ BTS อ่อนนุช ต้องการเอเจนต์ช่วยดูแลผู้เช่า ค่าเช่า 22,000 บาท", now),
    demoTarget("listing", "Nina Property", "ปล่อยเช่าคอนโดทองหล่อ 1 ห้องนอน ราคา 25,000 บาท พร้อมเข้าอยู่", now),
  ];
  for (const target of targets) {
    state.targets[target.key] = target;
    state.analyses[target.key] = { ...analyzeDeterministically(target, state.businessProfile), demo: true };
  }

  seedThread(state, {
    id: "demo-customer-beam",
    name: "Beam · Demo",
    status: "bot_active",
    inbound: "หาสตูดิโอเลี้ยงสัตว์ได้ใกล้ BTS อารีย์ งบ 18,000 บาท ย้ายเดือนหน้า",
    reply: "สวัสดีค่ะ รับข้อมูลแล้วค่ะ ทีมงานจะคัดห้องใกล้ BTS อารีย์ งบไม่เกิน 18,000 บาท และเลี้ยงสัตว์ได้ให้ค่ะ",
    insight: { score: 94, intent: "tenant_lead", extracted: { location: "BTS อารีย์", budget: "18,000 บาท", moveDate: "เดือนหน้า" }, missing: [] },
  }, now, 0);
  seedThread(state, {
    id: "demo-owner-may",
    name: "คุณเมย์ · Demo",
    status: "human_handoff",
    inbound: "มีคอนโดอ่อนนุชอยากฝากปล่อยเช่า ขอคุยกับเจ้าหน้าที่ค่ะ",
    reply: "สวัสดีค่ะ รับเรื่องไว้แล้วค่ะ เจ้าหน้าที่จะติดต่อกลับเพื่อขอรายละเอียดห้องเพิ่มเติมนะคะ",
    insight: { score: 89, intent: "owner_lead", extracted: { location: "อ่อนนุช", budget: "Not provided", moveDate: "Not provided" }, missing: ["rental_price", "room_details"] },
  }, now, 60_000);

  if (!state.events.some((event) => event.action === "customer_demo_loaded")) {
    state.events.push({ id: "event_customer_demo", action: "customer_demo_loaded", detail: "3 lead scenarios · 2 Messenger conversations", at: now });
  }
  return { created, targets: targets.length, threads: 2 };
}

function demoTarget(suffix, author, text, now) {
  const key = `demo:${groupId}:${suffix}:post`;
  return {
    key,
    kind: "post",
    groupId,
    postId: `demo-${suffix}`,
    commentId: null,
    url: `https://www.facebook.com/groups/${groupId}`,
    author,
    text,
    postText: text,
    context: [],
    fingerprint: `customer-demo-${suffix}-v1`,
    discoveredAt: now,
    lastSeenAt: now,
    demo: true,
  };
}

function seedThread(state, scenario, now, offset) {
  const timestamp = Date.parse(now) - offset;
  const messageKey = `${scenario.id}:inbound`;
  const outboundKey = `${scenario.id}:outbound`;
  state.messengerThreads[scenario.id] ??= {
    id: scenario.id,
    customerName: scenario.name,
    status: scenario.status,
    lastMessageAt: new Date(timestamp).toISOString(),
    insight: scenario.insight,
    demo: true,
  };
  state.messengerMessages[messageKey] ??= {
    key: messageKey,
    mid: `mid.${messageKey}`,
    senderId: scenario.id,
    text: scenario.inbound,
    timestamp,
    state: "sent",
    receivedAt: new Date(timestamp).toISOString(),
    demo: true,
  };
  state.messengerOutbound[outboundKey] ??= {
    id: `msg-${scenario.id}`,
    replyToMid: `mid.${messageKey}`,
    senderId: scenario.id,
    text: scenario.reply,
    state: "sent",
    createdAt: new Date(timestamp + 1_000).toISOString(),
    finishedAt: new Date(timestamp + 1_000).toISOString(),
    messageId: `demo-${scenario.id}`,
    demo: true,
  };
}
