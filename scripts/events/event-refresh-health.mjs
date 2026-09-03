import { sourceProblems } from "../lib/event-source-health.mjs";
import { auditEventLocations } from "../lib/venue-location-audit.mjs";

export const DEFAULT_MINI_SUCCESS_MAX_AGE_HOURS = 26;
export const DEFAULT_OUTPUT_MAX_AGE_HOURS = 30;
export const DEFAULT_OUTPUT_SNAPSHOT_MAX_AGE_HOURS = 30;

export const REQUIRED_SOURCE_IDS = Object.freeze([
  "fetchMusicInParkEvents",
  "fetchJazzOnThePlazzEvents",
  "fetchLosAltosEvents",
  "fetchSjJazzEvents",
  "fetchHappyHollowEvents",
  "fetchPearTheatreEvents",
  "fetchTicketmasterEvents",
  "fetchMeetupEvents",
  "fetchPlaywrightEvents",
  "fetchInboundEvents",
]);

function ageHours(value, now) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return null;
  return (now.getTime() - timestamp) / 3_600_000;
}

function timestampProblem(label, value, now, maxAgeHours) {
  const age = ageHours(value, now);
  if (age === null) return `${label} has no valid timestamp`;
  if (age < -1) return `${label} timestamp is in the future`;
  if (age > maxAgeHours) return `${label} is ${age.toFixed(1)}h old (maximum ${maxAgeHours}h)`;
  return null;
}

export function inspectEventRefreshOutput({
  data,
  now = new Date(),
  maxAgeHours = DEFAULT_OUTPUT_MAX_AGE_HOURS,
  snapshotMaxAgeHours = DEFAULT_OUTPUT_SNAPSHOT_MAX_AGE_HOURS,
  requiredSourceIds = REQUIRED_SOURCE_IDS,
} = {}) {
  const problems = [];
  if (!data || typeof data !== "object") {
    return { ok: false, problems: ["upcoming-events output is missing or invalid"] };
  }

  const generatedProblem = timestampProblem(
    "upcoming-events output",
    data.generatedAt,
    now,
    maxAgeHours,
  );
  if (generatedProblem) problems.push(generatedProblem);

  const events = Array.isArray(data.events) ? data.events : null;
  if (!events) {
    problems.push("upcoming-events output has no events array");
  } else if (events.length === 0) {
    problems.push("upcoming-events output contains no events");
  }
  if (events && Number(data.eventCount) !== events.length) {
    problems.push(`eventCount ${data.eventCount} does not match ${events.length} events`);
  }

  const sourceHealth = Array.isArray(data.sourceHealth) ? data.sourceHealth : null;
  if (!sourceHealth) {
    problems.push("upcoming-events output has no sourceHealth array");
  } else {
    const byId = new Map(sourceHealth.map((source) => [source?.id, source]));
    for (const sourceId of requiredSourceIds) {
      if (!byId.has(sourceId)) problems.push(`required source health is missing: ${sourceId}`);
    }
    // Match generate-events: absorb a few broken optional adapters; only page
    // when a critical source is unhealthy or too many optionals fail at once.
    const { blocking } = sourceProblems(sourceHealth);
    problems.push(...blocking);
  }

  // Venue integrity. Blocks only on records that contradict themselves — a
  // listing that announces it moved and then names its own institution as the
  // venue. See lib/venue-location-audit.mjs for the 2026-09-03 defects.
  const locationAudit = auditEventLocations(events || []);
  problems.push(...locationAudit.problems);

  const snapshots = Array.isArray(data.inputSnapshots) ? data.inputSnapshots : null;
  if (!snapshots) {
    problems.push("upcoming-events output has no inputSnapshots array");
  } else {
    for (const name of ["playwright-events", "inbound-events"]) {
      const snapshot = snapshots.find((item) => item?.name === name);
      if (!snapshot) {
        problems.push(`required input snapshot is missing: ${name}`);
        continue;
      }
      if (snapshot.status !== "ok") {
        problems.push(`${name} snapshot is ${snapshot.status || "invalid"}`);
      }
      const snapshotProblem = timestampProblem(
        `${name} snapshot`,
        snapshot.timestamp,
        now,
        snapshotMaxAgeHours,
      );
      if (snapshotProblem) problems.push(snapshotProblem);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    locationWarnings: locationAudit.warnings,
    eventCount: events?.length || 0,
    sourceCount: sourceHealth?.length || 0,
  };
}

export function inspectMiniRefreshState({
  state,
  now = new Date(),
  maxAgeHours = DEFAULT_MINI_SUCCESS_MAX_AGE_HOURS,
} = {}) {
  if (!state || typeof state !== "object") {
    return { ok: false, problems: ["Mini refresh state is missing or invalid"] };
  }
  const problem = timestampProblem(
    "last successful Mini refresh",
    state.lastSuccessAt,
    now,
    maxAgeHours,
  );
  const problems = problem ? [problem] : [];
  if (!/^[0-9a-f]{40}$/i.test(String(state.head || ""))) {
    problems.push("Mini refresh state has no valid pushed HEAD");
  }
  return { ok: problems.length === 0, problems };
}

export function inspectMiniEventRefresh({ state, data, now = new Date() } = {}) {
  const stateHealth = inspectMiniRefreshState({ state, now });
  const outputHealth = inspectEventRefreshOutput({ data, now });
  return {
    ok: stateHealth.ok && outputHealth.ok,
    problems: [...stateHealth.problems, ...outputHealth.problems],
    stateHealth,
    outputHealth,
  };
}
