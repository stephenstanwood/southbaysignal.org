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
import { callClaude } from "./lib/claude.mjs";
import {
  auditDigestFreshness,
  formatFreshnessAlert,
  MAX_DIGEST_AGE_DAYS,
} from "./lib/digest-staleness.mjs";
import { loadEnvLocal } from "./lib/env.mjs";
import { writeFileAtomic } from "./lib/io.mjs";
import { catSignal } from "./lib/notify.mjs";
import {
  fetchCivicClerkPastMeeting,
  fetchCivicEngagePastMeeting,
  fetchEscribePastMeeting,
  legistarMeetingUrl,
  ptDateISO,
  substantiveAgendaTitles,
  verifyLegistarBodyOnDate,
  verifyPrimeGovBodyOnDate,
} from "./lib/civic-meetings.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "digests.json");

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// ── City config (SBS city IDs → Stoa city names + schedule) ──

// `legistar` is the public *.legistar.com subdomain (used to build agenda links).
// `legistarApi` is the Web API client name (often the same, but Sunnyvale +
// Palo Alto differ). Both are needed because the public site and the Web API
// don't always agree.
const CITIES = [
  // Campbell has no Legistar client, so when Stoa's ingestion stalls there is
  // nothing behind it. It stalled from 2026-07-09 to at least 2026-08-27 while
  // the council kept meeting (Aug 3, Aug 18), and the digest quietly reran the
  // July 7 record the whole time. `escribe` is the first-party archive.
  { city: "campbell",      stoaCity: "Campbell",      cityName: "Campbell",      schedule: "1st and 3rd Tuesday",   agendaUrl: "https://pub-campbell.escribemeetings.com/",
    escribe: {
      host: "pub-campbell.escribemeetings.com",
      // Executive sessions are closed to the public; they are not city business
      // a resident can read about, and eScribe files them as their own type.
      meetingTypes: [
        "City Council Regular Session Meeting",
        "City Council Special Meeting",
        "City Council Study Session",
      ],
    } },
  // Stoa's newest Saratoga record with real content sat at 2026-06-03 for
  // eleven weeks — the June 17 one is a 17-char stub ("RESOLUTION 26-034")
  // that fails hasRealContent — while the council met on Aug 11 and Aug 19.
  { city: "saratoga",      stoaCity: "Saratoga",      cityName: "Saratoga",      schedule: "1st and 3rd Wednesday", agendaUrl: "https://www.saratoga.ca.us/AgendaCenter/City-Council-13",
    civicengage: { baseUrl: "https://www.saratoga.ca.us", calendarId: "City-Council-13" } },
  // Los Altos had no digest at all between 2026-04-13 and 2026-08-27: Stoa
  // returns only far-future CivicClerk stubs for it, so there was never a past
  // meeting to summarize and carryForward had nothing left to hold onto.
  { city: "los-altos",     stoaCity: "Los Altos",     cityName: "Los Altos",     schedule: "2nd and 4th Tuesday",   agendaUrl: "https://losaltosca.portal.civicclerk.com/",
    civicclerk: { apiHost: "losaltosca.api.civicclerk.com" } },
  { city: "los-gatos",     stoaCity: "Los Gatos",     cityName: "Los Gatos",     schedule: "1st and 3rd Tuesday",   agendaUrl: "https://losgatos-ca.municodemeetings.com/", councilBody: "Town Council" },
  { city: "san-jose",      stoaCity: "San Jose",      cityName: "San José",      schedule: "1st and 3rd Tuesday",   agendaUrl: "https://sanjose.legistar.com/Calendar.aspx",      legistar: "sanjose",      legistarApi: "sanjose" },
  { city: "mountain-view", stoaCity: "Mountain View", cityName: "Mountain View", schedule: "2nd and 4th Tuesday",   agendaUrl: "https://mountainview.legistar.com/Calendar.aspx", legistar: "mountainview", legistarApi: "mountainview" },
  { city: "sunnyvale",     stoaCity: "Sunnyvale",     cityName: "Sunnyvale",     schedule: "2nd and 4th Tuesday",   agendaUrl: "https://sunnyvale.legistar.com/Calendar.aspx",    legistar: "sunnyvale",    legistarApi: "sunnyvaleca" },
  { city: "cupertino",     stoaCity: "Cupertino",     cityName: "Cupertino",     schedule: "1st and 3rd Tuesday",   agendaUrl: "https://cupertino.legistar.com/Calendar.aspx",    legistar: "cupertino",    legistarApi: "cupertino" },
  { city: "santa-clara",   stoaCity: "Santa Clara",   cityName: "Santa Clara",   schedule: "2nd and 4th Tuesday",   agendaUrl: "https://santaclara.legistar.com/Calendar.aspx",   legistar: "santaclara",   legistarApi: "santaclara" },
  // Milpitas + Palo Alto digests stall when Stoa lacks full agenda text: recent
  // Milpitas records are CivicClerk stubs ("Meeting record available on...") that
  // fail hasRealContent, and recent Palo Alto records are commission/item-level
  // rather than City Council. The real fix is upstream in Stoa ingestion;
  // Milpitas now has a first-party fallback for when it stalls, Palo Alto does
  // not (PrimeGov is read only to verify which body met, not for agenda text).
  // Palo Alto has no legistarApi: webapi.legistar.com/v1/paloalto is not a
  // provisioned client (500 "connection string not set up") even though the
  // public paloalto.legistar.com calendar exists for source links.
  { city: "milpitas",      stoaCity: "Milpitas",      cityName: "Milpitas",      schedule: "1st and 3rd Tuesday",   agendaUrl: "https://www.milpitas.gov/129/Agendas-Minutes",
    civicclerk: { apiHost: "milpitasca.api.civicclerk.com" } },
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
    const substantive = substantiveAgendaTitles(items.map((i) => i.EventItemTitle));
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


// Every city whose Stoa records have gone quiet reads from its own portal
// instead. Ordered by preference: Legistar returns structured event items, the
// rest return an agenda document this has to parse. A city with no entry here
// has no fallback — it carries forward and the freshness audit says so.
function pastMeetingFallback(config) {
  if (config.legistarApi) {
    return { provider: "Legistar", fetch: () => fetchLegistarPastMeeting(config.legistarApi) };
  }
  if (config.escribe) {
    return { provider: "eScribe", fetch: () => fetchEscribePastMeeting(config.escribe) };
  }
  if (config.civicclerk) {
    return { provider: "CivicClerk", fetch: () => fetchCivicClerkPastMeeting(config.civicclerk) };
  }
  if (config.civicengage) {
    return { provider: "CivicEngage", fetch: () => fetchCivicEngagePastMeeting(config.civicengage) };
  }
  return null;
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
- "keyTopics": array of up to 5 short bullet strings (specific topics, not generic). Return only as many as the source actually supports — one distinct agenda item per bullet. A thin agenda gets 1-2 bullets; never restate the same item in different words to reach a count.

Be concrete. Write for someone who wants to know what's happening in their city.
Do not include meta-commentary about incomplete or truncated source data (e.g. "vendor name incomplete in agenda", "details not publicly shared", "agenda item unclear"). If a detail isn't in the source, just omit that bullet — do not substitute an invented one.

Agenda excerpts are often cut off mid-sentence ("...for FY 2026-", "provide direction on the"). Summarize only the part you can actually read; never guess how a truncated sentence ends or invent the missing object. Saratoga's June 3 2026 digest turned the fragment "provide direction on the" into a bullet about "implementing the chosen service level" — nothing in the source said that.

The source is an agenda, not minutes: it lists what is before the body, not the order things happened. Never narrate a sequence of events ("once the Council settled on X, it moved to Y") — the agenda cannot support it.

Match the source's wording on sensitive framing. If the agenda says "federal civil enforcement," do not narrow it to "immigration enforcement," "tax enforcement," or any specific subtype unless the source explicitly uses that word.

Match the agenda's exact CEQA determination. "Not a Project" and "Exempt" are different findings — an item the agenda marks "Not a Project" is outside CEQA entirely, so never describe it as exempt or as having an exemption.`;

  // Go through the shared client: it disables extended thinking and raises a
  // named error on truncation. This call used to be an inline fetch asking for
  // 512 tokens with thinking left on, which on claude-sonnet-5 means the
  // response is [thinking, text] and the thinking block eats most of the
  // budget. Campbell's source excerpt is a garbled meeting transcript rather
  // than a clean agenda, so it drew the longest reasoning of any city and blew
  // the ceiling on roughly three runs in four (measured 2026-08-27: 9/12
  // truncated at 512, 0/12 at the current settings). The truncated JSON had no
  // closing brace, the regex below found nothing, and the throw was swallowed
  // by carryForward("summarize-failed") — seven weeks of a stale digest.
  const text = await callClaude(prompt, {
    apiKey: ANTHROPIC_API_KEY,
    maxTokens: 1500,
    label: `digest:${config.city}`,
  });

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
    // Count consecutive carried-forward runs so a persistent gap is separable
    // from one bad night. A successful run writes a fresh object without the
    // field, which resets the streak.
    const runs = (Number(prev.carriedForwardRuns) || 0) + 1;
    digests[config.city] = {
      ...prev,
      carriedForward: true,
      carryForwardReason: reason,
      carriedForwardRuns: runs,
    };
    console.warn(`  ↻ ${config.cityName}: carrying forward previous digest (${prev.meetingDateIso}), run ${runs} in a row (city=${config.city}, reason=${reason})`);
  }

  // Cutoff: if Stoa's record is older than this, try Legistar fallback
  const stoaStaleCutoff = new Date(Date.now() - STOA_STALENESS_DAYS * 86_400_000)
    .toISOString().split("T")[0];

  for (const config of CITIES) {
    let meeting = byCity[config.stoaCity];

    const stoaStale = !meeting || meeting.date < stoaStaleCutoff;
    const fallbackSource = pastMeetingFallback(config);
    if (stoaStale && fallbackSource) {
      const stoaDateLabel = meeting ? meeting.date : "none";
      process.stdout.write(`  ↻ ${config.cityName}: Stoa stale (${stoaDateLabel}), trying ${fallbackSource.provider}...`);
      try {
        const fallback = await fallbackSource.fetch();
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
      // Set when the relabel can cite the retitled body's own agenda, so the
      // digest doesn't source an ARB/commission item to the Council's page.
      let bodySourceUrl = null;
      if (!config.councilBody && (config.legistarApi || config.primegov) && /^city council\b/i.test(bodyLabel)) {
        // Pass the record's own text: when several bodies met that day, the
        // verifier needs it to tell which one this agenda came from.
        const recordText = `${meeting.title || ""} ${meeting.excerpt || ""}`;
        const actual = config.legistarApi
          ? await verifyLegistarBodyOnDate(config.legistarApi, meeting.date, recordText)
          : await verifyPrimeGovBodyOnDate(config.primegov, meeting.date, recordText);
        if (actual?.body) {
          console.warn(`  ⚠️  ${config.cityName}: no City Council meeting on ${meeting.date} — relabeling as "${actual.body}" (city=${config.city})`);
          bodyLabel = actual.body;
          bodySourceUrl = actual.sourceUrl;
        } else if (actual && actual.councilMet === false) {
          // The council provably did not sit, but several bodies did and the
          // record's text doesn't say which one this agenda came from. Naming
          // any of them would be a coin flip; keeping "City Council" is a claim
          // the calendar contradicts. Hold the previous digest instead — the
          // one option that asserts nothing false.
          console.warn(`  ⚠️  ${config.cityName}: no City Council meeting on ${meeting.date} and the record's body is ambiguous — holding previous digest (city=${config.city})`);
          carryForward(config, "body-unresolved");
          continue;
        } else if (!actual) {
          // The verifier could not answer (fetch failed, or the date is absent
          // from the calendar). It is configured for this city precisely because
          // upstream mislabels reach here, so silence is not agreement — falling
          // through would publish an unchecked "City Council" heading on whatever
          // body actually met. Palo Alto's 2026-08-26 Economic Development
          // Committee meeting shipped as "Palo Alto City Council" this way on
          // 2026-09-01, complete with the Council's meets-on cadence and agenda
          // link; the identical PrimeGov call resolved the committee correctly
          // when replayed. Hold the previous digest and let the log say why.
          console.warn(`  ⚠️  ${config.cityName}: could not verify which body met on ${meeting.date} — holding previous digest (city=${config.city})`);
          carryForward(config, "body-unverified");
          continue;
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
        // config.agendaUrl is the *City Council* agenda page, and it is the last
        // resort. When the digest was relabeled to another body above, citing it
        // misattributes the item to a body that never heard it — Palo Alto's
        // Aug 6 2026 ARB wireless item shipped pointing at the Council page — so
        // the relabeled body's own agenda wins. A first-party fallback likewise
        // already knows the exact page it read, and citing the portal's landing
        // page instead makes the reader hunt for the meeting being summarized.
        sourceUrl:
          bodySourceUrl
          ?? meeting.sourceUrl
          ?? (config.legistar ? legistarMeetingUrl(config.legistar, meeting.date) : config.agendaUrl),
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
    await reportFreshness(previousDigests, today, "no digests generated this run");
    return;
  }

  writeFileAtomic(OUT_PATH, JSON.stringify(digests, null, 2) + "\n");
  console.log(`\nDone — ${Object.keys(digests).length} digests written to ${OUT_PATH}`);

  await reportFreshness(digests, today);
}

// The carry-forward above is deliberately soft, which is why nobody noticed it
// running for seven weeks. Close that loop: say out loud, every run, which
// cities are publishing something a resident would call current — and DM #tasks
// when one isn't. See lib/digest-staleness.mjs for why the published meeting
// date, not the carry-forward streak, is the signal that actually tracks this.
async function reportFreshness(digests, today, context = "") {
  const { alerts, ok } = auditDigestFreshness({ cities: CITIES, digests, today });
  if (ok) {
    console.log(`✅ freshness: all ${CITIES.length} cities within ${MAX_DIGEST_AGE_DAYS} days`);
    return;
  }

  console.warn(`\n⚠️  freshness: ${alerts.length} of ${CITIES.length} cities need attention`);
  for (const alert of alerts) console.warn(`   ${alert.cityName}: ${alert.detail}`);

  await catSignal({
    key: "digest-staleness",
    title: "Council digests are going stale",
    body:
      (context ? `${context}\n\n` : "") +
      `${alerts.length} of ${CITIES.length} city digests are past the ` +
      `${MAX_DIGEST_AGE_DAYS}-day floor or stuck on a carried-forward card:\n\n` +
      `${formatFreshnessAlert(alerts)}\n\n` +
      "Fix the upstream source (Stoa ingestion or the city's own portal), then " +
      "re-run `npm run generate-digests`.",
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
