// ---------------------------------------------------------------------------
// Freshness audit for the per-city council digests
// ---------------------------------------------------------------------------
// generate-digests degrades softly on purpose: a city whose source comes up
// empty keeps the previous run's card rather than 404ing /gov/<city>. That is
// the right behavior for one bad night and the wrong behavior for seven weeks,
// and nothing was watching the difference — the Campbell digest republished a
// July 7 meeting until 2026-08-27, when a copy pass happened to notice.
//
// Two distinct things go stale and only one of them is a carry-forward:
//
//   * a run fails and the previous card is reused (`carriedForward`), and
//   * the run *succeeds* against a source that itself stopped advancing.
//
// Campbell was mostly the second. Its summarize step failed roughly three
// nights in four, but the nights it succeeded it re-summarized the same July 7
// record — so a carry-forward streak counter alone would have kept resetting to
// zero and never fired. The published meeting date is the signal that actually
// tracks reader-visible staleness; the streak counter catches the faster,
// noisier failure. Check both.
// ---------------------------------------------------------------------------

/** A council meeting a resident could still call recent. Two sittings' worth. */
export const MAX_DIGEST_AGE_DAYS = 35;

/** Consecutive carried-forward runs before a source gap stops being a hiccup. */
export const MAX_CARRY_FORWARD_RUNS = 3;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from one ISO calendar date to another. Null if either is unusable. */
export function daysBetween(fromIso, toIso) {
  if (!ISO_DATE.test(String(fromIso ?? "")) || !ISO_DATE.test(String(toIso ?? ""))) return null;
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Compare a freshly written digest set against the cities it was supposed to
 * cover.
 *
 * @param {object}   opts
 * @param {Array}    opts.cities   `[{ city, cityName }]` — the configured set
 * @param {object}   opts.digests  the digests.json object about to be written
 * @param {string}   opts.today    Pacific ISO date the run considers "now"
 * @returns {{ alerts: Array, ok: boolean }} alerts are ordered worst-first
 */
export function auditDigestFreshness({
  cities = [],
  digests = {},
  today,
  maxAgeDays = MAX_DIGEST_AGE_DAYS,
  maxCarryForwardRuns = MAX_CARRY_FORWARD_RUNS,
} = {}) {
  const alerts = [];

  for (const config of cities) {
    const cityName = config.cityName ?? config.city;
    const digest = digests[config.city];

    if (!digest) {
      alerts.push({
        city: config.city,
        cityName,
        kind: "missing",
        detail: "no digest written and no previous one to carry forward",
      });
      continue;
    }

    const ageDays = daysBetween(digest.meetingDateIso, today);
    const runs = Number(digest.carriedForwardRuns) || 0;

    if (ageDays === null) {
      alerts.push({
        city: config.city,
        cityName,
        kind: "undated",
        detail: `digest has no usable meetingDateIso (${JSON.stringify(digest.meetingDateIso ?? null)})`,
      });
      continue;
    }

    if (ageDays > maxAgeDays) {
      alerts.push({
        city: config.city,
        cityName,
        kind: "stale",
        ageDays,
        meetingDateIso: digest.meetingDateIso,
        detail:
          `published meeting is ${ageDays} days old (${digest.meetingDateIso})` +
          (digest.carriedForward ? ` — carried forward, ${digest.carryForwardReason}` : " — source is not advancing"),
      });
      continue;
    }

    if (runs >= maxCarryForwardRuns) {
      alerts.push({
        city: config.city,
        cityName,
        kind: "carry-forward-streak",
        runs,
        meetingDateIso: digest.meetingDateIso,
        detail: `carried forward ${runs} runs in a row (${digest.carryForwardReason ?? "no reason recorded"})`,
      });
    }
  }

  // Worst first: a city with no card at all outranks one that is merely old.
  const rank = { missing: 0, undated: 1, stale: 2, "carry-forward-streak": 3 };
  alerts.sort((a, b) => (rank[a.kind] - rank[b.kind]) || a.city.localeCompare(b.city));

  return { alerts, ok: alerts.length === 0 };
}

/** One-line-per-city body for the Discord alert. */
export function formatFreshnessAlert(alerts) {
  return alerts.map((a) => `• **${a.cityName}** — ${a.detail}`).join("\n");
}
