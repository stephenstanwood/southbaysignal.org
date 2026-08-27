import assert from "node:assert/strict";
import test from "node:test";

import { callClaude, extractText } from "./claude.mjs";

const OK = { apiKey: "test-key", sleep: async () => {}, onRetry: () => {} };

/** A Response-shaped stub: only what callClaude actually reads. */
function reply(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const text = (value, stopReason = "end_turn") => ({
  stop_reason: stopReason,
  content: [{ type: "text", text: value }],
});

test("extractText reads past a thinking block", () => {
  assert.equal(extractText([{ type: "thinking", thinking: "…" }, { type: "text", text: "answer" }]), "answer");
  assert.equal(extractText([{ type: "thinking", thinking: "…" }]), "");
  assert.equal(extractText(null), "");
});

test("callClaude disables extended thinking so the budget goes to the answer", async () => {
  let sent;
  await callClaude("hi", {
    ...OK,
    fetchImpl: async (_url, req) => { sent = JSON.parse(req.body); return reply(200, text("{}")); },
  });
  assert.deepEqual(sent.thinking, { type: "disabled" });

  await callClaude("hi", {
    ...OK,
    thinking: true,
    fetchImpl: async (_url, req) => { sent = JSON.parse(req.body); return reply(200, text("{}")); },
  });
  assert.equal(sent.thinking, undefined, "opting in leaves the API default alone");
});

// The Campbell digest bug: the text block was present but cut off mid-JSON, so
// the caller's parse blamed the model instead of the token ceiling.
test("callClaude refuses a truncated answer and names the ceiling", async () => {
  await assert.rejects(
    callClaude("hi", {
      ...OK,
      maxTokens: 512,
      fetchImpl: async () => reply(200, text('{"summary": "cut off mid', "max_tokens")),
    }),
    /claude: response hit the 512-token ceiling and is truncated — raise maxTokens/,
  );
});

test("a truncated answer is not retried — the same budget fails the same way", async () => {
  let calls = 0;
  await assert.rejects(
    callClaude("hi", {
      ...OK,
      fetchImpl: async () => { calls += 1; return reply(200, text("{", "max_tokens")); },
    }),
    /truncated/,
  );
  assert.equal(calls, 1);
});

test("callClaude still reports a response with no text block at all", async () => {
  await assert.rejects(
    callClaude("hi", {
      ...OK,
      fetchImpl: async () => reply(200, { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "…" }] }),
    }),
    /no text block in response \(stop_reason=end_turn, blocks=\[thinking\]\)/,
  );
});

test("callClaude retries a 529 Overloaded and returns the eventual answer", async () => {
  const statuses = [529, 529, 529, 200];
  let calls = 0;
  const answer = await callClaude("hi", {
    ...OK,
    fetchImpl: async () => {
      const status = statuses[calls++];
      return status === 200 ? reply(200, text("done")) : reply(status, { error: { message: "Overloaded" } });
    },
  });
  assert.equal(answer, "done");
  assert.equal(calls, 4, "the default budget is four tries");
});

test("callClaude honors Retry-After over its own backoff", async () => {
  const waits = [];
  let calls = 0;
  await callClaude("hi", {
    ...OK,
    sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async () =>
      calls++ === 0 ? reply(429, { error: { message: "rate limit" } }, { "retry-after": "7" }) : reply(200, text("ok")),
  });
  assert.deepEqual(waits, [7_000]);
});

// The API answers 529 with `retry-after: 0`. Taken literally that fires every
// remaining attempt inside one millisecond — three tries, one overload window,
// three failures. San José carried forward four runs straight on exactly this.
test("a Retry-After of 0 does not collapse the backoff", async () => {
  const waits = [];
  let calls = 0;
  await callClaude("hi", {
    ...OK,
    baseDelayMs: 1_000,
    sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async () =>
      calls++ < 2 ? reply(529, { error: { message: "Overloaded" } }, { "retry-after": "0" }) : reply(200, text("ok")),
  });
  assert.deepEqual(waits, [1_000, 2_000], "backoff is the floor, Retry-After only raises it");
});

test("callClaude caps the wait so a scheduled refresh cannot hang", async () => {
  const waits = [];
  let calls = 0;
  await callClaude("hi", {
    ...OK,
    maxRetryDelayMs: 2_000,
    sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async () =>
      calls++ === 0 ? reply(503, {}, { "retry-after": "600" }) : reply(200, text("ok")),
  });
  assert.deepEqual(waits, [2_000]);
});

test("callClaude gives up after the configured attempts and reports the status", async () => {
  let calls = 0;
  await assert.rejects(
    callClaude("hi", {
      ...OK,
      attempts: 2,
      fetchImpl: async () => { calls += 1; return reply(529, { error: { message: "Overloaded" } }); },
    }),
    /Claude API error 529 — Overloaded/,
  );
  assert.equal(calls, 2);
});

test("callClaude does not retry a permanent 4xx", async () => {
  let calls = 0;
  await assert.rejects(
    callClaude("hi", {
      ...OK,
      fetchImpl: async () => { calls += 1; return reply(400, { error: { message: "bad request" } }); },
    }),
    /Claude API error 400 — bad request/,
  );
  assert.equal(calls, 1, "a malformed request is not going to succeed on a retry");
});

test("callClaude retries a network failure and surfaces the last one", async () => {
  let calls = 0;
  const answer = await callClaude("hi", {
    ...OK,
    fetchImpl: async () => {
      if (++calls < 3) throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
      return reply(200, text("recovered"));
    },
  });
  assert.equal(answer, "recovered");

  calls = 0;
  await assert.rejects(
    callClaude("hi", {
      ...OK,
      attempts: 2,
      fetchImpl: async () => { calls += 1; throw new Error("ETIMEDOUT"); },
    }),
    /ETIMEDOUT/,
  );
  assert.equal(calls, 2);
});

test("callClaude refuses to run without a key", async () => {
  await assert.rejects(
    callClaude("hi", { apiKey: "", label: "digests", fetchImpl: async () => reply(200, text("x")) }),
    /digests: ANTHROPIC_API_KEY not set/,
  );
});
