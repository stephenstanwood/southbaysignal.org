// Shared fetch helpers for generate-*.mjs scripts.
// Single User-Agent string + timeout defaults so all scraping is consistent
// and polite (see API Etiquette in CLAUDE.md).

export const UA = "SouthBaySignal/1.0 (stanwood.dev; public event aggregator)";

const TRANSIENT_STATUSES = new Set([408, 425, 429]);

function isTransientStatus(status) {
  return TRANSIENT_STATUSES.has(status) || status >= 500;
}

function retryAfterMs(response, now = Date.now()) {
  const value = response.headers.get("retry-after");
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function defaultRetryReporter({ attempt, attempts, delayMs, reason }) {
  console.warn(
    `Transient fetch failure (${reason}); retrying ${attempt + 1}/${attempts} in ${delayMs}ms`,
  );
}

/**
 * GET a URL with bounded retries for temporary upstream failures.
 *
 * Permanent 4xx responses return immediately. Each retry receives a fresh
 * timeout signal, honors Retry-After when present, and caps the wait so a
 * scheduled refresh cannot hang indefinitely.
 */
export async function fetchWithRetry(
  url,
  {
    timeout = 20_000,
    headers = {},
    attempts = 3,
    baseDelayMs = 500,
    maxRetryDelayMs = 30_000,
    fetchImpl = globalThis.fetch,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    onRetry = defaultRetryReporter,
  } = {},
) {
  const boundedAttempts = Math.max(1, Math.trunc(attempts));

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });

      if (!isTransientStatus(response.status) || attempt === boundedAttempts) {
        return response;
      }

      // Retry-After may only *lengthen* the wait, never shorten it below our
      // own backoff — a server answering `retry-after: 0` under load would
      // otherwise get every remaining attempt fired at it inside a millisecond.
      const delayMs = Math.min(
        Math.max(retryAfterMs(response) ?? 0, baseDelayMs * 2 ** (attempt - 1)),
        maxRetryDelayMs,
      );
      await response.body?.cancel().catch(() => {});
      onRetry({ attempt, attempts: boundedAttempts, delayMs, reason: response.status });
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

  throw new Error("fetch retry loop exhausted");
}

export async function fetchJson(url, { timeout = 15_000, headers = {}, ...retry } = {}) {
  const res = await fetchWithRetry(url, {
    timeout,
    headers: { "User-Agent": UA, Accept: "application/json", ...headers },
    ...retry,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function fetchText(url, { timeout = 20_000, headers = {}, ...retry } = {}) {
  const res = await fetchWithRetry(url, {
    timeout,
    headers: { "User-Agent": UA, ...headers },
    ...retry,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}
