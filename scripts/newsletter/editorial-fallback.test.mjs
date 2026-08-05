// The editorial pass runs on the Max-plan claude CLI and falls back to the
// metered Anthropic API when that fails. The fallback only earns its cost if it
// actually fires, so this exercises the real branch against a stub CLI and a
// local stand-in for the Anthropic API — no plan usage, no tokens billed.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "sbt-editorial-"));

function stubCli(script) {
  const path = join(workdir, `claude-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const FAILING_CLI = stubCli("#!/bin/sh\ncat >/dev/null\necho 'Claude usage limit reached' >&2\nexit 1\n");
const WORKING_CLI = stubCli('#!/bin/sh\ncat >/dev/null\nprintf \'{"from":"cli"}\'\n');

/** Minimal Anthropic Messages streaming response — enough for the SDK to parse. */
function startMockAnthropic(text) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("message_start", {
      type: "message_start",
      message: {
        id: "msg_test", type: "message", role: "assistant", model: "claude-fable-5",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    send("message_stop", { type: "message_stop" });
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("a working CLI is used directly and the API is never touched", async () => {
  process.env.CLAUDE_CLI_PATH = WORKING_CLI;
  process.env.ANTHROPIC_API_KEY = "sk-ant-unused";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1"; // any call here would fail

  const { callClaudeNewsletterEditor } = await import("./lib.mjs");
  const result = await callClaudeNewsletterEditor("packet");
  assert.equal(result.via, "claude-cli");
  assert.equal(result.raw, '{"from":"cli"}');
});

test("a usage-capped CLI falls through to the Anthropic API", async () => {
  const { server, port } = await startMockAnthropic('{"from":"api"}');
  try {
    process.env.CLAUDE_CLI_PATH = FAILING_CLI;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

    const { callClaudeNewsletterEditor } = await import("./lib.mjs");
    const result = await callClaudeNewsletterEditor("packet");
    assert.equal(result.via, "anthropic-api");
    assert.equal(result.raw, '{"from":"api"}');
  } finally {
    server.close();
  }
});

test("with no API key the CLI failure propagates so the send degrades cleanly", async () => {
  process.env.CLAUDE_CLI_PATH = FAILING_CLI;
  delete process.env.ANTHROPIC_API_KEY;

  const { callClaudeNewsletterEditor } = await import("./lib.mjs");
  await assert.rejects(
    () => callClaudeNewsletterEditor("packet"),
    /usage limit reached/,
    "the caller catches this and ships the deterministic build",
  );
});
