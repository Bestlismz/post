export function evaluatePolicy(policy, context, now = new Date()) {
  if (policy?.mode === 'observe') return { action: 'observe', reasons: ['observe_mode'] };
  const reasons = [];
  const threshold = policy?.minimumConfidence === undefined ? 1 : policy.minimumConfidence;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) reasons.push('invalid_confidence_threshold');
  if (policy?.mode !== 'automatic') reasons.push('approval_required');
  if (context.grounded !== true || context.automaticEligible !== true) reasons.push('ungrounded');
  if (!Number.isFinite(context.confidence) || context.confidence < 0 || context.confidence > 1 || context.confidence < threshold) reasons.push('confidence');
  if (context.sourceHealth !== 'connected') reasons.push('source_health');
  if (context.replyWindowOpen !== true) reasons.push('reply_window');
  if (context.optOut) reasons.push('opt_out');
  if (context.humanTakeover) reasons.push('human_takeover');
  for (const scope of ['organization','source','conversation']) {
    const limit = policy?.rateLimits?.[scope];
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(context.counts?.[scope]) || context.counts[scope] >= limit)) reasons.push(`${scope}_rate_limit`);
  }
  if (policy?.businessHours) {
    try {
      const { timeZone, days, start, end } = policy.businessHours;
      const validTime = value => typeof value==='string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
      if (!validTime(start) || !(validTime(end) || end==='24:00') || start>=end || typeof timeZone!=='string' || !timeZone || !Array.isArray(days) || !days.length || days.some(day=>!Number.isInteger(day)||day<0||day>6)) throw new Error();
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type,p.value]));
      const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday), time = `${parts.hour}:${parts.minute}`;
      if (!days.includes(day) || time < start || time >= end) reasons.push('business_hours');
    } catch { reasons.push('invalid_business_hours'); }
  }
  return { action: reasons.length ? 'review' : 'authorize', reasons };
}
