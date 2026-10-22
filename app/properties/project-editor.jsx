"use client";

import { AlertCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api-client.mjs";
import { UnsavedDialog, useDialogA11y } from "./dialog-a11y";

const emptyProject = {
  name: "",
  address: "",
  district: "",
  province: "",
  station: "",
  walkingDistanceM: "",
  amenities: "",
};
function toForm(project) {
  return {
    name: project?.name ?? "",
    address: project?.address ?? "",
    district: project?.district ?? "",
    province: project?.province ?? "",
    station: project?.transit?.[0]?.station ?? "",
    walkingDistanceM: project?.transit?.[0]?.walkingDistanceM ?? "",
    amenities: (project?.amenities ?? []).join(", "),
  };
}
function payload(form) {
  return {
    name: form.name,
    address: form.address || null,
    district: form.district || null,
    province: form.province || null,
    transit: form.station
      ? [
          {
            station: form.station,
            walkingDistanceM: Number(form.walkingDistanceM || 0),
          },
        ]
      : [],
    amenities: form.amenities
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

export function ProjectEditor({
  editor,
  mutate,
  onClose,
  onRefreshed,
  onSaved,
}) {
  const original = useMemo(
    () => (editor.mode === "edit" ? editor.project : null),
    [editor],
  );
  const [current, setCurrent] = useState(original);
  const [form, setForm] = useState(() => toForm(original));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const dialogRef = useRef(null),
    closeRef = useRef(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(current));
  const requestClose = () => (dirty ? setConfirmClose(true) : onClose());
  const resumeEditing = () => {
    setConfirmClose(false);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => closeRef.current?.focus()),
    );
  };
  useDialogA11y({
    dialogRef,
    initialRef: closeRef,
    onEscape: requestClose,
    suspended: confirmClose,
  });
  const update = (key) => (event) =>
    setForm((value) => ({ ...value, [key]: event.target.value }));

  useEffect(() => {
    const guard = (event) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim()) return setError("กรุณาระบุชื่อโครงการ");
    setSaving(true);
    setError("");
    setConflict(false);
    try {
      const project = await mutate(
        current ? `/api/projects/${current.id}` : "/api/projects",
        {
          method: current ? "PATCH" : "POST",
          body: payload(form),
          revision: current?.revision,
        },
      );
      onSaved(project, current ? "อัปเดตโครงการแล้ว" : "เพิ่มโครงการแล้ว");
    } catch (caught) {
      if (caught.status === 409) setConflict(true);
      else setError(caught.message);
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    if (!current) return;
    setSaving(true);
    try {
      const latest = await api.request(`/api/projects/${current.id}`);
      setCurrent(latest);
      setForm(toForm(latest));
      setConflict(false);
      onRefreshed(latest);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="property-drawer-backdrop" role="presentation">
      <aside
        ref={dialogRef}
        className="property-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-editor-title"
        inert={confirmClose}
        aria-hidden={confirmClose ? "true" : undefined}
      >
        <header className="property-drawer__header">
          <div>
            <span className="property-drawer__context">
              {current ? current.name : "โครงการใหม่"}
            </span>
            <h2 id="project-editor-title">
              {current ? "แก้ไขโครงการ" : "เพิ่มโครงการ"}
            </h2>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            aria-label="ปิดแผงโครงการ"
            onClick={requestClose}
          >
            <X size={20} />
          </button>
        </header>
        <form className="property-form" onSubmit={submit}>
          {conflict ? (
            <div className="conflict-notice" role="alert">
              <AlertCircle size={19} />
              <div>
                <b>ข้อมูลโครงการถูกแก้ไขจากที่อื่น</b>
                <span>โหลด revision ล่าสุดก่อนบันทึกต่อ</span>
              </div>
              <button type="button" onClick={reloadLatest}>
                โหลดโครงการล่าสุด
              </button>
            </div>
          ) : null}
          <section className="property-form__section">
            <h3>ข้อมูลโครงการ</h3>
            <label className="field field--wide">
              <span>
                ชื่อโครงการ <b>*</b>
              </span>
              <input
                aria-label="ชื่อโครงการ"
                value={form.name}
                onChange={update("name")}
              />
            </label>
            <label className="field field--wide">
              <span>ที่อยู่</span>
              <textarea
                aria-label="ที่อยู่โครงการ"
                rows="2"
                value={form.address}
                onChange={update("address")}
              />
            </label>
            <div className="field-grid">
              <label className="field">
                <span>เขต / อำเภอ</span>
                <input
                  aria-label="เขต / อำเภอ"
                  value={form.district}
                  onChange={update("district")}
                />
              </label>
              <label className="field">
                <span>จังหวัด</span>
                <input
                  aria-label="จังหวัด"
                  value={form.province}
                  onChange={update("province")}
                />
              </label>
            </div>
          </section>
          <section className="property-form__section">
            <h3>ข้อมูลที่ใช้จับคู่ความต้องการ</h3>
            <div className="field-grid">
              <label className="field">
                <span>สถานีรถไฟฟ้าใกล้ที่สุด</span>
                <input
                  aria-label="สถานีรถไฟฟ้าใกล้ที่สุด"
                  value={form.station}
                  onChange={update("station")}
                  placeholder="เช่น MRT เพชรบุรี"
                />
              </label>
              <label className="field">
                <span>ระยะเดินจากสถานี (เมตร)</span>
                <input
                  aria-label="ระยะเดินจากสถานี (เมตร)"
                  type="number"
                  min="0"
                  value={form.walkingDistanceM}
                  onChange={update("walkingDistanceM")}
                />
              </label>
            </div>
            <label className="field field--wide">
              <span>สิ่งอำนวยความสะดวก</span>
              <input
                aria-label="สิ่งอำนวยความสะดวก"
                value={form.amenities}
                onChange={update("amenities")}
                placeholder="คั่นแต่ละรายการด้วยเครื่องหมายจุลภาค"
              />
            </label>
          </section>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="property-drawer__footer">
            <button
              className="button button--secondary"
              type="button"
              onClick={requestClose}
            >
              ยกเลิก
            </button>
            <button
              className="button button--primary"
              type="submit"
              disabled={saving}
            >
              {saving ? "กำลังบันทึก…" : "บันทึกโครงการ"}
            </button>
          </footer>
        </form>
      </aside>
      {confirmClose ? (
        <UnsavedDialog onCancel={resumeEditing} onDiscard={onClose} />
      ) : null}
    </div>
  );
}
