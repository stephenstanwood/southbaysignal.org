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
//   3. Middling thinking → there is room for a *partial* answer, so a text
//      block IS present but cut off mid-JSON. The caller's parse then fails
//      with a message that blames the model.
//
// Case 2 is what killed generate-weekend-picks: on a 16.6k-token prompt with
// max_tokens 1536, all 1536 output tokens went to thinking. The caller then
// threw "Cannot read properties of undefined (reading 'match')" — a message
// that names neither the API nor the real cause — and the stale JSON just sat
// on the homepage behind its staleness guard for 18 days.
//
// Case 3 is what stalled the Campbell council digest for seven weeks:
// generate-digests asked for 512 tokens with thinking left on, so roughly three
// runs in four came back as unclosed JSON, threw "No JSON in Claude response",
// and were swallowed by a carry-forward fallback that republished July 7.
//
// So: read the first TEXT block wherever it sits, and raise a loud, specific
// error when there isn't one or when the response was truncated. These are
// structured-extraction prompts that don't benefit from extended thinking, so
// callers get it disabled by default and keep their whole token budget for the
// answer.
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

// Overload and rate-limit answers are capacity, not a verdict on the request.
// Same set http.mjs retries on, plus every 5xx — the API returns 529 Overloaded
// under load, which is how San José's digest carried forward twice in a row on
// 2026-08-27 with nothing wrong on either end.
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

function isTransientStatus(status) {
  return TRANSIENT_STATUSES.has(status) || status >= 500;
}

function retryAfterMs(response, now = Date.now()) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * POST a single-turn prompt and return its text.
 *
 * Retries transient upstream failures with backoff. A permanent 4xx and a
 * truncated answer both fail immediately — neither gets better on a retry.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.apiKey]     defaults to process.env.ANTHROPIC_API_KEY
 * @param {string} [opts.model]      defaults to claude-sonnet-5
 * @param {number} [opts.maxTokens]  defaults to 2048
 * @param {boolean} [opts.thinking]  extended thinking; defaults to false
 * @param {string} [opts.label]      names this call in error messages
 * @param {number} [opts.attempts]   total tries including the first; default 4
 * @param {Function} [opts.fetchImpl] injectable for tests
 * @returns {Promise<string>}
 */
export async function callClaude(prompt, opts = {}) {
  const {
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = CLAUDE_SONNET,
    maxTokens = 2048,
    thinking = false,
    label = "claude",
    attempts = 4,
    baseDelayMs = 2_000,
    maxRetryDelayMs = 30_000,
    fetchImpl = globalThis.fetch,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    onRetry = ({ attempt, attempts: total, delayMs, reason }) =>
      console.warn(`${label}: transient ${reason}; retry ${attempt + 1}/${total} in ${delayMs}ms`),
  } = opts;

  if (!apiKey) throw new Error(`${label}: ANTHROPIC_API_KEY not set`);

  const request = {
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
  };

  const boundedAttempts = Math.max(1, Math.trunc(attempts));
  let res;
  let data;

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      res = await fetchImpl(API_URL, request);
      data = await res.json().catch(() => null);

      if (res.ok || !isTransientStatus(res.status) || attempt === boundedAttempts) break;

      // Retry-After may only *lengthen* the wait. The API answers 529 with
      // `retry-after: 0`, and taking that literally retried three times inside
      // one millisecond — three guaranteed failures dressed up as three tries,
      // which is how San José carried forward four runs straight on 2026-08-27.
      const delayMs = Math.min(
        Math.max(retryAfterMs(res) ?? 0, baseDelayMs * 2 ** (attempt - 1)),
        maxRetryDelayMs,
      );
      onRetry({ attempt, attempts: boundedAttempts, delayMs, reason: res.status });
      await sleep(delayMs);
    } catch (error) {
      if (attempt === boundedAttempts) throw error;
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxRetryDelayMs);
      onRetry({
        attempt,
        attempts: boundedAttempts,
        delayMs,
        reason: error?.name || "network error",
      });
      await sleep(delayMs);
    }
  }

  if (!res.ok) {
    const detail = data?.error?.message ? ` — ${data.error.message}` : "";
    throw new Error(`${label}: Claude API error ${res.status}${detail}`);
  }

  // A response that stopped at the token ceiling is truncated mid-sentence even
  // when a text block is present, and every caller here parses the result as
  // JSON — so the caller sees "no JSON in response" or a parse error that names
  // neither the API nor the real cause. generate-digests spent seven weeks
  // republishing a stale Campbell digest on exactly this: thinking ate most of
  // a 512-token budget, the JSON came back with no closing brace, and the
  // failure was swallowed by a carry-forward fallback. Name it here instead.
  if (data?.stop_reason === "max_tokens") {
    throw new Error(
      `${label}: response hit the ${maxTokens}-token ceiling and is truncated — raise maxTokens`,
    );
  }

  const text = extractText(data?.content);
  if (!text) {
    // Name the cause. The old code failed here with an undefined-property
    // TypeError that told the operator nothing.
    const types = (data?.content ?? []).map((c) => c?.type).join(", ") || "none";
    throw new Error(
      `${label}: no text block in response (stop_reason=${data?.stop_reason ?? "?"}, blocks=[${types}])`,
    );
  }

  return text;
}
