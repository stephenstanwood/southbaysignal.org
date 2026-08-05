#!/usr/bin/env node
// ---------------------------------------------------------------------------
// backfill-virtual-flag-2026-08-05.mjs
//
// One-time heal for events already sitting in upcoming-events.json without a
// `virtual` flag because the ingest only ever inferred it from title and
// description text.
//
// The 2026-08-05 newsletter ran SJSU's "Collegiate Recovery Community (CRC)
// All Recovery Meeting" as its afternoon field-guide pick, paired with a lunch
// recommendation, inside a lede promising "three self-contained pairings."
// events.sjsu.edu lists that meeting as VIRTUAL. Nothing in its title or blurb
// says so, so no regex could catch it. generate-events.mjs now reads each
// platform's own location-type field, but the events already in the committed
// feed predate that and still render a campus venue with a map link.
//
// Reads the same authoritative endpoints the ingest now uses:
//   SJSU + Stanford (Localist)  /api/2/events  → experience
//   SCU (LiveWhale)             /live/json/events → online_type / is_online
//
// Sets `virtual: true` only. Never clears an existing flag, never edits any
// other field, and never touches events-archive.json — the archive backs the
// already-sent /newsletters/2026-08-05 issue and sent issues are immutable.
//
// Usage: node scripts/oneoff/backfill-virtual-flag-2026-08-05.mjs [--dry-run]
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "../lib/io.mjs";
import { fetchJson } from "../lib/http.mjs";
import { virtualFromSourceSignal } from "../../src/lib/south-bay/eventFilters.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UPCOMING = join(ROOT, "src", "data", "south-bay", "upcoming-events.json");
const dryRun = process.argv.includes("--dry-run");

function todayPT() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

async function localistExperienceMap(origin) {
  const map = new Map();
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, 12); page++) {
    const data = await fetchJson(
      `${origin}/api/2/events?start=${todayPT()}&days=370&pp=100&page=${page}`,
      { timeout: 30_000 },
    );
    pages = data?.page?.total ?? 1;
    for (const wrapper of data?.events ?? []) {
      const ev = wrapper?.event;
      if (!ev?.localist_url || !ev.experience) continue;
      map.set(ev.localist_url.replace(/\/+$/, ""), ev.experience);
    }
  }
  return map;
}

async function liveWhaleOnlineMap(origin) {
  const map = new Map();
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, 14); page++) {
    const data = await fetchJson(`${origin}/live/json/events?page=${page}`, { timeout: 30_000 });
    pages = data?.meta?.total_pages ?? 1;
    for (const ev of data?.data ?? []) {
      if (ev?.id === undefined || ev?.id === null) continue;
      const signal = ev.online_type ?? (ev.is_online ? "Online only" : null);
      if (signal === null) continue;
      map.set(String(ev.id), signal);
    }
  }
  return map;
}

const liveWhaleId = (url) => (String(url || "").match(/\/event\/(\d+)\b/) || [])[1] ?? null;
const normalizeUrl = (url) => String(url || "").replace(/\/+$/, "");

const [sjsu, stanford, scu] = await Promise.all([
  localistExperienceMap("https://events.sjsu.edu"),
  localistExperienceMap("https://events.stanford.edu"),
  liveWhaleOnlineMap("https://events.scu.edu"),
]);
console.log(
  `location types: SJSU ${sjsu.size}, Stanford ${stanford.size}, SCU ${scu.size}`,
);

// Only the three feeds this heal has an authoritative lookup for. Library
// events already carry BiblioCommons' isVirtual; every other source keeps
// whatever the text pass decided.
function sourceSignal(event) {
  switch (event.source) {
    case "SJSU Events":
      return sjsu.get(normalizeUrl(event.url));
    case "Stanford Events":
      return stanford.get(normalizeUrl(event.url));
    case "Santa Clara University":
      return scu.get(liveWhaleId(event.url));
    default:
      return undefined;
  }
}

const data = JSON.parse(readFileSync(UPCOMING, "utf8"));
const healed = [];
for (const event of data.events ?? []) {
  if (event.virtual === true) continue;
  if (virtualFromSourceSignal(sourceSignal(event)) !== true) continue;
  event.virtual = true;
  healed.push(event);
}

console.log(`\n${healed.length} event(s) flagged virtual from their source:`);
for (const e of healed) {
  console.log(`  ${e.date} ${e.time ?? "(no time)"} | ${e.source} | ${e.title}`);
}

if (!healed.length) {
  console.log("\nnothing to heal");
} else if (dryRun) {
  console.log("\n--dry-run: no file written");
} else {
  writeFileAtomic(UPCOMING, JSON.stringify(data, null, 2) + "\n");
  console.log(`\nwrote ${UPCOMING}`);
}
