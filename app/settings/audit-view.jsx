"use client";

import { ChevronDown, History, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api-client.mjs";

const date = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });
const correlation = (entry) => entry.details?.correlationId ?? entry.details?.attemptId ?? entry.details?.operationId ?? entry.details?.jobId ?? entry.details?.receiptId ?? entry.details?.replyVersionId ?? entry.id;

export function AuditView() {
  const [query, setQuery] = useState("");
  const [action, setAction] = useState("");
  const [result, setResult] = useState({ entries: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async ({ append = false, cursor = null, correlationId = query, actionName = action } = {}) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ limit: "20" });
    if (correlationId.trim()) params.set("correlationId", correlationId.trim());
    if (actionName) params.set("action", actionName);
    if (cursor) params.set("cursor", cursor);
    try {
      const next = await api.request(`/api/settings/audit?${params}`);
      setResult((current) => ({ entries: append ? [...current.entries, ...next.entries] : next.entries, nextCursor: next.nextCursor ?? null }));
    } catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  }, [action, query]);
  useEffect(() => { void load({ correlationId: "", actionName: "" }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <section className="settings-panel settings-panel--audit" aria-labelledby="audit-title">
    <header className="settings-panel__head"><span className="settings-panel__icon"><History size={18}/></span><div><h2 id="audit-title">บันทึกการใช้งาน</h2><p>ค้นหาหลักฐานทั่วระบบด้วย correlation ID หรือเหตุการณ์</p></div></header>
    <form className="audit-filters" onSubmit={(event) => { event.preventDefault(); void load(); }}>
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
    <footer className="audit-footer"><span>{loading ? "กำลังโหลด…" : `${result.entries.length} รายการ`}</span>{result.nextCursor ? <button className="settings-button" type="button" disabled={loading} onClick={() => load({ append: true, cursor: result.nextCursor })}>โหลดเพิ่มเติม</button> : null}</footer>
  </section>;
}
