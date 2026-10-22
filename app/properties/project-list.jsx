import { Building2, ChevronRight, MapPin, Pencil } from "lucide-react";

export function ProjectList({
  projects,
  counts,
  activeId,
  onSelect,
  onEdit,
  loading,
  canEdit,
}) {
  return (
    <aside className="project-panel" aria-label="โครงการ">
      <div className="project-panel__header">
        <h2>โครงการ</h2>
        <span>{projects.length}</span>
      </div>
      <div className="project-list" role="tree" aria-label="รายชื่อโครงการ">
        <button
          className={`project-row${activeId === "all" ? " is-active" : ""}`}
          type="button"
          role="treeitem"
          aria-selected={activeId === "all"}
          onClick={() => onSelect("all")}
        >
          <span className="project-row__icon">
            <Building2 size={18} />
          </span>
          <span className="project-row__content">
            <b>ทุกโครงการ</b>
            <small>ห้องทั้งหมด</small>
          </span>
          <em>
            {Object.values(counts).reduce((sum, count) => sum + count, 0)}
          </em>
        </button>
        {loading && !projects.length ? (
          <div className="project-list__loading">กำลังโหลดโครงการ…</div>
        ) : null}
        {projects.map((project) => (
          <div
            className={`project-row project-row--project${activeId === project.id ? " is-active" : ""}`}
            role="treeitem"
            aria-selected={activeId === project.id}
            key={project.id}
          >
            <button
              className="project-row__select"
              type="button"
              aria-label={`เลือกโครงการ ${project.name}`}
              onClick={() => onSelect(project.id)}
            >
              <span className="project-row__icon">
                <Building2 size={18} />
              </span>
              <span className="project-row__content">
                <b>{project.name}</b>
                <small>
                  <MapPin size={12} />
                  {[project.district, project.province]
                    .filter(Boolean)
                    .join(", ") || "ยังไม่ระบุทำเล"}
                </small>
              </span>
              <span className="project-row__tail">
                <em>{counts[project.id] ?? 0}</em>
                <ChevronRight size={15} />
              </span>
            </button>
            {canEdit ? (
              <button
                className="project-row__edit"
                type="button"
                aria-label={`แก้ไขโครงการ ${project.name}`}
                onClick={() => onEdit(project)}
              >
                <Pencil size={15} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}
