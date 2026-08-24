/**
 * Read policy for the inbound event shards.
 *
 * pull-inbound-events reads one Vercel Blob shard per intake email — 860+ of
 * them as of 2026-08, and the count only grows. Under SBT_STRICT_EVENT_REFRESH
 * the script threw on *any* shard error, so three transient `fetch failed`
 * reads out of 860 aborted the entire nightly refresh (2026-08-23/24) after the
 * 40-minute Playwright stage had already written 623 good events. Bounded
 * concurrency and retries made that rarer, but "one unreachable shard kills the
 * run" was still the policy, and the scrape is far too expensive to throw away
 * over a 0.35% read blip.
 *
 * So: a *subset* of unreachable shards degrades — write what we have, warn
 * loudly. A *systemic* failure still blocks, because that is indistinguishable
 * from the inbound source going dark, and the downstream coverage guards in
 * pull-inbound-events only notice once the loss is already enormous.
 *
 * The shard *list* is a separate case and always blocks: without it we cannot
 * enumerate the shard universe, so a failure there silently undercounts rather
 * than reporting a subset we can measure.
 */

export const MAX_SHARD_FAILURE_RATIO = 0.05;
export const MIN_TOLERATED_SHARD_FAILURES = 2;

/**
 * How many unreadable shards to absorb before treating the run as systemic.
 * The floor keeps a handful of shards from making every blip fatal; the ratio
 * keeps a real outage from hiding behind a large shard count.
 */
export function toleratedShardFailures(shardTotal) {
  if (!Number.isFinite(shardTotal) || shardTotal <= 0) return 0;
  return Math.max(
    MIN_TOLERATED_SHARD_FAILURES,
    Math.floor(shardTotal * MAX_SHARD_FAILURE_RATIO),
  );
}

function sample(errors) {
  const shown = errors.slice(0, 3).join("; ");
  return errors.length > 3 ? `${shown}; +${errors.length - 3} more` : shown;
}

/**
 * Classify one inbound read into blocking problems and non-fatal warnings.
 *
 * @param {object} input
 * @param {string|null} input.listError    shard listing failure, if any
 * @param {number} input.shardTotal        shards enumerated by the listing
 * @param {string[]} input.shardErrors     shards that failed every attempt
 * @param {string|null} input.legacyError  legacy monolithic blob failure, if any
 * @returns {{ blocking: string[], warnings: string[] }}
 */
export function inboundReadProblems({
  listError = null,
  shardTotal = 0,
  shardErrors = [],
  legacyError = null,
} = {}) {
  const blocking = [];
  const warnings = [];

  if (listError) {
    blocking.push(`inbound shard list failed: ${listError}`);
  }

  const allowed = toleratedShardFailures(shardTotal);
  if (shardErrors.length > allowed) {
    blocking.push(
      `inbound shards unreadable: ${shardErrors.length}/${shardTotal} failed after retries ` +
        `(tolerating ${allowed}) — ${sample(shardErrors)}`,
    );
  } else if (shardErrors.length > 0) {
    warnings.push(
      `inbound shards degraded: ${shardErrors.length}/${shardTotal} unreadable after retries ` +
        `(within the ${allowed} tolerated) — ${sample(shardErrors)}`,
    );
  }

  // The legacy monolithic blob is a retiring fallback that shards have already
  // superseded. Losing it is worth saying out loud, never worth a page: if it
  // still held anything material, the coverage-regression guard catches it.
  if (legacyError) {
    warnings.push(`legacy inbound blob unreadable: ${legacyError}`);
  }

  return { blocking, warnings };
}
