#!/usr/bin/env node
/**
 * generate-weekend-picks.mjs
 *
 * Reads upcoming-events.json, asks Claude to pick exactly 2 Saturday + 2
 * Sunday standouts, and writes editorial picks to weekend-picks.json.
 *
 * The homepage WeekendAheadCard requires a 2+2 shape; we enforce it
 * structurally by bucketing the candidate pool before asking Claude.
 *
 * Run: node --env-file=.env.local scripts/generate-weekend-picks.mjs
 */

import { readFileSync } from "fs";
import { writeFileAtomic } from "./lib/io.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnvLocal } from "./lib/env.mjs";
import { callClaude } from "./lib/claude.mjs";
import { isEventPublishable } from "../src/lib/south-bay/eventOccurrence.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_PATH = join(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "weekend-picks.json");

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// ── Helpers ──

function cityLabel(city) {
  return city.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function getWeekendRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  // Next Friday (or today if it's Fri/Sat/Sun)
  let daysToFri;
  if (day === 5) daysToFri = 0;
  else if (day === 6) daysToFri = -1; // Sat → use yesterday's Fri
  else if (day === 0) daysToFri = -2; // Sun → use 2 days ago Fri
  else daysToFri = 5 - day;           // Mon-Thu → upcoming Fri

  const fri = new Date(now);
  fri.setDate(now.getDate() + daysToFri);
  const sun = new Date(fri);
  sun.setDate(fri.getDate() + 2);

  // Use local date string (en-CA gives YYYY-MM-DD) so start/end match the label's local dates
  const toLocalIso = (d) => d.toLocaleDateString("en-CA");
  return {
    start: toLocalIso(fri),
    end: toLocalIso(sun),
    label: `${fri.toLocaleDateString("en-US", { month: "long", day: "numeric" })} – ${sun.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`,
  };
}

// ── Main ──

function dowOfIso(iso) {
  return new Date(iso + "T12:00:00").getDay();
}

function formatGroup(events, prefix) {
  return events.map((e, i) =>
    `${prefix}${i + 1}. [${e.displayDate || e.date} ${e.time || "all day"}] ${e.title} — ${cityLabel(e.city)}${e.venue ? `, ${e.venue}` : ""} (${e.cost}) — ${(e.description || "").slice(0, 240)}`
  ).join("\n");
}

async function main() {
  const { events } = JSON.parse(readFileSync(EVENTS_PATH, "utf8"));
  const { start, end, label } = getWeekendRange();

  console.log(`Weekend: ${label} (${start} → ${end})`);

  // Filter to Sat/Sun non-ongoing events. Friday is intentionally excluded —
  // the homepage card and the Events strip both describe "the weekend ahead",
  // and mixing Friday picks in starves Sat/Sun of slots.
  const weekend = events.filter(
    (e) => isEventPublishable(e)
      && !e.ongoing
      && e.date >= start
      && e.date <= end
      && (dowOfIso(e.date) === 6 || dowOfIso(e.date) === 0)
  );

  const satEvents = weekend.filter((e) => dowOfIso(e.date) === 6);
  const sunEvents = weekend.filter((e) => dowOfIso(e.date) === 0);

  console.log(`Found ${weekend.length} weekend events (Sat: ${satEvents.length}, Sun: ${sunEvents.length})`);

  if (satEvents.length === 0 && sunEvents.length === 0) {
    writeFileAtomic(OUT_PATH, JSON.stringify({ weekendLabel: label, generatedAt: new Date().toISOString(), picks: [] }, null, 2) + "\n");
    console.log("No weekend events — wrote empty picks.");
    return;
  }

  // Cap each day at 80 to keep prompt reasonable
  const satSample = satEvents.slice(0, 80);
  const sunSample = sunEvents.slice(0, 80);

  const prompt = `You are the editorial voice of South Bay Signal, a local news site for Silicon Valley residents.

The upcoming weekend is ${label}. Here are events happening across the South Bay, grouped by day.

SATURDAY EVENTS (${satSample.length}):
${formatGroup(satSample, "S")}

SUNDAY EVENTS (${sunSample.length}):
${formatGroup(sunSample, "U")}

Rank your top 4 Saturday picks (S-codes) AND top 4 Sunday picks (U-codes), best-first — 8 codes total. We'll take the top 2 from each day in code, falling back to lower-ranked picks only if needed for venue diversity. Prioritize:
- Events that are unique, annual, or rare (not things you can do any weekend)
- Free or affordable events
- Broad appeal across different types of residents
- Venue and city diversity — try to spread your 8 picks across as many distinct venues and cities as possible so the script has real alternatives if the top picks share a venue
- Avoid stacking multiple library-program picks at the same library

Avoid: university admin events, clinical studies, internal community meetings, things open every week (farmers markets are fine if especially notable)

When writing the "why", do NOT invent or guess the day-of-week or time-of-day. If you mention either, copy from the event's bracketed [DayAbbr, Mon D TIME] header verbatim (e.g. "Sat morning", "Sun 7:30 PM"). Never call something a "matinee" unless the time is before 5 PM.

Do NOT invent factual claims not present in the event title or description: composer/author/director attributions, headcounts, edition numbers, founding years, or "first/largest/oldest" superlatives. If a detail isn't in the event text, leave it out.

Each "why" must describe ONLY the event at its own code. Do NOT borrow venue names, performers, or details from other events in the list — even if they're similar or scheduled at the same time.

Return ONLY a JSON array of 8 objects (4 S-codes ranked best-first, then 4 U-codes ranked best-first), no other text:
[
  { "code": "S<n>", "why": "1 sentence under 20 words" },
  { "code": "S<n>", "why": "..." },
  { "code": "S<n>", "why": "..." },
  { "code": "S<n>", "why": "..." },
  { "code": "U<n>", "why": "..." },
  { "code": "U<n>", "why": "..." },
  { "code": "U<n>", "why": "..." },
  { "code": "U<n>", "why": "..." }
]`;

  let rankedCandidates;
  try {
    const raw = await callClaude(prompt, { maxTokens: 2048, label: "weekend-picks" });
    const json = raw.match(/\[[\s\S]*\]/)?.[0];
    if (!json) throw new Error("No JSON array in response");
    rankedCandidates = JSON.parse(json);
  } catch (err) {
    console.error("Claude error:", err.message);
    process.exit(1);
  }

  // Resolve each ranked code to its event, preserving Claude's order. Then walk
  // Sat/Sun candidates separately, taking the top 2 per day that introduce a
  // new venue (and ideally a new city) compared to picks already taken. This
  // is the venue-dedup floor — two SAT picks at the same library is what we're
  // trying to avoid, but we also dedup across days when possible.
  const resolved = rankedCandidates.map(({ code, why }) => {
    const m = typeof code === "string" ? code.match(/^([SU])(\d+)$/i) : null;
    if (!m) {
      console.warn(`  ⚠️  Skipping pick with malformed code: ${JSON.stringify(code)}`);
      return null;
    }
    const prefix = m[1].toUpperCase();
    const idx = parseInt(m[2], 10) - 1;
    const e = prefix === "S" ? satSample[idx] : sunSample[idx];
    if (!e) {
      console.warn(`  ⚠️  Skipping pick with out-of-range code: ${code}`);
      return null;
    }
    return { code, why, day: prefix, event: e };
  }).filter(Boolean);

  const venueKey = (e) => (e.venue || "").toLowerCase().trim();
  const cityKey = (e) => (e.city || "").toLowerCase().trim();

  function pickDay(prefix) {
    const cands = resolved.filter((c) => c.day === prefix);
    const picked = [];
    const seenVenues = new Set([...picked, ...selected].map((p) => venueKey(p.event)).filter(Boolean));
    // Pass 1: require a venue we haven't used in any final pick
    for (const c of cands) {
      if (picked.length >= 2) break;
      const v = venueKey(c.event);
      if (v && seenVenues.has(v)) continue;
      if (picked.some((p) => p.event.id === c.event.id)) continue;
      picked.push(c);
      if (v) seenVenues.add(v);
    }
    // Pass 2 (fallback): fill any remaining slot, allowing venue reuse but
    // skipping exact duplicate events. Logs when we had to relax.
    if (picked.length < 2) {
      for (const c of cands) {
        if (picked.length >= 2) break;
        if (picked.some((p) => p.event.id === c.event.id)) continue;
        console.warn(`  ⚠️  Venue dedup couldn't be satisfied on ${prefix === "S" ? "Sat" : "Sun"} — falling back to ${c.event.title} (${c.event.venue})`);
        picked.push(c);
      }
    }
    return picked;
  }

  const selected = [];
  selected.push(...pickDay("S"));
  selected.push(...pickDay("U"));

  const distinctCities = new Set(selected.map((p) => cityKey(p.event))).size;
  if (distinctCities < selected.length) {
    console.log(`  ℹ️  ${selected.length} picks span ${distinctCities} cities (venue-unique enforced, city overlap allowed).`);
  }

  const output = {
    weekendLabel: label,
    weekendStart: start,
    weekendEnd: end,
    generatedAt: new Date().toISOString(),
    picks: selected.map(({ why, event: e }) => {
      // Validate any bracketed [Day, Mon D TIME] in the why matches this event,
      // then strip ALL brackets — the UI shows displayDate/time separately, so
      // leaving the bracket in produces a duplicate prefix in the rendered card.
      // Claude occasionally pastes a different show's date/time; warn loudly.
      const bracketRe = /\s*\[[^\]]*\]/g;
      let validatedWhy = why;
      const brackets = why?.match(bracketRe) || [];
      for (const b of brackets) {
        const inner = b.replace(/[\[\]]/g, "").trim();
        const expectedDate = (e.displayDate || "").replace(/\./g, "");
        const expectedTime = (e.time || "").replace(/\s+/g, " ").trim();
        const matchesDate = expectedDate && inner.toLowerCase().includes(expectedDate.toLowerCase());
        const matchesTime = expectedTime && inner.toLowerCase().includes(expectedTime.toLowerCase());
        if (!matchesDate && !matchesTime) {
          console.warn(`  ⚠️  Stripped non-matching bracket from "${e.title}": ${b.trim()}`);
        }
      }
      // If Claude bracketed a venue ("Brahms at [Mountain Winery]." or
      // "Fest at [Downtown Campbell] brings…"), strip the preposition together
      // with the bracket. Otherwise the leftover "at." or "at brings" reads broken.
      validatedWhy = validatedWhy.replace(/\s+(?:at|in|on|near|to)\s+\[[^\]]*\]/gi, "");
      validatedWhy = validatedWhy.replace(bracketRe, "");
      // Legacy belt-and-suspenders: catch any dangling " at—" / " at ." that
      // somehow slipped past the combined strip above (e.g. preposition glued to
      // a comma instead of a space before the bracket).
      validatedWhy = validatedWhy.replace(/\s+(at|in|on|near|to)\s*([—–\-,.;!?])/gi, "$2");
      // Collapse accidental word duplications ("venue venue", "the the").
      validatedWhy = validatedWhy.replace(/\b(\w+)\s+\1\b/gi, "$1");
      return {
        id: e.id,
        title: e.title,
        date: e.date,
        displayDate: e.displayDate,
        time: e.time,
        endTime: e.endTime,
        city: e.city,
        venue: e.venue,
        cost: e.cost,
        url: e.url,
        category: e.category,
        // Pre-populate photo refs so the homepage WeekendAheadCard doesn't
        // need to load the full upcoming-events.json (1260+ events) to look
        // up images.
        photoRef: e.photoRef ?? null,
        image: e.image ?? null,
        why: validatedWhy.replace(/\s{2,}/g, " ").trim(),
      };
    }).filter(Boolean),
  };

  const satPicks = output.picks.filter((p) => dowOfIso(p.date) === 6).length;
  const sunPicks = output.picks.filter((p) => dowOfIso(p.date) === 0).length;
  if (satPicks !== 2 || sunPicks !== 2) {
    console.warn(`\n⚠️  Expected 2 Sat + 2 Sun, got ${satPicks} Sat + ${sunPicks} Sun — homepage card will stay hidden until this resolves.`);
  }

  writeFileAtomic(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ ${output.picks.length} picks written to weekend-picks.json (${satPicks} Sat + ${sunPicks} Sun)`);
  output.picks.forEach((p) => console.log(`  • ${p.title} — ${p.why}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
