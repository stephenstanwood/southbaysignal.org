// Shared fetch helpers for generate-*.mjs scripts.
// Single User-Agent string + timeout defaults so all scraping is consistent
// and polite (see API Etiquette in CLAUDE.md).

export const UA = "SouthBaySignal/1.0 (stanwood.dev; public event aggregator)";

export async function fetchJson(url, { timeout = 15_000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function fetchText(url, { timeout = 20_000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}
