import assert from "node:assert/strict";
import test from "node:test";
import * as demo from "../src/demo.mjs";

function state() {
  return {
    businessProfile: {
      name: "Rental Radar",
      description: "ช่วยผู้เช่าหาห้องหรือคอนโด และช่วยเจ้าของประกาศปล่อยเช่า",
      relevantIntents: ["tenant_lead", "owner_lead", "listing"],
      relevanceThreshold: 60,
      updatedAt: "2026-10-21T00:00:00.000Z",
    },
    groups: {}, targets: {}, analyses: {}, messengerThreads: {}, messengerMessages: {}, messengerOutbound: {}, events: [],
  };
}

test("customer demo seed populates every data-driven surface idempotently", () => {
  const workspace = state();
  const now = "2026-10-21T16:00:00.000Z";

  const first = demo.seedCustomerDemo?.(workspace, now);
  assert.equal(first?.created, true);
  assert.equal(Object.values(workspace.groups).filter((item) => item.demo).length, 1);
  assert.equal(Object.values(workspace.targets).filter((item) => item.demo).length, 3);
  assert.equal(Object.values(workspace.analyses).filter((item) => item.demo && item.relevant).length, 3);
  const owner = workspace.analyses[`demo:9999999999999999:owner:post`];
  const listing = workspace.analyses[`demo:9999999999999999:listing:post`];
  assert.equal(owner.intent, "owner_lead");
  assert.equal(owner.extracted.budgetMax, 22000);
  assert.equal(listing.intent, "listing");
  assert.equal(Object.values(workspace.messengerThreads).filter((item) => item.demo).length, 2);
  assert.equal(Object.values(workspace.messengerOutbound).filter((item) => item.demo).length, 2);
  assert.equal(workspace.events.filter((item) => item.action === "customer_demo_loaded").length, 1);

  delete workspace.groups["9999999999999999"].demo;
  const second = demo.seedCustomerDemo(workspace, now);
  assert.equal(second.created, false);
  assert.equal(workspace.groups["9999999999999999"].demo, true);
  assert.equal(Object.values(workspace.targets).filter((item) => item.demo).length, 3);
  assert.equal(Object.values(workspace.messengerThreads).filter((item) => item.demo).length, 2);
  assert.equal(workspace.events.filter((item) => item.action === "customer_demo_loaded").length, 1);
});
