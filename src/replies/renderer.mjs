import { immutable, readSnapshot, readFormat, readSelections, safeText } from "./contracts.mjs";

export function defaultReplyFormat(locale = "th") {
  return readFormat({ locale, tone: "friendly", greetingId: "hello", closingId: "thanks", ctaId: "requirements", emojiPolicy: "none", maxLength: 1800, numberFormat: "grouped", dateFormat: "iso", requiredDisclosureId: "snapshot", forbiddenPhrases: [] });
}

const words = {
  en: { hello: { friendly: "Hello!", formal: "Hello.", neutral: "Hello." }, thanks: "Thank you.", requirements: "Please share the area, budget, and move-in date you have not mentioned yet, and we will narrow the search for you.", no_match_requirements: "If a nearby area, another room type, or a different move-in date could work, tell us which option is flexible and we will check again.", follow_up: "Would you like our team to follow up?", snapshot: "These details come from our current room list; our team will reconfirm availability before you decide.", confirm: "Our team must reconfirm these details before any booking.", options: "Based on what you shared, these are the closest available matches:", no_match: "We checked the current room list but do not have an option matching all of those requirements yet.", clarify: "We can help narrow this down; we just need the details that are still missing.", handoff: "Our team will review your request and follow up with the most suitable options.", pets: { allowed: "Pets allowed", case_by_case: "Pets considered case by case", not_allowed: "Pets not allowed", unknown: "Pet policy unknown" } },
  th: { hello: { friendly: "สวัสดีค่ะ", formal: "เรียนคุณลูกค้า", neutral: "สวัสดี" }, thanks: "ขอบคุณค่ะ", requirements: "รบกวนแจ้งเฉพาะทำเล งบประมาณ หรือวันที่ต้องการย้ายเข้าที่ยังไม่ได้ระบุ เพื่อให้ทีมงานคัดห้องได้ตรงขึ้นนะคะ", no_match_requirements: "หากยืดหยุ่นเรื่องพื้นที่ใกล้เคียง ประเภทห้อง หรือวันย้ายเข้าได้ แจ้งข้อที่สะดวกได้เลยนะคะ ทีมงานจะช่วยหาให้อีกครั้ง", follow_up: "ให้ทีมงานติดต่อกลับในแชตนี้ได้เลยไหมคะ", snapshot: "ข้อมูลนี้มาจากรายการห้องปัจจุบัน ทีมงานจะยืนยันห้องว่างอีกครั้งก่อนตัดสินใจค่ะ", confirm: "ทีมงานจะยืนยันรายละเอียดอีกครั้งก่อนการจองค่ะ", options: "จากเงื่อนไขที่แจ้งมา ตอนนี้มีห้องที่ใกล้เคียงที่สุดดังนี้ค่ะ", no_match: "ทีมงานตรวจรายการปัจจุบันแล้ว แต่ยังไม่พบห้องที่ตรงทุกเงื่อนไขค่ะ", clarify: "ยินดีช่วยคัดห้องให้ค่ะ ตอนนี้ยังขาดรายละเอียดบางส่วนเพื่อเลือกตัวเลือกที่เหมาะที่สุด", handoff: "ทีมงานจะตรวจสอบคำขอและติดต่อกลับพร้อมตัวเลือกที่เหมาะสมค่ะ", pets: { allowed: "เลี้ยงสัตว์ได้", case_by_case: "พิจารณาสัตว์เลี้ยงเป็นรายกรณี", not_allowed: "ห้ามเลี้ยงสัตว์", unknown: "ยังไม่ทราบนโยบายสัตว์เลี้ยง" } },
};

export function validateFormatText(text, inputFormat) {
  const format = readFormat(inputFormat);
  safeText(text.replaceAll("\n", " "));
  if (!text.trim() || [...text].length > format.maxLength) throw new Error("Reply exceeds maximum length or is empty");
  if (format.emojiPolicy === "none" && /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u20E3]/u.test(text)) throw new Error("Reply violates emoji policy");
  if (!text.split("\n").includes(words[format.locale][format.requiredDisclosureId])) throw new Error("Reply is missing required disclosure");
  for (const phrase of format.forbiddenPhrases) if (text.toLocaleLowerCase("en-US").includes(phrase.toLocaleLowerCase("en-US"))) throw new Error("Reply contains forbidden phrase");
}

export function renderReply(input, snapshot, inputFormat) {
  const facts = readSnapshot(snapshot), format = readFormat(inputFormat), selections = readSelections(input, facts);
  const w = words[format.locale], en = format.locale === "en";
  const number = value => format.numberFormat === "grouped" ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 20, useGrouping: true }).format(value) : String(value);
  const date = value => format.dateFormat === "iso" ? value : `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
  const lines = [], provenance = [];
  const append = (text, source) => { const start = lines.join("\n").length + (lines.length ? 1 : 0); lines.push(text); if (source) provenance.push({ ...source, start, end: start + text.length, text }); };
  const appendSegments = segments => {
    const lineStart = lines.join("\n").length + (lines.length ? 1 : 0);
    let text = "";
    for (const segment of segments) {
      const start = lineStart + text.length;
      text += segment.text;
      if (segment.source) provenance.push({ ...segment.source, start, end: start + segment.text.length, text: segment.text });
    }
    lines.push(text);
  };
  if (format.greetingId !== "none") append(w.hello[format.tone] + (format.emojiPolicy === "friendly" ? " 🙂" : ""));
  append(w[selections.templateId]);
  for (const [index, selected] of selections.units.entries()) {
    const fact = facts.factSnapshot.find(item => item.unitId === selected.unitId);
    const clauses = {
      identity: () => en ? `${index + 1}. ${fact.projectName} · ${fact.unitCode}` : `${index + 1}. ${fact.projectName} ห้อง ${fact.unitCode}`,
      price: () => en ? `${number(fact.monthlyRentThb)} THB/month` : `ค่าเช่า ${number(fact.monthlyRentThb)} บาท/เดือน`,
      availableFrom: () => en ? `available ${date(fact.availableFrom)}` : `ว่าง ${date(fact.availableFrom)}`,
      bedrooms: () => fact.bedrooms === 0 ? (en ? "studio" : "ห้องสตูดิโอ") : en ? `${number(fact.bedrooms)} bedroom${fact.bedrooms === 1 ? "" : "s"}` : `${number(fact.bedrooms)} ห้องนอน`,
      petPolicy: () => w.pets[fact.petPolicy],
      transit: () => fact.transit.map(item => en ? `${item.station}, ${number(item.walkingDistanceM)} m walk` : `ใกล้ ${item.station} เดินประมาณ ${number(item.walkingDistanceM)} เมตร`).join("; "),
    };
    const segments = [];
    for (const factId of selected.factIds) {
      if (segments.length) segments.push({text:" · "});
      segments.push({text:clauses[factId](),source:{ unitId: fact.unitId, unitRevision: fact.unitRevision, projectId: fact.projectId, projectRevision: fact.projectRevision, factId }});
    }
    appendSegments(segments);
  }
  append(w[format.requiredDisclosureId]);
  if (format.ctaId !== "none") append(format.ctaId === "requirements" && selections.templateId === "options"
    ? (en ? "Tell us your preferred room size and move-in date, and we can narrow these down." : "หากมีจำนวนห้องนอนและวันที่ต้องการย้ายเข้า แจ้งเพิ่มเติมได้เลยนะคะ ทีมงานจะช่วยคัดให้แคบลง")
    : format.ctaId === "requirements" && selections.templateId === "no_match"
      ? w.no_match_requirements
      : w[format.ctaId]);
  if (format.closingId !== "none") append(w.thanks);
  const text = lines.join("\n");
  validateFormatText(text, format);
  return immutable({ text, snapshotId: facts.id, selections, format, provenance, grounded: true, automaticEligible: true });
}
