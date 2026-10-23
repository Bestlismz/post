"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "../lib/api-client.mjs";
import { retryOnceWithFreshCsrf } from "../lib/csrf-retry.mjs";
import { canonicalInboxHref, inboxHref, readInboxRouteState } from "../lib/routes.mjs";
import { FocusSheet } from "./focus-sheet";
import { InboxTable } from "./inbox-queue";
import "./workspace.css";

const idempotencyKey = (action, id) => `${action}-${id}-${crypto.randomUUID()}`;
function commandHeaders({ action, id, revision, csrfToken }) {
  const headers = { "Idempotency-Key": idempotencyKey(action, id), "If-Match": `"${revision}"` };
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return headers;
}

function listResource(filters, cursor = null) {
  const params = new URLSearchParams({ limit: "100" });
  for (const [key, value] of Object.entries({ channel: filters.channel, status: filters.status, location: filters.location, budgetMin: filters.budgetMin, budgetMax: filters.budgetMax, assignee: filters.assignee, q: filters.search })) if (value) params.set(key, value);
  if (cursor) params.set("cursor", cursor);
  return `/api/inbox?${params}`;
}

function InboxWorkspace() {
  const router = useRouter(), searchParams = useSearchParams();
  const routeState = readInboxRouteState(searchParams), requestedId = routeState.item, filters = routeState.filters;
  const filterKey = JSON.stringify(filters);
  const [items, setItems] = useState([]), [resultCount, setResultCount] = useState(0), [nextCursor, setNextCursor] = useState(null), [listState, setListState] = useState({ loading: true, loadingMore: false, error: null });
  const [selectedId, setSelectedId] = useState(requestedId), [detail, setDetail] = useState(null);
  const [detailState, setDetailState] = useState({ loading: false, error: null }), [csrfToken, setCsrfToken] = useState("");
  const tableTriggerRef = useRef(null), sheetWasOpenRef = useRef(false), selectedRef = useRef(selectedId), detailRef = useRef(detail);
  const listAbortRef = useRef(null), listRequestRef = useRef(0);
  const routeSearchRef = useRef(searchParams.toString() ? `?${searchParams}` : "");
  selectedRef.current = selectedId; detailRef.current = detail;

  const applySelection = useCallback((id) => {
    const nextId = id ?? null;
    if (selectedRef.current === nextId) return false;
    selectedRef.current = nextId; setSelectedId(nextId); return true;
  }, []);
  const navigateState = useCallback((patch, { history = "push" } = {}) => {
    const href = inboxHref(routeSearchRef.current, patch);
    routeSearchRef.current = new URL(href, window.location.origin).search;
    router[history](href, { scroll: false });
  }, [router]);
  const navigateSelection = useCallback((id, { history = "replace" } = {}) => {
    const nextId = id ?? null, changed = applySelection(nextId);
    if (new URLSearchParams(window.location.search).get("item") !== nextId) navigateState({ item: nextId }, { history });
    return changed;
  }, [applySelection, navigateState]);
  const loadList = useCallback(async ({ append = false, cursor = null } = {}) => {
    const requestId = ++listRequestRef.current;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    if (!append) setNextCursor(null);
    setListState((state) => ({ loading: !append, loadingMore: append, error: append ? state.error : null }));
    try {
      const payload = await api.request(listResource(JSON.parse(filterKey), cursor), { signal: controller.signal });
      if (controller.signal.aborted || requestId !== listRequestRef.current) return;
      const nextItems = Array.isArray(payload?.items) ? payload.items : [];
      setItems((current) => append ? [...new Map([...current, ...nextItems].map((item) => [item.id, item])).values()] : nextItems);
      setResultCount(Number.isSafeInteger(payload?.resultCount) ? payload.resultCount : nextItems.length);
      setNextCursor(typeof payload?.nextCursor === "string" && payload.nextCursor ? payload.nextCursor : null);
      setListState({ loading: false, loadingMore: false, error: null });
    } catch (error) {
      if (controller.signal.aborted || requestId !== listRequestRef.current) return;
      setListState({ loading: false, loadingMore: false, error });
    }
  }, [filterKey, navigateSelection]);
  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return; }
    setDetailState({ loading: true, error: null });
    try { const payload = await api.request(`/api/inbox/${encodeURIComponent(id)}`); if (selectedRef.current === id) { setDetail(payload); setDetailState({ loading: false, error: null }); } }
    catch (error) { if (selectedRef.current === id) setDetailState({ loading: false, error }); }
  }, []);

  useEffect(() => {
    const canonical = canonicalInboxHref(window.location.search);
    routeSearchRef.current = new URL(canonical, window.location.origin).search;
    if (`${window.location.pathname}${window.location.search}` !== canonical) router.replace(canonical, { scroll: false });
  }, [router, searchParams]);
  useEffect(() => { void loadList(); return () => listAbortRef.current?.abort(); }, [loadList]);
  useEffect(() => { void api.request("/api/auth/csrf", { method: "POST" }).then((value) => setCsrfToken(value?.csrfToken ?? "")).catch(() => undefined); }, []);
  useEffect(() => { applySelection(requestedId); }, [applySelection, requestedId]);
  useEffect(() => { setDetail(null); void loadDetail(selectedId); }, [selectedId, loadDetail]);
  useEffect(() => {
    const open = Boolean(selectedId);
    if (sheetWasOpenRef.current && !open) requestAnimationFrame(() => { if (tableTriggerRef.current?.isConnected) tableTriggerRef.current.focus({ preventScroll: true }); });
    sheetWasOpenRef.current = open;
  }, [selectedId]);
  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const events = new EventSource("/api/inbox/events");
    const refresh = (event) => {
      try {
        const next = JSON.parse(event.data), current = detailRef.current;
        const resources = [selectedRef.current, current?.conversationId, ...(current?.replies ?? []).map((reply) => reply.id), ...(current?.deliveries ?? []).map((delivery) => delivery.id)];
        void loadList(); if (next.resourceType === "inbox" || next.workItemId === selectedRef.current || resources.includes(next.resourceId)) void loadDetail(selectedRef.current);
      } catch { /* durable refetch will reconcile malformed transport data */ }
    };
    events.addEventListener("inbox", refresh); events.addEventListener("reset", () => { void loadList(); void loadDetail(selectedRef.current); });
    return () => events.close();
  }, [loadDetail, loadList]);

  const choose = useCallback((id, trigger) => { tableTriggerRef.current = trigger; navigateSelection(id, { history: "push" }); }, [navigateSelection]);
  const changeFilters = useCallback((patch) => navigateState({ ...patch, item: null }, { history: "push" }), [navigateState]);
  const closeFocusSheet = useCallback(() => { applySelection(null); navigateState({ item: null }, { history: "push" }); }, [applySelection, navigateState]);
  const runCommand = useCallback(async (action, input = {}) => {
    if (!detail) return null;
    const revision = detail.processingRevision;
    const request = (token) => {
      if (action === "prepare") return api.request(`/api/inbox/${encodeURIComponent(detail.id)}/prepare`, { method: "POST", headers: commandHeaders({ action, id: detail.id, revision, csrfToken: token }), body: "{}" });
      if (action === "handoff") return api.request(`/api/inbox/${encodeURIComponent(detail.id)}/handoff`, { method: "POST", headers: commandHeaders({ action, id: detail.id, revision, csrfToken: token }), body: JSON.stringify({ reason: input.reason ?? "ส่งต่อให้ทีมดูแลจาก Inbox" }) });
      if (action === "edit") return api.request(`/api/replies/${encodeURIComponent(input.replyId)}/edit`, { method: "POST", headers: commandHeaders({ action, id: input.replyId, revision, csrfToken: token }), body: JSON.stringify({ text: input.text }) });
      if (action === "approve") return api.request(`/api/replies/${encodeURIComponent(input.replyId)}/approve`, { method: "POST", headers: commandHeaders({ action, id: input.replyId, revision, csrfToken: token }), body: "{}" });
      if (action === "retry") return api.request(`/api/deliveries/${encodeURIComponent(input.deliveryIntentId)}/retry`, { method: "POST", headers: commandHeaders({ action, id: input.deliveryIntentId, revision, csrfToken: token }), body: JSON.stringify({ verification: "comment_not_present" }) });
      throw new Error("Unsupported Inbox command");
    };
    return retryOnceWithFreshCsrf({ token: csrfToken, request, refresh: async () => (await api.request("/api/auth/csrf", { method: "POST" })).csrfToken, onRefresh: setCsrfToken });
  }, [csrfToken, detail]);

  return <section className="inbox-table-view" aria-label="กล่องข้อความรวม">
    <InboxTable items={items} resultCount={resultCount} nextCursor={nextCursor} selectedId={selectedId} onSelect={choose} state={listState} onRetry={loadList} onLoadMore={() => loadList({ append: true, cursor: nextCursor })} filters={filters} onFiltersChange={changeFilters} obscured={Boolean(selectedId)} />
    <FocusSheet open={Boolean(selectedId)} detail={detail} loading={detailState.loading} error={detailState.error} onRetry={() => loadDetail(selectedId)} onClose={closeFocusSheet} runCommand={runCommand} onRefresh={() => loadDetail(selectedId)} commandsReady={Boolean(csrfToken)} />
  </section>;
}

export default function InboxPage() {
  return <Suspense fallback={<div className="inbox-route-loading" aria-label="กำลังเปิด Inbox" />}><InboxWorkspace /></Suspense>;
}
