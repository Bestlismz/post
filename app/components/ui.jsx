export function NavItem({label,icon,active,onClick}){return <button className={active?"active":""} onClick={onClick} aria-current={active?"page":undefined}><span>{icon}</span><b>{label}</b></button>}
export function StatusDot({state="live"}){return <i className={`status-dot ${state}`}/>}
export function SurfaceHead({title,subtitle,action}){return <div className="surface-head"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>}
export function Intent({value}){return <em className={`intent ${value||"irrelevant"}`}>{({tenant_lead:"Tenant",owner_lead:"Owner",listing:"Listing",irrelevant:"Low signal"})[value]||"Pending"}</em>}
