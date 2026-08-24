// Decision logic for the daily photoRef sentinel (scripts/check-photoref-health.mjs).
//
// The point of the sentinel is to catch photoRefs that Google has quietly
// expired, which shows up as a permanent 4xx on the media endpoint. It is NOT
// meant to page on timeouts: those say something about the machine or the link
// to Google, not about the refs, and the remedy the alert prescribes (a full
// --force refresh) does nothing for them.
//
// Kept separate from the script so the classification is unit-testable without
// network or an API key.

import { isTransientSourceError } from "./event-source-health.mjs";

const TRANSIENT_STATUSES = new Set([408, 425, 429]);

/** Statuses that mean "try again later", not "this ref is dead". */
export function isTransientStatus(status) {
  return TRANSIENT_STATUSES.has(status) || status >= 500;
}

/**
 * Bucket one probe into ok / stale / unreachable.
 *
 * stale       - Google answered with a permanent client error. The ref is bad.
 * unreachable - timeout, DNS, socket, or a still-transient status after retries.
 *               Environmental; says nothing about the ref.
 */
export function classifyPhotoRefResult({ status = null, error = null } = {}) {
  if (error) {
    return isTransientSourceError(error) ? "unreachable" : "stale";
  }
  if (status === null) return "unreachable";
  if (status >= 200 && status < 300) return "ok";
  return isTransientStatus(status) ? "unreachable" : "stale";
}

export function summarize(results) {
  const counts = { ok: 0, stale: 0, unreachable: 0 };
  for (const r of results) counts[r.kind] += 1;
  return { ...counts, total: results.length };
}

// A handful of timeouts is normal background noise on a busy machine; only a
// broadly unreachable Google is worth a message, and it gets its own wording.
export const STALE_THRESHOLD = 0.10;
export const UNREACHABLE_THRESHOLD = 0.50;

/**
 * Decide what (if anything) to alert on.
 *
 * Stale wins over unreachable: a real expiration is the thing we built this to
 * catch, and it should not be masked by a noisy network. Unreachable alerts use
 * a separate cooldown key so an unhealthy Mini cannot suppress a later genuine
 * stale-ref page.
 */
export function decideAlert(counts, {
  staleThreshold = STALE_THRESHOLD,
  unreachableThreshold = UNREACHABLE_THRESHOLD,
} = {}) {
  const total = counts.total || 0;
  if (total === 0) return { kind: "none" };

  if (counts.stale / total > staleThreshold) {
    return { kind: "stale", stale: counts.stale, total };
  }
  if (counts.unreachable / total > unreachableThreshold) {
    return { kind: "unreachable", unreachable: counts.unreachable, total };
  }
  return { kind: "none" };
}
