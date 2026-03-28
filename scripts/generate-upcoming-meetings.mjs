#!/usr/bin/env node
/**
 * generate-upcoming-meetings.mjs
 *
 * Queries the Legistar Web API (free, no auth) for each South Bay city's
 * next scheduled council meeting and writes the results to
 * src/data/south-bay/upcoming-meetings.json.
 *
 * Run: node scripts/generate-upcoming-meetings.mjs
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "upcoming-meetings.json");

const UA = "SouthBaySignal/1.0 (stanwood.dev; public civic data aggregator)";

const LEGISTAR_CITIES = [
  { city: "san-jose",      client: "sanjose",      body: "City Council" },
  { city: "mountain-view", client: "mountainview",  body: "City Council" },
  { city: "sunnyvale",     client: "sunnyvaleca",   body: "City Council" },
  { city: "cupertino",     client: "cupertino",     body: "City Council" },
  { city: "santa-clara",   client: "santaclara",    body: "City Council" },
];

async function fetchNextMeeting(city, client, body) {
  const today = new Date().toISOString().split("T")[0];
  const url =
    `https://webapi.legistar.com/v1/${client}/Events` +
    `?$filter=EventBodyName eq '${body}' and EventDate gt datetime'${today}T00:00:00'` +
    `&$orderby=EventDate asc&$top=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const events = await res.json();
  if (!events.length) return null;

  const ev = events[0];
  const date = new Date(ev.EventDate);

  // Skip placeholder dates more than 60 days out (common Legistar calendar blocker)
  const daysOut = (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysOut > 60) return null;

  return {
    date: date.toISOString().split("T")[0],
    displayDate: date.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      timeZone: "America/Los_Angeles",
    }),
    bodyName: ev.EventBodyName,
    location: ev.EventLocation || null,
    url: `https://${client}.legistar.com/MeetingDetail.aspx?ID=${ev.EventId}&GUID=${ev.EventGuid}`,
    legistarEventId: ev.EventId,
  };
}

async function main() {
  console.log("Fetching upcoming council meetings from Legistar...\n");

  const meetings = {};

  for (const { city, client, body } of LEGISTAR_CITIES) {
    process.stdout.write(`  ⏳ ${city}...`);
    try {
      const next = await fetchNextMeeting(city, client, body);
      if (next) {
        meetings[city] = next;
        console.log(` ✅ ${next.displayDate}`);
      } else {
        console.log(` — none scheduled`);
      }
    } catch (err) {
      console.log(` ⚠️  ${err.message}`);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    meetings,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  const count = Object.keys(meetings).length;
  console.log(`\n✅ Done — ${count} cities with upcoming meetings → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
