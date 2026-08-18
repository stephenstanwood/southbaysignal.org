#!/usr/bin/env node
/**
 * generate-digests.mjs
 *
 * Pulls pre-ingested council meeting data from stoa.works/api/council-meetings,
 * summarizes the most recent meeting per city with Claude Sonnet, and writes
 * results to src/data/south-bay/digests.json.
 *
 * Much faster than re-scraping Legistar/CivicEngage — Stoa already has the data.
 *
 * Usage:
 *   node --env-file=.env.local scripts/generate-digests.mjs
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnvLocal } from "./lib/env.mjs";
import { writeFileAtomic } from "./lib/io.mjs";
import { legistarMeetingUrl, ptDateISO } from "./lib/civic-meetings.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "digests.json");

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const CLAUDE_SONNET = "claude-sonnet-5";

// ── City config (SBS city IDs → Stoa city names + schedule) ──

// `legistar` is the public *.legistar.com subdomain (used to build agenda links).
// `legistarApi` is the Web API client name (often the same, but Sunnyvale +
// Palo Alto differ). Both are needed because the public site and the Web API
// don't always agree.
const CITIES = [
  { city: "campbell",      stoaCity: "Campbell",      cityName: "Campbell",      schedule: "1st and 3rd Tuesday",   agendaUrl: "https://pub-campbell.escribemeetings.com/" },
  { city: "saratoga",      stoaCity: "Saratoga",      cityName: "Saratoga",      schedule: "1st and 3rd Wednesday", agendaUrl: "https://www.saratoga.ca.us/AgendaCenter/City-Council-13" },
  { city: "los-altos",     stoaCity: "Los Altos",     cityName: "Los Altos",     schedule: "2nd and 4th Tuesday",   agendaUrl: "https://losaltosca.portal.civicclerk.com/" },
  { city: "los-gatos",     stoaCity: "Los Gatos",     cityName: "Los Gatos",     schedule: "1st and 3rd Tuesday",   agendaUrl: "https://losgatos-ca.municodemeetings.com/", councilBody: "Town Council" },
  { city: "san-jose",      stoaCity: "San Jose",      cityName: "San José",      schedule: "1st and 3rd Tuesday",   agendaUrl: "https://sanjose.legistar.com/Calendar.aspx",      legistar: "sanjose",      legistarApi: "sanjose" },
  { city: "mountain-view", stoaCity: "Mountain View", cityName: "Mountain View", schedule: "2nd and 4th Tuesday",   agendaUrl: "https://mountainview.legistar.com/Calendar.aspx", legistar: "mountainview", legistarApi: "mountainview" },
  { city: "sunnyvale",     stoaCity: "Sunnyvale",     cityName: "Sunnyvale",     schedule: "2nd and 4th Tuesday",   agendaUrl: "https://sunnyvale.legistar.com/Calendar.aspx",    legistar: "sunnyvale",    legistarApi: "sunnyvaleca" },
  { city: "cupertino",     stoaCity: "Cupertino",     cityName: "Cupertino",     schedule: "1st and 3rd Tuesday",   agendaUrl: "https://cupertino.legistar.com/Calendar.aspx",    legistar: "cupertino",    legistarApi: "cupertino" },
  { city: "santa-clara",   stoaCity: "Santa Clara",   cityName: "Santa Clara",   schedule: "2nd and 4th Tuesday",   agendaUrl: "https://santaclara.legistar.com/Calendar.aspx",   legistar: "santaclara",   legistarApi: "santaclara" },
  // Milpitas + Palo Alto digests stall when Stoa lacks full agenda text: recent
  // Milpitas records are CivicClerk stubs ("Meeting record available on...") that
  // fail hasRealContent, and recent Palo Alto records are commission/item-level
  // rather than City Council. The fix belongs upstream in Stoa ingestion.
  // Palo Alto has no legistarApi: webapi.legistar.com/v1/paloalto is not a
  // provisioned client (500 "connection string not set up") even though the
  // public paloalto.legistar.com calendar exists for source links.
  { city: "milpitas",      stoaCity: "Milpitas",      cityName: "Milpitas",      schedule: "1st and 3rd Tuesday",   agendaUrl: "https://www.milpitas.gov/129/Agendas-Minutes" },
  // Palo Alto left Legistar — paloalto.legistar.com answers "Invalid parameters!"
  // for every request, so `legistar:` here only produced dead source links and a
  // body check that silently no-opped. PrimeGov is the live system of record.
  { city: "palo-alto",     stoaCity: "Palo Alto",     cityName: "Palo Alto",     schedule: "1st and 3rd Monday",    agendaUrl: "https://www.paloalto.gov/City-Hall/City-Council/Council-Agendas-Minutes", primegov: "cityofpaloalto.primegov.com" },
];

// If Stoa's most recent record for a city is older than this many days, we try
// to pull the latest past meeting directly from Legistar.
const STOA_STALENESS_DAYS = 21;

// ── Helpers ──

// ── Fetch Stoa data ──

async function fetchStoaMeetingsForCity(stoaCity, councilBody = "City Council") {
  // Try typed query first, then fall back to untyped (some cities lack type tags).
  // Los Gatos uses "Town Council"; everyone else "City Council".
  const typedParam = `&type=${councilBody.replace(/\s+/g, "+")}`;
  for (const typeParam of [typedParam, ""]) {
    const url = `https://www.stoa.works/api/council-meetings?city=${encodeURIComponent(stoaCity)}${typeParam}&limit=10`;
    const res = await fetch(url, {
      headers: { "User-Agent": "SouthBaySignal/1.0 (stanwood.dev; internal data sharing)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) continue;
    const data = await res.json();
    let records = data.records ?? [];
    // If untyped, filter to likely City/Town Council records by title
    if (!typeParam && records.length > 0) {
      const council = records.filter((r) => {
        const title = (r.title || "").toLowerCase();
        return title.includes("city council") || title.includes("town council") ||
               title.includes("council meeting") ||
               title.includes("please scroll") || title.includes("live translation");
      });
      records = council.length > 0 ? council : records;
    }
    if (records.length > 0) return records;
  }
  return [];
}

async function fetchStoaMeetings() {
  console.log("Fetching from stoa.works/api/council-meetings (per-city)...");
  const allRecords = [];
  for (const config of CITIES) {
    const records = await fetchStoaMeetingsForCity(config.stoaCity, config.councilBody);
    allRecords.push(...records);
  }
  console.log(`  Got ${allRecords.length} records total\n`);
  return allRecords;
}

// ── Legistar past-meeting fallback ──
//
// When Stoa hasn't ingested a city's most recent agenda yet, hit the Legistar
// Web API directly. Returns a record shaped like a Stoa record so the rest of
// the pipeline (hasRealContent, summarize, etc.) treats it the same way.
const LEGISTAR_UA = "SouthBaySignal/1.0 (stanwood.dev; civic data aggregator)";

async function fetchLegistarPastMeeting(client) {
  const today = new Date().toISOString().split("T")[0];
  const url =
    `https://webapi.legistar.com/v1/${client}/Events` +
    `?$filter=EventBodyName eq 'City Council' and EventDate lt datetime'${today}T23:59:59'` +
    `&$orderby=EventDate desc&$top=3`;

  const res = await fetch(url, {
    headers: { "User-Agent": LEGISTAR_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const events = await res.json();
  if (!events?.length) return null;

  for (const ev of events) {
    const itemsRes = await fetch(
      `https://webapi.legistar.com/v1/${client}/Events/${ev.EventId}/EventItems`,
      { headers: { "User-Agent": LEGISTAR_UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
    );
    if (!itemsRes.ok) continue;
    const items = await itemsRes.json();
    const substantive = items
      .map((i) => (i.EventItemTitle || "").split(/\r?\n/)[0].trim())
      .filter((t) => t.length > 25 && t.length < 300)
      .filter((t) => !/^(roll call|call to order|pledge of allegiance|adjournment|closed session|public comment|consent calendar|recess)/i.test(t))
      .filter((t) => t !== t.toUpperCase());
    if (substantive.length < 2) continue;

    const excerpt = substantive.slice(0, 12).join(". ");
    return {
      id: `legistar-${client}-${ev.EventId}`,
      city: null,
      date: new Date(ev.EventDate).toISOString().split("T")[0],
      meetingType: "City Council",
      title: `City Council — ${ev.EventDate}`,
      excerpt,
      keywords: substantive.slice(0, 5),
      source: "legistar-direct",
    };
  }
  return null;
}

// Upstream records carry a `meetingType` we display verbatim, and it defaults to
// "City Council" when absent. On 2026-08-05 San José's record was labeled City
// Council but the only meeting that day was the Joint Rules and Open Government
// Committee / Committee of the Whole — so the digest told residents the Council
// met when it had not. Ask Legistar what actually convened on that date: if no
// City Council event exists, return the real body name so the digest is honest.
// Returns null on any error or when the label already checks out, leaving the
// existing behavior untouched.
async function verifyLegistarBodyOnDate(client, dateIso) {
  try {
    const url =
      `https://webapi.legistar.com/v1/${client}/Events` +
      `?$filter=EventDate ge datetime'${dateIso}T00:00:00'` +
      ` and EventDate lt datetime'${dateIso}T23:59:59'`;
    const res = await fetch(url, {
      headers: { "User-Agent": LEGISTAR_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const events = await res.json();
    if (!Array.isArray(events) || events.length === 0) return null;

    const bodies = events.map((e) => String(e.EventBodyName || "").trim()).filter(Boolean);
    if (bodies.some((b) => /^city council\b/i.test(b))) return null; // label is correct

    // Prefer the body whose name reads like the deliberative one (committee /
    // commission / council-of-the-whole) over incidental same-day staff hearings.
    const preferred =
      bodies.find((b) => /\b(committee|commission)\b/i.test(b)) ?? bodies[0];
    if (!preferred) return null;
    // Strip meeting-type boilerplate Legistar prepends to some body names
    // ("Joint Meeting for the Rules and Open Government Committee…"). It's not
    // part of the body's name and it makes the card heading unreadable.
    return preferred.replace(/^(?:joint|special|regular)\s+meeting\s+(?:for|of)\s+the\s+/i, "").trim();
  } catch {
    return null;
  }
}

// Same honesty check as above, for cities on PrimeGov instead of Legistar.
// Palo Alto's Legistar instance is decommissioned (paloalto.legistar.com answers
// every request with "Invalid parameters!"), so the Legistar verifier could
// never run for it and upstream mislabels sailed through. On 2026-08-17 the
// Aug 6 digest was published as "Palo Alto City Council" when PrimeGov shows
// the only Aug 6 meeting was the Architectural Review Board — the Council's
// Aug 3 sitting was canceled and its next one was Aug 10.
async function verifyPrimeGovBodyOnDate(domain, dateIso) {
  try {
    const year = dateIso.slice(0, 4);
    const url = `https://${domain}/api/v2/PublicPortal/ListArchivedMeetings?year=${year}`;
    const res = await fetch(url, {
      headers: { "User-Agent": LEGISTAR_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const meetings = await res.json();
    if (!Array.isArray(meetings)) return null;

    // PrimeGov dateTime is a naive local wall clock, so the Pacific calendar
    // date is the literal prefix — never re-read it as UTC.
    const sameDay = meetings.filter((m) => String(m.dateTime || "").slice(0, 10) === dateIso);
    if (sameDay.length === 0) return null;

    // PrimeGov marks cancellations in the title. A canceled council sitting must
    // not count as confirmation that the council met.
    const live = sameDay.filter((m) => !/cancel(?:led|ed)|postponed/i.test(m.title || ""));
    if (live.length === 0) return null;

    const titles = live.map((m) => String(m.title || "").trim()).filter(Boolean);
    if (titles.some((t) => /^city council\b/i.test(t))) return null; // label is correct

    const preferred =
      titles.find((t) => /\b(board|committee|commission)\b/i.test(t)) ?? titles[0];
    if (!preferred) return null;
    // Drop the "Regular Meeting" / "Special Meeting" suffix PrimeGov appends —
    // it is meeting type, not the body's name.
    return preferred.replace(/\s+(?:regular|special|joint)\s+meeting\b.*$/i, "").trim();
  } catch {
    return null;
  }
}

// ── Claude summarization ──

// Meta-commentary parentheticals occasionally leak into keyTopics even though
// the prompt forbids them — Sonnet writes "Five-year service agreements
// authorized with vendors (names partially listed)" or "Closed session
// convened (details not public)". The qualifier is the model admitting its
// source data was thin; a resident reading the digest just sees filler in
// parens. Strip the parenthetical (and the leading whitespace) and keep the
// substantive part of the topic.
const META_PARENTHETICAL_PATTERNS = [
  /\s*\([^)]*\b(?:not\s+(?:made\s+)?public|details?\s+(?:not|un)\w*|specifics?\s+(?:not|un)\w*|partially\s+(?:listed|identified|named|disclosed)|name(?:s)?\s+(?:un)?(?:clear|listed|disclosed|given|withheld)|not\s+(?:yet\s+)?(?:specified|given|named|disclosed|listed|included|provided|shared|detailed)|unspecified|tbd|incomplete|omitted)\b[^)]*\)/i,
];

function cleanKeyTopic(topic) {
  let t = String(topic || "");
  for (const re of META_PARENTHETICAL_PATTERNS) {
    t = t.replace(re, "");
  }
  return t.replace(/\s+/g, " ").trim();
}

function cleanKeyTopics(topics) {
  if (!Array.isArray(topics)) return topics;
  return topics
    .map(cleanKeyTopic)
    .filter((t) => t.length > 0);
}

// Sonnet occasionally truncates two-word city names — most often "Mountain View"
// becomes "Mountain" ("the Mountain City Council held a special session…").
// Stephen has caught and hand-fixed this verbatim at least once (commit 15558a1).
// Keyed per-city so we only patch the digest belonging to that city — avoids
// touching incidental "Mountain" mentions in other cities' summaries.
const CITY_NAME_FIXES = {
  "Mountain View": [
    [/\bMountain (?=City|Town|Council)/g, "Mountain View "],
  ],
};

function enforceCityName(cityName, text) {
  if (typeof text !== "string") return text;
  const patterns = CITY_NAME_FIXES[cityName];
  if (!patterns) return text;
  let out = text;
  for (const [re, replacement] of patterns) {
    out = out.replace(re, replacement);
  }
  return out;
}

// bodyLabel is the verified name of the body that actually convened (see
// verifyLegistarBodyOnDate). It must be resolved *before* this call: on
// 2026-08-11 Santa Clara's July 16 Station Area Task Force digest opened "This
// Santa Clara City Council meeting agenda included…" because the relabel ran
// after summarization, so the prompt still said City Council. Pass it in.
async function summarize(config, meeting, bodyLabel) {
  const isYouTubeTranscript = meeting.source === "youtube-transcript";
  // Strip the VTT metadata prefix that appears in YouTube transcript records
  const rawExcerpt = (meeting.excerpt || "").replace(/^Kind:\s*captions\s+Language:\s*\w+\s*/i, "").trim();

  const contentBlock = isYouTubeTranscript
    ? `Meeting transcript (partial — opening segment only): ${rawExcerpt}`
    : `Agenda highlights: ${rawExcerpt}`;

  const transcriptNote = isYouTubeTranscript
    ? `Note: the content above is the opening segment of the meeting transcript. It may only capture roll call and procedural items. Summarize what you can and be honest if the substantive agenda items aren't captured.`
    : "";

  const councilBody = bodyLabel ?? config.councilBody ?? "City Council";
  // Agendas publish days ahead of the meeting, so a digest is often written for
  // a meeting that hasn't happened yet. Without this the model defaults to past
  // tense ("The Council met to approve…"), which reports a scheduled meeting as
  // a completed one — a factual claim about a future event.
  const isUpcoming = meeting.date > ptDateISO();
  const tenseNote = isUpcoming
    ? `IMPORTANT: this meeting has NOT happened yet — it is scheduled for ${meeting.date} and the source is the published agenda. Write in the future tense ("the ${councilBody} will consider…", "is set to review…"). Never write that the ${councilBody} "met", "approved", "voted", "adopted", or "decided" — nothing has been decided yet.`
    : `This meeting has already taken place. Past tense is fine, but the source is the agenda, not the minutes — describe what was taken up ("the ${councilBody} considered…"), not how any vote turned out.`;
  const prompt = `Summarize this ${config.cityName}, CA ${councilBody} meeting for residents in plain English.

Meeting date: ${meeting.date}
${contentBlock}
Keywords: ${meeting.keywords.join(", ")}
${tenseNote}
${transcriptNote}

Return JSON with:
- "summary": 2-3 sentence plain-English overview of what was discussed (no jargon)
- "keyTopics": array of 3-5 short bullet strings (specific topics, not generic)

Be concrete. Write for someone who wants to know what's happening in their city.
Do not include meta-commentary about incomplete or truncated source data (e.g. "vendor name incomplete in agenda", "details not publicly shared", "agenda item unclear"). If a detail isn't in the source, just omit that bullet — pick a different concrete topic instead.

Match the source's wording on sensitive framing. If the agenda says "federal civil enforcement," do not narrow it to "immigration enforcement," "tax enforcement," or any specific subtype unless the source explicitly uses that word.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text()}`);

  const msg = await res.json();
  const text = msg.content?.find((c) => c.type === "text")?.text ?? "";
  // Extract the first JSON object from the response (handles trailing text/preamble)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in Claude response: ${text.substring(0, 100)}`);
  return JSON.parse(jsonMatch[0]);
}

// ── Main ──

// Carry forward on partial regen — a city whose source has nothing fresh
// this run (Stoa ingestion gap, Legistar hiccup, Claude summarize error)
// used to just vanish from the output (`digests = {}` starts empty every
// run and there's no fallback merge), silently 404ing /gov/<city> after
// enough consecutive misses. los-altos disappeared this way for 3+ months
// (last real digest 2026-04-13) because Stoa's council-meetings ingestion
// for it currently returns only far-future stub placeholders with no past
// content — see feedback_carry_forward_on_partial_regen memory. D30/D31/D08.
function loadPreviousDigests() {
  try {
    return JSON.parse(readFileSync(OUT_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const previousDigests = loadPreviousDigests();
  const records = await fetchStoaMeetings();

  // Group by city name (keep most recent City Council meeting per city)
  // PT, not UTC: the nightly run fires ~8pm PT, which is already "tomorrow" in
  // UTC. Using the UTC date let tomorrow's published agenda through the
  // past-meetings-only filter below, and the summary then described a meeting
  // that hadn't happened yet in the past tense (Los Gatos, 2026-08-03).
  const today = ptDateISO();
  const PLACEHOLDER_EXCERPTS = [
    "meeting agenda available",
    "search for specific items",
    "no items",
  ];
  // Boilerplate phrases that indicate the excerpt is meeting logistics, not substance
  const BOILERPLATE_PHRASES = [
    "how to observe the meeting",
    "cable channel",
    "live translations in over",
    "wordly.ai",
    "americans with disabilities act",
    "scroll to the end for information about",
    "rules of conduct of the meeting",
    // Remote-participation instructions. Santa Clara's ingested records are
    // nothing but this block (Zoom link, webinar ID, eComment steps), which
    // produced a "digest" that summarized how to join the meeting instead of
    // what was on the agenda.
    "webinar id",
    "ecomment",
    "submit written public comment",
  ];
  // A record whose *title* is the participation notice rather than a meeting
  // name never carries agenda content — the notice is the whole record.
  const LOGISTICS_TITLE = /\bconduct(?:s|ing)\b[^.]*\bmeetings?\b[^.]*\b(?:hybrid|in-person|remotely)\b/i;
  function hasRealContent(r) {
    const ex = (r.excerpt || "").toLowerCase().trim();
    if (ex.length <= 80) return false;
    if (LOGISTICS_TITLE.test(r.title || "")) return false;
    if (PLACEHOLDER_EXCERPTS.some((p) => ex.includes(p))) return false;
    // If 2+ boilerplate phrases appear, it's meeting logistics not substance
    const boilerplateHits = BOILERPLATE_PHRASES.filter((p) => ex.includes(p)).length;
    if (boilerplateHits >= 2) return false;
    return true;
  }

  // Group by city — prefer most recent meeting with real content
  const byCity = {};
  for (const r of records) {
    if (r.date > today) continue;
    // Accept "City Council" or "Town Council" — Los Gatos is the only Town in SCC.
    if (r.meetingType !== "City Council" && r.meetingType !== "Town Council") continue;
    // Stoa mislabels some commission/board meetings as "City Council" — skip any
    // record whose title names a non-council body (e.g. Sunnyvale's "5:30 P.M.
    // PERSONNEL BOARD MEETING" came through typed City Council on 2026-06-08).
    const titleLower = (r.title || "").toLowerCase();
    if (/\b(commission|committee|board|authority|task force)\b/.test(titleLower) && !titleLower.includes("council")) continue;
    const existing = byCity[r.city];
    // Prefer records with real content; among those, take most recent
    const rReal = hasRealContent(r);
    if (!existing) {
      if (rReal) { byCity[r.city] = r; }
      continue;
    }
    const exReal = hasRealContent(existing);
    if (rReal && !exReal) { byCity[r.city] = r; continue; }
    if (!rReal && exReal) continue;
    if (r.date > existing.date) byCity[r.city] = r;
  }

  // Don't show meetings older than 9 months — stale data is worse than no data
  const STALE_CUTOFF = new Date();
  STALE_CUTOFF.setMonth(STALE_CUTOFF.getMonth() - 9);
  const staleIso = STALE_CUTOFF.toISOString().split("T")[0];

  const digests = {};

  // Reuse the previous run's digest for a city that comes up empty this run,
  // as long as it isn't itself past the 9-month floor — don't perpetuate
  // indefinitely-stale carried-forward data. Logs loudly (was a silent
  // `continue` before) so a persistent source gap is debuggable rather than
  // just watching the city quietly 404 a few weeks later.
  function carryForward(config, reason) {
    const prev = previousDigests[config.city];
    if (!prev) {
      console.warn(`  ⚠️  ${config.cityName}: no source meeting AND no previous digest to carry forward (city=${config.city}, reason=${reason})`);
      return;
    }
    if (prev.meetingDateIso && prev.meetingDateIso < staleIso) {
      console.warn(`  ⚠️  ${config.cityName}: previous digest (${prev.meetingDateIso}) is also >9 months old — not carrying forward (city=${config.city}, reason=${reason})`);
      return;
    }
    digests[config.city] = { ...prev, carriedForward: true, carryForwardReason: reason };
    console.warn(`  ↻ ${config.cityName}: carrying forward previous digest (${prev.meetingDateIso}) (city=${config.city}, reason=${reason})`);
  }

  // Cutoff: if Stoa's record is older than this, try Legistar fallback
  const stoaStaleCutoff = new Date(Date.now() - STOA_STALENESS_DAYS * 86_400_000)
    .toISOString().split("T")[0];

  for (const config of CITIES) {
    let meeting = byCity[config.stoaCity];

    const stoaStale = !meeting || meeting.date < stoaStaleCutoff;
    if (stoaStale && config.legistarApi) {
      const stoaDateLabel = meeting ? meeting.date : "none";
      process.stdout.write(`  ↻ ${config.cityName}: Stoa stale (${stoaDateLabel}), trying Legistar...`);
      try {
        const fallback = await fetchLegistarPastMeeting(config.legistarApi);
        if (fallback && (!meeting || fallback.date > meeting.date)) {
          meeting = fallback;
          console.log(` ✅ got ${fallback.date}`);
        } else {
          console.log(` — no newer record`);
        }
      } catch (e) {
        console.log(` ⚠️  ${e.message}`);
      }
    }

    if (!meeting) {
      console.warn(`  ⚠️  ${config.cityName}: no recent City Council meeting from any source (city=${config.city}, stoaCity=${config.stoaCity}, legistarApi=${config.legistarApi ?? "none"})`);
      carryForward(config, "no-source-meeting");
      continue;
    }
    if (meeting.date < staleIso) {
      console.warn(`  ⏭️  ${config.cityName}: most recent record is ${meeting.date} (>9 months old, skipping) (city=${config.city})`);
      carryForward(config, "source-meeting-too-old");
      continue;
    }

    // Never replace a published digest with an OLDER meeting. Stoa serves a
    // sliding 10-record window, so when newer meetings fall out of it (or come
    // back without excerpts, failing hasRealContent) the "most recent with real
    // content" pick can land months behind what is already live. That regression
    // reads to a visitor as the city having gone quiet, which is worse than
    // holding the last good digest. Hit 2026-08-17: Los Gatos Aug 4 → May 19 and
    // Saratoga May 20 → March 18, neither city having a Legistar fallback.
    const publishedIso = previousDigests[config.city]?.meetingDateIso;
    if (publishedIso && meeting.date < publishedIso) {
      console.warn(`  ⏮️  ${config.cityName}: source meeting ${meeting.date} predates published ${publishedIso} — holding previous digest (city=${config.city})`);
      carryForward(config, "source-regressed");
      continue;
    }

    console.log(`  ⏳ ${config.cityName} (${meeting.date})...`);
    try {
      // Resolve the real body name BEFORE summarizing — the prompt names the
      // body, so relabeling afterward leaves the summary describing a City
      // Council meeting that never happened.
      // Use meetingType from Stoa (not hardcoded) so mislabeled records are
      // surfaced rather than masked. Falls back to "City Council" if absent.
      // councilBody (when set) hard-overrides — Los Gatos is officially a Town
      // and its body is the Town Council, but Stoa records sometimes come back
      // labeled "City Council".
      let bodyLabel = config.councilBody ?? meeting.meetingType ?? "City Council";
      if (!config.councilBody && (config.legistarApi || config.primegov) && /^city council\b/i.test(bodyLabel)) {
        const actualBody = config.legistarApi
          ? await verifyLegistarBodyOnDate(config.legistarApi, meeting.date)
          : await verifyPrimeGovBodyOnDate(config.primegov, meeting.date);
        if (actualBody) {
          console.warn(`  ⚠️  ${config.cityName}: no City Council meeting on ${meeting.date} — relabeling as "${actualBody}" (city=${config.city})`);
          bodyLabel = actualBody;
        }
      }

      const parsed = await summarize(config, meeting, bodyLabel);

      const meetingDateFormatted = new Date(meeting.date + "T12:00:00").toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric",
      });

      digests[config.city] = {
        city: config.city,
        cityName: config.cityName,
        body: bodyLabel,
        meetingDate: meetingDateFormatted,
        meetingDateIso: meeting.date,
        title: `${config.cityName} ${bodyLabel} — ${meetingDateFormatted}`,
        summary: enforceCityName(config.cityName, parsed.summary ?? ""),
        keyTopics: cleanKeyTopics(parsed.keyTopics ?? meeting.keywords.slice(0, 5))
          .map((t) => enforceCityName(config.cityName, t)),
        // config.schedule describes the *council's* cadence. When the digest is
        // relabeled to a committee or commission above, that cadence doesn't
        // apply — omit it rather than pair the wrong body with the wrong meets-on.
        schedule: /council\b/i.test(bodyLabel) ? config.schedule : null,
        sourceUrl: config.legistar ? legistarMeetingUrl(config.legistar, meeting.date) : config.agendaUrl,
        generatedAt: new Date().toISOString(),
      };

      console.log(`  ✅ ${config.cityName}: ${meetingDateFormatted}`);
    } catch (err) {
      console.error(`  ❌ ${config.cityName}: summarize failed (city=${config.city}, meetingDate=${meeting.date}, source=${meeting.source ?? "stoa"}): ${err.message}`);
      carryForward(config, "summarize-failed");
    }

    // Be polite — small delay between Claude calls
    await new Promise((r) => setTimeout(r, 300));
  }

  // Preserve existing file if no digests were generated (e.g. API credits exhausted)
  if (Object.keys(digests).length === 0) {
    console.warn("\n⚠️  No digests generated — preserving existing digests.json");
    return;
  }

  writeFileAtomic(OUT_PATH, JSON.stringify(digests, null, 2) + "\n");
  console.log(`\nDone — ${Object.keys(digests).length} digests written to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
