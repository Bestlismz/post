"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Building2,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { api } from "../lib/api-client.mjs";
import { useDialogA11y } from "./dialog-a11y";
import { ProjectList } from "./project-list";
import { ProjectEditor } from "./project-editor";
import { UnitEditor } from "./unit-editor";
import { UnitTable } from "./unit-table";
import "./properties.css";

function idempotencyKey() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `inventory-${Date.now()}-${Math.random()}`
  );
}

function ArchiveDialog({
  unit,
  conflict,
  saving,
  onCancel,
  onConfirm,
  onRefresh,
}) {
  const dialogRef = useRef(null),
    cancelRef = useRef(null),
    refreshRef = useRef(null);
  useDialogA11y({ dialogRef, initialRef: cancelRef, onEscape: onCancel });
  useEffect(() => {
    if (conflict) refreshRef.current?.focus();
  }, [conflict]);
  return (
    <div className="confirm-backdrop">
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-title"
      >
        <span className="confirm-dialog__icon">
          <Archive size={20} />
        </span>
        <h2 id="archive-title">เก็บห้องนี้เข้าประวัติ?</h2>
        <p>
          ห้อง {unit.unitCode} จะไม่ถูกนำไปจับคู่กับลูกค้า
          แต่ประวัติและข้อความอ้างอิงเดิมจะยังอยู่ครบ
        </p>
        {conflict ? (
          <div className="confirm-dialog__conflict" role="alert">
            <b>ข้อมูลห้องถูกแก้ไขจากที่อื่น</b>
            <span>โหลด revision ล่าสุดก่อนเลือกดำเนินการอีกครั้ง</span>
          </div>
        ) : null}
        <div>
          {conflict ? (
            <button
              ref={refreshRef}
              className="button button--secondary"
              type="button"
              onClick={onRefresh}
            >
              โหลดข้อมูลล่าสุดและปิด
            </button>
          ) : (
            <>
              <button
                ref={cancelRef}
                className="button button--secondary"
                type="button"
                onClick={onCancel}
              >
                ยกเลิก
              </button>
              <button
                className="button button--danger"
                type="button"
                disabled={saving}
                onClick={onConfirm}
              >
                ยืนยันเก็บเข้าประวัติ
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PropertiesPage() {
  const [projects, setProjects] = useState([]);
  const [units, setUnits] = useState([]);
  const [actor, setActor] = useState(null);
  const csrfRef = useRef("");
  const csrfPromiseRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [activeProjectId, setActiveProjectId] = useState("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [editor, setEditor] = useState(null);
  const [projectEditor, setProjectEditor] = useState(null);
  const [toast, setToast] = useState("");
  const [menuUnitId, setMenuUnitId] = useState(null);
  const [archiveUnit, setArchiveUnit] = useState(null);
  const [archiveConflict, setArchiveConflict] = useState(false);
  const [archiveSaving, setArchiveSaving] = useState(false);
  const [actionConflict, setActionConflict] = useState(null);

  const canEdit = ["admin", "inventory_manager"].includes(actor?.role);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const [projectResult, unitResult, identityResult] =
      await Promise.allSettled([
        api.request("/api/projects"),
        api.request("/api/units"),
        api.request("/api/me"),
      ]);
    if (projectResult.status === "fulfilled")
      setProjects(projectResult.value.projects ?? []);
    if (unitResult.status === "fulfilled")
      setUnits(unitResult.value.units ?? []);
    if (identityResult.status === "fulfilled")
      setActor(identityResult.value.user ?? null);
    if (projectResult.status === "rejected" || unitResult.status === "rejected")
      setLoadError("โหลดข้อมูลห้องบางส่วนไม่สำเร็จ");
    setLoading(false);
  }, []);

  const ensureCsrf = useCallback(async (force = false) => {
    if (csrfPromiseRef.current) return csrfPromiseRef.current;
    if (!force && csrfRef.current) return csrfRef.current;
    if (force) csrfRef.current = "";
    const request = api
      .request("/api/auth/csrf", { method: "POST" })
      .then(({ csrfToken }) => {
        if (!csrfToken) throw new Error("ไม่สามารถเตรียมการบันทึกข้อมูลได้");
        csrfRef.current = csrfToken;
        return csrfToken;
      })
      .finally(() => {
        csrfPromiseRef.current = null;
      });
    csrfPromiseRef.current = request;
    return request;
  }, []);

  const mutate = useCallback(
    async (path, { method, body, revision }) => {
      const operationKey = idempotencyKey();
      const send = (token) =>
        api.request(path, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": operationKey,
            "X-CSRF-Token": token,
            ...(revision == null ? {} : { "If-Match": `\"${revision}\"` }),
          },
          body: JSON.stringify(body ?? {}),
        });
      let token = await ensureCsrf();
      try {
        return await send(token);
      } catch (error) {
        if (error.status !== 403) throw error;
        token = await ensureCsrf(true);
        return send(token);
      }
    },
    [ensureCsrf],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!canEdit) return;
    void ensureCsrf().catch(() =>
      setLoadError("ไม่สามารถเตรียมสิทธิ์สำหรับแก้ไขข้อมูลได้"),
    );
  }, [canEdit, ensureCsrf]);
  useEffect(() => {
    if (!toast) return undefined;
    const timeout = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timeout);
  }, [toast]);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        projects.map((project) => [
          project.id,
          units.filter(
            (unit) =>
              unit.projectId === project.id && unit.status !== "archived",
          ).length,
        ]),
      ),
    [projects, units],
  );
  const filteredUnits = useMemo(
    () =>
      units.filter((unit) => {
        if (activeProjectId !== "all" && unit.projectId !== activeProjectId)
          return false;
        if (status !== "all" && unit.status !== status) return false;
        const project = projects.find((entry) => entry.id === unit.projectId);
        const haystack =
          `${unit.unitCode} ${unit.roomType ?? ""} ${project?.name ?? ""}`.toLocaleLowerCase(
            "th",
          );
        return haystack.includes(query.trim().toLocaleLowerCase("th"));
      }),
    [activeProjectId, projects, query, status, units],
  );

  function replaceUnit(next) {
    setUnits((current) =>
      current.some((unit) => unit.id === next.id)
        ? current.map((unit) => (unit.id === next.id ? next : unit))
        : [...current, next],
    );
  }

  function replaceProject(next) {
    setProjects((current) =>
      current.some((project) => project.id === next.id)
        ? current.map((project) => (project.id === next.id ? next : project))
        : [...current, next],
    );
  }

  function restoreUnitMenuFocus(unitId) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const trigger = [
          ...document.querySelectorAll("[data-unit-menu-trigger]"),
        ].find(
          (node) =>
            node.dataset.unitMenuTrigger === unitId &&
            node.getClientRects().length,
        );
        trigger?.focus();
      }),
    );
  }

  async function refreshUnit(unitId) {
    try {
      const latest = await api.request(`/api/units/${unitId}`);
      replaceUnit(latest);
      setActionConflict(null);
      return latest;
    } catch (error) {
      setToast(error.message);
      return null;
    }
  }

  async function changeAvailability(unit, nextStatus) {
    try {
      const next = await mutate(`/api/units/${unit.id}/availability`, {
        method: "POST",
        revision: unit.revision,
        body: { status: nextStatus },
      });
      replaceUnit(next);
      setActionConflict(null);
      setToast("อัปเดตสถานะห้องแล้ว");
    } catch (error) {
      if (error.status === 409)
        setActionConflict({
          kind: "availability",
          unitId: unit.id,
          message: "สถานะห้องถูกแก้ไขจากที่อื่น",
        });
      else setToast(error.message);
    }
  }

  async function confirmArchive() {
    if (!archiveUnit) return;
    try {
      setArchiveSaving(true);
      const next = await mutate(`/api/units/${archiveUnit.id}/archive`, {
        method: "POST",
        revision: archiveUnit.revision,
        body: {},
      });
      replaceUnit(next);
      setArchiveUnit(null);
      setArchiveConflict(false);
      setMenuUnitId(null);
      restoreUnitMenuFocus(next.id);
      setToast("เก็บในประวัติแล้ว");
    } catch (error) {
      if (error.status === 409) setArchiveConflict(true);
      else setToast(error.message);
    } finally {
      setArchiveSaving(false);
    }
  }

  async function refreshArchiveUnit() {
    if (!archiveUnit) return;
    const latest = await refreshUnit(archiveUnit.id);
    if (latest) {
      setArchiveUnit(null);
      setArchiveConflict(false);
      setMenuUnitId(null);
      restoreUnitMenuFocus(latest.id);
    }
  }

  const activeProject =
    projects.find((project) => project.id === activeProjectId) ??
    projects[0] ??
    null;

  return (
    <div className="properties-page">
      <header className="properties-heading">
        <div>
          <p>Inventory workspace</p>
          <h1>ห้องและโครงการ</h1>
          <span>ข้อมูลชุดนี้ใช้คัดกรองห้องและสร้างคำตอบให้ลูกค้าโดยตรง</span>
        </div>
        {canEdit ? (
          <div className="properties-heading__actions">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setProjectEditor({ mode: "create" })}
            >
              <Building2 size={17} />
              เพิ่มโครงการ
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() =>
                setEditor({ mode: "create", projectId: activeProject?.id })
              }
              disabled={!projects.length}
            >
              <Plus size={17} />
              เพิ่มห้อง
            </button>
          </div>
        ) : null}
      </header>

      {loadError ? (
        <div className="regional-error" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={load}>
            <RefreshCw size={16} />
            ลองอีกครั้ง
          </button>
        </div>
      ) : null}
      {actor && !canEdit ? (
        <div className="properties-readonly" role="status">
          <b>โหมดอ่านอย่างเดียว</b>
          <span>
            บัญชีนี้ดูคลังห้องได้ แต่ต้องให้ผู้ดูแลหรือผู้จัดการคลังเป็นผู้แก้ไข
          </span>
        </div>
      ) : null}
      {actionConflict ? (
        <div className="regional-error" role="alert">
          <span>
            <b>{actionConflict.message}</b> โหลดข้อมูลล่าสุดก่อนเลือกสถานะใหม่
          </span>
          <button
            type="button"
            onClick={() => refreshUnit(actionConflict.unitId)}
          >
            <RefreshCw size={16} />
            โหลดห้องล่าสุด
          </button>
        </div>
      ) : null}

      <div className="properties-layout">
        <ProjectList
          projects={projects}
          counts={counts}
          activeId={activeProjectId}
          onSelect={setActiveProjectId}
          loading={loading}
          canEdit={canEdit}
          onEdit={(project) => setProjectEditor({ mode: "edit", project })}
        />
        <section className="unit-workspace" aria-label="รายการห้อง">
          <div className="unit-toolbar">
            <label className="unit-search">
              <Search size={17} />
              <span className="rr-sr-only">ค้นหาห้อง</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="ค้นหารหัสห้องหรือโครงการ"
              />
            </label>
            <label className="unit-filter">
              <SlidersHorizontal size={16} />
              <span>สถานะ</span>
              <select
                aria-label="ตัวกรองสถานะ"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="all">ทั้งหมด</option>
                <option value="draft">ฉบับร่าง</option>
                <option value="available">ว่าง</option>
                <option value="held">จองชั่วคราว</option>
                <option value="rented">ให้เช่าแล้ว</option>
                <option value="unknown">รอตรวจสอบ</option>
                <option value="archived">ประวัติ</option>
              </select>
            </label>
            <span className="unit-toolbar__count">
              {filteredUnits.length} ห้อง
            </span>
          </div>
          <UnitTable
            units={filteredUnits}
            projects={projects}
            loading={loading}
            canEdit={canEdit}
            onEdit={(unit) => setEditor({ mode: "edit", unit })}
            onAvailability={changeAvailability}
            onAdd={() =>
              setEditor({ mode: "create", projectId: activeProject?.id })
            }
            menuUnitId={menuUnitId}
            onMenu={(id) =>
              setMenuUnitId((current) => (current === id ? null : id))
            }
            onArchive={(unit) => {
              setArchiveConflict(false);
              setArchiveUnit(unit);
            }}
          />
        </section>
      </div>

      {projectEditor ? (
        <ProjectEditor
          editor={projectEditor}
          mutate={mutate}
          onClose={() => setProjectEditor(null)}
          onRefreshed={replaceProject}
          onSaved={(project, message) => {
            replaceProject(project);
            setActiveProjectId(project.id);
            setProjectEditor(null);
            setToast(message);
          }}
        />
      ) : null}
      {editor ? (
        <UnitEditor
          editor={editor}
          projects={projects}
          mutate={mutate}
          onClose={() => setEditor(null)}
          onRefreshed={replaceUnit}
          onSaved={(unit, message) => {
            replaceUnit(unit);
            setEditor(null);
            setToast(message);
          }}
        />
      ) : null}
      {archiveUnit ? (
        <ArchiveDialog
          unit={archiveUnit}
          conflict={archiveConflict}
          saving={archiveSaving}
          onCancel={() => {
            setArchiveUnit(null);
            setArchiveConflict(false);
          }}
          onConfirm={confirmArchive}
          onRefresh={refreshArchiveUnit}
        />
      ) : null}
      {toast ? (
        <div className="properties-toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
