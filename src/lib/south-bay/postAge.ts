// ---------------------------------------------------------------------------
// Age labels for Reddit pulse tiles
// ---------------------------------------------------------------------------
// Split out of RedditPulseTeaser so the arithmetic is testable without a DOM.
//
// The generator stamps `ageHours` at write time. Rendering that value directly
// is only correct on the day it was generated: while Reddit was rate-limiting
// the RSS fetch, reddit-pulse.json went 20 days without a refresh and every
// homepage tile kept advertising "1h ago" for a three-week-old thread.
// `createdUtc` is absolute, so it survives a stalled generator.
// ---------------------------------------------------------------------------

/** Humanize an age in hours: "now", "5h ago", "1d ago", "20d ago". */
export function formatAge(hours: number): string {
  if (hours < 1) return "now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1d ago" : `${days}d ago`;
}

/**
 * Age of a post in hours, measured against `nowMs`.
 *
 * Prefers the absolute `createdUtc` (seconds since epoch). Falls back to the
 * generator's stored `ageHours` when the record predates that field or when
 * there is no clock yet — during SSR and first paint, where reading the clock
 * would freeze a build-time value into the HTML and mismatch on hydration.
 *
 * Never returns a negative age: a post whose timestamp is slightly ahead of
 * the client's clock reads as "now", not as a future thread.
 */
export function resolvePostAgeHours(
  createdUtc: number | undefined,
  storedHours: number,
  nowMs: number | null,
): number {
  if (nowMs === null || !Number.isFinite(createdUtc)) return storedHours;
  return Math.max(0, (nowMs / 1000 - (createdUtc as number)) / 3600);
}
