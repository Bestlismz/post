import assert from "node:assert/strict";
import test from "node:test";
import { submissionPolicy } from "../src/submission-policy.mjs";

test("demo targets always stay local even when live sending is locked", () => {
  assert.equal(submissionPolicy({ mode: "live", liveSubmissionEnabled: false }, { demo: true }), "demo");
});

test("real live targets remain locked unless explicitly enabled", () => {
  assert.equal(submissionPolicy({ mode: "live", liveSubmissionEnabled: false }, {}), "blocked");
  assert.equal(submissionPolicy({ mode: "live", liveSubmissionEnabled: true }, {}), "remote");
  assert.equal(submissionPolicy({ mode: "fixture", liveSubmissionEnabled: false }, {}), "remote");
});
