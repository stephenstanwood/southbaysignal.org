#!/usr/bin/env node
/**
 * generate-city-briefings.mjs
 *
 * Generates a city-specific weekly briefing for each South Bay city.
 * Pulls from upcoming events, around-town highlights, and council agenda
 * items, then uses Claude Sonnet to write a one-sentence editorial lead.
 *
 * Output: src/data/south-bay/city-briefings.json
 *
 * Run: node --env-file=.env.local scripts/generate-city-briefings.mjs
 */

import { readFileSync } from "fs";
import { writeFileAtomic } from "./lib/io.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnvLocal } from "./lib/env.mjs";
import { callClaude as callClaudeApi } from "./lib/claude.mjs";
import {
  hasProspectiveCityHallUpgrade,
  meetingWithinBriefingWindow,
} from "./lib/city-briefing-integrity.mjs";
import {
  hasDownbeatDayLanguage,
  hasRelativeDayReference,
} from "./social/lib/content-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EVENTS_PATH   = join(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");
const AROUND_PATH   = join(__dirname, "..", "src", "data", "south-bay", "around-town.json");
const MEETINGS_PATH = join(__dirname, "..", "src", "data", "south-bay", "upcoming-meetings.json");
const OUT_PATH      = join(__dirname, "..", "src", "data", "south-bay", "city-briefings.json");

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}


const CITIES = [
  { id: "campbell",      name: "Campbell" },
  { id: "cupertino",     name: "Cupertino" },
  { id: "los-gatos",     name: "Los Gatos" },
  { id: "mountain-view", name: "Mountain View" },
  { id: "saratoga",      name: "Saratoga" },
  { id: "sunnyvale",     name: "Sunnyvale" },
  // Accented — matches the canonical registry in src/lib/south-bay/cities.ts,
  // the city's own styling, and every other generated file.
  { id: "san-jose",      name: "San José" },
  { id: "santa-clara",   name: "Santa Clara" },
  { id: "los-altos",     name: "Los Altos" },
  { id: "palo-alto",     name: "Palo Alto" },
  { id: "milpitas",      name: "Milpitas" },
];

// Event `date` fields are Pacific calendar dates, so the window and the label
// printed over it must both be computed in PT. Deriving `start` from
// toISOString() (UTC) while labelling with toLocaleDateString() (local) made the
// two disagree every night the job ran after 5pm PT — the UTC day had already
// rolled over, so a Jul 21–28 window shipped under a "Jul 20 – Jul 27" header.
const TZ = "America/Los_Angeles";

function pacificDateStr(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date);
}

// Anchor at noon UTC so day arithmetic and formatting never cross a DST edge.
function shiftDays(dateStr, days) {
  const dt = new Date(`${dateStr}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().split("T")[0];
}

function labelDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function getWeekRange() {
  const start = pacificDateStr(new Date());
  const end = shiftDays(start, 7);
  return { start, end, label: `${labelDate(start)} – ${labelDate(end)}` };
}

async function callClaude(prompt) {
  const text = await callClaudeApi(prompt, { maxTokens: 800, label: "city-briefings" });
  return text.trim();
}

// Agenda items that carry no news. Council agendas open with procedural
// scaffolding ("Public Participation and Access", "5:30 P.M. SPECIAL COUNCIL
// MEETING (Study Session)", "Adjourn"), so taking agendaItems[0] surfaced
// filler as the week's city-hall highlight while the actual item — Sunnyvale's
// "Eliminate the Use of Chemical Pesticide on City Owned or Leased Property" —
// sat further down the list and only showed up in the summary.
const AGENDA_BOILERPLATE = [
  /^public participation/i,
  /^(call to order|roll call|flag salute|pledge)/i,
  /special council meeting|study session\)?$/i,
  /^(adjourn|recess|closed session)/i,
  /^approve .*minutes/i,
  /^(consent calendar|oral communications|public comment)/i,
  /^(presentations?|proclamations?|ceremonial)/i,
  // These leading `^` anchors miss closed-session procedure that doesn't start
  // with the words: "Convene to Closed Session" led Sunnyvale's week, and
  // Mountain View's only item — "Public Employee Performance Evaluation
  // (California Government Code §54957(b)(1))" — led its own. Neither is
  // something a resident can attend or act on.
  /closed session/i,
  /^public (employee|employment)\b/i,
  /government code\s*§?\s*(?:section\s*)?5495[6-9]/i,
  /^conference with (legal counsel|real property|labor)/i,
  // Standing procedural report slots present on every agenda.
  /^(mayor and )?council(member)?s? (excused absence|travel report)/i,
  /^report (from|of) the (council liaison|city manager|city attorney|mayor)\b/i,
  /^(city )?council travel reports?\b/i,
];

function firstSubstantiveAgendaItem(agendaItems) {
  return agendaItems?.find((a) => a.title && !AGENDA_BOILERPLATE.some((p) => p.test(a.title.trim()))) ?? null;
}

function formatEventDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? "";
  // Parse as local date (avoid UTC shift) and emit "Mon, May 4"
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

async function generateBriefing(city, events, aroundItems, meetingData) {
  const eventLines = events.slice(0, 5).map((e) =>
    `- ${e.title}${e.venue ? ` at ${e.venue}` : ""}${e.date ? ` (${formatEventDate(e.date)})` : ""}${e.time ? ` @ ${e.time}` : ""} — ${e.category}`
  ).join("\n");

  const aroundLines = aroundItems.slice(0, 3).map((a) => {
    const date = a.date ? ` (${formatEventDate(a.date)})` : "";
    const summary = a.summary ? `\n   ${a.summary}` : "";
    return `- ${a.headline}${date}${summary}`;
  }).join("\n");

  const agendaLines = (meetingData?.agendaItems ?? [])
    .filter((a) => a.title && !AGENDA_BOILERPLATE.some((p) => p.test(a.title.trim())))
    .slice(0, 3)
    .map((a) => `- ${a.title}`)
    .join("\n");

  const hasSomething = events.length > 0 || aroundItems.length > 0 || (meetingData?.agendaItems?.length ?? 0) > 0;
  if (!hasSomething) return null;

  const parts = [];
  if (eventLines) parts.push(`Upcoming events:\n${eventLines}`);
  if (aroundLines) parts.push(`City hall highlights:\n${aroundLines}`);
  if (agendaLines && meetingData?.displayDate) {
    parts.push(`Next council meeting (${meetingData.displayDate}) agenda:\n${agendaLines}`);
  }

  const prompt = `You are the editorial voice of South Bay Signal, a hyperlocal news site for Silicon Valley residents.

Write ONE sentence (20-30 words) summarizing what's most interesting or noteworthy happening in ${city.name} this week. Tone: crisp, local, specific — like a smart friend texting you what's going on in your city. Mention actual event names or city hall actions if relevant. No fluff.

Important rules:
- Only reference facts that are explicitly present in the data below. Never invent or infer specifics like company names, dollar amounts, project types, ridership counts, square footage, or unit counts that aren't literally written in the data. If a number or proper noun isn't in the data, leave it out.
- Only mention a day of week (Monday, Tuesday, etc.) if it appears in the data below. Do not infer or guess weekdays from dates — the day labels are already provided in parentheses. Each event has its own day; never transfer a day or time from one event to another.
- Match the source's framing. If a council resolution restricts "federal civil enforcement," do not narrow it to "immigration enforcement" or any other specific subtype unless the data uses that word.
- No group-count nouns like "trifecta," "trio," "duo," or "quartet" — they imply specific counts and routinely don't match the actual data. Just say "three events" or list the items.
- No audience labels — don't write "for the intellectually curious," "for foodies," "for nature lovers," or similar. Describe what's happening, not who would like it.
- Use neutral verbs for legal or council items ("discussed," "approved," "weighs," "considers"). Avoid sensational framing like "faces legal heat," "battles," "fights," or "tackles" when the source describes a routine agenda item.
- Match the verb to the source summary. If a city hall summary says the council "held a public hearing," your verb is "heard" or "reviewed" — not "approved." If the summary says "approved," "adopted," or "filed," use that exact verb. Never upgrade a hearing to an approval.
- A past agenda date does not prove a meeting occurred or an item was heard. If the source says "scheduled to," "set to," "expected to," or "council to hear/consider," preserve that uncertainty even after the date; never convert it to "heard," "considered," or another completed action.
- Match tense to the date. City hall items show their date in parentheses; today is ${new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}. Items dated in the past must use past tense. Reserve present or future tense for items whose date is today or later.
- The text after "at" in an event line is a VENUE, never an organizer, host, sponsor, or performer. Meetup venue names routinely carry a landmark or trailhead label ("PG&E @ Rancho San Antonio Park", "Our Hub - A Bay Area Art & Wellness Community"). Never write that a venue "leads," "hosts," "sponsors," "presents," or "runs" the event unless the data says so in words — describe the event itself ("a 4.3-mile group hike at Rancho San Antonio") and leave the organizer out when you don't have one.
- Never write "today", "tonight", "tomorrow", or "this evening". This briefing is cached and read for days after it is written, so a relative day silently points at the wrong date. Name the day ("Friday", "Saturday") using the day labels in the data.
- Never describe the week, the weekend, or a day as quiet, slow, thin, light, sparse, sleepy, soft, or weak. There is always something useful to do — lead with the strongest options instead of apologizing for the calendar.
- Do not attribute a city hall item to a specific body ("the council," "the planning commission") unless the data names that body. Advisory boards and commissions are frequently the actual body. When the body isn't stated, write it body-neutrally ("Palo Alto is weighing…", "city staff recommended…").
- A person named in an event title is NOT necessarily physically present. Many author talks, "One Book" programs, and library events are livestreams, screenings, or watch parties hosted locally. Do not write that someone "visits," "appears at," "comes to," or "performs at" a venue unless the data explicitly says so. When unsure, describe what the venue is doing — "the library hosts a discussion of," "screens," "streams" — rather than asserting the person is there in person.

${parts.join("\n\n")}

Reply with ONLY the sentence, no quotes or preamble.`;

  // Two rules the model breaks often enough to be worth checking rather than
  // just asking for: downbeat day language (the site's loudest editorial
  // standard) and relative day words (which go stale in a cached artifact).
  // Both shipped on 2026-08-29. Retry once naming the offense, then drop the
  // summary rather than publish it — a city without a briefing line reads
  // better than one that is downbeat or points at the wrong day.
  const violations = (text) => {
    const found = [];
    if (hasDownbeatDayLanguage(text)) {
      found.push(
        "it described the week, weekend, or a day as quiet/slow/thin/light/sparse/sleepy/soft/weak",
      );
    }
    if (hasRelativeDayReference(text)) {
      found.push('it used a relative day word ("today"/"tonight"/"tomorrow") instead of naming the day');
    }
    if (hasProspectiveCityHallUpgrade(text, aroundItems)) {
      found.push("it upgraded an agenda-only city-hall item into a completed action");
    }
    return found;
  };

  const first = await callClaude(prompt);
  if (!first) return first;
  const firstIssues = violations(first);
  if (!firstIssues.length) return first;

  console.log(`  ${city.name}: ${firstIssues.join("; ")} — retrying`);
  const retry = await callClaude(
    `${prompt}\n\nYour previous attempt broke the rules — ${firstIssues.join("; ")}:\n"${first}"\nRewrite it, keeping every fact, without those problems.`,
  );
  if (retry && !violations(retry).length) return retry;
  console.log(`  ${city.name}: still violating after retry — dropping the summary`);
  return "";
}

async function main() {
  const { events: allEvents } = JSON.parse(readFileSync(EVENTS_PATH, "utf8"));
  const around = JSON.parse(readFileSync(AROUND_PATH, "utf8"));
  const meetingsData = JSON.parse(readFileSync(MEETINGS_PATH, "utf8"));
  const { start, end, label } = getWeekRange();

  // This script copies around-town headlines verbatim into city-hall highlights,
  // so it only tells the truth when it runs AFTER generate-around-town.mjs. When
  // it ran first it published the *previous* day's headlines — including ones the
  // fresh pass had since corrected: "City Council revokes tobacco retailer
  // licenses" went out as settled fact after around-town had softened it to "to
  // revoke" (the agenda only carried a hearing to consider revocation).
  //
  // Drop stale city-hall material rather than reprint it. Briefings still ship —
  // events and council agendas are read fresh — they just lose the city-hall
  // highlight until the run order is fixed upstream.
  const aroundAgeHours = around.generatedAt
    ? (Date.now() - Date.parse(around.generatedAt)) / 3_600_000
    : Infinity;
  const aroundIsFresh = aroundAgeHours < 6;
  const aroundItems = aroundIsFresh ? around.items : [];
  if (!aroundIsFresh) {
    console.warn(
      `⚠️  around-town.json is ${Number.isFinite(aroundAgeHours) ? `${aroundAgeHours.toFixed(1)}h old` : "missing generatedAt"} — ` +
      `skipping city-hall highlights so stale headlines aren't reprinted.\n` +
      `    Fix: run generate-around-town.mjs BEFORE generate-city-briefings.mjs.\n`
    );
  }

  console.log(`Generating city briefings for ${label}…\n`);

  const result = {};

  for (const city of CITIES) {
    const cityEvents = allEvents.filter(
      // Virtual listings belong in the Events calendar, but they are not a
      // physical city highlight. Without this guard, an online author talk or
      // campus webinar can displace a real local event from the weekly brief.
      (e) => e.city === city.id && !e.ongoing && e.virtual !== true && e.date >= start && e.date <= end
    ).sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));

    // Filter out non-public events (practices, rehearsals, etc.)
    const BRIEFING_SKIP = /\b(practice|rehearsal|staff meeting|board meeting)\b/i;
    const publicEvents = cityEvents.filter((e) => !BRIEFING_SKIP.test(e.title));

    // Prefer non-sports events for the briefing lead; keep sports as fallback
    const interestingEvents = [
      ...publicEvents.filter((e) => e.category !== "sports"),
      ...publicEvents.filter((e) => e.category === "sports"),
    ].slice(0, 5);

    const cityAroundItems = aroundItems.filter((a) => a.cityId === city.id);
    const nextCityMeeting = meetingsData.meetings?.[city.id] ?? null;
    const cityMeeting = meetingWithinBriefingWindow(nextCityMeeting, start, end)
      ? nextCityMeeting
      : null;

    if (!interestingEvents.length && !cityAroundItems.length && !cityMeeting?.agendaItems?.length) {
      console.log(`  ${city.name}: no data — skipping`);
      continue;
    }

    try {
      const summary = await generateBriefing(city, interestingEvents, cityAroundItems, cityMeeting);
      if (!summary) {
        console.log(`  ${city.name}: no summary generated — skipping`);
        continue;
      }

      // Build highlight list (up to 3 items for display)
      const highlights = [];
      for (const e of interestingEvents.slice(0, 2)) {
        highlights.push({
          type: "event",
          title: e.title,
          when: e.displayDate ? `${e.displayDate}${e.time ? ` · ${e.time}` : ""}` : e.date,
          venue: e.venue || null,
          category: e.category,
          url: e.url || null,
        });
      }
      // A meeting flagged closed-session has no public business to preview, no
      // matter what its item titles look like.
      const leadAgendaItem = cityMeeting?.closedSession
        ? null
        : firstSubstantiveAgendaItem(cityMeeting?.agendaItems);
      if (leadAgendaItem) {
        highlights.push({
          type: "council",
          title: leadAgendaItem.title.replace(/\.$/, ""),
          when: cityMeeting.displayDate,
          venue: null,
          category: "government",
          url: cityMeeting.url || null,
        });
      } else if (cityAroundItems.length) {
        highlights.push({
          type: "cityhall",
          title: cityAroundItems[0].headline,
          when: null,
          venue: null,
          category: "government",
          url: cityAroundItems[0].sourceUrl || null,
        });
      }

      result[city.id] = {
        cityId: city.id,
        cityName: city.name,
        summary,
        highlights: highlights.slice(0, 3),
        weekLabel: label,
        generatedAt: new Date().toISOString(),
      };

      console.log(`  ✓ ${city.name}: ${summary}`);
    } catch (err) {
      console.error(`  ✗ ${city.name}: ${err.message}`);
    }

    // Small delay between Claude calls to be polite
    await new Promise((r) => setTimeout(r, 300));
  }

  // If no briefings were generated (e.g. API credits exhausted), preserve existing file
  if (Object.keys(result).length === 0) {
    console.warn("\n⚠️  No briefings generated — preserving existing city-briefings.json");
    return;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    weekLabel: label,
    weekStart: start,
    weekEnd: end,
    cities: result,
  };

  writeFileAtomic(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ ${Object.keys(result).length} city briefings written to city-briefings.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
