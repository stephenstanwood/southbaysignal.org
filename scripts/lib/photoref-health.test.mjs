import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPhotoRefResult,
  decideAlert,
  isTransientStatus,
  summarize,
} from "./photoref-health.mjs";

test("2xx is healthy", () => {
  assert.equal(classifyPhotoRefResult({ status: 200 }), "ok");
  assert.equal(classifyPhotoRefResult({ status: 204 }), "ok");
});

test("permanent client errors mean the ref is dead", () => {
  // Google answers 403 for an expired photo reference and 400 for a malformed one.
  assert.equal(classifyPhotoRefResult({ status: 403 }), "stale");
  assert.equal(classifyPhotoRefResult({ status: 400 }), "stale");
  assert.equal(classifyPhotoRefResult({ status: 404 }), "stale");
});

test("rate limits and 5xx are unreachable, not stale", () => {
  assert.ok(isTransientStatus(429));
  assert.ok(isTransientStatus(503));
  assert.ok(!isTransientStatus(403));
  assert.equal(classifyPhotoRefResult({ status: 429 }), "unreachable");
  assert.equal(classifyPhotoRefResult({ status: 502 }), "unreachable");
});

test("the abort message that paged us in Aug 2026 is unreachable, not stale", () => {
  const err = new Error("The operation was aborted due to timeout");
  assert.equal(classifyPhotoRefResult({ error: err }), "unreachable");
});

test("other network faults are unreachable", () => {
  for (const msg of ["fetch failed", "ENOTFOUND", "ECONNRESET", "socket hang up"]) {
    assert.equal(classifyPhotoRefResult({ error: new Error(msg) }), "unreachable", msg);
  }
});

test("an all-timeout sample does NOT fire the stale-ref page", () => {
  // 2026-08-23: 20/20 aborted on a loaded Mini while the refs were fine.
  const results = Array.from({ length: 20 }, () => ({ kind: "unreachable" }));
  const counts = summarize(results);
  assert.equal(counts.stale, 0);
  const alert = decideAlert(counts);
  assert.equal(alert.kind, "unreachable");
});

test("a partly-timed-out sample does NOT fire the stale-ref page", () => {
  // 2026-08-24: 11/20 aborted, 9 fine.
  const results = [
    ...Array.from({ length: 11 }, () => ({ kind: "unreachable" })),
    ...Array.from({ length: 9 }, () => ({ kind: "ok" })),
  ];
  const alert = decideAlert(summarize(results));
  assert.notEqual(alert.kind, "stale");
});

test("a few timeouts stay silent entirely", () => {
  const results = [
    ...Array.from({ length: 3 }, () => ({ kind: "unreachable" })),
    ...Array.from({ length: 17 }, () => ({ kind: "ok" })),
  ];
  assert.equal(decideAlert(summarize(results)).kind, "none");
});

test("genuinely expired refs still page", () => {
  const results = [
    ...Array.from({ length: 5 }, () => ({ kind: "stale" })),
    ...Array.from({ length: 15 }, () => ({ kind: "ok" })),
  ];
  const alert = decideAlert(summarize(results));
  assert.equal(alert.kind, "stale");
  assert.equal(alert.stale, 5);
});

test("a noisy network cannot mask expired refs", () => {
  const results = [
    ...Array.from({ length: 5 }, () => ({ kind: "stale" })),
    ...Array.from({ length: 14 }, () => ({ kind: "unreachable" })),
    { kind: "ok" },
  ];
  assert.equal(decideAlert(summarize(results)).kind, "stale");
});

test("a clean sample is silent", () => {
  const results = Array.from({ length: 20 }, () => ({ kind: "ok" }));
  assert.equal(decideAlert(summarize(results)).kind, "none");
});

test("empty sample never alerts", () => {
  assert.equal(decideAlert(summarize([])).kind, "none");
});

test("timeouts do not inflate the stale rate in a mixed run", () => {
  // The gap in the all-transport-only suppression: 11 timeouts + 2 genuinely
  // dead refs is a 10% stale run, not a 65% one. Counting the timeouts toward
  // the rate pages Stephen with a number six times the real problem.
  const results = [
    ...Array.from({ length: 11 }, () => ({ kind: "unreachable" })),
    ...Array.from({ length: 2 }, () => ({ kind: "stale" })),
    ...Array.from({ length: 7 }, () => ({ kind: "ok" })),
  ];
  const counts = summarize(results);
  assert.equal(counts.stale, 2);
  // 2/20 stale is under the threshold, so the refresh page must not fire.
  // The run is still flagged — as the host problem it actually is.
  const alert = decideAlert(counts);
  assert.notEqual(alert.kind, "stale");
  assert.equal(alert.kind, "unreachable");
});
