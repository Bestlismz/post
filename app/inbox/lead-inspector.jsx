import { Bath, BedDouble, CalendarDays, Cat, ChevronRight, MapPin, RefreshCw, Wallet, X } from "lucide-react";

const labels = { district: [MapPin, "ทำเล"], budgetMax: [Wallet, "งบประมาณ"], bedrooms: [BedDouble, "ประเภทห้อง"], requiredPetPolicy: [Cat, "เงื่อนไขเพิ่มเติม"], moveInDate: [CalendarDays, "วันที่ย้ายเข้า"] };
function requirementValue(key, value) {
  if (value === null || value === undefined || value === "") return "ยังไม่ระบุ";
  if (key === "budgetMax") return `ไม่เกิน ${new Intl.NumberFormat("th-TH").format(value)} บาท`;
  if (key === "bedrooms") return `${value} ห้องนอน`;
  if (key === "requiredPetPolicy") return value === "allowed" ? "เลี้ยงสัตว์ได้" : value === "case_by_case" ? "พิจารณาเป็นกรณี" : value;
  if (key === "moveInDate") return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium" }).format(new Date(`${value}T00:00:00+07:00`));
  return value;
}
function petLabel(value) { return value === "allowed" ? "เลี้ยงสัตว์ได้" : value === "case_by_case" ? "พิจารณาสัตว์เลี้ยงเป็นกรณี" : value === "not_allowed" ? "ไม่อนุญาตสัตว์เลี้ยง" : "ยังไม่ระบุ"; }

export function LeadInspector({ detail, loading, open, onClose }) {
  return <aside className={`lead-inspector${open ? " is-open" : ""}`} aria-label="ข้อมูลลีด" aria-hidden={!open}>
    <header className="lead-inspector__tabs"><strong>ข้อมูลประกอบการตอบ</strong><button className="lead-inspector__close" type="button" onClick={onClose} aria-label="ปิดข้อมูลลีด"><X size={18} /></button></header>
    {loading && !detail ? <div className="inspector-skeleton"><i /><i /><i /><i /></div> : null}
    {detail ? <div className="lead-inspector__scroll"><section className="requirements-panel"><div className="inspector-heading"><h2>ความต้องการ</h2></div><dl>{Object.entries(labels).map(([key, [Icon, label]]) => <div key={key} className={detail.missingRequirements?.includes(key) ? "is-missing" : ""}><dt><Icon size={17} />{label}</dt><dd>{requirementValue(key, detail.requirements?.[key])}</dd></div>)}</dl>{detail.missingRequirements?.length ? <p className="requirements-missing">ยังขาด {detail.missingRequirements.length} ข้อมูลก่อนจับคู่ได้แม่นยำที่สุด</p> : null}</section><section className="matches-panel"><div className="inspector-heading"><h2>ห้องที่แนะนำ ({detail.matches?.length ?? 0})</h2><span><RefreshCw size={13} />ข้อมูลปัจจุบัน</span></div>{detail.matches?.length ? detail.matches.map((unit) => <UnitMatch key={unit.unitId} unit={unit} />) : <div className="matches-empty"><BedDouble size={23} /><strong>ยังไม่มีห้องที่ตรงครบ</strong><p>ขอข้อมูลที่ยังขาด แล้วระบบจะจับคู่ใหม่จากห้องที่เผยแพร่และว่างอยู่</p></div>}</section></div> : null}
  </aside>;
}

function UnitMatch({ unit }) {
  return <article className="unit-match"><div className="unit-match__image" aria-hidden="true"><span>{unit.score ?? "—"}</span><small>match</small></div><div className="unit-match__body"><header><div><h3>{unit.projectName}</h3><p>{unit.unitCode}</p></div><ChevronRight size={18} /></header><strong className="unit-match__rent">฿{new Intl.NumberFormat("th-TH").format(unit.monthlyRentThb)} / เดือน</strong><p className="unit-match__facts"><BedDouble size={14} />{unit.bedrooms ?? "—"} ห้องนอน <Bath size={14} />{unit.areaSqm ?? "—"} ตร.ม. · ชั้น {unit.floor ?? "—"}</p><ul><li>{petLabel(unit.petPolicy)}</li>{unit.transit?.slice(0, 1).map((transit) => <li key={typeof transit === "string" ? transit : transit.station}>{typeof transit === "string" ? transit : `${transit.station} ${transit.walkingDistanceM} ม.`}</li>)}</ul><time>อัปเดต {new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }).format(new Date(unit.factsUpdatedAt))}</time></div></article>;
}
