import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("production shell removes the legacy top-level navigation", async () => {
  const page = await readFile(new URL("app/page.jsx", projectRoot), "utf8");

  assert.doesNotMatch(
    page,
    /Lead inbox|Reply review|Messenger|Facebook login|Overview|Activity/,
  );
});

test("shell exposes one five-destination route manifest", async () => {
  const { routes } = await import("../app/lib/routes.mjs");

  assert.deepEqual(
    routes.map((route) => route.id),
    ["inbox", "properties", "sources", "automations", "settings"],
  );
  assert.deepEqual(
    routes.map((route) => route.mobileLabel),
    ["Inbox", "Properties", "Sources", "Automations", "Settings"],
  );
  assert.equal(
    routes.some((route) => /Overview|Messenger|Browser|Activity/.test(route.label)),
    false,
  );
});

test("route state restores from a URL and browser popstate", async () => {
  const { createRouteStore } = await import("../app/lib/routes.mjs");
  const listeners = new Map();
  const browser = {
    location: { href: "https://radar.test/properties?status=available" },
    history: {
      pushState(_state, _unused, href) {
        browser.location.href = new URL(href, browser.location.href).href;
      },
      replaceState(_state, _unused, href) {
        browser.location.href = new URL(href, browser.location.href).href;
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const seen = [];
  const store = createRouteStore(browser, (state) => seen.push(state));

  assert.equal(store.getSnapshot().route, "properties");
  store.navigate({ route: "sources", query: { source: "group-12" } });
  assert.equal(browser.location.href, "https://radar.test/sources?source=group-12");
  browser.location.href = "https://radar.test/inbox?view=table&item=lead-7";
  listeners.get("popstate")();
  assert.deepEqual(seen.at(-1), {
    route: "inbox",
    query: { item: "lead-7", view: "table" },
  });
  store.destroy();
});

test("Inbox route is table-only and canonicalizes legacy workspace state into authoritative filters", async () => {
  const { canonicalInboxHref, inboxHref, readInboxRouteState } = await import("../app/lib/routes.mjs");

  assert.deepEqual(readInboxRouteState("?view=workspace&state=needs_review&channel=facebook_group&location=%E0%B8%AD%E0%B9%82%E0%B8%A8%E0%B8%81&budgetMin=10000&budgetMax=25000&assignee=unassigned&q=%E0%B8%AB%E0%B9%89%E0%B8%AD%E0%B8%87&item=lead-7"), {
    item: "lead-7",
    filters: {
      channel: "facebook_group",
      status: "needs_review",
      location: "อโศก",
      budgetMin: "10000",
      budgetMax: "25000",
      assignee: "unassigned",
      search: "ห้อง",
    },
  });
  assert.equal(canonicalInboxHref("?view=workspace&state=needs_review&item=lead-7"), "/inbox?item=lead-7&status=needs_review");
  assert.equal(inboxHref("?status=needs_review&channel=messenger", { status: null, channel: null }), "/inbox");
});

test("Inbox status filter only submits statuses accepted by the API", async () => {
  const queue = await readFile(new URL("app/inbox/inbox-queue.jsx", projectRoot), "utf8");

  assert.match(queue, /Object\.entries\(statusFilterLabels\)/);
  assert.match(queue, /const statusFilterLabels\s*=\s*\{[^}]*pending_or_updated[^}]*needs_review[^}]*completed[^}]*handoff[^}]*failed[^}]*\}/s);
  assert.doesNotMatch(queue, /statusFilterLabels\s*=\s*\{[^}]*reconciling/s);
  assert.doesNotMatch(queue, /statusFilterLabels\s*=\s*\{[^}]*send_failed/s);
});

test("every navigation destination is backed by a real App Router page", async () => {
  const { routes } = await import("../app/lib/routes.mjs");
  for (const route of routes) {
    const page = await readFile(
      new URL(`app/${route.id}/page.jsx`, projectRoot),
      "utf8",
    );
    if (route.id === "inbox") {
      assert.match(page, /InboxTable/);
      assert.doesNotMatch(page, /InboxQueue|InboxViewSwitch|view\s*===\s*["']workspace["']/);
    }
    else if (route.id === "properties") assert.match(page, /UnitTable/);
    else if (route.id === "sources") assert.match(page, /SourceRow/);
    else if (route.id === "automations") assert.match(page, /PolicyEditor/);
    else if (route.id === "settings") assert.match(page, /AuditView/);
    else assert.match(page, /RoutePlaceholder/);
  }

  const rootPage = await readFile(new URL("app/page.jsx", projectRoot), "utf8");
  assert.match(rootPage, /redirect\(["']\/inbox["']\)/);
});

test("standalone navigate mutates history without registering a popstate listener", async () => {
  const { navigate } = await import("../app/lib/routes.mjs");
  let listenersAdded = 0;
  const browser = {
    location: { href: "https://radar.test/inbox" },
    history: {
      pushState(_state, _unused, href) {
        browser.location.href = new URL(href, browser.location.href).href;
      },
      replaceState(_state, _unused, href) {
        browser.location.href = new URL(href, browser.location.href).href;
      },
    },
    addEventListener() {
      listenersAdded += 1;
    },
  };

  const state = navigate(
    { route: "automations", query: { source: "group-12" } },
    { browser },
  );

  assert.equal(listenersAdded, 0);
  assert.equal(
    browser.location.href,
    "https://radar.test/automations?source=group-12",
  );
  assert.deepEqual(state, {
    route: "automations",
    query: { source: "group-12" },
  });
});

test("shell exposes active-route and mobile labels accessibly", async () => {
  const shell = await readFile(
    new URL("app/components/app-shell.jsx", projectRoot),
    "utf8",
  );
  const layout = await readFile(
    new URL("app/styles/layout.css", projectRoot),
    "utf8",
  );

  assert.match(shell, /aria-current=.*page/);
  assert.match(shell, /rr-nav__mobile-label/);
  assert.match(layout, /min-height:\s*44px/);
  assert.match(layout, /prefers-reduced-motion:\s*reduce/);
  assert.match(shell, /role=["']menu["']/);
  assert.match(shell, /api\/auth\/logout/);
  assert.match(shell, /className="rr-brand" href="\/inbox"/);
  assert.doesNotMatch(shell, /rr-search|rr-review-filter|rr-connection/);
});

test("API client maps untrusted failures to safe typed errors", async () => {
  const { ApiError, createApiClient } = await import("../app/lib/api-client.mjs");
  const api = createApiClient(async () =>
    new Response(
      JSON.stringify({
        error: "password=super-secret; SELECT * FROM sessions",
        code: "INTERNAL_QUERY_FAILURE",
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    ),
  );

  await assert.rejects(
    api.request("/api/inbox"),
    (error) =>
      error instanceof ApiError &&
      error.status === 500 &&
      error.code === "server_error" &&
      error.message === "ระบบขัดข้องชั่วคราว กรุณาลองอีกครั้ง" &&
      !JSON.stringify(error).includes("super-secret"),
  );
});

test("API client reports an expired protected session but leaves login failures inline", async () => {
  const { createApiClient } = await import("../app/lib/api-client.mjs");
  let expired = 0;
  const api = createApiClient(
    async () => new Response(null, { status: 401 }),
    { onUnauthorized: () => { expired += 1; } },
  );

  await assert.rejects(api.request("/api/inbox"), { status: 401, code: "unauthorized" });
  assert.equal(expired, 1);
  await assert.rejects(api.request("/api/auth/login"), { status: 401, code: "unauthorized" });
  assert.equal(expired, 1);
});

test("API client distinguishes a retryable network failure", async () => {
  const { createApiClient } = await import("../app/lib/api-client.mjs");
  const api = createApiClient(async () => {
    throw new Error("ECONNRESET at internal-db.example");
  });

  await assert.rejects(
    api.request("/health"),
    (error) =>
      error.status === 0 &&
      error.code === "network_error" &&
      error.retryable === true &&
      !error.message.includes("internal-db"),
  );
});

test("API client preserves allow-listed Inbox conflict codes", async () => {
  const { createApiClient } = await import("../app/lib/api-client.mjs");
  const api = createApiClient(async () => new Response(
    JSON.stringify({ error: "stale", code: "INVENTORY_CHANGED" }),
    { status: 409, headers: { "content-type": "application/json" } },
  ));
  await assert.rejects(api.request("/api/inbox/item"), (error) => error.status === 409 && error.code === "INVENTORY_CHANGED");
});

test("API client preserves only allow-listed operational reason codes", async () => {
  const { createApiClient } = await import("../app/lib/api-client.mjs");
  const api = createApiClient(async () => new Response(
    JSON.stringify({ error: "internal detail", reasonCode: "SELECTOR_CIRCUIT_OPEN" }),
    { status: 409, headers: { "content-type": "application/json" } },
  ));

  await assert.rejects(api.request("/api/sources"), (error) =>
    error.status === 409 &&
    error.reasonCode === "SELECTOR_CIRCUIT_OPEN" &&
    !error.message.includes("internal detail"),
  );
});
