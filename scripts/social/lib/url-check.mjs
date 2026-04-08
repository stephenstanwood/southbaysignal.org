// ---------------------------------------------------------------------------
// South Bay Signal — URL Validation
// Verifies URLs are specific, reachable, and not generic homepages
// ---------------------------------------------------------------------------

import { logStep, logSkip, logError } from "./logger.mjs";

// Patterns that indicate a generic homepage / useless landing
const HOMEPAGE_PATTERNS = [
  /^https?:\/\/[^/]+\/?$/,                    // bare domain
  /^https?:\/\/www\.[^/]+\/?$/,               // www + bare domain
  /legistar\.com\/Calendar\.aspx/,            // Legistar calendar index
  /municodemeetings\.com\/?$/,                 // MuniCode home
];

// URL patterns that are always too ugly for social
const UGLY_URL_PATTERNS = [
  /%2F/i,                                      // encoded slashes
  /Calendar\.aspx\?From=/,                     // Legistar date params
];

// Signals in page body that the event is dead.
// Patterns must be specific enough to avoid false positives from
// unrelated page text (cancellation policies, past tense mentions, etc.)
const CANCELLATION_PATTERNS = [
  /this event (is|has been) cancel/i,
  /event (is|has been) cancel/i,
  /event.{0,10}(is|has been) postponed/i,
  /EventCancelled/,                             // schema.org structured data
  /event-notification-cancell/i,                // common CSS class pattern
  /\bno longer (taking place|happening)\b/i,
];

/**
 * Check if a URL is specific enough for social posting.
 * Returns { ok: boolean, reason?: string, url: string }
 */
export function isUrlSpecific(url) {
  if (!url || url.trim() === "") {
    return { ok: false, reason: "no URL provided", url: "" };
  }

  for (const pattern of HOMEPAGE_PATTERNS) {
    if (pattern.test(url)) {
      return { ok: false, reason: `generic homepage: ${url}`, url };
    }
  }

  for (const pattern of UGLY_URL_PATTERNS) {
    if (pattern.test(url)) {
      return { ok: false, reason: `ugly/unusable URL: ${url}`, url };
    }
  }

  return { ok: true, url };
}

/**
 * Fetch a URL and check if it returns a valid response.
 * Also reads the page body to detect cancellation notices.
 * Returns { ok: boolean, status?: number, reason?: string }
 */
export async function isUrlReachable(url, timeout = 8000) {
  if (!url) return { ok: false, reason: "no URL" };

  try {
    // Always GET (not HEAD) so we can read the body for cancellation signals
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeout),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SouthBayToday/1.0)",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    }

    // Read body and check for cancellation signals
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html") || contentType.includes("text/plain")) {
      const body = await res.text();
      // Scan whole body — cancellation notices can be deep in the page
      const snippet = body;
      for (const pattern of CANCELLATION_PATTERNS) {
        if (pattern.test(snippet)) {
          return { ok: false, status: res.status, reason: `page says event is canceled/postponed` };
        }
      }
    }

    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Full URL validation: check specificity + reachability.
 * Returns { ok: boolean, reason?: string, url: string }
 */
export async function validateUrl(url) {
  const specific = isUrlSpecific(url);
  if (!specific.ok) return specific;

  const reachable = await isUrlReachable(url);
  if (!reachable.ok) {
    return { ok: false, reason: reachable.reason, url };
  }

  return { ok: true, url };
}

/**
 * Filter a list of candidate items, keeping only those with valid URLs.
 * Logs skipped items.
 */
export async function filterByUrl(candidates) {
  const results = [];
  const skipped = [];

  for (const item of candidates) {
    const check = await validateUrl(item.url);
    if (check.ok) {
      results.push(item);
    } else {
      skipped.push({ title: item.title, reason: check.reason });
      logSkip(`URL rejected: ${item.title} — ${check.reason}`);
    }

    // Small delay to be polite
    await new Promise((r) => setTimeout(r, 200));
  }

  if (skipped.length > 0) {
    logStep("🔗", `URL check: ${results.length} passed, ${skipped.length} skipped`);
  }

  return results;
}
