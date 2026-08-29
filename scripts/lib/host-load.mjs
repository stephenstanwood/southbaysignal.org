import { cpus, loadavg } from "node:os";

/**
 * A saturated host looks exactly like a mass source outage. Every `page.goto`
 * burns its full timeout budget and returns zero rows, so the coverage gate
 * reports "22→17 sources" and Discord says the sources are down.
 *
 * On 2026-08-29 that reading was wrong in both directions: 23 leaked plugin
 * processes held ~9 of the Mini's 10 cores (load average 84), while the
 * "down" venues answered curl with a 200 in under half a second. The refresh
 * had no way to say so, so the alert sent the reader hunting through adapters
 * that were never broken.
 *
 * These helpers attach the host's own state to that error. They never change
 * whether the run fails — the fail-closed gate is unchanged — they only make
 * the resulting message point at the right machine.
 */

/** Load-per-core above which the host, not the network, is the likely story. */
export const SATURATION_RATIO = 2;

/** Below this many failures the timeout share is noise, not a pattern. */
const MIN_FAILURES_FOR_PATTERN = 3;

export function hostLoad({ load1, cores } = {}) {
  const resolvedCores = Number(cores ?? cpus().length) || 1;
  const resolvedLoad = Number(load1 ?? loadavg()[0]) || 0;
  return {
    load1: resolvedLoad,
    cores: resolvedCores,
    ratio: resolvedLoad / resolvedCores,
  };
}

/** Playwright reports contention as `page.goto`/`waitForSelector` timeouts. */
export function countNavigationTimeouts(sourceHealth = []) {
  const failures = sourceHealth.filter((health) => health?.error);
  const timeouts = failures.filter((health) => /timeout/i.test(String(health.error)));
  return { failures: failures.length, timeouts: timeouts.length };
}

/**
 * Build the diagnostic suffix for a coverage-regression error. Returns "" when
 * there is nothing worth saying, so the caller can append it unconditionally.
 */
export function describeRefreshFailureContext({ sourceHealth = [], load = hostLoad() } = {}) {
  const { failures, timeouts } = countNavigationTimeouts(sourceHealth);
  const saturated = load.ratio >= SATURATION_RATIO;
  const timeoutDominated = failures >= MIN_FAILURES_FOR_PATTERN && timeouts / failures >= 0.5;

  const parts = [
    `host load ${load.load1.toFixed(2)} over ${load.cores} core(s)`
    + ` (${load.ratio.toFixed(1)}× per-core)`,
  ];
  if (failures) parts.push(`${timeouts}/${failures} source error(s) were timeouts`);

  if (saturated && timeoutDominated) {
    parts.push(
      "this host was saturated and most sources timed out rather than failing —"
      + " check local CPU contention before touching any adapter",
    );
  } else if (saturated) {
    parts.push("this host was saturated; treat source counts as unreliable");
  }

  return ` — ${parts.join("; ")}`;
}
