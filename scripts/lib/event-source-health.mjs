export const DEFAULT_SNAPSHOT_MAX_AGE_HOURS = 30;

const REQUIRED_REFRESH_ENV = Object.freeze([
  "TICKETMASTER_API_KEY",
  "MEETUP_CLIENT_ID",
  "MEETUP_MEMBER_ID",
  "MEETUP_KID",
  "MEETUP_PRIVATE_KEY",
]);

function ageHours(timestamp, now) {
  const then = Date.parse(String(timestamp || ""));
  if (!Number.isFinite(then)) return null;
  return (now.getTime() - then) / 3_600_000;
}

function datedEventCounts(events) {
  const counts = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const date = String(event?.date || "");
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) continue;
    counts.set(date, (counts.get(date) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function countDatedEventsOnOrAfter(source, today) {
  const counts = source?.dateCounts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return null;
  const entries = Object.entries(counts).filter(([date, count]) => (
    /^20\d{2}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Number(count))
  ));
  if (entries.length === 0) return null;
  return entries.reduce(
    (sum, [date, count]) => sum + (date >= today ? Number(count) : 0),
    0,
  );
}

export function inspectSnapshot({
  name,
  data,
  timestamp,
  now = new Date(),
  maxAgeHours = DEFAULT_SNAPSHOT_MAX_AGE_HOURS,
}) {
  const count = Array.isArray(data?.events) ? data.events.length : 0;
  const age = ageHours(timestamp, now);
  let status = "ok";
  let reason = null;

  if (!data || !Array.isArray(data.events)) {
    status = "invalid";
    reason = "missing events array";
  } else if (count === 0) {
    status = "empty";
    reason = "contains no events";
  } else if (age === null) {
    status = "invalid";
    reason = "missing or invalid refresh timestamp";
  } else if (age < -1) {
    status = "invalid";
    reason = "refresh timestamp is in the future";
  } else if (age > maxAgeHours) {
    status = "stale";
    reason = `${age.toFixed(1)}h old (maximum ${maxAgeHours}h)`;
  }

  return {
    name,
    status,
    count,
    timestamp: timestamp || null,
    ageHours: age === null ? null : Number(age.toFixed(2)),
    reason,
  };
}

export function strictRefreshInputHealth({
  env = process.env,
  playwright,
  inbound,
  now = new Date(),
  maxAgeHours = DEFAULT_SNAPSHOT_MAX_AGE_HOURS,
} = {}) {
  const missingEnv = REQUIRED_REFRESH_ENV.filter((key) => !String(env[key] || "").trim());
  const snapshots = [
    inspectSnapshot({
      name: "playwright-events",
      data: playwright,
      timestamp: playwright?._meta?.generatedAt,
      now,
      maxAgeHours,
    }),
    inspectSnapshot({
      name: "inbound-events",
      data: inbound,
      timestamp: inbound?._meta?.pulledAt,
      now,
      maxAgeHours,
    }),
  ];
  const problems = [
    ...missingEnv.map((key) => `missing required credential ${key}`),
    ...snapshots
      .filter((snapshot) => snapshot.status !== "ok")
      .map((snapshot) => `${snapshot.name} is ${snapshot.status}: ${snapshot.reason}`),
  ];
  return { ok: problems.length === 0, missingEnv, snapshots, problems };
}

export function buildSourceHealth(sourceDefinitions, settledResults) {
  return sourceDefinitions.map((source, index) => {
    const result = settledResults[index];
    if (!result || result.status === "rejected") {
      return {
        id: source.id,
        label: source.label,
        critical: Boolean(source.critical),
        status: "error",
        count: 0,
        dateCounts: {},
        error: result?.reason?.message || String(result?.reason || "source did not run"),
      };
    }

    const events = Array.isArray(result.value) ? result.value : [];
    const count = events.length;
    return {
      id: source.id,
      label: source.label,
      critical: Boolean(source.critical),
      status: count > 0 ? "ok" : "empty",
      count,
      dateCounts: datedEventCounts(events),
      error: null,
    };
  });
}

// How many non-critical adapters may fail before we treat the run as unsafe.
// Above this, the failures look systemic (network, DNS, a shared upstream)
// rather than a handful of individually dead feeds.
export const DEFAULT_SOURCE_ERROR_TOLERANCE = 6;

function describeSource(source) {
  return `${source.label} is ${source.status}${source.error ? `: ${source.error}` : ""}`;
}

/**
 * Split source failures into the ones that must block the overwrite and the
 * ones the run can absorb.
 *
 * A thrown adapter error is still unsafe in isolation — we do not know whether
 * the source is legitimately empty — but blocking the whole refresh on any one
 * of them is worse: four dead sports feeds took down a 4,000-event refresh for
 * five days in Jul/Aug 2026, and with it the daily newsletter, which refuses to
 * send without a fresh feed. Critical broad sources still block on any non-ok
 * status; everything else is tolerated (and reported) until enough of them fail
 * at once to look systemic.
 */
export function sourceProblems(sourceHealth, { tolerance = DEFAULT_SOURCE_ERROR_TOLERANCE } = {}) {
  const critical = [];
  const tolerable = [];

  for (const source of Array.isArray(sourceHealth) ? sourceHealth : []) {
    if (source.critical) {
      if (source.status !== "ok") critical.push(source);
    } else if (source.status === "error") {
      tolerable.push(source);
    }
  }

  const toleranceExceeded = tolerable.length > tolerance;
  return {
    blocking: [...critical, ...(toleranceExceeded ? tolerable : [])].map(describeSource),
    tolerated: toleranceExceeded ? [] : tolerable.map(describeSource),
    toleranceExceeded,
  };
}

export function eventRegressionProblem({ previous, nextSourceCount, nextEventCount }) {
  if (!previous) return null;
  const previousSourceCount = Array.isArray(previous.sources) ? previous.sources.length : 0;
  const previousEventCount = Number(previous.eventCount || previous.events?.length || 0);
  if (previousSourceCount < 10 || previousEventCount <= 0) return null;

  const lostSources = previousSourceCount - nextSourceCount;
  if (lostSources < 4 && nextEventCount >= previousEventCount * 0.6) return null;
  return `event coverage regressed from ${previousSourceCount} to ${nextSourceCount} sources and ${previousEventCount} to ${nextEventCount} events`;
}

/**
 * Catch a single adapter losing records that were still scheduled for the
 * future. Aggregate event totals cannot see this when a large library feed
 * masks a smaller first-party source. Date-bucket baselines naturally age out,
 * so seasonal sources may empty after their final occurrence without a manual
 * allowlist.
 */
export function sourceRegressionProblems({
  previousSourceHealth,
  nextSourceHealth,
  today,
  minimumExpected = 3,
  minimumRetainedRatio = 0.25,
} = {}) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(today || ""))) return [];
  const previousById = new Map(
    (Array.isArray(previousSourceHealth) ? previousSourceHealth : [])
      .map((source) => [source?.id, source]),
  );
  const problems = [];

  for (const next of Array.isArray(nextSourceHealth) ? nextSourceHealth : []) {
    const previous = previousById.get(next?.id);
    if (!previous || previous.status !== "ok" || next?.status === "error") continue;

    const expected = countDatedEventsOnOrAfter(previous, today);
    const actual = countDatedEventsOnOrAfter(next, today) ?? 0;
    if (expected === null || expected < minimumExpected) continue;

    if (actual === 0) {
      problems.push(`${next.label} lost ${expected} still-upcoming source records`);
      continue;
    }

    const retainedRatio = actual / expected;
    if (retainedRatio < minimumRetainedRatio) {
      problems.push(
        `${next.label} retained only ${actual} of ${expected} still-upcoming source records (${Math.round(retainedRatio * 100)}%)`,
      );
    }
  }

  return problems;
}
