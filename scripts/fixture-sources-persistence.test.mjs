import assert from "node:assert/strict";
import test from "node:test";
import { createSourcesAutomationWorkspaceFixture } from "../fixture/sources-automation-workspace.mjs";

test("fixture Sources restores added groups after workspace restart", () => {
  let persistedGroups;
  const first = createSourcesAutomationWorkspaceFixture({
    onGroupsChange: (groups) => { persistedGroups = groups; },
  });

  const created = first.addGroup(
    { url: "https://www.facebook.com/groups/987654321001234" },
    "persist-group",
  );
  assert.equal(first.listSources().groups.length, 3);
  assert.ok(persistedGroups.some((group) => group.id === created.id));

  const restarted = createSourcesAutomationWorkspaceFixture({ initialGroups: persistedGroups });
  assert.deepEqual(
    restarted.listSources().groups.find((group) => group.id === created.id),
    Object.fromEntries(Object.entries(created).filter(([key]) => key !== "created")),
  );
});
