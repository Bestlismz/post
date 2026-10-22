import { Building2, ChevronRight, MapPin } from "lucide-react";

export function ProjectList({ projects, counts, activeId, onSelect, loading }) {
  return (
    <aside className="project-panel" aria-label="โครงการ">
      <div className="project-panel__header"><h2>โครงการ</h2><span>{projects.length}</span></div>
      <div className="project-list" role="tree" aria-label="รายชื่อโครงการ">
        <button className={`project-row${activeId === "all" ? " is-active" : ""}`} type="button" role="treeitem" aria-selected={activeId === "all"} onClick={() => onSelect("all")}>
          <span className="project-row__icon"><Building2 size={18} /></span><span className="project-row__content"><b>ทุกโครงการ</b><small>ห้องทั้งหมด</small></span><em>{Object.values(counts).reduce((sum, count) => sum + count, 0)}</em>
        </button>
        {loading && !projects.length ? <div className="project-list__loading">กำลังโหลดโครงการ…</div> : null}
        {projects.map((project) => (
          <button className={`project-row${activeId === project.id ? " is-active" : ""}`} type="button" role="treeitem" aria-selected={activeId === project.id} onClick={() => onSelect(project.id)} key={project.id}>
            <span className="project-row__icon"><Building2 size={18} /></span>
            <span className="project-row__content"><b>{project.name}</b><small><MapPin size={12} />{[project.district, project.province].filter(Boolean).join(", ") || "ยังไม่ระบุทำเล"}</small></span>
            <span className="project-row__tail"><em>{counts[project.id] ?? 0}</em><ChevronRight size={15} /></span>
          </button>
        ))}
      </div>
    </aside>
  );
}
