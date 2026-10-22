const manifest = [
  { id: "inbox", label: "Inbox", mobileLabel: "Inbox", path: "/inbox", icon: "inbox" },
  { id: "properties", label: "Properties", mobileLabel: "Properties", path: "/properties", icon: "properties" },
  { id: "sources", label: "Sources", mobileLabel: "Sources", path: "/sources", icon: "sources" },
  { id: "automations", label: "Automations", mobileLabel: "Automations", path: "/automations", icon: "automations" },
  { id: "settings", label: "Settings", mobileLabel: "Settings", path: "/settings", icon: "settings" },
];

export const routes = Object.freeze(manifest.map((route) => Object.freeze(route)));
export const inboxViews = Object.freeze(["workspace", "table"]);
export const inboxStates = Object.freeze(["all", "needs_review"]);
const routeById = new Map(routes.map((route) => [route.id, route]));
const routeByPath = new Map(routes.map((route) => [route.path, route]));

export function readInboxRouteState(search) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search ?? "");
  const requestedView = params.get("view");
  const requestedState = params.get("state");
  return {
    view: inboxViews.includes(requestedView) ? requestedView : "workspace",
    state: requestedState === "needs_review" ? "needs_review" : "all",
    item: params.get("item") || null,
  };
}

export function inboxHref(search, patch = {}) {
  const params = new URLSearchParams(search ?? "");
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || value === "" || (key === "state" && value === "all")) params.delete(key);
    else params.set(key, String(value));
  }
  return `/inbox${params.size ? `?${params.toString()}` : ""}`;
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
