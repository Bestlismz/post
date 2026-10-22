"use client";

import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api-client.mjs";
import { UnsavedDialog, useDialogA11y } from "./dialog-a11y";

const emptyUnit = {
  projectId: "",
  unitCode: "",
  roomType: "",
  bedrooms: "",
  bathrooms: "",
  floor: "",
  areaSqm: "",
  monthlyRentThb: "",
  depositMonths: "",
  advanceMonths: "",
  petPolicy: "",
  availableFrom: "",
  description: "",
  media: [],
};
const requiredForPublish = [
  ["projectId", "โครงการ"],
  ["unitCode", "รหัสห้อง"],
  ["roomType", "ประเภทห้อง"],
  ["monthlyRentThb", "ค่าเช่าต่อเดือน"],
  ["availableFrom", "วันที่พร้อมเข้าอยู่"],
  ["petPolicy", "นโยบายสัตว์เลี้ยง"],
  ["description", "รายละเอียดสำหรับลูกค้า"],
];
const numericFields = new Set([
  "bedrooms",
  "bathrooms",
  "floor",
  "areaSqm",
  "monthlyRentThb",
  "depositMonths",
  "advanceMonths",
]);

function toForm(unit) {
  return Object.fromEntries(
    Object.keys(emptyUnit).map((key) => [key, unit?.[key] ?? emptyUnit[key]]),
  );
}
function payload(form) {
  return Object.fromEntries(
    Object.entries(form).map(([key, value]) => [
      key,
      numericFields.has(key)
        ? value === ""
          ? null
          : Number(value)
        : key === "media"
          ? value
          : value || null,
    ]),
  );
}

export function UnitEditor({
  editor,
  projects,
  mutate,
  onClose,
  onRefreshed,
  onSaved,
}) {
  const initial = useMemo(
    () =>
      toForm(
        editor.mode === "edit"
          ? editor.unit
          : {
              ...emptyUnit,
              projectId: editor.projectId || projects[0]?.id || "",
            },
      ),
    [editor, projects],
  );
  const [form, setForm] = useState(initial);
  const [current, setCurrent] = useState(
    editor.mode === "edit" ? editor.unit : null,
  );
  const [publicationErrors, setPublicationErrors] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [conflict, setConflict] = useState(false);
  const dialogRef = useRef(null),
    closeRef = useRef(null);
  const pristine = toForm(
    current ?? {
      ...emptyUnit,
      projectId: editor.projectId || projects[0]?.id || "",
    },
  );
  const dirty = JSON.stringify(form) !== JSON.stringify(pristine);
  const update = (key) => (event) => {
    setForm((value) => ({ ...value, [key]: event.target.value }));
    setPublicationErrors((value) => value.filter((field) => field !== key));
  };
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

  async function save(publish) {
    const missing = publish
      ? requiredForPublish
          .filter(([field]) => form[field] === "" || form[field] == null)
          .map(([field]) => field)
      : [];
    if (missing.length) {
      setPublicationErrors(missing);
      setError("");
      return;
    }
    setSaving(true);
    setError("");
    setConflict(false);
    try {
      let unit;
      if (current)
        unit = await mutate(`/api/units/${current.id}`, {
          method: "PATCH",
          body: payload(form),
          revision: current.revision,
        });
      else
        unit = await mutate("/api/units", {
          method: "POST",
          body: payload(form),
        });
      if (publish && unit.status !== "available")
        unit = await mutate(`/api/units/${unit.id}/availability`, {
          method: "POST",
          body: { status: "available" },
          revision: unit.revision,
        });
      if (publish && !unit.publishedAt)
        unit = await mutate(`/api/units/${unit.id}/publish`, {
          method: "POST",
          body: {},
          revision: unit.revision,
        });
      setCurrent(unit);
      setForm(toForm(unit));
      onSaved(unit, publish ? "เผยแพร่แล้ว" : "บันทึกข้อมูลห้องแล้ว");
    } catch (caught) {
      if (caught.status === 409) {
        setConflict(true);
        setError("");
      } else setError(caught.message);
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    if (!current) return;
    setSaving(true);
    try {
      const latest = await api.request(`/api/units/${current.id}`);
      setCurrent(latest);
      setForm(toForm(latest));
      setConflict(false);
      setPublicationErrors([]);
      onRefreshed?.(latest);
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
        className="property-drawer property-drawer--unit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unit-editor-title"
        inert={confirmClose}
        aria-hidden={confirmClose ? "true" : undefined}
      >
        <header className="property-drawer__header">
          <div>
            <span className="property-drawer__context">
              {editor.mode === "edit"
                ? `ห้อง ${current?.unitCode}`
                : "ห้องใหม่"}
            </span>
            <h2 id="unit-editor-title">
              {editor.mode === "edit" ? "แก้ไขข้อมูลห้อง" : "เพิ่มห้อง"}
            </h2>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            aria-label="ปิดแผงแก้ไข"
            onClick={requestClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="property-form">
          {conflict ? (
            <div className="conflict-notice" role="alert">
              <AlertCircle size={19} />
              <div>
                <b>ข้อมูลห้องถูกแก้ไขจากที่อื่น</b>
                <span>
                  โหลดข้อมูลล่าสุดก่อนแก้ไขต่อ เพื่อไม่ให้ทับข้อมูลของทีม
                </span>
              </div>
              <button type="button" onClick={reloadLatest}>
                โหลดข้อมูลล่าสุด
              </button>
            </div>
          ) : null}
          {publicationErrors.length ? (
            <div
              className="publication-errors"
              data-testid="publication-errors"
              role="alert"
            >
              <AlertCircle size={19} />
              <div>
                <b>กรอกข้อมูลที่จำเป็นก่อนเผยแพร่</b>
                <ul>
                  {requiredForPublish
                    .filter(([field]) => publicationErrors.includes(field))
                    .map(([field, label]) => (
                      <li key={field}>{label}</li>
                    ))}
                </ul>
              </div>
            </div>
          ) : null}
          <section className="property-form__section">
            <h3>ข้อมูลหลัก</h3>
            <div className="field-grid">
              <label className="field">
                <span>
                  โครงการ <b>*</b>
                </span>
                <select
                  aria-label="โครงการ"
                  value={form.projectId}
                  onChange={update("projectId")}
                  disabled={editor.mode === "edit"}
                >
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className={`field${publicationErrors.includes("unitCode") ? " has-error" : ""}`}
              >
                <span>
                  รหัสห้อง <b>*</b>
                </span>
                <input
                  aria-label="รหัสห้อง"
                  value={form.unitCode}
                  onChange={update("unitCode")}
                />
              </label>
            </div>
            <div className="field-grid">
              <label
                className={`field${publicationErrors.includes("roomType") ? " has-error" : ""}`}
              >
                <span>
                  ประเภทห้อง <b>*</b>
                </span>
                <select
                  aria-label="ประเภทห้อง"
                  value={form.roomType}
                  onChange={update("roomType")}
                >
                  <option value="">เลือกประเภทห้อง</option>
                  <option value="สตูดิโอ">สตูดิโอ</option>
                  <option value="1 ห้องนอน">1 ห้องนอน</option>
                  <option value="2 ห้องนอน">2 ห้องนอน</option>
                  <option value="3 ห้องนอน">3 ห้องนอน</option>
                </select>
              </label>
              <label
                className={`field${publicationErrors.includes("monthlyRentThb") ? " has-error" : ""}`}
              >
                <span>
                  ค่าเช่าต่อเดือน <b>*</b>
                </span>
                <div className="input-prefix">
                  <span>฿</span>
                  <input
                    aria-label="ค่าเช่าต่อเดือน"
                    type="number"
                    min="1"
                    value={form.monthlyRentThb}
                    onChange={update("monthlyRentThb")}
                  />
                </div>
              </label>
            </div>
            <div className="field-grid field-grid--three">
              <label className="field">
                <span>ห้องนอน</span>
                <input
                  aria-label="จำนวนห้องนอน"
                  type="number"
                  min="0"
                  value={form.bedrooms}
                  onChange={update("bedrooms")}
                />
              </label>
              <label className="field">
                <span>ห้องน้ำ</span>
                <input
                  aria-label="จำนวนห้องน้ำ"
                  type="number"
                  min="0"
                  value={form.bathrooms}
                  onChange={update("bathrooms")}
                />
              </label>
              <label className="field">
                <span>พื้นที่ (ตร.ม.)</span>
                <input
                  aria-label="พื้นที่ห้อง"
                  type="number"
                  min="1"
                  step="0.1"
                  value={form.areaSqm}
                  onChange={update("areaSqm")}
                />
              </label>
            </div>
          </section>
          <section className="property-form__section">
            <h3>เงื่อนไขการเช่า</h3>
            <div className="field-grid">
              <label
                className={`field${publicationErrors.includes("availableFrom") ? " has-error" : ""}`}
              >
                <span>
                  วันที่พร้อมเข้าอยู่ <b>*</b>
                </span>
                <input
                  aria-label="วันที่พร้อมเข้าอยู่"
                  type="date"
                  value={form.availableFrom}
                  onChange={update("availableFrom")}
                />
              </label>
              <label
                className={`field${publicationErrors.includes("petPolicy") ? " has-error" : ""}`}
              >
                <span>
                  นโยบายสัตว์เลี้ยง <b>*</b>
                </span>
                <select
                  aria-label="นโยบายสัตว์เลี้ยง"
                  value={form.petPolicy}
                  onChange={update("petPolicy")}
                >
                  <option value="">เลือกนโยบาย</option>
                  <option value="allowed">เลี้ยงได้</option>
                  <option value="case_by_case">พิจารณาเป็นกรณี</option>
                  <option value="not_allowed">ไม่อนุญาต</option>
                  <option value="unknown">ยังไม่ทราบ</option>
                </select>
              </label>
            </div>
            <div className="field-grid field-grid--three">
              <label className="field">
                <span>ชั้น</span>
                <input
                  aria-label="ชั้น"
                  type="number"
                  value={form.floor}
                  onChange={update("floor")}
                />
              </label>
              <label className="field">
                <span>เงินประกัน (เดือน)</span>
                <input
                  aria-label="เงินประกัน"
                  type="number"
                  min="0"
                  value={form.depositMonths}
                  onChange={update("depositMonths")}
                />
              </label>
              <label className="field">
                <span>ล่วงหน้า (เดือน)</span>
                <input
                  aria-label="ค่าเช่าล่วงหน้า"
                  type="number"
                  min="0"
                  value={form.advanceMonths}
                  onChange={update("advanceMonths")}
                />
              </label>
            </div>
          </section>
          <section className="property-form__section">
            <h3>ข้อความที่ใช้ตอบลูกค้า</h3>
            <label
              className={`field field--wide${publicationErrors.includes("description") ? " has-error" : ""}`}
            >
              <span>
                รายละเอียดสำหรับลูกค้า <b>*</b>
              </span>
              <textarea
                aria-label="รายละเอียดสำหรับลูกค้า"
                rows="5"
                maxLength="1200"
                value={form.description}
                onChange={update("description")}
                placeholder="ระบุจุดเด่นและข้อมูลห้องโดยไม่ใส่เบอร์โทร อีเมล หรือ LINE ID"
              />
              <small>
                {String(form.description).length}/1,200 ·
                ระบบจะใช้ข้อความนี้เป็นข้อเท็จจริงในการตอบลูกค้า
              </small>
            </label>
          </section>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {current?.publishedAt ? (
            <p className="published-note">
              <CheckCircle2 size={16} />
              เผยแพร่แล้ว · แก้ไขข้อเท็จจริงจะสร้าง revision ใหม่
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
              className="button button--secondary"
              type="button"
              onClick={() => save(false)}
              disabled={saving}
            >
              {saving
                ? "กำลังบันทึก…"
                : editor.mode === "edit"
                  ? "บันทึกการเปลี่ยนแปลง"
                  : "บันทึกฉบับร่าง"}
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => save(true)}
              disabled={saving || Boolean(current?.publishedAt)}
            >
              บันทึกและเผยแพร่
            </button>
          </footer>
        </div>
      </aside>
      {confirmClose ? (
        <UnsavedDialog onCancel={resumeEditing} onDiscard={onClose} />
      ) : null}
    </div>
  );
}
