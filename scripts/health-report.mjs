#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Signal — Artifact Health Report
// ---------------------------------------------------------------------------
// Checks freshness, item counts, and coverage for all generated artifacts.
// Usage: node scripts/health-report.mjs [--json]
//
// Outputs a summary to stdout. With --json, outputs machine-readable JSON.

import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data", "south-bay");
const jsonMode = process.argv.includes("--json");

// ---------------------------------------------------------------------------
// Artifact definitions: expected cadence, item count field, structure hints
// ---------------------------------------------------------------------------

const ARTIFACTS = [
  {
    name: "Events",
    file: "upcoming-events.json",
    cadence: "hourly",
    maxStaleHours: 6,
    countFn: (d) => d.eventCount || d.events?.length,
    metaFn: (d) => d.generatedAt,
  },
  {
    name: "Upcoming Meetings",
    file: "upcoming-meetings.json",
    cadence: "hourly",
    maxStaleHours: 12,
    countFn: (d) => {
      if (!d.meetings) return 0;
      // Each city has one meeting object (not an array)
      return Object.values(d.meetings).filter(
        (v) => v && typeof v === "object" && v.date
      ).length;
    },
    metaFn: (d) => d.generatedAt,
  },
  {
    name: "Digests",
    file: "digests.json",
    cadence: "daily",
    maxStaleHours: 48,
    countFn: (d) => Object.keys(d).length,
    metaFn: (d) => {
      // Per-city generatedAt — find the most recent one
      const times = Object.values(d)
        .map((v) => v?.generatedAt)
        .filter(Boolean);
      return times.sort().pop();
    },
  },
  {
    name: "City Briefings",
    file: "city-briefings.json",
    cadence: "daily",
    maxStaleHours: 48,
    countFn: (d) =>
      Array.isArray(d.cities)
        ? d.cities.length
        : typeof d.cities === "object"
          ? Object.keys(d.cities).length
          : d.briefings?.length,
    metaFn: (d) => d.generatedAt,
  },
  {
    name: "Around Town",
    file: "around-town.json",
    cadence: "daily",
    maxStaleHours: 48,
    countFn: (d) => d.items?.length,
    metaFn: (d) => d.generatedAt,
  },
  {
    name: "Restaurant Radar",
    file: "restaurant-radar.json",
    cadence: "daily",
    maxStaleHours: 48,
    countFn: (d) => d.items?.length || 0,
    metaFn: (d) => d.generatedAt,
  },
  {
    name: "SCC Food Openings",
    file: "scc-food-openings.json",
    cadence: "daily",
    maxStaleHours: 48,
    countFn: (d) => (d.opened?.length ?? 0) + (d.inspections?.length ?? 0) + (d.comingSoon?.length ?? 0),
    metaFn: (d) => d.generatedAt,
  },
  {
    name: "Permits",
    file: "permit-pulse.json",
    cadence: "daily",
    maxStaleHours: 48,
    countFn: (d) => {
      if (!d.cities) return 0;
      return Object.values(d.cities).reduce(
        (s, c) => s + (c.permits?.length || 0),
        0
      );
    },
    metaFn: (d) => {
      const times = Object.values(d.cities || {})
        .map((v) => v?.generatedAt)
        .filter(Boolean);
      return times.sort().pop();
    },
  },
  {
    name: "APOD",
    file: "apod.json",
    cadence: "daily",
    maxStaleHours: 48,
    countFn: (d) => d.items?.length,
    metaFn: (d) => d.generatedAt,
  },
  {
    name: "Weekend Picks",
    file: "weekend-picks.json",
    cadence: "weekly",
    maxStaleHours: 168,
    countFn: (d) => d.picks?.length,
    metaFn: (d) => d.generatedAt,
  },
  {
    name: "Spring Break Picks",
    file: "spring-break-picks.json",
    cadence: "seasonal",
    maxStaleHours: 720,
    countFn: (d) => d.picks?.length,
    metaFn: (d) => d.generatedAt,
  },
  {
    name: "Photos",
    file: "photos.json",
    cadence: "daily",
    maxStaleHours: 48,
    countFn: (d) =>
      d.cities
        ? Object.values(d.cities).reduce(
            (s, c) => s + (Array.isArray(c) ? c.length : 0),
            0
          )
        : 0,
    metaFn: (d) => d.generated || d.generatedAt,
  },
  {
    name: "Curated Photos",
    file: "curated-photos.json",
    cadence: "daily",
    maxStaleHours: 48,
    countFn: (d) => d.photos?.length,
    metaFn: (d) => d.generatedAt || d.generated,
  },
  {
    name: "Short URLs",
    file: "short-urls.json",
    cadence: "on-demand",
    maxStaleHours: null,
    countFn: (d) => Object.keys(d).length,
    metaFn: () => null, // No timestamp — on-demand
  },
];

// ---------------------------------------------------------------------------
// Cities we expect coverage for
// ---------------------------------------------------------------------------

const EXPECTED_CITIES = [
  "campbell",
  "cupertino",
  "los-altos",
  "los-gatos",
  "milpitas",
  "mountain-view",
  "palo-alto",
  "san-jose",
  "santa-clara",
  "saratoga",
  "sunnyvale",
];

// ---------------------------------------------------------------------------
// Run report
// ---------------------------------------------------------------------------

function hoursAgo(isoStr) {
  if (!isoStr) return null;
  return (Date.now() - new Date(isoStr).getTime()) / 3600000;
}

function formatAge(hours) {
  if (hours === null) return "unknown";
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const results = [];

for (const artifact of ARTIFACTS) {
  const filePath = join(DATA_DIR, artifact.file);
  const entry = {
    name: artifact.name,
    file: artifact.file,
    cadence: artifact.cadence,
    exists: false,
    generatedAt: null,
    ageHours: null,
    stale: false,
    itemCount: null,
    fileSizeKB: null,
    warnings: [],
  };

  try {
    const stat = statSync(filePath);
    entry.exists = true;
    entry.fileSizeKB = Math.round(stat.size / 1024);

    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    entry.generatedAt = artifact.metaFn(data) || null;
    entry.ageHours = hoursAgo(entry.generatedAt);
    entry.itemCount = artifact.countFn(data) ?? null;

    if (entry.itemCount === 0 && !artifact.emptyOk) {
      entry.warnings.push("empty (0 items)");
    }

    if (
      artifact.maxStaleHours &&
      entry.ageHours !== null &&
      entry.ageHours > artifact.maxStaleHours
    ) {
      entry.stale = true;
      entry.warnings.push(`stale (>${artifact.maxStaleHours}h)`);
    }

    if (!entry.generatedAt && artifact.cadence !== "on-demand") {
      entry.warnings.push("no generatedAt timestamp");
    }

    // City coverage check for applicable artifacts
    if (artifact.file === "digests.json") {
      const coveredCities = Object.keys(data);
      const missing = EXPECTED_CITIES.filter((c) => !coveredCities.includes(c));
      if (missing.length) {
        entry.warnings.push(`missing cities: ${missing.join(", ")}`);
      }
    }
    if (artifact.file === "upcoming-meetings.json" && data.meetings) {
      const coveredCities = Object.keys(data.meetings).filter(
        (c) => data.meetings[c]?.date
      );
      const health = data.sourceHealth ?? {};
      // A city with no meeting is only worth reporting as a defect when its
      // source actually failed. Councils genuinely recess (most of the South Bay
      // goes dark in August), so lumping recess in with broken scrapers trained
      // us to ignore this line — Campbell's agenda feed sat frozen for 302 days
      // behind a benign-looking "missing cities" warning.
      const broken = Object.entries(health).filter(([, s]) => s?.status === "error");
      if (broken.length) {
        for (const [city, s] of broken) {
          entry.warnings.push(`source broken — ${city} (${s.provider}): ${s.detail}`);
        }
      }
      const missing = EXPECTED_CITIES.filter(
        (c) => !coveredCities.includes(c) && health[c]?.status !== "error"
      );
      if (missing.length) {
        const label = Object.keys(health).length
          ? "no meeting on the calendar"
          : "missing cities";
        entry.warnings.push(`${label}: ${missing.join(", ")}`);
      }
    }
  } catch (err) {
    entry.warnings.push(`read error: ${err.message}`);
  }

  results.push(entry);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        reportGeneratedAt: new Date().toISOString(),
        artifacts: results,
        summary: {
          total: results.length,
          stale: results.filter((r) => r.stale).length,
          warnings: results.filter((r) => r.warnings.length > 0).length,
          missing: results.filter((r) => !r.exists).length,
        },
      },
      null,
      2
    )
  );
} else {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║            South Bay Signal — Artifact Health Report        ║");
  console.log(
    `║            ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}                ║`
  );
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const maxNameLen = Math.max(...results.map((r) => r.name.length));

  for (const r of results) {
    const status = !r.exists
      ? "❌ MISSING"
      : r.stale
        ? "⚠️  STALE "
        : r.warnings.length > 0
          ? "⚡ WARN  "
          : "✅ OK    ";

    const age = r.ageHours !== null ? formatAge(r.ageHours) : "no timestamp";
    const count = r.itemCount !== null ? `${r.itemCount} items` : "";
    const size = r.fileSizeKB !== null ? `${r.fileSizeKB}KB` : "";

    console.log(
      `${status} ${r.name.padEnd(maxNameLen)}  ${age.padEnd(10)} ${count.padEnd(12)} ${size}`
    );

    if (r.warnings.length > 0) {
      for (const w of r.warnings) {
        console.log(`${"".padEnd(11)}${"".padEnd(maxNameLen)}  └─ ${w}`);
      }
    }
  }

  const staleCount = results.filter((r) => r.stale).length;
  const warnCount = results.filter((r) => r.warnings.length > 0).length;
  const missingCount = results.filter((r) => !r.exists).length;

  console.log(`\n─── Summary ───`);
  console.log(`Total: ${results.length} artifacts`);
  if (missingCount) console.log(`Missing: ${missingCount}`);
  if (staleCount) console.log(`Stale: ${staleCount}`);
  if (warnCount) console.log(`With warnings: ${warnCount}`);
  if (!missingCount && !staleCount && !warnCount) console.log("All artifacts healthy.");
  console.log();
}
