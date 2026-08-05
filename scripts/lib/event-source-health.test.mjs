import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSourceHealth,
  eventRegressionProblem,
  sourceProblems,
  inspectSnapshot,
  sourceRegressionProblems,
  strictRefreshInputHealth,
} from "./event-source-health.mjs";

const NOW = new Date("2026-07-20T03:00:00.000Z");

test("rejects stale and timestamp-less snapshots", () => {
  assert.equal(inspectSnapshot({
    name: "playwright",
    data: { events: [{}] },
    timestamp: "2026-07-18T00:00:00.000Z",
    now: NOW,
    maxAgeHours: 30,
  }).status, "stale");
  assert.equal(inspectSnapshot({
    name: "inbound",
    data: { events: [{}] },
    timestamp: null,
    now: NOW,
  }).status, "invalid");
});

test("strict input health requires credentials and both fresh snapshots", () => {
  const env = Object.fromEntries([
    "TICKETMASTER_API_KEY",
    "MEETUP_CLIENT_ID",
    "MEETUP_MEMBER_ID",
    "MEETUP_KID",
    "MEETUP_PRIVATE_KEY",
  ].map((key) => [key, "present"]));
  const result = strictRefreshInputHealth({
    env,
    playwright: { _meta: { generatedAt: "2026-07-20T02:00:00.000Z" }, events: [{}] },
    inbound: { _meta: { pulledAt: "2026-07-20T01:00:00.000Z" }, events: [{}] },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test("source health blocks a critical empty source but absorbs a broken optional one", () => {
  const health = buildSourceHealth(
    [
      { id: "broad", label: "Broad feed", critical: true },
      { id: "seasonal", label: "Seasonal feed", critical: false },
      { id: "broken", label: "Broken feed", critical: false },
    ],
    [
      { status: "fulfilled", value: [] },
      { status: "fulfilled", value: [] },
      { status: "rejected", reason: new Error("upstream 503") },
    ],
  );
  const result = sourceProblems(health);
  assert.deepEqual(result.blocking, ["Broad feed is empty"]);
  assert.deepEqual(result.tolerated, ["Broken feed is error: upstream 503"]);
  assert.equal(result.toleranceExceeded, false);
});

test("a handful of dead optional feeds never blocks the refresh", () => {
  // The Jul/Aug 2026 outage: four sports/theatre adapters 403/400'd and took
  // down a 4,000-event refresh — and five days of newsletters with it.
  const definitions = ["Earthquakes", "Bay FC", "Santa Cruz Warriors", "Palo Alto Players"]
    .map((label, i) => ({ id: `s${i}`, label, critical: false }));
  const health = buildSourceHealth(
    [{ id: "tm", label: "Ticketmaster", critical: true }, ...definitions],
    [
      { status: "fulfilled", value: [{ date: "2026-08-05" }] },
      ...definitions.map(() => ({ status: "rejected", reason: new Error("403") })),
    ],
  );
  const result = sourceProblems(health);
  assert.deepEqual(result.blocking, []);
  assert.equal(result.tolerated.length, 4);
});

test("a systemic outage still blocks even when no source is marked critical", () => {
  const definitions = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, label: `Feed ${i}`, critical: false }));
  const health = buildSourceHealth(
    definitions,
    definitions.map(() => ({ status: "rejected", reason: new Error("ETIMEDOUT") })),
  );
  const result = sourceProblems(health);
  assert.equal(result.toleranceExceeded, true);
  assert.equal(result.blocking.length, 9);
  assert.deepEqual(result.tolerated, []);
});

test("detects meaningful source or event-count regressions", () => {
  const previous = { sources: Array.from({ length: 20 }, (_, i) => `s${i}`), eventCount: 100 };
  assert.match(eventRegressionProblem({ previous, nextSourceCount: 15, nextEventCount: 95 }), /regressed/);
  assert.match(eventRegressionProblem({ previous, nextSourceCount: 19, nextEventCount: 50 }), /regressed/);
  assert.equal(eventRegressionProblem({ previous, nextSourceCount: 19, nextEventCount: 90 }), null);
});

test("records dated source baselines and blocks a masked single-source collapse", () => {
  const definitions = [{ id: "music", label: "Town concert schedule", critical: false }];
  const previous = buildSourceHealth(definitions, [{
    status: "fulfilled",
    value: [
      { date: "2026-07-18" },
      { date: "2026-07-22" },
      { date: "2026-07-29" },
      { date: "2026-08-05" },
      { date: "2026-08-12" },
      { date: "2026-08-19" },
    ],
  }]);
  const next = buildSourceHealth(definitions, [{
    status: "fulfilled",
    value: [{ date: "2026-07-22" }],
  }]);

  assert.deepEqual(previous[0].dateCounts, {
    "2026-07-18": 1,
    "2026-07-22": 1,
    "2026-07-29": 1,
    "2026-08-05": 1,
    "2026-08-12": 1,
    "2026-08-19": 1,
  });
  assert.deepEqual(sourceRegressionProblems({
    previousSourceHealth: previous,
    nextSourceHealth: next,
    today: "2026-07-20",
  }), ["Town concert schedule retained only 1 of 5 still-upcoming source records (20%)"]);
});

test("source baselines age out seasonal events instead of requiring an allowlist", () => {
  const previous = [{
    id: "seasonal",
    label: "Seasonal series",
    status: "ok",
    count: 3,
    dateCounts: { "2026-07-01": 1, "2026-07-08": 1, "2026-07-15": 1 },
  }];
  const next = [{
    id: "seasonal",
    label: "Seasonal series",
    status: "empty",
    count: 0,
    dateCounts: {},
  }];
  assert.deepEqual(sourceRegressionProblems({
    previousSourceHealth: previous,
    nextSourceHealth: next,
    today: "2026-07-20",
  }), []);
});

test("blocks an adapter that drops every still-upcoming source record", () => {
  const previous = [{
    id: "official",
    label: "Official calendar",
    status: "ok",
    count: 3,
    dateCounts: { "2026-08-01": 1, "2026-08-08": 1, "2026-08-15": 1 },
  }];
  const next = [{
    id: "official",
    label: "Official calendar",
    status: "empty",
    count: 0,
    dateCounts: {},
  }];
  assert.deepEqual(sourceRegressionProblems({
    previousSourceHealth: previous,
    nextSourceHealth: next,
    today: "2026-07-20",
  }), ["Official calendar lost 3 still-upcoming source records"]);
});
