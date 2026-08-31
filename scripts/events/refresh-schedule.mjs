/**
 * The primary launch agent's normal and retry slots are 90 minutes apart.
 * Keep this window only wide enough to coalesce those two slots: when a
 * daytime watchdog recovery is older than this, the normal nightly refresh
 * must still run. At three hours, any success recent enough to suppress the
 * 20:45 retry will still be under 25.5 hours old at the next 19:15 slot,
 * safely inside the watchdog's 26-hour heartbeat ceiling.
 */
export const RETRY_SLOT_SUPPRESSION_HOURS = 3;

export function hasRecentSuccessfulRefresh({
  lastSuccessAt,
  now = new Date(),
  maxAgeHours = RETRY_SLOT_SUPPRESSION_HOURS,
} = {}) {
  const last = Date.parse(String(lastSuccessAt || ""));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  if (!Number.isFinite(last) || !Number.isFinite(nowMs)) return false;

  const ageMs = nowMs - last;
  return ageMs >= 0 && ageMs < maxAgeHours * 3_600_000;
}
