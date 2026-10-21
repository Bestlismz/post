import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFacebookTargets,
  canonicalFacebookTarget,
  isFacebookTimestampTrigger,
  normalizeFacebookArticle,
  pickFacebookContentScope,
} from "../src/browser.mjs";
import { preserveSubmittedTargetKeys } from "../src/state.mjs";

test("normalizes a Facebook comment without changing metadata", () => {
  const result = normalizeFacebookArticle([
    "Best Lismzz",
    "·",
    "4m",
    "·",
    "Author",
    "Admin",
    "[POC COMMENT TEST 2026-10-20] ความคิดเห็นจำลองสำหรับทดสอบการอ่านคอมเมนต์",
    "Reply",
  ].join("\n"), "comment");

  assert.deepEqual(result, {
    author: "Best Lismzz",
    text: "[POC COMMENT TEST 2026-10-20] ความคิดเห็นจำลองสำหรับทดสอบการอ่านคอมเมนต์",
  });
});

test("keeps multiline post content and removes action labels", () => {
  const result = normalizeFacebookArticle([
    "Mali",
    "2h",
    "หาห้องเช่าใกล้ BTS อ่อนนุช",
    "งบไม่เกิน 12,000 บาท",
    "Like",
    "Comment",
    "Share",
  ].join("\n"), "post");

  assert.deepEqual(result, {
    author: "Mali",
    text: "หาห้องเช่าใกล้ BTS อ่อนนุช\nงบไม่เกิน 12,000 บาท",
  });
});

test("normalizes the current Facebook group card without placeholder and time labels", () => {
  const result = normalizeFacebookArticle([
    "Facebook",
    "Facebook",
    "Best Lismzz",
    "Admin",
    "·",
    "12 hours ago",
    "12h",
    "·",
    "[POC TEST 2026-10-20] โพสต์ทดสอบระบบ",
    "Shared post",
    "2",
    "Like",
    "Comment",
    "Share",
  ].join("\n"), "post");

  assert.deepEqual(result, {
    author: "Best Lismzz",
    text: "[POC TEST 2026-10-20] โพสต์ทดสอบระบบ",
  });
});

test("chooses the smallest ancestor containing meaningful comment text", () => {
  const result = pickFacebookContentScope([
    "12h",
    "·\n12h",
    "Best Lismzz\n·\n12h",
    "Best Lismzz\n·\n12h\nความคิดเห็นที่ต้องตอบ",
    "Best Lismzz\n·\n12h\nความคิดเห็นที่ต้องตอบ\nLike\nReply",
  ], "comment");

  assert.deepEqual(result, {
    author: "Best Lismzz",
    text: "ความคิดเห็นที่ต้องตอบ",
    rawText: "Best Lismzz\n·\n12h\nความคิดเห็นที่ต้องตอบ",
  });
});

test("canonicalizes a tracked Facebook comment permalink", () => {
  const result = canonicalFacebookTarget(
    "https://www.facebook.com/groups/1742522453522327/posts/1742525160188723/?comment_id=1742528283521744&__cft__[0]=tracking",
    "1742522453522327",
  );

  assert.deepEqual(result, {
    groupId: "1742522453522327",
    postId: "1742525160188723",
    commentId: "1742528283521744",
    kind: "comment",
    url: "https://www.facebook.com/groups/1742522453522327/posts/1742525160188723/?comment_id=1742528283521744",
  });
});

test("builds stable post and comment targets from an opened permalink", () => {
  const targets = buildFacebookTargets("1742522453522327", [
    {
      url: "https://www.facebook.com/groups/1742522453522327/posts/1742525160188723",
      scopes: ["Best Lismzz\n12h\nโพสต์หลัก\nLike\nComment\nShare"],
    },
    {
      url: "https://www.facebook.com/groups/1742522453522327/posts/1742525160188723/?comment_id=1742528283521744&tracking=yes",
      scopes: ["12h", "Best Lismzz\n12h\nความคิดเห็นทดสอบ"],
    },
  ]);

  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map(({ key, kind, postId, commentId, url, text, postText, context }) => ({
    key, kind, postId, commentId, url, text, postText, context,
  })), [
    {
      key: "live:1742522453522327:1742525160188723:post",
      kind: "post",
      postId: "1742525160188723",
      commentId: null,
      url: "https://www.facebook.com/groups/1742522453522327/posts/1742525160188723/",
      text: "โพสต์หลัก",
      postText: "โพสต์หลัก",
      context: ["Best Lismzz: ความคิดเห็นทดสอบ"],
    },
    {
      key: "live:1742522453522327:1742528283521744:comment",
      kind: "comment",
      postId: "1742525160188723",
      commentId: "1742528283521744",
      url: "https://www.facebook.com/groups/1742522453522327/posts/1742525160188723/?comment_id=1742528283521744",
      text: "ความคิดเห็นทดสอบ",
      postText: "โพสต์หลัก",
      context: ["Best Lismzz: ความคิดเห็นทดสอบ"],
    },
  ]);
});

test("ignores a permalink node that has no meaningful content scope", () => {
  const targets = buildFacebookTargets("1742522453522327", [
    {
      url: "https://www.facebook.com/groups/1742522453522327/posts/1742525160188723",
      scopes: ["12h", "·\n12h"],
    },
    {
      url: "https://www.facebook.com/groups/1742522453522327/posts/1742525160188723",
      scopes: ["Best Lismzz\n12h\nโพสต์ที่อ่านได้"],
    },
  ]);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].text, "โพสต์ที่อ่านได้");
});

test("keeps the durable submission key when a comment gains its real permalink id", () => {
  const scanned = [{
    key: "live:100:comment-22:comment",
    kind: "comment",
    groupId: "100",
    fingerprint: "same-content",
    postId: "post-11",
    commentId: "comment-22",
  }];
  const existing = {
    "live:100:post-11:comment": {
      key: "live:100:post-11:comment",
      kind: "comment",
      groupId: "100",
      fingerprint: "same-content",
      postId: null,
      commentId: "post-11",
    },
  };
  const submissions = { "live:100:post-11:comment": { state: "verified" } };

  assert.equal(
    preserveSubmittedTargetKeys(scanned, existing, submissions)[0].key,
    "live:100:post-11:comment",
  );
});

test("recognizes an obfuscated group timestamp trigger without reading its label", () => {
  assert.equal(isFacebookTimestampTrigger(
    "https://www.facebook.com/groups/1742522453522327?__cft__[0]=opaque&__tn__=%2CO%2CP-R#?abc",
    "1742522453522327",
  ), true);
  assert.equal(isFacebookTimestampTrigger(
    "https://www.facebook.com/groups/1742522453522327/user/61595775053726/?__cft__[0]=opaque",
    "1742522453522327",
  ), false);
});

test("rejects Facebook anti-scraping glyphs as post content", () => {
  assert.throws(
    () => normalizeFacebookArticle("S͏\ne͏\no͏\nd͏\no͏\nr͏\nn͏\nt͏\np͏", "post"),
    /did not contain stable visible text/,
  );
});

test("removes anti-scraping glyphs before normalizing a hydrated post", () => {
  assert.deepEqual(normalizeFacebookArticle([
    "S͏", "e͏", "o͏", "d͏", "Best Lismzz", "12h", "เนื้อหาโพสต์จริง", "Like", "Comment", "Share",
  ].join("\n"), "post"), {
    author: "Best Lismzz",
    text: "เนื้อหาโพสต์จริง",
  });
});
