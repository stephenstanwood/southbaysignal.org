#!/usr/bin/env node
/**
 * generate-outages.mjs
 *
 * Fetches active PG&E power outages in Santa Clara County from PG&E's
 * ArcGIS REST API and writes them to src/data/south-bay/outages.json.
 *
 * Run: node scripts/generate-outages.mjs
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "outages.json");

const PGE_URL =
  "https://ags.pge.esriemcs.com/arcgis/rest/services/43/outages/MapServer/5/query";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "SouthBaySignal/1.0 (southbaysignal.org; public data)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function titleCase(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function main() {
  console.log("Fetching PG&E outages for Santa Clara County…");

  const params = new URLSearchParams({
    where: "COUNTY='Santa Clara'",
    outFields: "OUTAGE_CAUSE,EST_CUSTOMERS,CITY,COUNTY,OUTAGE_START,CURRENT_ETOR_TEXT,CREW_CURRENT_STATUS",
    f: "pjson",
  });

  let data;
  try {
    data = await fetchJson(`${PGE_URL}?${params}`);
  } catch (err) {
    console.error("PG&E API error:", err.message);
    // Write empty outages rather than crashing the builder
    writeFileSync(
      OUT_PATH,
      JSON.stringify({ outages: [], generatedAt: new Date().toISOString(), error: err.message }, null, 2) + "\n",
    );
    return;
  }

  const features = data.features ?? [];
  console.log(`  ${features.length} active outage(s) found`);

  const outages = features.map((f) => {
    const a = f.attributes;
    // OUTAGE_START is a Unix timestamp in milliseconds
    const startMs = a.OUTAGE_START;
    const startIso = startMs ? new Date(startMs).toISOString() : null;

    return {
      city: titleCase(a.CITY ?? ""),
      county: a.COUNTY ?? "Santa Clara",
      customers: a.EST_CUSTOMERS ? Math.round(a.EST_CUSTOMERS) : null,
      cause: a.OUTAGE_CAUSE ?? null,
      startedAt: startIso,
      etor: a.CURRENT_ETOR_TEXT ?? null,       // estimated time of restoration
      crewStatus: a.CREW_CURRENT_STATUS ?? null,
    };
  }).sort((a, b) => (b.customers ?? 0) - (a.customers ?? 0));

  const totalCustomers = outages.reduce((sum, o) => sum + (o.customers ?? 0), 0);

  const output = {
    outages,
    totalOutages: outages.length,
    totalCustomers,
    generatedAt: new Date().toISOString(),
    source: "PG&E Outage Map",
    sourceUrl: "https://pgealerts.alerts.pge.com/outagecenter/",
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ ${outages.length} outage(s), ${totalCustomers} customers affected`);
  outages.forEach((o) =>
    console.log(`  • ${o.city}: ${o.customers ?? "?"} customers — ${o.cause ?? "unknown cause"} — ERT: ${o.etor ?? "TBD"}`)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
