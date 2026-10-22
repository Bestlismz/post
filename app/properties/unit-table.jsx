import { BedDouble, CalendarDays, MoreHorizontal, Pencil, Plus, Ruler, TrainFront } from "lucide-react";

const statusCopy = { draft: "ฉบับร่าง", available: "ว่าง", held: "จองชั่วคราว", rented: "ให้เช่าแล้ว", unknown: "รอตรวจสอบ", archived: "ประวัติ" };
const allowedTransitions = {
  draft: ["draft", "unknown", "available"], unknown: ["unknown", "draft", "available"], available: ["available", "unknown", "held", "rented"], held: ["held", "available", "rented", "unknown"], rented: ["rented", "available", "unknown"], archived: ["archived"],
};

function UnitStatus({ unit, onAvailability }) {
  return <select className={`status-select status-select--${unit.status}`} aria-label="สถานะห้อง" value={unit.status} onChange={(event) => onAvailability(unit, event.target.value)} disabled={unit.status === "archived"}>{(allowedTransitions[unit.status] ?? [unit.status]).map((value) => <option value={value} key={value}>{statusCopy[value]}</option>)}</select>;
}

function UnitActions({ unit, onEdit, menuOpen, onMenu, onArchive }) {
  return <div className="unit-actions"><button className="icon-button" type="button" aria-label={`แก้ไขห้อง ${unit.unitCode}`} onClick={() => onEdit(unit)} disabled={unit.status === "archived"}><Pencil size={16} /></button><div className="unit-menu-wrap"><button className="icon-button" type="button" aria-label={`เมนูห้อง ${unit.unitCode}`} aria-expanded={menuOpen} onClick={() => onMenu(unit.id)}><MoreHorizontal size={18} /></button>{menuOpen ? <div className="unit-menu" role="menu"><button type="button" role="menuitem" onClick={() => onEdit(unit)} disabled={unit.status === "archived"}>แก้ไขข้อมูล</button><button className="unit-menu__danger" type="button" role="menuitem" onClick={() => onArchive(unit)} disabled={unit.status === "archived"}>เก็บเข้าประวัติ</button></div> : null}</div></div>;
}

function ProjectMeta({ unit, project }) {
  const transit = project?.transit?.[0];
  return <div className="unit-identity"><span className="unit-identity__code">{unit.unitCode}</span><b>{project?.name ?? "ไม่พบโครงการ"}</b>{transit ? <small><TrainFront size={12} />{transit.station} {transit.walkingDistanceM ? `${transit.walkingDistanceM.toLocaleString("th-TH")} ม.` : ""}</small> : null}</div>;
}

function UnitRow({ unit, project, onEdit, onAvailability, menuUnitId, onMenu, onArchive }) {
  return <tr className={unit.status === "archived" ? "is-archived" : ""}><td><ProjectMeta unit={unit} project={project} /></td><td><div className="unit-facts"><span><BedDouble size={14} />{unit.roomType ?? "ยังไม่ระบุ"}</span><span><Ruler size={14} />{unit.areaSqm ? `${unit.areaSqm.toLocaleString("th-TH")} ตร.ม.` : "—"}</span></div></td><td><strong className="unit-price">{unit.monthlyRentThb ? `฿${unit.monthlyRentThb.toLocaleString("th-TH")}` : "ยังไม่ระบุ"}</strong><small className="unit-price__suffix">/ เดือน</small></td><td><span className="unit-date"><CalendarDays size={14} />{unit.availableFrom ? new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${unit.availableFrom}T00:00:00`)) : "ยังไม่ระบุ"}</span></td><td><UnitStatus unit={unit} onAvailability={onAvailability} /></td><td><UnitActions unit={unit} onEdit={onEdit} menuOpen={menuUnitId === unit.id} onMenu={onMenu} onArchive={onArchive} /></td></tr>;
}

export function UnitTable({ units, projects, loading, onEdit, onAvailability, onAdd, menuUnitId, onMenu, onArchive }) {
  const projectFor = (unit) => projects.find((project) => project.id === unit.projectId);
  const groups = projects.map((project) => ({ project, units: units.filter((unit) => unit.projectId === project.id) })).filter((group) => group.units.length);
  const ungrouped = units.filter((unit) => !projectFor(unit));
  if (ungrouped.length) groups.push({ project: { id: "missing", name: "ไม่พบโครงการ" }, units: ungrouped });
  if (loading && !units.length) return <div className="unit-empty"><span className="unit-empty__loader" />กำลังโหลดข้อมูลห้อง…</div>;
  if (!units.length) return <div className="unit-empty"><span className="unit-empty__icon"><BedDouble size={24} /></span><h3>ยังไม่มีห้องในมุมมองนี้</h3><p>เพิ่มห้องแรกหรือเปลี่ยนตัวกรองเพื่อดูข้อมูลในประวัติ</p><button className="button button--primary" type="button" onClick={onAdd}><Plus size={17} />เพิ่มห้อง</button></div>;
  return (
    <>
      <div className="unit-table-wrap" data-testid="unit-table">
        <table className="unit-table"><thead><tr><th>ห้อง / โครงการ</th><th>รายละเอียด</th><th>ค่าเช่า</th><th>พร้อมเข้าอยู่</th><th>สถานะ</th><th><span className="rr-sr-only">การทำงาน</span></th></tr></thead>{groups.map(({ project, units: projectUnits }) => <tbody key={project.id}><tr className="unit-group-row"><th colSpan="6" scope="rowgroup">โครงการ {project.name} · {projectUnits.length.toLocaleString("th-TH")} ห้อง</th></tr>{projectUnits.map((unit) => <UnitRow key={unit.id} unit={unit} project={project} onEdit={onEdit} onAvailability={onAvailability} menuUnitId={menuUnitId} onMenu={onMenu} onArchive={onArchive} />)}</tbody>)}</table>
      </div>
      <div className="unit-cards" aria-label="รายการห้องแบบการ์ด">{units.map((unit) => { const project = projectFor(unit); return <article className={`unit-card${unit.status === "archived" ? " is-archived" : ""}`} data-testid="unit-card" key={unit.id}><header><ProjectMeta unit={unit} project={project} /><UnitActions unit={unit} onEdit={onEdit} menuOpen={menuUnitId === unit.id} onMenu={onMenu} onArchive={onArchive} /></header><div className="unit-card__facts"><span><BedDouble size={14} />{unit.roomType ?? "ยังไม่ระบุ"}</span><span><Ruler size={14} />{unit.areaSqm ? `${unit.areaSqm} ตร.ม.` : "—"}</span><span><CalendarDays size={14} />{unit.availableFrom || "ยังไม่ระบุ"}</span></div><div className="unit-card__footer"><strong>{unit.monthlyRentThb ? `฿${unit.monthlyRentThb.toLocaleString("th-TH")} / เดือน` : "ยังไม่ระบุค่าเช่า"}</strong><UnitStatus unit={unit} onAvailability={onAvailability} /></div></article>; })}</div>
    </>
  );
}
