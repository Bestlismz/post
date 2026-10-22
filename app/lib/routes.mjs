const manifest = [
  { id: "inbox", label: "Inbox", mobileLabel: "Inbox", path: "/inbox", icon: "inbox" },
  { id: "properties", label: "Properties", mobileLabel: "Properties", path: "/properties", icon: "properties" },
  { id: "sources", label: "Sources", mobileLabel: "Sources", path: "/sources", icon: "sources" },
  { id: "automations", label: "Automations", mobileLabel: "Automations", path: "/automations", icon: "automations" },
  { id: "settings", label: "Settings", mobileLabel: "Settings", path: "/settings", icon: "settings" },
];

export const routes = Object.freeze(manifest.map((route) => Object.freeze(route)));
const routeById = new Map(routes.map((route) => [route.id, route]));
const routeByPath = new Map(routes.map((route) => [route.path, route]));

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
      const method = options.replace ? "replaceState" : "pushState";
      browser.history[method](routeState, "", routeHref(routeState));
      const next = readRouteState(browser.location);
      onChange(next);
      return next;
    },
    destroy() {
      browser.removeEventListener?.("popstate", restore);
    },
  };
}

export function navigate(routeState, options = {}) {
  return createRouteStore(options.browser ?? globalThis.window).navigate(routeState, options);
}
