const paths = {
  overview: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9h13v-9"/><path d="M9.5 19v-5h5v5"/></>,
  leads: <><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3"/><path d="M12 1.75v2.5M12 19.75v2.5M1.75 12h2.5M19.75 12h2.5"/></>,
  groups: <><path d="M4 5.5h6.5v13H4zM13.5 5.5H20v13h-6.5z"/><path d="M7.25 9h.01M16.75 9h.01M7.25 12h.01M16.75 12h.01M7.25 15h.01M16.75 15h.01"/></>,
  review: <><path d="m4 16 1.2-4.5L15.4 1.3a1.8 1.8 0 0 1 2.6 0l4.7 4.7a1.8 1.8 0 0 1 0 2.6L12.5 18.8 8 20z"/><path d="m13.8 3 7.2 7.2M5.2 11.5l7.3 7.3M3 23h18"/></>,
  messenger: <><path d="M21 11.4a8.6 8.6 0 0 1-9 8.6 9.8 9.8 0 0 1-3.7-.7L3 21l1.7-4.6A8.1 8.1 0 0 1 3 11.4a8.6 8.6 0 0 1 9-8.5 8.6 8.6 0 0 1 9 8.5Z"/><path d="m7.5 14 3.2-3.4 2.5 2 3.3-3.5"/></>,
  browser: <><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 8.5h18M6.5 6.25h.01M9 6.25h.01"/></>,
  activity: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5h4M12 3V1.5M21 12h1.5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-2.87 2.87-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06-2.87-2.87.06-.06A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.4v-4h.1A1.7 1.7 0 0 0 4.2 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06L6.67 3.8l.06.06A1.7 1.7 0 0 0 8.6 4.2a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1v-.1h4v.1a1.7 1.7 0 0 0 1 1.7 1.7 1.7 0 0 0 1.87-.34l.06-.06 2.87 2.87-.06.06A1.7 1.7 0 0 0 19.4 8.6a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1a1.7 1.7 0 0 0-1.7 1Z"/></>,
};
export function Icon({name}){return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>}
export function NavItem({label,icon,active,onClick}){return <button className={active?"active":""} onClick={onClick} aria-label={label} title={label} aria-current={active?"page":undefined}><span className="nav-icon-wrap"><Icon name={icon}/></span><b>{label}</b></button>}
export function StatusDot({state="live"}){return <i className={`status-dot ${state}`}/>}
export function SurfaceHead({title,subtitle,action}){return <div className="surface-head"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>}
export function Intent({value}){return <em className={`intent ${value||"irrelevant"}`}>{({tenant_lead:"Tenant",owner_lead:"Owner",listing:"Listing",irrelevant:"Low signal"})[value]||"Pending"}</em>}
