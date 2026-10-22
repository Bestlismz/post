import { immutable, readSnapshot, readFormat, readSelections } from "./contracts.mjs";

export function defaultReplyFormat(locale = "th") {
  return readFormat({ locale, tone: "friendly", greetingId: "hello", closingId: "thanks", ctaId: "requirements", emojiPolicy: "none", maxLength: 1800, numberFormat: "grouped", dateFormat: "iso", requiredDisclosureId: "snapshot", forbiddenPhrases: [] });
}

const words = {
  en: { hello: { friendly: "Hello!", formal: "Hello.", neutral: "Hello." }, thanks: "Thank you.", requirements: "Please share your preferred area, budget, and move-in date.", follow_up: "Would you like our team to follow up?", snapshot: "Details reflect the inventory snapshot; please confirm current availability with our team.", confirm: "Our team must reconfirm these details before any booking.", options: "Options from our inventory:", clarify: "We need more details to check suitable options.", handoff: "Our team will review your request.", pets: { allowed: "Pets allowed", case_by_case: "Pets considered case by case", not_allowed: "Pets not allowed", unknown: "Pet policy unknown" } },
  th: { hello: { friendly: "สวัสดีค่ะ", formal: "เรียนคุณลูกค้า", neutral: "สวัสดี" }, thanks: "ขอบคุณค่ะ", requirements: "รบกวนแจ้งทำเล งบประมาณ และวันที่ต้องการย้ายเข้า", follow_up: "ต้องการให้ทีมงานติดต่อกลับในแชตนี้ไหมคะ", snapshot: "ข้อมูลอ้างอิงจากรายการห้อง ณ เวลาที่ตรวจสอบ กรุณายืนยันห้องว่างปัจจุบันกับทีมงานอีกครั้ง", confirm: "ทีมงานต้องยืนยันข้อมูลเหล่านี้อีกครั้งก่อนการจอง", options: "ตัวเลือกจากรายการห้องของเรา:", clarify: "รบกวนแจ้งข้อมูลเพิ่มเติมเพื่อช่วยตรวจสอบตัวเลือกที่เหมาะสม", handoff: "ทีมงานจะช่วยตรวจสอบคำขอของคุณ", pets: { allowed: "เลี้ยงสัตว์ได้", case_by_case: "พิจารณาสัตว์เลี้ยงเป็นรายกรณี", not_allowed: "ห้ามเลี้ยงสัตว์", unknown: "ยังไม่ทราบนโยบายสัตว์เลี้ยง" } },
};

export function renderReply(input, snapshot, inputFormat) {
  const facts = readSnapshot(snapshot), format = readFormat(inputFormat), selections = readSelections(input, facts);
  const w = words[format.locale], en = format.locale === "en";
  const number = value => format.numberFormat === "grouped" ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 20, useGrouping: true }).format(value) : String(value);
  const date = value => format.dateFormat === "iso" ? value : `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
  const lines = [], provenance = [];
  const append = (text, source) => { const start = lines.join("\n").length + (lines.length ? 1 : 0); lines.push(text); if (source) provenance.push({ ...source, start, end: start + text.length, text }); };
  if (format.greetingId !== "none") append(w.hello[format.tone] + (format.emojiPolicy === "friendly" ? " 🙂" : ""));
  append(w[selections.templateId]);
  for (const selected of selections.units) {
    const fact = facts.factSnapshot.find(item => item.unitId === selected.unitId);
    const clauses = {
      identity: () => `${fact.projectName} · ${fact.unitCode}`,
      price: () => en ? `Rent: ${number(fact.monthlyRentThb)} THB/month` : `ค่าเช่า ${number(fact.monthlyRentThb)} บาท/เดือน`,
      availableFrom: () => en ? `Available from: ${date(fact.availableFrom)}` : `ว่างตั้งแต่ ${date(fact.availableFrom)}`,
      bedrooms: () => en ? `${number(fact.bedrooms)} bedroom${fact.bedrooms === 1 ? "" : "s"}` : `${number(fact.bedrooms)} ห้องนอน`,
      petPolicy: () => w.pets[fact.petPolicy],
      transit: () => fact.transit.map(item => en ? `${item.station}: ${number(item.walkingDistanceM)} m walking distance` : `${item.station}: ระยะเดิน ${number(item.walkingDistanceM)} เมตร`).join("; "),
    };
    for (const factId of selected.factIds) append(clauses[factId](), { unitId: fact.unitId, unitRevision: fact.unitRevision, projectId: fact.projectId, projectRevision: fact.projectRevision, factId });
  }
  append(w[format.requiredDisclosureId]);
  if (format.ctaId !== "none") append(w[format.ctaId]);
  if (format.closingId !== "none") append(w.thanks);
  const text = lines.join("\n");
  if ([...text].length > format.maxLength) throw new Error("Reply exceeds maximum length");
  for (const phrase of format.forbiddenPhrases) if (text.toLocaleLowerCase("en-US").includes(phrase.toLocaleLowerCase("en-US"))) throw new Error("Reply contains forbidden phrase");
  return immutable({ text, snapshotId: facts.id, selections, format, provenance, grounded: true, automaticEligible: true });
}
