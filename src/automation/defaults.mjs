export function defaultAutomationPolicy() {
  return {
    mode: "approval",
    minimumConfidence: 0.82,
    rateLimits: { organization: 100, source: 20, conversation: 2 },
    businessHours: { timeZone: "Asia/Bangkok", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "24:00" },
  };
}

export function defaultSourcePolicy() {
  const policy = defaultAutomationPolicy();
  return { rateLimits: policy.rateLimits, businessHours: policy.businessHours };
}

export function defaultSourceSchedule() {
  return {
    enabled: true,
    cadenceMinutes: 15,
    timeZone: "Asia/Bangkok",
    days: [0, 1, 2, 3, 4, 5, 6],
    start: "00:00",
    end: "24:00",
    dailyLimit: 96,
    maintenanceWindows: [],
  };
}
