#!/usr/bin/env node
/**
 * generate-around-town.mjs
 *
 * Generates "Around the South Bay" items from multiple public-record sources:
 *   1. City Council meetings (via Stoa API)
 *   2. Planning Commission meetings (via Stoa API)
 *   3. Notable building permits (from permit-pulse.json)
 *   4. Development tracker status changes (from development-data.ts)
 *
 * Usage:
 *   node --env-file=.env.local scripts/generate-around-town.mjs
 */

import { readFileSync, existsSync } from "fs";
import { writeFileAtomic } from "./lib/io.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { loadEnvLocal } from "./lib/env.mjs";
import { legistarMeetingUrl } from "./lib/civic-meetings.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "around-town.json");
const DEV_CACHE_PATH = join(__dirname, "..", "src", "data", "south-bay", ".dev-status-cache.json");
const PERMIT_PATH = join(__dirname, "..", "src", "data", "south-bay", "permit-pulse.json");
const DEV_DATA_PATH = join(__dirname, "..", "src", "data", "south-bay", "development-data.ts");

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const CLAUDE_SONNET = "claude-sonnet-5";

// ── City config ──

const CITIES = [
  { stoaCity: "Campbell",      cityId: "campbell",      cityName: "Campbell",      agendaUrl: "https://www.campbellca.gov/AgendaCenter/City-Council-10",              permitUrl: null },
  // Saratoga + Los Altos: the *-ca.municodemeetings.com hosts now serve a cert
  // for *.teammunicode.com, so they fail TLS verification in a browser. Point at
  // the cities' own agenda portals (same URLs generate-digests.mjs uses).
  { stoaCity: "Saratoga",      cityId: "saratoga",      cityName: "Saratoga",      agendaUrl: "https://www.saratoga.ca.us/AgendaCenter/City-Council-13",              permitUrl: null },
  { stoaCity: "Los Altos",     cityId: "los-altos",     cityName: "Los Altos",     agendaUrl: "https://losaltosca.portal.civicclerk.com/",                            permitUrl: null },
  { stoaCity: "Los Gatos",     cityId: "los-gatos",     cityName: "Los Gatos",     agendaUrl: "https://losgatos-ca.municodemeetings.com/",                            permitUrl: null },
  { stoaCity: "San Jose",      cityId: "san-jose",      cityName: "San José",      agendaUrl: "https://sanjose.legistar.com/Calendar.aspx",      legistar: "sanjose",      permitUrl: "https://sjpermits.org/" },
  { stoaCity: "Mountain View", cityId: "mountain-view", cityName: "Mountain View", agendaUrl: "https://mountainview.legistar.com/Calendar.aspx", legistar: "mountainview",  permitUrl: null },
  { stoaCity: "Sunnyvale",     cityId: "sunnyvale",     cityName: "Sunnyvale",     agendaUrl: "https://sunnyvale.legistar.com/Calendar.aspx",    legistar: "sunnyvale",     permitUrl: null },
  { stoaCity: "Cupertino",     cityId: "cupertino",     cityName: "Cupertino",     agendaUrl: "https://cupertino.legistar.com/Calendar.aspx",    legistar: "cupertino",     permitUrl: null },
  { stoaCity: "Santa Clara",   cityId: "santa-clara",   cityName: "Santa Clara",   agendaUrl: "https://santaclara.legistar.com/Calendar.aspx",   legistar: "santaclara",    permitUrl: null },
  // Milpitas: ci.milpitas.ca.gov no longer presents a valid cert — milpitas.gov
  // is the live domain. Palo Alto: the cityofpaloalto.org paths 301 to
  // paloalto.gov and 404 there; PermitView is the portal generate-permits.mjs
  // actually reads.
  { stoaCity: "Milpitas",      cityId: "milpitas",      cityName: "Milpitas",      agendaUrl: "https://www.milpitas.gov/129/Agendas-Minutes",                         permitUrl: null },
  { stoaCity: "Palo Alto",     cityId: "palo-alto",     cityName: "Palo Alto",     agendaUrl: "https://www.paloalto.gov/City-Hall/City-Council/Council-Agendas-Minutes", legistar: "paloalto", permitUrl: "https://gis.cityofpaloalto.org/PermitView/" },
];

const CITY_BY_STOA = Object.fromEntries(CITIES.map((c) => [c.stoaCity, c]));

// ── Helpers ──

async function claudeJson(prompt, maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  const msg = await res.json();
  const text = msg.content?.find((c) => c.type === "text")?.text ?? "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  return JSON.parse(jsonMatch[0]);
}

function makeId(cityId, date, headline) {
  // sha1 of the headline keeps the suffix stable across runs while avoiding
  // the collisions the old base64-slice produced for headlines that share a
  // long common prefix ("Council to update ..." → identical 8-char prefix,
  // same ID for two distinct items on the same city+date).
  const hash = createHash("sha1").update(headline).digest("hex").slice(0, 8);
  return `${cityId}-${date}-${hash}`;
}

// ── Boilerplate detection (shared with generate-digests.mjs) ──

const PLACEHOLDER_EXCERPTS = ["meeting agenda available", "search for specific items", "no items", "translation:"];
const BOILERPLATE_PHRASES = [
  "how to observe the meeting",
  "cable channel",
  "live translations in over",
  "wordly.ai",
  "americans with disabilities act",
  "scroll to the end for information about",
  "rules of conduct of the meeting",
  "anyone wishing to address",
  "this meeting is being conducted",
  "this portion of the meeting is reserved",
];

function hasRealContent(r) {
  const ex = (r.excerpt || "").toLowerCase().trim();
  if (ex.length < 60) return false;
  if (PLACEHOLDER_EXCERPTS.some((p) => ex.startsWith(p))) return false;
  const boilerplateHits = BOILERPLATE_PHRASES.filter((p) => ex.includes(p)).length;
  if (boilerplateHits >= 2) return false;
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 1 + 2: Council + Planning Commission meetings from Stoa
// ══════════════════════════════════════════════════════════════════════════════

async function fetchStoaMeetings(meetingType) {
  const label = meetingType.replace("+", " ");
  console.log(`\n📋 Fetching ${label} meetings from Stoa...`);
  const allRecords = [];
  for (const config of CITIES) {
    const url = `https://www.stoa.works/api/council-meetings?city=${encodeURIComponent(config.stoaCity)}&type=${meetingType}&limit=10`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "SouthBaySignal/1.0 (stanwood.dev; internal data sharing)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      allRecords.push(...(data.records ?? []));
    } catch {}
  }
  console.log(`  Got ${allRecords.length} ${label} records`);
  return allRecords;
}

async function findInterestingItems(config, meetings, bodyType) {
  const content = meetings.map((m) => {
    const excerpt = (m.excerpt || "")
      .replace(/^Kind:\s*captions\s+Language:\s*\w+\s*/i, "")
      .trim();
    return `Date: ${m.date}\nBody: ${bodyType}\nTitle: ${m.title || ""}\nAgenda: ${excerpt}\nKeywords: ${(m.keywords || []).join(", ")}`;
  }).join("\n\n---\n\n");

  const bodyNote = bodyType === "Planning Commission"
    ? "These are Planning Commission meetings — focus on development projects, zoning decisions, design review, and land use changes."
    : "";

  const prompt = `You are reading recent ${config.cityName}, CA ${bodyType} meeting agendas and minutes.
${bodyNote}

Your job: identify items that a South Bay resident would genuinely find interesting, surprising, or worth knowing about.

SKIP: routine approvals, consent calendar, minutes approval, procedural items, public comment with no outcome, generic budget discussions, YouTube/Zoom instructions.

SKIP HARDER: items where the agenda only shows a title (e.g. "Terminal Elevator Replacement Project") without enough substance to summarize. If you'd need to speculate or hedge ("though specifics weren't provided", "details unclear", "this could affect..."), the right move is to leave the item out, not to write a vague summary. A resident reading hedge text feels like they're reading filler.

NEVER FABRICATE: do not invent case names, party names, dollar amounts, vote counts, addresses, agency or regulator names, or any specific fact not present in the agenda data. Closed session line items often list only a citation like "Conf. with Legal Counsel — existing litigation" with no party names — if a name isn't in the source, do not make one up. Skip the item. When the source references compliance with regulations but doesn't name the specific agency, say "regional air quality regulations" or "state requirements" rather than inventing an agency name (e.g. there is no "South Bay Air District" — Bay Area air quality is regulated by BAAQMD).

NEVER NAME STAFF CONTACTS: Legistar agendas include bureaucratic metadata like "Staff Contact: Jane Doe" or "Project Manager: John Smith" or "Sponsoring Department: …". These identify the city employee handling the paperwork, NOT the subject of the action. Never write "This follows the staff contact listing X", "named X as the new …", or treat a staff-contact name as the appointee/principal of the item. Omit these names entirely.

MATCH THE SOURCE'S FRAMING — DO NOT NARROW: if a council resolution restricts "federal civil enforcement," do not narrow it to "immigration enforcement," "tax enforcement," or any specific subtype unless the agenda explicitly uses that word. Do not invent illustrative examples ("for immigration, tax, or other..."). Stick to the source's wording on sensitive framing.

DO NOT ASSERT APPROVAL FOR FUTURE OR SAME-DAY MEETINGS: if a meeting's date matches today's date and the agenda is forward-looking (e.g. "proposed", "to consider", "study session"), do not write that it was approved or adopted. Use forward-looking language ("to hear", "to consider", "scheduled to review") or skip the item.

KEEP: notable development projects (housing, commercial, controversial permits), policy changes affecting residents, contested votes, new programs/ordinances, zoning/land use decisions, physical changes to the city.

Meeting data:
${content}

NO FILLER ADJECTIVES: do not call a project "significant", "substantial", "major", "large-scale", "notable", or "important" without saying *why* the resident should care. Do not write "This represents …", "This reflects ongoing …", "This underscores …" — sentences that gesture at significance instead of stating it. If you can't name the concrete reason (jobs, units, location, price tag, who's affected), drop the second sentence. One useful sentence beats two with one of them puffed up.

Return a JSON array (may be empty if nothing is interesting). Each item:
{
  "date": "YYYY-MM-DD",
  "headline": "short plain-English headline (max 12 words, no jargon). NEVER start a number with $; fiscal years like 2026-27 must be written as 'FY 2026-27', not '$2026-27'.",
  "summary": "1-2 sentences. What happened, why it matters. Written for a resident. NEVER use relative time words (tonight, today, this week) — use date or day name. NEVER admit you don't know what happened ('though specifics weren't provided', 'details weren't clear', 'without more details') — if you would have to, return [] instead. NEVER pad with filler significance language (see NO FILLER ADJECTIVES above)."
}

Return [] if nothing is genuinely interesting. Quality over quantity.`;

  return claudeJson(prompt);
}

// Filter out items whose summary admits Claude couldn't tell what happened.
// These slip through occasionally even when the prompt forbids them — a thin
// agenda title gets a hedge summary like "though specific details weren't
// provided" or "this could affect X" without any concrete X. Residents read
// these as filler. Drop them programmatically as a safety net.
const HEDGE_PATTERNS = [
  /\b(?:specifics?|details?|content|substance)\s+(?:was|were|wasn'?t|weren'?t)\s+(?:not\s+)?(?:provided|specified|included|made\s+clear|clear|available)\b/i,
  /\bthough\s+(?:specific\s+)?(?:details?|specifics?)\b/i,
  /\bwithout\s+(?:more|further|additional)\s+details?\b/i,
  /\bagenda\s+(?:didn'?t|did\s+not)\s+(?:provide|specify|include|detail)\b/i,
  /\b(?:exact|specific)\s+(?:nature|content|terms|impact)\s+(?:remains|is)\s+unclear\b/i,
  /\bdetails?\s+(?:remain|are)\s+unclear\b/i,
  /\bstaff\s+contact\b/i,
  /\bproject\s+manager\s+(?:is|listing|listed)\b/i,
  /\bsponsoring\s+department\b/i,
];

function isHedgeSummary(summary) {
  const s = String(summary || "");
  return HEDGE_PATTERNS.some((re) => re.test(s));
}

// AI-speak filler: a trailing sentence that gestures at significance without
// naming a concrete reason. Three real shapes pulled from around-town.json:
//   "This large-scale development represents substantial investment in the city's commercial real estate."
//   "The project reflects ongoing corporate investment in San José's commercial districts."
//   "This represents a significant leadership decision for the city's executive administration."
// First sentences in those items carried real info (dollar amount, address,
// action) — only the second sentence was padding. Strip the padding sentence
// instead of dropping the whole item.
const FILLER_TAIL_PATTERNS = [
  /\bthis\s+(?:represents|reflects|underscores|highlights|demonstrates|marks|signals|suggests|indicates)\b/i,
  /\bthe\s+(?:project|decision|action|move|change|update)\s+(?:represents|reflects|underscores|highlights|demonstrates|marks|signals|suggests|indicates)\b/i,
  /\bthis\s+(?:large[-\s]scale|major|significant|substantial)\s+\w+\s+(?:represents|reflects|underscores)\b/i,
  /\b(?:represents|reflects)\s+(?:ongoing|substantial|significant|continued)\s+\w+\s+in\b/i,
];

// "X and suggests/indicates/signals a major Y in the city/area" — a conjunctive
// AI-hedge tail tacked onto a real first clause. Strip only the trailing clause,
// not the whole sentence, so the concrete info before "and" survives.
const FILLER_CONJUNCTIVE_TAIL =
  /,?\s+and\s+(?:suggests|indicates|signals|points\s+to|reflects)\s+(?:a|an|ongoing|continued|growing|broader|wider)\s+[^.!?]*[.!?]?\s*$/i;

function stripFillerTail(summary) {
  const s = String(summary || "").trim();
  if (!s) return s;
  // Split on sentence-ending punctuation followed by whitespace and a capital.
  const sentences = s.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const trimmed = sentences.length >= 2 && FILLER_TAIL_PATTERNS.some((re) => re.test(sentences[sentences.length - 1]))
    ? sentences.slice(0, -1).join(" ").trim()
    : s;
  // Strip a trailing "and suggests/indicates/signals …" clause from the final sentence.
  return trimmed.replace(FILLER_CONJUNCTIVE_TAIL, (match) => {
    const endsWithPunct = /[.!?]\s*$/.test(match);
    return endsWithPunct ? "." : "";
  });
}

// Permit exports abbreviate the street type ("1803 Bradford Wy", "151
// University Av", "3055 Orchard Dr"). Claude usually expands it in the
// headline and then pastes the raw form into the summary, so one item shipped
// as "Bradford Way" up top and "1803 Bradford Wy" in the body. Expand
// deterministically instead of adding another prompt rule.
//
// Anchored to a street number so the abbreviation can only be read as a street
// type: "Dr" after "3055 Orchard" is Drive, "Dr" before a surname is a title
// and never follows a house number.
const STREET_TYPES = {
  av: "Avenue", ave: "Avenue", blvd: "Boulevard", cir: "Circle", ct: "Court",
  dr: "Drive", ln: "Lane", pkwy: "Parkway", pl: "Place", rd: "Road",
  st: "Street", ter: "Terrace", wy: "Way", way: "Way",
};
// Capture the trailing token generically and look it up, rather than baking the
// keys into the pattern — an inline alternation would need the /i flag, which
// would also loosen the [A-Z] street-name guard into matching lowercase prose.
// The street-name run is LAZY. Greedy, it swallowed the abbreviation itself and
// tested the word after it: "1803 Bradford Wy has received" matched "Bradford
// Wy " as the name and "has" as the street type, found no entry, and left the
// address untouched. Shortest-first tries "Bradford" + "Wy" and hits.
const STREET_ADDRESS = /\b(\d+\s+(?:[A-Z][A-Za-z'’.-]*\s+){1,3}?)([A-Za-z]{2,5})\b\.?/g;

function expandStreetAbbreviations(text) {
  return String(text || "").replace(STREET_ADDRESS, (match, head, abbrev) => {
    const full = STREET_TYPES[abbrev.toLowerCase()];
    // Not a street type, or already spelled out — leave the original alone.
    if (!full || full.toLowerCase() === abbrev.toLowerCase()) return match;
    return `${head}${full}`;
  });
}

async function gatherMeetingItems(meetingType) {
  const label = meetingType.replace("+", " ");
  const sourceTag = meetingType === "City+Council" ? "council" : "planning";
  const records = await fetchStoaMeetings(meetingType);

  const today = new Date().toISOString().split("T")[0];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffIso = cutoff.toISOString().split("T")[0];

  const SKIP_TYPES = new Set(["closed session", "special meeting"]);
  const items = [];

  for (const config of CITIES) {
    const cityMeetings = records.filter((r) =>
      r.city === config.stoaCity &&
      r.date <= today &&
      r.date >= cutoffIso &&
      hasRealContent(r) &&
      !SKIP_TYPES.has((r.title || "").toLowerCase())
    ).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);

    if (!cityMeetings.length) continue;

    console.log(`  ⏳ ${config.cityName} (${label}): evaluating ${cityMeetings.length} meetings...`);

    try {
      const found = await findInterestingItems(config, cityMeetings, label);
      for (const item of found) {
        const sourceUrl = config.legistar
          ? legistarMeetingUrl(config.legistar, item.date)
          : config.agendaUrl;
        items.push({
          id: makeId(config.cityId, item.date, item.headline),
          cityId: config.cityId,
          cityName: config.cityName,
          date: item.date,
          headline: expandStreetAbbreviations(item.headline),
          summary: expandStreetAbbreviations(item.summary),
          sourceUrl,
          source: sourceTag,
        });
        console.log(`  ✅ ${config.cityName}: ${item.headline}`);
      }
      if (!found.length) console.log(`  — ${config.cityName}: nothing interesting`);
    } catch (err) {
      console.error(`  ❌ ${config.cityName}: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return items;
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 3: Notable building permits from permit-pulse.json
// ══════════════════════════════════════════════════════════════════════════════

async function gatherPermitItems() {
  console.log("\n🏗️  Scanning permits...");
  if (!existsSync(PERMIT_PATH)) {
    console.log("  ⏭️  permit-pulse.json not found, skipping");
    return [];
  }

  const data = JSON.parse(readFileSync(PERMIT_PATH, "utf8"));
  const allNotable = [];

  for (const [cityId, cityData] of Object.entries(data.cities || {})) {
    const config = CITIES.find((c) => c.cityId === cityId);
    if (!config) continue;

    const PERMIT_BLOCKLIST = /\b(reroof|re-roof|roofing|roof replacement)\b/i;
    const permits = (cityData.permits || []).filter((p) => {
      // Skip boring permits
      if (PERMIT_BLOCKLIST.test(p.description || "")) return false;
      // Notable: high value, new construction, entitlements, or adds housing units
      if (p.valuation > 500_000) return true;
      if (["residential-new", "commercial-large", "entitlement"].includes(p.category)) return true;
      if (p.units > 0) return true;
      return false;
    });

    if (permits.length) {
      // No second truncation here. generate-permits.mjs already caps each city
      // at its top 10 notable permits, and slicing to 8 silently hid the tail:
      // on 2026-08-10 San José had three Villa Homes prefab ADUs at 3180 Rubino
      // Dr (#121/#123/#125), #125 fell outside the slice, and the item shipped
      // as "Two prefab ADUs permitted at same Rubino Drive complex".
      allNotable.push({ config, permits });
    }
  }

  if (!allNotable.length) {
    console.log("  — No notable permits found");
    return [];
  }

  // Batch all notable permits into one Claude call per city
  const items = [];
  for (const { config, permits } of allNotable) {
    const permitText = permits.map((p) =>
      `- ${p.categoryLabel || p.category}: ${p.description || "No description"} at ${p.address || "unknown address"} ($${(p.valuation || 0).toLocaleString()}, ${p.units || 0} units, issued ${p.issueDate})`
    ).join("\n");

    console.log(`  ⏳ ${config.cityName}: evaluating ${permits.length} notable permits...`);

    try {
      const found = await claudeJson(`These are recently issued building permits in ${config.cityName}, CA. Pick the 1-2 most interesting ones that a resident would care about — new businesses, new housing, large construction projects, or anything unusual. Skip routine renovations and ADUs unless they fit a broader pattern worth pointing out.

Permits:
${permitText}

IMPORTANT — a permit being issued means construction is *cleared to begin*, NOT that it has started. Do NOT write "breaks ground", "groundbreaking", "construction begins", "construction starts", or "launches" — those imply a milestone the data does not support. Use language like "permitted", "receives building permit", "cleared to build", "permit issued for". Do NOT label projects as "affordable", "workforce", or "luxury" unless that wording appears in the permit description.

NOT NAMES: San José permit descriptions carry a trade-scope code in parentheses — "(Bemp 100%)", "(Bepm100%)", "(Bep 100%)", "(B 100%)", "(B)", and "Srp" prefixes. These are Building/Electrical/Plumbing/Mechanical scope markers, NOT developers, businesses, or project names. Never name them as a party ("developer Bemp"). Ignore them entirely. Only name a developer, owner, or tenant when it appears in the description as an actual name.

COUNTS: the list above is the notable permits only, not every permit issued. If you state a count ("two ADUs", "three units"), it must match exactly what is listed — count the lines, do not estimate. When several permits share one address, prefer wording that does not hinge on a total ("prefab ADUs permitted at…").

NO FILLER ADJECTIVES: do not call a project "significant", "substantial", "major", "large-scale", "notable", or "important" without saying *why* the resident should care. Do not write "This represents …", "This reflects ongoing …", "This underscores …" — sentences that gesture at significance instead of stating it. If you can't name the concrete reason (square footage, units, tenant, dollar tag in context, neighborhood impact), drop the second sentence. One useful sentence beats two with one of them puffed up.

Return a JSON array. Each item:
{
  "date": "YYYY-MM-DD",
  "headline": "short plain-English headline (max 12 words). Use permit-accurate verbs only.",
  "summary": "1-2 sentences. What's being permitted, where, why it matters. Do not assert construction has started. No filler significance language."
}

Return [] if nothing is genuinely noteworthy.`, 512);

      for (const item of found) {
        items.push({
          id: makeId(config.cityId, item.date, item.headline),
          cityId: config.cityId,
          cityName: config.cityName,
          date: item.date,
          headline: expandStreetAbbreviations(item.headline),
          summary: expandStreetAbbreviations(item.summary),
          sourceUrl: config.permitUrl || config.agendaUrl,
          source: "permit",
        });
        console.log(`  ✅ ${config.cityName}: ${item.headline}`);
      }
      if (!found.length) console.log(`  — ${config.cityName}: no noteworthy permits`);
    } catch (err) {
      console.error(`  ❌ ${config.cityName} permits: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return items;
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 4: Development tracker status changes
// ══════════════════════════════════════════════════════════════════════════════

const STATUS_LABELS = {
  proposed: "Proposed",
  approved: "Approved",
  "under-construction": "Under Construction",
  "opening-soon": "Opening Soon",
  completed: "Completed",
  "on-hold": "On Hold",
};

function gatherDevItems() {
  console.log("\n🏢 Checking development tracker...");
  if (!existsSync(DEV_DATA_PATH)) {
    console.log("  ⏭️  development-data.ts not found, skipping");
    return [];
  }

  // Parse projects from the TS file using vm to eval the JS array literal
  const tsContent = readFileSync(DEV_DATA_PATH, "utf8");
  const arrayMatch = tsContent.match(/DevProject\[\]\s*=\s*(\[[\s\S]*?\n\])\s*;/);
  if (!arrayMatch) {
    console.log("  ⚠️  Could not find projects array in development-data.ts");
    return [];
  }

  let projects;
  try {
    // The array literal is valid JS — eval it directly (trusted local file)
    projects = eval(`(${arrayMatch[1]})`);
  } catch (err) {
    console.log(`  ⚠️  Could not parse projects: ${err.message}`);
    return [];
  }

  // Load previous status cache
  let prevCache = {};
  if (existsSync(DEV_CACHE_PATH)) {
    try {
      prevCache = JSON.parse(readFileSync(DEV_CACHE_PATH, "utf8"));
    } catch {}
  }

  const isFirstRun = Object.keys(prevCache).length === 0;
  const today = new Date().toISOString().split("T")[0];
  const items = [];

  // Build new cache and detect changes
  const newCache = {};
  for (const p of projects) {
    newCache[p.id] = p.status;

    if (isFirstRun) continue; // Seed run — don't generate items
    if (prevCache[p.id] === p.status) continue; // No change

    const oldLabel = STATUS_LABELS[prevCache[p.id]] || prevCache[p.id] || "New";
    const newLabel = STATUS_LABELS[p.status] || p.status;
    const headline = prevCache[p.id]
      ? `${p.name} moves to ${newLabel.toLowerCase()}`
      : `${p.name} added to development tracker`;
    const summary = prevCache[p.id]
      ? `${p.name} in ${p.city} has moved from ${oldLabel} to ${newLabel}.${p.scale ? ` The ${p.category} project is ${p.scale}.` : ""}`
      : `${p.name} in ${p.city} (${newLabel}) has been added to the development tracker.${p.scale ? ` Scale: ${p.scale}.` : ""}`;

    items.push({
      id: makeId(p.cityId, today, headline),
      cityId: p.cityId,
      cityName: p.city,
      date: today,
      headline,
      summary,
      sourceUrl: "", // no external source
      source: "development",
    });
    console.log(`  ✅ ${p.city}: ${headline}`);
  }

  // Save updated cache
  writeFileAtomic(DEV_CACHE_PATH, JSON.stringify(newCache, null, 2) + "\n");

  if (isFirstRun) {
    console.log(`  📦 First run — seeded cache with ${Object.keys(newCache).length} projects (no items generated)`);
  } else if (!items.length) {
    console.log("  — No status changes detected");
  }

  return items;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN: gather, merge, deduplicate, output
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  // Gather from all sources
  const [councilItems, planningItems, permitItems] = await Promise.all([
    gatherMeetingItems("City+Council"),
    gatherMeetingItems("Planning+Commission"),
    gatherPermitItems(),
  ]);
  const devItems = gatherDevItems(); // sync, no API calls

  const allItems = [...councilItems, ...planningItems, ...permitItems, ...devItems];
  console.log(`\n📊 Totals: ${councilItems.length} council, ${planningItems.length} planning, ${permitItems.length} permit, ${devItems.length} development`);

  // Hedge-summary filter: drop items where Claude wrote vague "specifics weren't
  // provided / details unclear / could affect..." filler. These slip past even
  // a strict prompt and look like junk on city pages.
  const hedgeFiltered = allItems.filter((item) => {
    if (isHedgeSummary(item.summary)) {
      console.log(`  🪓 dropped hedge summary [${item.cityName}]: ${item.headline}`);
      return false;
    }
    return true;
  });
  if (hedgeFiltered.length < allItems.length) {
    console.log(`  ${allItems.length - hedgeFiltered.length} hedge items dropped`);
  }

  // Filler-tail trim: strip a trailing "This represents …" / "The project
  // reflects ongoing …" sentence so the deploy keeps the useful first sentence
  // without the AI-speak puff. Safety net for the NO FILLER ADJECTIVES prompt
  // rule — same shape as hedge but rewrites rather than drops.
  let trimmed = 0;
  for (const item of hedgeFiltered) {
    const before = item.summary;
    const after = stripFillerTail(before);
    if (after !== before) {
      item.summary = after;
      trimmed += 1;
      console.log(`  ✂️  trimmed filler tail [${item.cityName}]: ${item.headline}`);
    }
  }
  if (trimmed) console.log(`  ${trimmed} filler tails trimmed`);

  // Sort by date descending
  hedgeFiltered.sort((a, b) => b.date.localeCompare(a.date));

  // Simple dedup: if two items from the same city have very similar headlines, keep the first (higher priority source)
  const seen = new Set();
  const deduped = hedgeFiltered.filter((item) => {
    const key = `${item.cityId}-${item.headline.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const topItems = deduped.slice(0, 8);

  const output = {
    items: topItems,
    generatedAt: new Date().toISOString(),
  };

  writeFileAtomic(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ Done — ${topItems.length} items written to ${OUT_PATH}`);
  for (const item of topItems) {
    console.log(`  [${item.source}] ${item.cityName} (${item.date}): ${item.headline}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
