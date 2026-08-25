import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectEventRefreshOutput,
  inspectMiniEventRefresh,
  inspectMiniRefreshState,
} from "./event-refresh-health.mjs";

const NOW = new Date("2026-07-20T05:00:00.000Z");
const REQUIRED = [
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
];

function healthyOutput() {
  return {
    generatedAt: "2026-07-20T04:30:00.000Z",
    eventCount: 2,
    events: [{ id: "a" }, { id: "b" }],
    sourceHealth: REQUIRED.map((id) => ({
      id,
      label: id,
      critical: ["fetchTicketmasterEvents", "fetchMeetupEvents", "fetchPlaywrightEvents", "fetchInboundEvents"].includes(id),
      status: "ok",
      count: 2,
      dateCounts: { "2026-08-01": 2 },
      error: null,
    })),
    inputSnapshots: [
      { name: "playwright-events", status: "ok", timestamp: "2026-07-20T04:20:00.000Z" },
      { name: "inbound-events", status: "ok", timestamp: "2026-07-20T04:25:00.000Z" },
    ],
  };
}

test("accepts a fresh complete refresh output", () => {
  const health = inspectEventRefreshOutput({ data: healthyOutput(), now: NOW });
  assert.equal(health.ok, true);
  assert.equal(health.eventCount, 2);
  assert.deepEqual(health.problems, []);
});

test("detects missing adapters, stale snapshots, and count mismatches", () => {
  const data = healthyOutput();
  data.eventCount = 99;
  data.sourceHealth = data.sourceHealth.filter((source) => source.id !== "fetchMusicInParkEvents");
  data.inputSnapshots[0].timestamp = "2026-07-18T00:00:00.000Z";
  const health = inspectEventRefreshOutput({
    data,
    now: NOW,
    snapshotMaxAgeHours: 8,
  });
  assert.equal(health.ok, false);
  assert.ok(health.problems.some((problem) => problem.includes("does not match")));
  assert.ok(health.problems.some((problem) => problem.includes("fetchMusicInParkEvents")));
  assert.ok(health.problems.some((problem) => problem.includes("playwright-events snapshot is")));
});

test("detects a stale or malformed Mini success heartbeat", () => {
  assert.equal(inspectMiniRefreshState({
    state: { lastSuccessAt: "2026-07-18T00:00:00.000Z", head: "a".repeat(40) },
    now: NOW,
  }).ok, false);
  assert.deepEqual(inspectMiniRefreshState({
    state: { lastSuccessAt: "2026-07-20T04:00:00.000Z", head: "not-a-sha" },
    now: NOW,
  }).problems, ["Mini refresh state has no valid pushed HEAD"]);
});

test("combines scheduler heartbeat and generated-output health", () => {
  const health = inspectMiniEventRefresh({
    state: { lastSuccessAt: "2026-07-20T04:00:00.000Z", head: "a".repeat(40) },
    data: healthyOutput(),
    now: NOW,
  });
  assert.equal(health.ok, true);
  assert.deepEqual(health.problems, []);
});

test("absorbs a broken optional adapter the same way generate-events does", () => {
  const data = healthyOutput();
  data.sourceHealth.push({
    id: "fetchHeritageTheatreEvents",
    label: "Heritage Theatre",
    critical: false,
    status: "error",
    count: 0,
    dateCounts: {},
    error: "429",
  });
  const health = inspectEventRefreshOutput({ data, now: NOW });
  assert.equal(health.ok, true);
  assert.deepEqual(health.problems, []);
});

test("still flags a critical Ticketmaster failure in the generated output", () => {
  const data = healthyOutput();
  const tm = data.sourceHealth.find((source) => source.id === "fetchTicketmasterEvents");
  tm.status = "error";
  tm.count = 0;
  tm.error = "429";
  const health = inspectEventRefreshOutput({ data, now: NOW });
  assert.equal(health.ok, false);
  assert.ok(health.problems.some((problem) => /fetchTicketmasterEvents is error: 429/.test(problem)));
});

test("pages when the output has no inputSnapshots array at all", () => {
  // 2026-08-24/25: an ad-hoc non-strict `npm run generate-events` (a93dbdba)
  // omitted the key entirely, two agent commits carried the field-less file
  // forward, and the watchdog fired. The checker was right and the producer
  // was wrong — generate-events now records snapshots on every run. Keep this
  // strict so the next producer that drops the field still pages instead of
  // going quiet.
  const data = healthyOutput();
  delete data.inputSnapshots;
  const health = inspectEventRefreshOutput({ data, now: NOW });
  assert.equal(health.ok, false);
  assert.ok(health.problems.includes("upcoming-events output has no inputSnapshots array"));
});

test("names the individual stale input rather than the whole array", () => {
  // The payoff of recording snapshots unconditionally: a non-strict run with a
  // stale input now reports which input went stale, instead of collapsing into
  // the far less actionable "no inputSnapshots array".
  const data = healthyOutput();
  data.inputSnapshots = data.inputSnapshots.map((snapshot) => (
    snapshot.name === "inbound-events"
      ? { ...snapshot, status: "stale", timestamp: "2026-07-18T00:00:00.000Z" }
      : snapshot
  ));
  const health = inspectEventRefreshOutput({ data, now: NOW });
  assert.equal(health.ok, false);
  assert.ok(health.problems.includes("inbound-events snapshot is stale"));
  assert.ok(!health.problems.some((problem) => problem.includes("no inputSnapshots array")));
});
