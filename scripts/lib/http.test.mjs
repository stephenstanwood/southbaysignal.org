import assert from "node:assert/strict";
import test from "node:test";

import { fetchJson, fetchText } from "./http.mjs";

const quiet = () => {};

test("fetchText retries a transient 503 and then succeeds", async () => {
  const responses = [new Response("busy", { status: 503 }), new Response("ready")];
  const delays = [];
  let calls = 0;

  const result = await fetchText("https://example.com/events", {
    fetchImpl: async () => responses[calls++],
    sleep: async (delayMs) => delays.push(delayMs),
    baseDelayMs: 100,
    onRetry: quiet,
  });

  assert.equal(result, "ready");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [100]);
});

test("fetchText does not retry a permanent 404", async () => {
  let calls = 0;

  await assert.rejects(
    fetchText("https://example.com/missing", {
      fetchImpl: async () => {
        calls += 1;
        return new Response("missing", { status: 404 });
      },
      sleep: async () => assert.fail("permanent responses must not sleep"),
      onRetry: quiet,
    }),
    /404/,
  );

  assert.equal(calls, 1);
});

test("fetchJson retries a network error with a fresh attempt", async () => {
  let calls = 0;

  const result = await fetchJson("https://example.com/data", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset");
      return Response.json({ ok: true });
    },
    sleep: async () => {},
    onRetry: quiet,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test("fetchText stops after the configured attempt limit", async () => {
  const delays = [];
  let calls = 0;

  await assert.rejects(
    fetchText("https://example.com/busy", {
      attempts: 3,
      baseDelayMs: 100,
      fetchImpl: async () => {
        calls += 1;
        return new Response("busy", { status: 503 });
      },
      sleep: async (delayMs) => delays.push(delayMs),
      onRetry: quiet,
    }),
    /503/,
  );

  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("fetchJson retries a 429 before succeeding", async () => {
  const delays = [];
  let calls = 0;

  const result = await fetchJson("https://example.com/tm", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "1" },
        });
      }
      return Response.json({ ok: true });
    },
    sleep: async (delayMs) => delays.push(delayMs),
    onRetry: quiet,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1_000]);
});

test("fetchText honors and caps Retry-After", async () => {
  const delays = [];
  let calls = 0;

  const result = await fetchText("https://example.com/rate-limited", {
    maxRetryDelayMs: 2_000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "10" },
        });
      }
      return new Response("ready");
    },
    sleep: async (delayMs) => delays.push(delayMs),
    onRetry: quiet,
  });

  assert.equal(result, "ready");
  assert.deepEqual(delays, [2_000]);
});
