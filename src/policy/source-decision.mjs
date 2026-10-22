import { evaluatePolicy } from './evaluator.mjs';

export function effectiveSourcePolicy(organizationPolicy,source) {
  return {...organizationPolicy,...(source?.policy??{}),mode:source?.mode??organizationPolicy?.mode};
}

export function evaluateSourceDecision({organizationPaused=false,organizationPolicy,source,context,actorKind='policy',now=new Date()}) {
  const reasons=[];
  if(organizationPaused)reasons.push('global_pause');
  if(source?.kill_switch)reasons.push('source_pause');
  if(source?.archived)reasons.push('source_archived');
  if(source?.allow_listed!==true)reasons.push('source_not_allowlisted');
  if(source?.session_health!=='healthy')reasons.push('source_session_unhealthy');
  if(source?.selector_health!=='healthy')reasons.push('source_selector_unhealthy');
  if(source?.session_circuit)reasons.push('session_circuit_open');
  if(source?.selector_circuit)reasons.push('selector_circuit_open');
  const operational=reasons.length===0;
  const policy=effectiveSourcePolicy(organizationPolicy,source);
  if(actorKind==='human'&&source?.mode==='observe')reasons.push('observe_mode');
  const evaluated=evaluatePolicy(actorKind==='human'?{...policy,mode:'automatic',minimumConfidence:0}:policy,{
    ...context,
    ...(actorKind==='human'?{grounded:true,automaticEligible:true,confidence:1}:{}),
    sourceHealth:operational?'connected':'unavailable',
  },now);
  return {action:reasons.length?(evaluated.action==='observe'?'observe':'review'):evaluated.action,reasons:[...new Set([...reasons,...evaluated.reasons])],effectivePolicy:policy};
}
