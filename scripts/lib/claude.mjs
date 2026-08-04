// ---------------------------------------------------------------------------
// Shared Anthropic Messages API client for the generate-* scripts
// ---------------------------------------------------------------------------
// Every generator used to inline its own fetch + `data.content[0].text`. That
// indexing is wrong against current models: claude-sonnet-5 returns an
// extended-thinking block FIRST, so content[0] is `{ type: "thinking" }` and
// content[0].text is undefined.
//
// Two separate failures came out of that, and both were silent:
//
//   1. Short thinking → content is ["thinking", "text"], and every caller read
//      undefined instead of the answer.
//   2. Long thinking → thinking consumes the whole max_tokens budget, the
//      response stops at `max_tokens` with content ["thinking"] and no text
//      block at all.
//
// Case 2 is what killed generate-weekend-picks: on a 16.6k-token prompt with
// max_tokens 1536, all 1536 output tokens went to thinking. The caller then
// threw "Cannot read properties of undefined (reading 'match')" — a message
// that names neither the API nor the real cause — and the stale JSON just sat
// on the homepage behind its staleness guard for 18 days.
//
// So: read the first TEXT block wherever it sits, and raise a loud, specific
// error when there isn't one. These are structured-extraction prompts that
// don't benefit from extended thinking, so callers get it disabled by default
// and keep their whole token budget for the answer.
// ---------------------------------------------------------------------------

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export const CLAUDE_SONNET = "claude-sonnet-5";

/**
 * Returns the text of the first `text` block in a Messages API content array,
 * skipping any thinking blocks. Returns "" when there is no text block.
 */
export function extractText(content) {
  if (!Array.isArray(content)) return "";
  const block = content.find((c) => c?.type === "text");
  return typeof block?.text === "string" ? block.text : "";
}

/**
 * POST a single-turn prompt and return its text.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.apiKey]     defaults to process.env.ANTHROPIC_API_KEY
 * @param {string} [opts.model]      defaults to claude-sonnet-5
 * @param {number} [opts.maxTokens]  defaults to 2048
 * @param {boolean} [opts.thinking]  extended thinking; defaults to false
 * @param {string} [opts.label]      names this call in error messages
 * @returns {Promise<string>}
 */
export async function callClaude(prompt, opts = {}) {
  const {
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = CLAUDE_SONNET,
    maxTokens = 2048,
    thinking = false,
    label = "claude",
  } = opts;

  if (!apiKey) throw new Error(`${label}: ANTHROPIC_API_KEY not set`);

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(thinking ? {} : { thinking: { type: "disabled" } }),
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = data?.error?.message ? ` — ${data.error.message}` : "";
    throw new Error(`${label}: Claude API error ${res.status}${detail}`);
  }

  const text = extractText(data?.content);
  if (!text) {
    // Name the cause. The old code failed here with an undefined-property
    // TypeError that told the operator nothing.
    const types = (data?.content ?? []).map((c) => c?.type).join(", ") || "none";
    const hint =
      data?.stop_reason === "max_tokens"
        ? ` — the ${maxTokens}-token budget ran out before any text was emitted; raise maxTokens`
        : "";
    throw new Error(
      `${label}: no text block in response (stop_reason=${data?.stop_reason ?? "?"}, blocks=[${types}])${hint}`,
    );
  }

  return text;
}
