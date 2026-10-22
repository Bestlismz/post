"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Building2, Plus, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { api } from "../lib/api-client.mjs";
import { ProjectList } from "./project-list";
import { UnitEditor } from "./unit-editor";
import { UnitTable } from "./unit-table";
import "./properties.css";

function idempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `inventory-${Date.now()}-${Math.random()}`;
}

function mutationHeaders(csrfToken, revision) {
  return {
    "Idempotency-Key": idempotencyKey(),
    ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    ...(revision ? { "If-Match": `"${revision}"` } : {}),
  };
}

function ProjectEditor({ csrfToken, onClose, onSaved }) {
  const [form, setForm] = useState({ name: "", address: "", district: "", province: "", station: "", walkingDistanceM: "", amenities: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const update = (key) => (event) => setForm((value) => ({ ...value, [key]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim()) return setError("กรุณาระบุชื่อโครงการ");
    setSaving(true);
    setError("");
    try {
      const project = await api.request("/api/projects", {
        method: "POST",
        headers: mutationHeaders(csrfToken),
        body: JSON.stringify({
          name: form.name,
          address: form.address || null,
          district: form.district || null,
          province: form.province || null,
          transit: form.station ? [{ station: form.station, walkingDistanceM: Number(form.walkingDistanceM || 0) }] : [],
          amenities: form.amenities.split(",").map((item) => item.trim()).filter(Boolean),
          media: [],
        }),
      });
      onSaved(project);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="property-drawer-backdrop" role="presentation">
      <aside className="property-drawer" role="dialog" aria-modal="true" aria-labelledby="project-editor-title">
        <header className="property-drawer__header">
          <div><span className="property-drawer__context">โครงการใหม่</span><h2 id="project-editor-title">เพิ่มโครงการ</h2></div>
          <button className="icon-button" type="button" aria-label="ปิดแผงโครงการ" onClick={onClose}><X size={20} /></button>
        </header>
        <form className="property-form" onSubmit={submit}>
          <section className="property-form__section">
            <h3>ข้อมูลโครงการ</h3>
            <label className="field field--wide"><span>ชื่อโครงการ <b>*</b></span><input aria-label="ชื่อโครงการ" value={form.name} onChange={update("name")} autoFocus /></label>
            <label className="field field--wide"><span>ที่อยู่</span><textarea aria-label="ที่อยู่โครงการ" rows="2" value={form.address} onChange={update("address")} /></label>
            <div className="field-grid">
              <label className="field"><span>เขต / อำเภอ</span><input aria-label="เขต / อำเภอ" value={form.district} onChange={update("district")} /></label>
              <label className="field"><span>จังหวัด</span><input aria-label="จังหวัด" value={form.province} onChange={update("province")} /></label>
            </div>
          </section>
          <section className="property-form__section">
            <h3>การเดินทางและสิ่งอำนวยความสะดวก</h3>
            <div className="field-grid">
              <label className="field"><span>สถานีรถไฟฟ้าใกล้ที่สุด</span><input aria-label="สถานีรถไฟฟ้าใกล้ที่สุด" value={form.station} onChange={update("station")} placeholder="เช่น MRT เพชรบุรี" /></label>
              <label className="field"><span>ระยะเดินจากสถานี (เมตร)</span><input aria-label="ระยะเดินจากสถานี (เมตร)" type="number" min="0" value={form.walkingDistanceM} onChange={update("walkingDistanceM")} /></label>
            </div>
            <label className="field field--wide"><span>สิ่งอำนวยความสะดวก</span><input aria-label="สิ่งอำนวยความสะดวก" value={form.amenities} onChange={update("amenities")} placeholder="คั่นแต่ละรายการด้วยเครื่องหมายจุลภาค" /></label>
          </section>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <footer className="property-drawer__footer">
            <button className="button button--secondary" type="button" onClick={onClose}>ยกเลิก</button>
            <button className="button button--primary" type="submit" disabled={saving}>{saving ? "กำลังบันทึก…" : "บันทึกโครงการ"}</button>
          </footer>
        </form>
      </aside>
    </div>
  );
}

export default function PropertiesPage() {
  const [projects, setProjects] = useState([]);
  const [units, setUnits] = useState([]);
  const [csrfToken, setCsrfToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [activeProjectId, setActiveProjectId] = useState("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [editor, setEditor] = useState(null);
  const [projectEditor, setProjectEditor] = useState(false);
  const [toast, setToast] = useState("");
  const [menuUnitId, setMenuUnitId] = useState(null);
  const [archiveUnit, setArchiveUnit] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const [projectResult, unitResult, identityResult] = await Promise.allSettled([
      api.request("/api/projects"), api.request("/api/units"), api.request("/api/me"),
    ]);
    if (projectResult.status === "fulfilled") setProjects(projectResult.value.projects ?? []);
    if (unitResult.status === "fulfilled") setUnits(unitResult.value.units ?? []);
    if (identityResult.status === "fulfilled") setCsrfToken(identityResult.value.csrfToken ?? "");
    if (projectResult.status === "rejected" || unitResult.status === "rejected") setLoadError("โหลดข้อมูลห้องบางส่วนไม่สำเร็จ");
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const timeout = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timeout);
  }, [toast]);

  const counts = useMemo(() => Object.fromEntries(projects.map((project) => [project.id, units.filter((unit) => unit.projectId === project.id && unit.status !== "archived").length])), [projects, units]);
  const filteredUnits = useMemo(() => units.filter((unit) => {
    if (activeProjectId !== "all" && unit.projectId !== activeProjectId) return false;
    if (status !== "all" && unit.status !== status) return false;
    const project = projects.find((entry) => entry.id === unit.projectId);
    const haystack = `${unit.unitCode} ${unit.roomType ?? ""} ${project?.name ?? ""}`.toLocaleLowerCase("th");
    return haystack.includes(query.trim().toLocaleLowerCase("th"));
  }), [activeProjectId, projects, query, status, units]);

  function replaceUnit(next) {
    setUnits((current) => current.some((unit) => unit.id === next.id) ? current.map((unit) => unit.id === next.id ? next : unit) : [...current, next]);
  }

  async function changeAvailability(unit, nextStatus) {
    try {
      const next = await api.request(`/api/units/${unit.id}/availability`, {
        method: "POST", headers: mutationHeaders(csrfToken, unit.revision), body: JSON.stringify({ status: nextStatus }),
      });
      replaceUnit(next);
      setToast("อัปเดตสถานะห้องแล้ว");
    } catch (error) {
      setToast(error.status === 409 ? "ข้อมูลห้องเปลี่ยนไปแล้ว กรุณาโหลดใหม่" : error.message);
    }
  }

  async function confirmArchive() {
    if (!archiveUnit) return;
    try {
      const next = await api.request(`/api/units/${archiveUnit.id}/archive`, {
        method: "POST", headers: mutationHeaders(csrfToken, archiveUnit.revision), body: JSON.stringify({}),
      });
      replaceUnit(next);
      setArchiveUnit(null);
      setMenuUnitId(null);
      setToast("เก็บในประวัติแล้ว");
    } catch (error) {
      setToast(error.status === 409 ? "ข้อมูลห้องเปลี่ยนไปแล้ว กรุณาโหลดใหม่" : error.message);
    }
  }

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null;

  return (
    <div className="properties-page">
      <header className="properties-heading">
        <div>
          <p>Inventory workspace</p>
          <h1>ห้องและโครงการ</h1>
          <span>ข้อมูลชุดนี้ใช้คัดกรองห้องและสร้างคำตอบให้ลูกค้าโดยตรง</span>
        </div>
        <div className="properties-heading__actions">
          <button className="button button--secondary" type="button" onClick={() => setProjectEditor(true)}><Building2 size={17} />เพิ่มโครงการ</button>
          <button className="button button--primary" type="button" onClick={() => setEditor({ mode: "create", projectId: activeProject?.id })} disabled={!projects.length}><Plus size={17} />เพิ่มห้อง</button>
        </div>
      </header>

      {loadError ? <div className="regional-error" role="alert"><span>{loadError}</span><button type="button" onClick={load}><RefreshCw size={16} />ลองอีกครั้ง</button></div> : null}

      <div className="properties-layout">
        <ProjectList projects={projects} counts={counts} activeId={activeProjectId} onSelect={setActiveProjectId} loading={loading} />
        <section className="unit-workspace" aria-label="รายการห้อง">
          <div className="unit-toolbar">
            <label className="unit-search"><Search size={17} /><span className="rr-sr-only">ค้นหาห้อง</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหารหัสห้องหรือโครงการ" /></label>
            <label className="unit-filter"><SlidersHorizontal size={16} /><span>สถานะ</span><select aria-label="ตัวกรองสถานะ" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">ทั้งหมด</option><option value="draft">ฉบับร่าง</option><option value="available">ว่าง</option><option value="held">จองชั่วคราว</option><option value="rented">ให้เช่าแล้ว</option><option value="unknown">รอตรวจสอบ</option><option value="archived">ประวัติ</option></select></label>
            <span className="unit-toolbar__count">{filteredUnits.length} ห้อง</span>
          </div>
          <UnitTable units={filteredUnits} projects={projects} loading={loading} onEdit={(unit) => setEditor({ mode: "edit", unit })} onAvailability={changeAvailability} onAdd={() => setEditor({ mode: "create", projectId: activeProject?.id })} menuUnitId={menuUnitId} onMenu={(id) => setMenuUnitId((current) => current === id ? null : id)} onArchive={(unit) => setArchiveUnit(unit)} />
        </section>
      </div>

      {projectEditor ? <ProjectEditor csrfToken={csrfToken} onClose={() => setProjectEditor(false)} onSaved={(project) => { setProjects((current) => [...current, project]); setActiveProjectId(project.id); setProjectEditor(false); setToast("เพิ่มโครงการแล้ว"); }} /> : null}
      {editor ? <UnitEditor editor={editor} projects={projects} csrfToken={csrfToken} onClose={() => setEditor(null)} onRefreshed={replaceUnit} onSaved={(unit, message) => { replaceUnit(unit); setEditor(null); setToast(message); }} /> : null}
      {archiveUnit ? <div className="confirm-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-title"><span className="confirm-dialog__icon"><Archive size={20} /></span><h2 id="archive-title">เก็บห้องนี้เข้าประวัติ?</h2><p>ห้อง {archiveUnit.unitCode} จะไม่ถูกนำไปจับคู่กับลูกค้า แต่ประวัติและข้อความอ้างอิงเดิมจะยังอยู่ครบ</p><div><button className="button button--secondary" type="button" onClick={() => setArchiveUnit(null)}>ยกเลิก</button><button className="button button--danger" type="button" onClick={confirmArchive}>ยืนยันเก็บเข้าประวัติ</button></div></div></div> : null}
      {toast ? <div className="properties-toast" role="status">{toast}</div> : null}
    </div>
  );
}
