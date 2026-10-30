function usageSummary(value, now = Date.now()) {
  value = value || {};
  const windows = Array.isArray(value.windows) ? value.windows : [];
  const window = windows.find((w) => w.window === "5h"),
    used = window?.used_pct;
  const reset = Date.parse(window?.resets_at),
    validReset = Number.isFinite(reset),
    expired = validReset && reset <= now;
  const known =
    value.status === "ready" &&
    typeof used === "number" &&
    Number.isFinite(used) &&
    !expired;
  // A used-up weekly (or weekly Opus) limit leaves no room in the 5h window.
  const weekly = windows.find((w) => {
    const until = Date.parse(w.resets_at);
    return (
      ["7d", "weekly", "Week", "7d-model"].includes(w.window) &&
      typeof w.used_pct === "number" &&
      w.used_pct >= 100 &&
      (!Number.isFinite(until) || until > now)
    );
  });
  const weeklyReset = Date.parse(weekly?.resets_at),
    until = weekly && Number.isFinite(weeklyReset) ? weeklyReset : null,
    resetsAt = weekly ? until : validReset ? reset : null;
  return {
    known: known || (value.status === "ready" && !!weekly),
    left: weekly ? 0 : known ? Math.max(0, Math.min(100, 100 - used)) : null,
    blocked: weekly
      ? weekly.window === "7d-model"
        ? "Hết hạn mức tuần " + (weekly.model || "Opus")
        : "Hết hạn mức tuần"
      : null,
    resetsAt,
    remainingMs: resetsAt === null ? null : Math.max(0, resetsAt - now),
    expired: weekly ? false : expired,
    stale: !!(value.stale || value.unavailable),
    updatedAt: value.updated_at || null,
  };
}
module.exports = { usageSummary };
