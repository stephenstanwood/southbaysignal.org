import assert from "node:assert/strict";
import test from "node:test";

import {
  inboundReadProblems,
  toleratedShardFailures,
  MIN_TOLERATED_SHARD_FAILURES,
} from "./inbound-shard-health.mjs";

test("a clean read reports nothing", () => {
  const { blocking, warnings } = inboundReadProblems({ shardTotal: 860, shardErrors: [] });
  assert.deepEqual(blocking, []);
  assert.deepEqual(warnings, []);
});

test("the 2026-08-23/24 outage shape degrades instead of blocking", () => {
  // The exact failure that aborted the nightly refresh after the Playwright
  // stage had already written 623 events: three unreachable shards out of 860.
  const { blocking, warnings } = inboundReadProblems({
    shardTotal: 860,
    shardErrors: [
      "lookout/events-shards/2ef0b6a588744507.json: fetch failed (after 3 attempts)",
      "lookout/events-shards/2ef184356e6fd3cf.json: fetch failed (after 3 attempts)",
      "lookout/events-shards/2f9644e5665ccfc7.json: fetch failed (after 3 attempts)",
    ],
  });
  assert.deepEqual(blocking, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /degraded: 3\/860/);
});

test("a systemic shard outage still blocks the refresh", () => {
  const shardErrors = Array.from({ length: 200 }, (_, i) => `shard-${i}.json: fetch failed`);
  const { blocking } = inboundReadProblems({ shardTotal: 860, shardErrors });
  assert.equal(blocking.length, 1);
  assert.match(blocking[0], /unreadable: 200\/860/);
  assert.match(blocking[0], /tolerating 43/);
});

test("the tolerance boundary blocks one past the limit, not at it", () => {
  const shardTotal = 100;
  const allowed = toleratedShardFailures(shardTotal); // 5
  const at = Array.from({ length: allowed }, (_, i) => `shard-${i}: fetch failed`);
  const over = [...at, "shard-over: fetch failed"];

  assert.deepEqual(inboundReadProblems({ shardTotal, shardErrors: at }).blocking, []);
  assert.equal(inboundReadProblems({ shardTotal, shardErrors: over }).blocking.length, 1);
});

test("a failed shard listing always blocks — the universe is unknowable", () => {
  // Without the listing there is no denominator: a silent undercount looks
  // exactly like a clean read, so this can never be degraded away.
  const { blocking } = inboundReadProblems({
    listError: "fetch failed",
    shardTotal: 0,
    shardErrors: [],
  });
  assert.equal(blocking.length, 1);
  assert.match(blocking[0], /shard list failed/);
});

test("a small shard set still absorbs a couple of blips", () => {
  assert.equal(toleratedShardFailures(4), MIN_TOLERATED_SHARD_FAILURES);
  const { blocking, warnings } = inboundReadProblems({
    shardTotal: 4,
    shardErrors: ["a: fetch failed", "b: fetch failed"],
  });
  assert.deepEqual(blocking, []);
  assert.equal(warnings.length, 1);
});

test("toleratedShardFailures is defined for degenerate totals", () => {
  for (const total of [0, -1, Number.NaN, undefined]) {
    assert.equal(toleratedShardFailures(total), 0);
  }
});

test("the legacy blob is a warning, never a blocker", () => {
  const { blocking, warnings } = inboundReadProblems({
    shardTotal: 860,
    shardErrors: [],
    legacyError: "fetch failed",
  });
  assert.deepEqual(blocking, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /legacy inbound blob/);
});

test("long failure lists are sampled rather than dumped whole", () => {
  const shardErrors = Array.from({ length: 60 }, (_, i) => `shard-${i}.json: fetch failed`);
  const { blocking } = inboundReadProblems({ shardTotal: 200, shardErrors });
  assert.match(blocking[0], /\+57 more/);
});
