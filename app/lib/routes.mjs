const manifest = [
  { id: "inbox", label: "Inbox", mobileLabel: "Inbox", path: "/inbox", icon: "inbox" },
  { id: "properties", label: "Properties", mobileLabel: "Properties", path: "/properties", icon: "properties" },
  { id: "sources", label: "Sources", mobileLabel: "Sources", path: "/sources", icon: "sources" },
  { id: "settings", label: "Settings", mobileLabel: "Settings", path: "/settings", icon: "settings" },
];

export const routes = Object.freeze(manifest.map((route) => Object.freeze(route)));
export const inboxStatuses = Object.freeze(["pending", "pending_or_updated", "preparing", "needs_review", "ready", "completed", "superseded", "handoff", "failed"]);
export const inboxChannels = Object.freeze(["messenger", "facebook_group"]);
const routeById = new Map(routes.map((route) => [route.id, route]));
const routeByPath = new Map(routes.map((route) => [route.path, route]));

export function readInboxRouteState(search) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search ?? "");
  const status = inboxStatuses.includes(params.get("status")) ? params.get("status") : params.get("state") === "needs_review" ? "needs_review" : "";
  const numeric = (name) => /^\d{1,10}$/.test(params.get(name) ?? "") ? params.get(name) : "";
  return {
    item: params.get("item") || null,
    filters: {
      channel: inboxChannels.includes(params.get("channel")) ? params.get("channel") : "",
      status,
      location: (params.get("location") ?? "").slice(0, 160),
      budgetMin: numeric("budgetMin"),
      budgetMax: numeric("budgetMax"),
      assignee: params.get("assignee") === "unassigned" ? "unassigned" : "",
      search: (params.get("q") ?? "").slice(0, 500),
    },
  };
}

export function inboxHref(search, patch = {}) {
  const params = new URLSearchParams(search ?? "");
  params.delete("view");
  params.delete("state");
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || value === "") params.delete(key);
    else params.set(key, String(value));
  }
  return `/inbox${params.size ? `?${params.toString()}` : ""}`;
}

export function canonicalInboxHref(search) {
  const { item, filters } = readInboxRouteState(search);
  const params = new URLSearchParams();
  if (item) params.set("item", item);
  for (const [key, value] of Object.entries({ channel: filters.channel, status: filters.status, location: filters.location, budgetMin: filters.budgetMin, budgetMax: filters.budgetMax, assignee: filters.assignee, q: filters.search })) {
    if (value) params.set(key, value);
  }
  return `/inbox${params.size ? `?${params}` : ""}`;
}

function locationUrl(location) {
  return new URL(location?.href ?? "http://localhost/inbox");
}

export function readRouteState(location) {
  const url = locationUrl(location);
  const pathname = (location?.pathname ?? url.pathname).replace(/\/$/, "") || "/";
  const search = location?.search ?? url.search;
  return {
    route: routeByPath.get(pathname)?.id ?? "inbox",
    query: Object.fromEntries([...new URLSearchParams(search)].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function routeHref(routeState = {}) {
  const route = routeById.get(routeState.route) ?? routeById.get("inbox");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(routeState.query ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  return `${route.path}${query.size ? `?${query}` : ""}`;
}

export function createRouteStore(browser, onChange = () => {}) {
  if (!browser?.history || !browser?.location) throw new TypeError("A browser-like history and location are required");
  const restore = () => onChange(readRouteState(browser.location));
  browser.addEventListener?.("popstate", restore);
  return {
    getSnapshot: () => readRouteState(browser.location),
    navigate(routeState, options = {}) {
      const next = mutateHistory(browser, routeState, options);
      onChange(next);
      return next;
    },
    destroy() {
      browser.removeEventListener?.("popstate", restore);
    },
  };
}

export function navigate(routeState, options = {}) {
  const next = mutateHistory(options.browser ?? globalThis.window, routeState, options);
  options.onChange?.(next);
  return next;
}

function mutateHistory(browser, routeState, options) {
  if (!browser?.history || !browser?.location) throw new TypeError("A browser-like history and location are required");
  const method = options.replace ? "replaceState" : "pushState";
  browser.history[method](routeState, "", routeHref(routeState));
  return readRouteState(browser.location);
}
