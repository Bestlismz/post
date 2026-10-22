import assert from "node:assert/strict";
import test from "node:test";
import { createInventoryWorkspaceFixture } from "../fixture/inventory-workspace.mjs";

test("properties fixture exposes seeded inventory and enforces revision lifecycle", () => {
  const inventory = createInventoryWorkspaceFixture();
  assert.ok(inventory.listProjects().projects.length >= 2);
  assert.ok(inventory.listUnits().units.some((unit) => unit.status === "available" && unit.publishedAt));

  const project = inventory.createProject({ name: "ไลฟ์ อโศก" });
  let unit = inventory.createUnit({ projectId: project.id, unitCode: "T-101", roomType: "1 ห้องนอน", monthlyRentThb: 18000, availableFrom: "2026-11-01", petPolicy: "allowed", description: "ห้องสวย เฟอร์นิเจอร์ครบ" });
  assert.throws(() => inventory.updateUnit(unit.id, { floor: 8 }, 99), (error) => error.status === 409);
  unit = inventory.changeAvailability(unit.id, "available", unit.revision);
  unit = inventory.publishUnit(unit.id, unit.revision);
  assert.ok(unit.publishedAt);
  unit = inventory.archiveUnit(unit.id, unit.revision);
  assert.equal(unit.status, "archived");
  assert.ok(inventory.listUnits().units.some((entry) => entry.id === unit.id));
});
