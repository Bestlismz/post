import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeDeterministically,
  analysisFingerprints,
  createRelevanceAnalyzer,
  isAnalysisFresh,
} from "../src/relevance.mjs";

const profile = {
  name: "Condo Match",
  description: "ช่วยผู้เช่าหาคอนโดและช่วยเจ้าของปล่อยเช่า",
  relevantIntents: ["tenant_lead", "owner_lead", "listing"],
  relevanceThreshold: 60,
  updatedAt: "2026-10-21T00:00:00.000Z",
};

function target(text, key = "live:100:1:post") {
  return { key, fingerprint: `fp:${text}`, text, postText: text, context: [] };
}

test("classifies Thai tenant demand and extracts rental criteria", () => {
  const result = analyzeDeterministically(target("หาคอนโดเช่าใกล้ BTS อ่อนนุช 1 ห้องนอน งบไม่เกิน 15,000 บาท ย้ายต้นเดือนหน้า"), profile);

  assert.equal(result.intent, "tenant_lead");
  assert.equal(result.relevant, true);
  assert.ok(result.score >= 80);
  assert.equal(result.extracted.budgetMax, 15000);
  assert.deepEqual(result.extracted.locations, ["BTS อ่อนนุช"]);
  assert.equal(result.extracted.bedrooms, "1");
  assert.equal(result.extracted.moveDate, "ต้นเดือนหน้า");
});

test("classifies English tenant demand", () => {
  const result = analyzeDeterministically(target("Looking for a studio to rent near Ari. Budget 18,000 THB, move next month."), profile);
  assert.equal(result.intent, "tenant_lead");
  assert.equal(result.relevant, true);
  assert.equal(result.extracted.budgetMax, 18000);
  assert.deepEqual(result.extracted.locations, ["Ari"]);
});

test("distinguishes owner help from a neutral listing", () => {
  const owner = analyzeDeterministically(target("เจ้าของห้องต้องการเอเจนต์ช่วยปล่อยเช่าคอนโด Ideo สุขุมวิท"), profile);
  const listing = analyzeDeterministically(target("ปล่อยเช่าคอนโด Ideo สุขุมวิท 1 ห้องนอน 17,000 บาท"), profile);
  assert.equal(owner.intent, "owner_lead");
  assert.equal(owner.relevant, true);
  assert.equal(listing.intent, "listing");
  assert.equal(listing.relevant, true);
});

test("keeps condo news and weak mentions below the threshold", () => {
  const news = analyzeDeterministically(target("ข่าวเปิดตัวคอนโดใหม่และบทวิเคราะห์ตลาดอสังหาริมทรัพย์"), profile);
  const weak = analyzeDeterministically(target("วันนี้ผ่านคอนโดแถวสุขุมวิท วิวสวยดี"), profile);
  assert.equal(news.intent, "irrelevant");
  assert.equal(news.relevant, false);
  assert.ok(weak.score < 60);
  assert.equal(weak.relevant, false);
});

test("invalidates analysis when target or profile changes", () => {
  const item = target("หาห้องเช่าแถวอารีย์");
  const fingerprints = analysisFingerprints(item, profile);
  const analysis = { ...fingerprints };
  assert.equal(isAnalysisFresh(analysis, item, profile), true);
  assert.equal(isAnalysisFresh(analysis, { ...item, fingerprint: "changed" }, profile), false);
  assert.equal(isAnalysisFresh(analysis, item, { ...profile, relevanceThreshold: 75 }), false);
});

test("uses validated structured OpenAI output", async () => {
  const client = { responses: { create: async () => ({ output_text: JSON.stringify({
    score: 91,
    intent: "tenant_lead",
    reasons: ["ระบุความต้องการเช่าชัดเจน"],
    extracted: { locations: ["อ่อนนุช"], budgetMin: null, budgetMax: 15000, propertyTypes: ["condo"], bedrooms: "1", moveDate: null, contactDetails: [] },
  }) }) } };
  const analyze = createRelevanceAnalyzer({ apiKey: "test", model: "test-model", client });
  const result = await analyze(target("หาคอนโดเช่าอ่อนนุช"), profile);
  assert.equal(result.source, "openai");
  assert.equal(result.score, 91);
  assert.equal(result.relevant, true);
});

test("falls back when OpenAI output is malformed or rejected", async () => {
  for (const client of [
    { responses: { create: async () => ({ output_text: "not-json" }) } },
    { responses: { create: async () => { throw new Error("bad key sk-proj-secret"); } } },
  ]) {
    const analyze = createRelevanceAnalyzer({ apiKey: "test", model: "test-model", client });
    const result = await analyze(target("หาคอนโดเช่าใกล้อารีย์"), profile);
    assert.equal(result.source, "deterministic_fallback");
    assert.doesNotMatch(result.detail, /sk-/);
  }
});
