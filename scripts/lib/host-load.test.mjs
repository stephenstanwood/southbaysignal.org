import assert from "node:assert/strict";
import test from "node:test";

import {
  countNavigationTimeouts,
  describeRefreshFailureContext,
  hostLoad,
} from "./host-load.mjs";

const timeoutError = 'page.goto: Timeout 30000ms exceeded.';

test("hostLoad reports load per core", () => {
  const load = hostLoad({ load1: 84, cores: 10 });
  assert.equal(load.ratio, 8.4);
});

test("hostLoad survives a zero core count", () => {
  const load = hostLoad({ load1: 4, cores: 0 });
  assert.equal(load.cores, 1);
  assert.equal(load.ratio, 4);
});

test("countNavigationTimeouts separates timeouts from real failures", () => {
  const health = [
    { error: timeoutError },
    { error: timeoutError },
    { error: "403 Forbidden" },
    { error: null },
    {},
  ];
  assert.deepEqual(countNavigationTimeouts(health), { failures: 3, timeouts: 2 });
});

test("a saturated, timeout-dominated run blames the host", () => {
  const message = describeRefreshFailureContext({
    sourceHealth: [
      { error: timeoutError },
      { error: timeoutError },
      { error: timeoutError },
      { error: "403 Forbidden" },
    ],
    load: hostLoad({ load1: 84, cores: 10 }),
  });
  assert.match(message, /host load 84\.00 over 10 core\(s\)/);
  assert.match(message, /3\/4 source error\(s\) were timeouts/);
  assert.match(message, /check local CPU contention before touching any adapter/);
});

test("a healthy host does not blame local contention", () => {
  const message = describeRefreshFailureContext({
    sourceHealth: [{ error: "403 Forbidden" }, { error: "404" }, { error: "500" }],
    load: hostLoad({ load1: 3, cores: 10 }),
  });
  assert.match(message, /0\/3 source error\(s\) were timeouts/);
  assert.doesNotMatch(message, /saturated/);
});

test("a saturated host with few failures still flags the load", () => {
  const message = describeRefreshFailureContext({
    sourceHealth: [{ error: timeoutError }],
    load: hostLoad({ load1: 40, cores: 10 }),
  });
  assert.match(message, /treat source counts as unreliable/);
  assert.doesNotMatch(message, /before touching any adapter/);
});

test("the suffix is appendable even with no source health", () => {
  const message = describeRefreshFailureContext({
    sourceHealth: [],
    load: hostLoad({ load1: 1, cores: 10 }),
  });
  assert.ok(message.startsWith(" — "));
  assert.doesNotMatch(message, /source error/);
});
