"use client";

import { ChevronDown, History, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api-client.mjs";

const date = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });
const correlation = (entry) => entry.details?.correlationId ?? entry.details?.attemptId ?? entry.details?.operationId ?? entry.details?.jobId ?? entry.details?.receiptId ?? entry.details?.replyVersionId ?? entry.id;
const emptyFilters = Object.freeze({ correlationId: "", action: "" });
const sameFilters = (left, right) => left.correlationId === right.correlationId && left.action === right.action;

export function AuditView() {
  const [query, setQuery] = useState("");
  const [action, setAction] = useState("");
  const [result, setResult] = useState({ entries: [], nextCursor: null, applied: emptyFilters });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const activeRequest = useRef(null);
  const load = useCallback(async ({ filters, append = false, cursor = null }) => {
    const id = ++requestId.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true); setError("");
    const params = new URLSearchParams({ limit: "20" });
    if (filters.correlationId) params.set("correlationId", filters.correlationId);
    if (filters.action) params.set("action", filters.action);
    if (cursor) params.set("cursor", cursor);
    try {
      const next = await api.request(`/api/settings/audit?${params}`, { signal: controller.signal });
      if (requestId.current !== id) return;
      setResult((current) => {
        if (append && !sameFilters(current.applied, filters)) return current;
        return { entries: append ? [...current.entries, ...next.entries] : next.entries, nextCursor: next.nextCursor ?? null, applied: filters };
      });
    } catch (cause) {
      if (requestId.current === id && !controller.signal.aborted) setError(cause.message);
    } finally {
      if (requestId.current === id) { activeRequest.current = null; setLoading(false); }
    }
  }, []);
  useEffect(() => {
    void load({ filters: emptyFilters });
    return () => activeRequest.current?.abort();
  }, [load]);

  return <section className="settings-panel settings-panel--audit" aria-labelledby="audit-title">
    <header className="settings-panel__head"><span className="settings-panel__icon"><History size={18}/></span><div><h2 id="audit-title">บันทึกการใช้งาน</h2><p>ค้นหาหลักฐานทั่วระบบด้วย correlation ID หรือเหตุการณ์</p></div></header>
    <form className="audit-filters" onSubmit={(event) => { event.preventDefault(); void load({ filters: Object.freeze({ correlationId: query.trim(), action }) }); }}>
      <label className="audit-search"><Search size={17}/><span className="rr-sr-only">ค้นหา correlation ID</span><input aria-label="ค้นหา correlation ID" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Correlation, attempt, operation, job…"/></label>
      <label className="audit-action"><span className="rr-sr-only">กรองเหตุการณ์</span><select aria-label="กรองเหตุการณ์" value={action} onChange={(event) => setAction(event.target.value)}><option value="">ทุกเหตุการณ์</option><option value="delivery.sent">delivery.sent</option><option value="reply.prepared">reply.prepared</option><option value="user.role_changed">user.role_changed</option><option value="settings.profile_changed">settings.profile_changed</option></select><ChevronDown size={16}/></label>
      <button className="settings-button" type="submit">ค้นหาบันทึก</button>
    </form>
    {error ? <p className="audit-error" role="alert">{error}</p> : null}
    <div className="audit-table" role="region" aria-label="Audit ledger" tabIndex="0">
      <table><thead><tr><th>เหตุการณ์</th><th>ผู้ดำเนินการ</th><th>Correlation</th><th>เวลา</th></tr></thead><tbody>
        {result.entries.map((entry) => <tr key={entry.id}><td><strong>{entry.action}</strong><span>{entry.entity_type} · {entry.entity_id}</span></td><td>{entry.actor_name ?? entry.actor_id ?? "ระบบ"}</td><td><code>{correlation(entry)}</code></td><td>{date.format(new Date(entry.created_at))}</td></tr>)}
      </tbody></table>
      {!loading && result.entries.length === 0 ? <div className="audit-empty">ไม่พบบันทึกที่ตรงกับตัวกรอง</div> : null}
    </div>
    <footer className="audit-footer"><span>{loading ? "กำลังโหลด…" : `${result.entries.length} รายการ`}</span>{result.nextCursor ? <button className="settings-button" type="button" disabled={loading} onClick={() => load({ filters: result.applied, append: true, cursor: result.nextCursor })}>โหลดเพิ่มเติม</button> : null}</footer>
  </section>;
}
