import { chromium } from "playwright-core";
import { digest } from "./state.mjs";

export function createSiteBrowser({ cdpUrl, mode, liveSubmissionEnabled, evidencePath }) {
  let browser;

  async function page() {
    if (!browser?.isConnected()) browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    return context.pages()[0] ?? context.newPage();
  }

  return {
    normalizeGroupUrl(raw) {
      const url = new URL(raw);
      if (mode === "fixture") {
        const match = url.pathname.match(/^\/fixture\/groups\/(1001|1002)\/?$/);
        if (!["127.0.0.1", "localhost"].includes(url.hostname) || !match) {
          throw new Error("Fixture mode accepts only a built-in group URL.");
        }
        return `http://127.0.0.1:3000/fixture/groups/${match[1]}`;
      }
      if (url.protocol !== "https:" || !["facebook.com", "www.facebook.com"].includes(url.hostname)) {
        throw new Error("Live mode accepts only an HTTPS facebook.com group URL.");
      }
      const match = url.pathname.match(/^\/groups\/(\d+)\/?$/);
      if (!match) throw new Error("Use a numeric Facebook group root URL, not a post or feed URL.");
      return `https://www.facebook.com/groups/${match[1]}`;
    },

    async inspectSession(groupUrl) {
      const active = await page();
      if (mode === "fixture") {
        const cookies = await active.context().cookies("http://127.0.0.1:3000");
        return cookies.some((cookie) => cookie.name === "fixture_session" && cookie.value === "connected")
          ? { state: "connected", actor: "Fixture Admin" }
          : { state: "not_connected", actor: null };
      }

      await active.goto(groupUrl ?? "https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
      const loginField = active.locator('input[name="email"], input[name="pass"]');
      if (await loginField.count()) return { state: "not_connected", actor: null };
      const profile = active.locator('a[href*="/me/"], a[aria-label*="profile" i]').first();
      const actor = (await profile.getAttribute("aria-label").catch(() => null)) ?? "Facebook account";
      return { state: "connected", actor };
    },

    async scan(groupUrl) {
      const active = await page();
      await active.goto(groupUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (mode === "fixture") return scanFixture(active, groupUrl);
      return scanFacebook(active, groupUrl);
    },

    async preflight(target) {
      const active = await page();
      await active.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (mode === "fixture") {
        const scope = fixtureScope(active, target);
        if ((await scope.count()) !== 1) throw new Error("The selected fixture target no longer resolves uniquely.");
        const current = await sourceText(scope, target.kind);
        if (digest(current) !== target.fingerprint) throw new Error("The selected target changed after review. Scan it again.");
        const composer = scope.locator(`textarea[data-poc-composer="${target.kind}"]`);
        if ((await composer.count()) !== 1) throw new Error("The selected target has no unique reply composer.");
        return;
      }

      const article = await liveTargetScope(active, target);
      const editors = target.kind === "comment"
        ? active.locator('[contenteditable="true"][role="textbox"][aria-label^="Reply to"]:visible')
        : article.locator('[contenteditable="true"][role="textbox"][aria-label*="comment" i]:visible');
      if ((await editors.count()) !== 1) throw new Error("Facebook did not expose one unambiguous reply editor.");
    },

    async submitOnce(target, message, attemptId) {
      const active = await page();
      if (mode === "fixture") {
        const scope = fixtureScope(active, target);
        const composer = scope.locator(`textarea[data-poc-composer="${target.kind}"]`);
        await composer.fill(message);
        await scope.locator(`button[data-poc-submit="${target.kind}"]`).click();
        const reply = active.locator(`[data-poc-own-reply][data-poc-target-key="${target.key}"]`).filter({ hasText: message });
        await reply.waitFor({ state: "visible", timeout: 10000 });
        const screenshot = evidencePath(attemptId);
        await active.screenshot({ path: screenshot, fullPage: true });
        return { verified: true, screenshotId: attemptId, visibleText: await reply.innerText() };
      }

      if (!liveSubmissionEnabled) throw new Error("Live submission is disabled. Set POC_LIVE_SUBMISSION=true for an authorized smoke test.");
      const article = await liveTargetScope(active, target);
      const editor = target.kind === "comment"
        ? active.locator('[contenteditable="true"][role="textbox"][aria-label^="Reply to"]:visible')
        : article.locator('[contenteditable="true"][role="textbox"][aria-label*="comment" i]:visible');
      await editor.fill(message);
      await editor.press("Enter");
      await active.waitForTimeout(2500);
      const screenshot = evidencePath(attemptId);
      await active.screenshot({ path: screenshot, fullPage: true });
      const verified = await verifyLivePlacement(active, target, message);
      return {
        verified,
        screenshotId: attemptId,
        visibleText: verified ? message : null,
        detail: verified
          ? "The exact reply is visible beneath the selected live target."
          : "The live click was attempted. Manual identity and placement verification is required.",
      };
    },

    async reconcile(target, message, attemptId) {
      const active = await page();
      await active.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      const locator = mode === "fixture"
        ? active.locator(`[data-poc-own-reply][data-poc-target-key="${target.key}"]`).filter({ hasText: message })
        : active.getByText(message, { exact: true }).filter({ visible: true });
      const verified = mode === "fixture"
        ? (await locator.count()) > 0
        : await verifyLivePlacement(active, target, message);
      if (!verified) return { verified: false };
      const screenshot = evidencePath(attemptId);
      await active.screenshot({ path: screenshot, fullPage: true });
      return { verified: true, screenshotId: attemptId, visibleText: await locator.first().innerText() };
    },
  };
}

async function scanFixture(page, groupUrl) {
  await page.locator("[data-poc-group-id]").waitFor({ timeout: 10000 });
  const posts = await page.locator("article[data-poc-post-id]").evaluateAll((nodes) =>
    nodes.slice(0, 10).map((node) => ({
      postId: node.dataset.pocPostId,
      author: node.querySelector("[data-poc-author]")?.textContent?.trim() ?? "Unknown",
      text: node.querySelector("[data-poc-post-text]")?.textContent?.trim() ?? "",
      comments: [...node.querySelectorAll("[data-poc-comment-id]")].slice(0, 20).map((comment) => ({
        commentId: comment.dataset.pocCommentId,
        author: comment.querySelector("[data-poc-author]")?.textContent?.trim() ?? "Unknown",
        text: comment.querySelector("[data-poc-comment-text]")?.textContent?.trim() ?? "",
      })),
    })),
  );
  const groupId = new URL(groupUrl).pathname.split("/").pop();
  const groupName = groupId === "1002" ? "Bangkok Condo Owners Test Group" : "Bangkok Room Finder Test Group";
  return buildFixtureTargets(groupId, groupUrl, posts, groupName);
}

export function buildFixtureTargets(groupId, groupUrl, posts, groupName) {
  const targets = [];
  for (const post of posts) {
    const postKey = `fixture:${groupId}:${post.postId}:post`;
    targets.push({
      key: postKey,
      kind: "post",
      groupId,
      postId: post.postId,
      commentId: null,
      url: `${groupUrl}#${post.postId}`,
      author: post.author,
      text: post.text,
      postText: post.text,
      context: post.comments.map((item) => `${item.author}: ${item.text}`),
      fingerprint: digest(post.text),
    });
    for (const comment of post.comments) {
      targets.push({
        key: `fixture:${groupId}:${post.postId}:${comment.commentId}`,
        kind: "comment",
        groupId,
        postId: post.postId,
        commentId: comment.commentId,
        url: `${groupUrl}#${comment.commentId}`,
        author: comment.author,
        text: comment.text,
        postText: post.text,
        context: post.comments.map((item) => `${item.author}: ${item.text}`),
        fingerprint: digest(comment.text),
      });
    }
  }
  return { groupId, groupName, targets };
}

async function scanFacebook(page, groupUrl) {
  const groupId = new URL(groupUrl).pathname.split("/")[2];
  const trace = [];
  await waitForFacebookFeed(page, groupId);
  const title = await page.title();
  const groupName = normalizeFacebookGroupName(title) || `Facebook group ${groupId}`;
  let initialCards = [];
  for (let attempt = 0; attempt < 9; attempt += 1) {
    initialCards = await readFacebookFeedCards(page, groupId);
    if (initialCards.some((card) => card.timestampHref)) break;
    await page.waitForTimeout(750);
  }
  trace.push(`feed cards=${initialCards.length}, timestamps=${initialCards.filter((card) => card.timestampHref).length}`);
  const discoveries = [];

  for (const initialCard of initialCards.slice(0, 10)) {
    if (page.url().replace(/\/$/, "") !== groupUrl.replace(/\/$/, "")) {
      await page.goto(groupUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForFacebookFeed(page, groupId);
    }
    let card;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      card = matchFacebookFeedCard(await readFacebookFeedCards(page, groupId), initialCard);
      if (card?.timestampHref) break;
      await page.waitForTimeout(400);
    }
    if (!card?.timestampHref) {
      trace.push("matching card had no stable timestamp trigger");
      continue;
    }
    const opened = await clickFacebookTimestamp(page, card.timestampHref, groupId);
    trace.push(`timestamp click opened=${opened}, url=${page.url()}`);
    if (!opened) continue;

    discoveries.push({ url: page.url(), scopes: card.scopes });
    await page.waitForTimeout(1200);
    discoveries.push(...await readFacebookCommentDiscoveries(page));
  }

  if (!discoveries.length) {
    discoveries.push(...await readFacebookLinkedDiscoveries(page));
  }
  const targets = buildFacebookTargets(groupId, discoveries);
  if (!targets.length) {
    console.warn(`Facebook scan trace: ${trace.join("; ")}`);
    throw new Error("Facebook posts are visible, but no permanent post link could be verified. Open the Browser view and try Scan again.");
  }
  return {
    groupId,
    groupName,
    targets: targets.slice(0, 30),
  };
}

export function normalizeFacebookGroupName(title) {
  return title.replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*Facebook.*$/i, "").trim();
}

async function waitForFacebookFeed(page, groupId) {
  const visiblePost = page.locator('[aria-label^="Actions for this post"], a[href*="/groups/"][href*="/posts/"]').first();
  await visiblePost.waitFor({ state: "attached", timeout: 8000 }).catch(() => undefined);
  await page.waitForFunction((expectedGroupId) => {
    const buttons = [...document.querySelectorAll('[aria-label^="Actions for this post"]')];
    return buttons.some((button) => {
      let node = button;
      for (let depth = 0; depth < 8 && node; depth += 1, node = node.parentElement) {
        for (const link of node.querySelectorAll("a[href]")) {
          const label = (link.innerText || link.getAttribute("aria-label") || "")
            .replace(/[\u034f\u200b-\u200f\u2060\ufeff]/g, "")
            .trim();
          const url = new URL(link.href);
          const expectedPath = `/groups/${expectedGroupId}`;
          const isTrigger = url.pathname.replace(/\/$/, "") === expectedPath
            && url.searchParams.has("__cft__[0]")
            && url.hash.startsWith("#?");
          if (isTrigger || /^\d+[smhdw]$/i.test(label) || /^\d+\s+(?:minutes?|hours?|days?)\s+ago$/i.test(label)) return true;
        }
      }
      return false;
    });
  }, groupId, { timeout: 6000 }).catch(() => undefined);
  if ((await visiblePost.count()) === 0) {
    for (let index = 0; index < 2; index += 1) {
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(700);
    }
  }
}

export async function readFacebookFeedCards(page, groupId) {
  const cards = await page.locator('[aria-label^="Actions for this post"]').evaluateAll((buttons, expectedGroupId) => buttons.map((button) => {
    const scopes = [];
    const timestampLinks = [];
    let node = button;
    for (let depth = 0; depth < 12 && node; depth += 1, node = node.parentElement) {
      scopes.push((node.innerText ?? "").trim());
      for (const link of node.querySelectorAll("a[href]")) {
        const label = (link.innerText || link.getAttribute("aria-label") || "")
          .replace(/[\u034f\u200b-\u200f\u2060\ufeff]/g, "")
          .trim();
        const url = new URL(link.href);
        const expectedPath = `/groups/${expectedGroupId}`;
        const isTrigger = url.pathname.replace(/\/$/, "") === expectedPath
          && url.searchParams.has("__cft__[0]")
          && url.hash.startsWith("#?");
        if (isTrigger || /^\d+[smhdw]$/i.test(label) || /^\d+\s+(?:minutes?|hours?|days?)\s+ago$/i.test(label)) {
          const href = link.getAttribute("href");
          if (href && !timestampLinks.includes(href)) timestampLinks.push(href);
        }
      }
    }
    return { scopes, timestampHref: timestampLinks[0] ?? null };
  }), groupId);

  return cards.flatMap((card) => {
    try {
      const content = pickFacebookContentScope(card.scopes, "post");
      return [{ ...card, fingerprint: digest(content.text) }];
    } catch {
      return [];
    }
  });
}

export async function clickFacebookTimestamp(page, href, groupId) {
  const link = page.locator(`a[href=${JSON.stringify(href)}]`).filter({ visible: true });
  if ((await link.count()) !== 1) return false;
  const isExpectedPost = (url) => {
    try { return canonicalFacebookTarget(url.href, groupId).kind === "post"; } catch { return false; }
  };
  const navigation = page.waitForURL(isExpectedPost, { timeout: 8000 }).catch(() => null);
  try { await link.click({ timeout: 5000 }); } catch { return false; }
  if (await navigation) return true;
  return isExpectedPost(new URL(page.url()));
}

export function matchFacebookFeedCard(cards, initialCard) {
  const sameHref = initialCard.timestampHref ? cards.filter((card) => card.timestampHref === initialCard.timestampHref) : [];
  if (sameHref.length === 1) return sameHref[0];
  const sameContent = cards.filter((card) => card.fingerprint === initialCard.fingerprint);
  return sameContent.length === 1 ? sameContent[0] : null;
}

async function readFacebookCommentDiscoveries(page) {
  return page.locator('a[href*="comment_id="]:not([href*="reply_comment_id="])').evaluateAll((links) => {
    const seen = new Set();
    return links.flatMap((link) => {
      const url = new URL(link.href);
      const commentId = url.searchParams.get("comment_id");
      if (!commentId || seen.has(commentId)) return [];
      seen.add(commentId);
      const scopes = [];
      let node = link;
      for (let depth = 0; depth < 12 && node; depth += 1, node = node.parentElement) {
        scopes.push((node.innerText ?? "").trim());
      }
      return [{ url: link.href, scopes }];
    });
  });
}

async function readFacebookLinkedDiscoveries(page) {
  return page.locator('a[href*="/groups/"][href*="/posts/"]').evaluateAll((links) => links.map((link) => {
    const scopes = [];
    let node = link;
    for (let depth = 0; depth < 12 && node; depth += 1, node = node.parentElement) {
      scopes.push((node.innerText ?? "").trim());
    }
    return { url: link.href, scopes };
  }));
}

export function normalizeFacebookArticle(rawText, kind) {
  const metadata = /^(?:Facebook|·|Author|Admin|Like|Comment|Reply|Share|Send|Follow|Shared post|\d+|\d+[smhdw]|\d+\s+(?:comments?|replies?|shares?)|\d+\s*(?:min|mins|minute|minutes|hour|hours|day|days)(?:\s+ago)?|(?:a|an)\s+(?:minute|hour|day|week)\s+ago|(?:today|yesterday)(?:\s+at\s+\d{1,2}:\d{2})?)$/i;
  const lines = rawText
    .split("\n")
    .map((line) => ({
      text: line.replace(/[\u034f\u200b-\u200f\u2060\ufeff]/g, "").trim(),
      isObfuscatedGlyph: /[\u034f\u200b-\u200f\u2060\ufeff]/.test(line),
    }))
    .filter((line) => line.text && !(line.isObfuscatedGlyph && line.text.length === 1) && !metadata.test(line.text))
    .map((line) => line.text);
  const author = lines[0] || "Visible Facebook member";
  const content = lines.slice(1);
  const text = content.join("\n").trim().slice(0, 4000);
  if (!text) throw new Error(`The live ${kind} did not contain stable visible text.`);
  return { author, text };
}

export function pickFacebookContentScope(scopes, kind) {
  for (const rawText of scopes) {
    try {
      return { ...normalizeFacebookArticle(rawText, kind), rawText };
    } catch {
      // Keep climbing until the smallest ancestor with actual content is found.
    }
  }
  throw new Error(`The live ${kind} did not contain stable visible text.`);
}

export function canonicalFacebookTarget(rawUrl, expectedGroupId) {
  const parsed = new URL(rawUrl, "https://www.facebook.com");
  const match = parsed.pathname.match(/^\/groups\/(\d+)\/posts\/(\d+)\/?$/);
  if (!match || match[1] !== expectedGroupId) throw new Error("Facebook returned a permalink outside the authorized group.");
  const commentId = parsed.searchParams.get("comment_id");
  const suffix = commentId ? `?comment_id=${commentId}` : "";
  return {
    groupId: match[1],
    postId: match[2],
    commentId,
    kind: commentId ? "comment" : "post",
    url: `https://www.facebook.com/groups/${match[1]}/posts/${match[2]}/${suffix}`,
  };
}

export function isFacebookTimestampTrigger(rawUrl, expectedGroupId) {
  const parsed = new URL(rawUrl, "https://www.facebook.com");
  return parsed.pathname.replace(/\/$/, "") === `/groups/${expectedGroupId}`
    && parsed.searchParams.has("__cft__[0]")
    && parsed.hash.startsWith("#?");
}

export function buildFacebookTargets(groupId, discoveries) {
  const normalized = [];
  const seen = new Set();
  for (const discovery of discoveries) {
    try {
      const identity = canonicalFacebookTarget(discovery.url, groupId);
      const itemKey = `${identity.kind}:${identity.commentId ?? identity.postId}`;
      if (seen.has(itemKey)) continue;
      const content = pickFacebookContentScope(discovery.scopes, identity.kind);
      seen.add(itemKey);
      normalized.push({ ...identity, ...content });
    } catch {
      // Facebook renders several structural copies of the same link; only
      // retain the first copy whose ancestor contains stable visible content.
    }
  }

  const postTextById = new Map(
    normalized.filter((item) => item.kind === "post").map((item) => [item.postId, item.text]),
  );
  const contextByPostId = new Map();
  for (const item of normalized.filter((entry) => entry.kind === "comment")) {
    const context = contextByPostId.get(item.postId) ?? [];
    context.push(`${item.author}: ${item.text}`);
    contextByPostId.set(item.postId, context);
  }

  return normalized.map((item) => ({
    key: `live:${groupId}:${item.commentId ?? item.postId}:${item.kind}`,
    kind: item.kind,
    groupId,
    postId: item.postId,
    commentId: item.commentId,
    url: item.url,
    author: item.author,
    text: item.text,
    postText: postTextById.get(item.postId) ?? "Open the Facebook permalink to view the parent post.",
    context: contextByPostId.get(item.postId) ?? [],
    fingerprint: digest(item.text),
  }));
}

async function liveTargetScope(page, target) {
  if (target.kind === "comment") {
    const candidates = page.locator('[role="article"]:visible').filter({ hasText: target.text.slice(0, 80) });
    const controls = candidates.getByText("Reply", { exact: true });
    if ((await controls.count()) !== 1) throw new Error("The live comment no longer resolves to one Reply control.");
    const openEditors = page.locator('[contenteditable="true"][role="textbox"][aria-label^="Reply to"]:visible');
    if ((await openEditors.count()) === 0) {
      await controls.click();
      await openEditors.waitFor({ state: "visible", timeout: 5000 });
    }
    if ((await openEditors.count()) > 1) throw new Error("Facebook exposed more than one visible comment reply editor.");
    return controls.locator('xpath=ancestor::*[@role="article"][1]');
  }
  const current = new URL(page.url());
  const canonicalPost = current.pathname.match(/\/groups\/(\d+)\/posts\/(\d+)\/?$/);
  if (!canonicalPost || canonicalPost[1] !== target.groupId || canonicalPost[2] !== target.postId) {
    throw new Error("The live post permalink changed before submission.");
  }
  const exactPostText = target.text.split("\n")[0].trim();
  const visiblePostText = page.getByText(exactPostText, { exact: true }).filter({ visible: true });
  if ((await visiblePostText.count()) !== 1) throw new Error("The live post text no longer resolves uniquely.");
  return page.locator("body");
}

async function verifyLivePlacement(page, target, message) {
  const replies = page.getByText(message, { exact: true }).filter({ visible: true });
  if ((await replies.count()) === 0) return false;
  return replies.evaluateAll((nodes, targetText) => nodes.some((node) => {
    let scope = node.parentElement;
    for (let depth = 0; depth < 30 && scope; depth += 1, scope = scope.parentElement) {
      if ((scope.innerText ?? "").includes(targetText)) return true;
    }
    return false;
  }), target.text.split("\n")[0].trim());
}

function fixtureScope(page, target) {
  const post = page.locator(`article[data-poc-post-id="${target.postId}"]`);
  return target.kind === "comment"
    ? post.locator(`[data-poc-comment-id="${target.commentId}"]`)
    : post;
}

async function sourceText(scope, kind) {
  return (await scope.locator(kind === "post" ? "[data-poc-post-text]" : "[data-poc-comment-text]").innerText()).trim();
}

