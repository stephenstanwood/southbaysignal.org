#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectEventRefreshOutput } from "./event-refresh-health.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const outputPath = process.env.SBT_EVENTS_OUTPUT_PATH
  || join(moduleDir, "..", "..", "src", "data", "south-bay", "upcoming-events.json");

function numericArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number`);
  return value;
}

let data = null;
try { data = JSON.parse(readFileSync(outputPath, "utf8")); } catch { /* reported below */ }

const health = inspectEventRefreshOutput({
  data,
  maxAgeHours: numericArg("--max-age-hours", 30),
  snapshotMaxAgeHours: numericArg("--snapshot-max-age-hours", 30),
});

// Non-blocking venue smells: records whose venue is just their source name and
// that carry no address. Most are legitimate (a library program at the library)
// but this is the population the 2026-09-03 wrong-venue defects sat in, so the
// count stays visible in every nightly log rather than needing a hand-run.
const locationWarnings = health.locationWarnings || [];
if (locationWarnings.length > 0) {
  console.warn(`[events-output-health] ${locationWarnings.length} venue warning(s) (not blocking):`);
  for (const warning of locationWarnings.slice(0, 10)) console.warn(`  · ${warning}`);
  if (locationWarnings.length > 10) {
    console.warn(`  · …and ${locationWarnings.length - 10} more`);
  }
}

if (!health.ok) {
  console.error(`[events-output-health] BLOCKED: ${health.problems.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log(`[events-output-health] healthy: ${health.eventCount} events across ${health.sourceCount} adapters`);
}
