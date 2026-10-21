import assert from "node:assert/strict";
import test from "node:test";
import { buildConversation, buildConversationOptions, conversationId } from "../src/conversation.mjs";

const target = (key, kind = "comment", extra = {}) => ({ key, kind, groupId: "g1", postId: "p1", author: key, text: `Text ${key}`, postText: "Parent context", url: `https://example.com/${key}`, ...extra });

test("conversation identity cannot collide on joined delimiters", () => {
  assert.notEqual(conversationId({ groupId: "a:b", postId: "c" }), conversationId({ groupId: "a", postId: "b:c" }));
});

test("conversation preserves sibling order and exact submission ownership", () => {
  const targets = [target("c2"), target("post", "post"), target("c1"), target("c2"), target("other-group", "comment", { groupId: "g2" }), target("other-post", "comment", { postId: "p2" })];
  const submissions = [{ targetKey: "post", state: "verified" }, { targetKey: "c1", state: "unknown" }, { targetKey: "other-group", state: "attempted" }];
  const workspace = { targets, submissions, groups: [{ id: "g1", name: "Known group" }] };
  const conversation = buildConversation(workspace, "c2");
  assert.equal(conversation.group.label, "Known group");
  assert.equal(conversation.post.author, "post");
  assert.equal(conversation.post.text, "Text post");
  assert.deepEqual(conversation.comments.map(({ target }) => target.key), ["c2", "c1"]);
  assert.equal(conversation.comments[0].submission, null);
  assert.equal(conversation.comments[1].submission, submissions[1]);
  assert.equal(conversation.postSubmission, submissions[0]);
  assert.equal(conversation.selectedTarget, targets[0]);
  assert.equal(buildConversationOptions(workspace).length, 3);
  assert.equal(buildConversationOptions(workspace)[0].targetKey, "post");
});

test("missing parent keeps context unattributed and has no post reply target", () => {
  const workspace = { targets: [target("comment-author")], submissions: [], groups: [] };
  const conversation = buildConversation(workspace, "comment-author");
  assert.deepEqual(conversation.post, { kind: "context", target: null, author: null, text: "Parent context" });
  assert.equal(conversation.group.label, "Group g1");
  assert.equal(conversation.postSubmission, null);
  assert.equal(buildConversation(workspace, "missing"), null);
});

test("missing post text never promotes a comment or scanner placeholder", () => {
  for (const postText of ["", "Open the Facebook permalink to view the parent post."]) {
    const conversation = buildConversation({ targets: [target("c1", "comment", { postText })], submissions: [] }, "c1");
    assert.equal(conversation.post.text, "");
    assert.equal(conversation.post.author, null);
  }
});

test("each persisted attempt state stays attached only to its target", () => {
  const submissions = ["attempted", "unknown", "verified"].map((state) => ({ targetKey: state, state, evidenceId: state }));
  const conversation = buildConversation({ targets: submissions.map((entry) => target(entry.targetKey)), submissions }, "unknown");
  assert.deepEqual(conversation.comments.map((row) => row.submission), submissions);
});
