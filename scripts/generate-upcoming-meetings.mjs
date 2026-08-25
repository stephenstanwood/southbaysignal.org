#!/usr/bin/env node
/**
 * generate-upcoming-meetings.mjs
 *
 * Queries the Legistar Web API (free, no auth) for each South Bay city's
 * next scheduled council meeting and writes the results to
 * src/data/south-bay/upcoming-meetings.json.
 *
 * Also fetches the top substantive agenda items for each meeting so the
 * Government tab can show a forward-looking preview of what's on the docket.
 *
 * Run: node scripts/generate-upcoming-meetings.mjs
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileAtomic } from "./lib/io.mjs";
import {
  confirmMeeting,
  isClosedSessionMeeting,
  legistarMeetingUrl,
  normalizeMeetingTime,
  onlyConfirmedMeetings,
  pickCivicClerkMeeting,
  ptDateISO,
} from "./lib/civic-meetings.mjs";
import { overlayPaloAltoStateOfTheCity } from "./lib/palo-alto-state-of-the-city-2026.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "upcoming-meetings.json");

const UA = "SouthBaySignal/1.0 (stanwood.dev; public civic data aggregator)";

const LEGISTAR_CITIES = [
  { city: "san-jose",      client: "sanjose",      site: "sanjose",      body: "City Council" },
  { city: "mountain-view", client: "mountainview", site: "mountainview", body: "City Council" },
  { city: "sunnyvale",     client: "sunnyvaleca",  site: "sunnyvaleca",  body: "City Council" },
  { city: "cupertino",     client: "cupertino",    site: "cupertino",    body: "City Council" },
  { city: "santa-clara",   client: "santaclara",   site: "santaclara",   body: "City Council" },
];

// Phrases that indicate a boilerplate/procedural agenda item to skip
const SKIP_PREFIXES = [
  "please scroll", "for live translation", "any member of the public",
  "you may speak", "to speak online", "by email", "members of the public", "to request",
  "the levine act", "how to", "fill out a", "each speaker", "notice to the public",
  "all public records", "page break", "open forum",
];
const SKIP_EXACT = new Set([
  "call to order", "roll call", "pledge of allegiance", "invocation",
  "adjournment", "closed session", "open session", "recess",
  "orders of the day", "postponements and orders of the day",
  "closed session report", "consent calendar", "end of consent calendar",
  "land use consent calendar", "ceremonial items", "strategic support",
  "public safety services", "transportation & aviation services",
  "environmental & utility services", "neighborhood services",
  "community & economic development", "redevelopment – successor agency",
  "land use", "land use - regular agenda", "regular agenda", "open forum",
  "adjournment recognition", "public hearings", "special meeting",
  "closed session, call to order in council chambers",
  "american disability act", "public comment in person only",
  "public comment", "public hearing",
  "final adoption of ordinances", "final adoption of ordinances.",
  "first reading of ordinances", "first reading of ordinances.",
]);

// Prefixes that indicate procedural/non-substantive items
const SKIP_STARTS_WITH = [
  "call to order", "roll call", "regular session,", "closed session,",
  "public comment", "subject:  conference with legal counsel",
  "subject:  conference with real property",
  // Invocation: drop the heading itself ("Invocation (District 5)") and the
  // clergy speaker line that often follows it (Father/Pastor/Rabbi/...).
  "invocation",
];

// Patterns matching purely procedural items that should never count as
// substantive even when their wording sneaks past the prefix lists.
const SKIP_REGEX = [
  // "Approval of [date] City Council meeting minutes" — pure ratification
  /\bapproval of (?:the )?(?:[a-z\d ,]+ )?(?:meeting )?minutes\b/i,
  // "Monthly Treasurer's Report / Investment Report" — recurring filings
  /\bmonthly treasurer'?s\s+(?:investment\s+)?report\b/i,
  // Brown Act closed-session boilerplate without a "Subject:" wrapper.
  // Mountain View posts these as bare titles, e.g.
  // "Conference with Real Property Negotiator (California Government Code §54956.8)".
  /^conference with (?:legal counsel|real property|labor)/i,
  // Closed-session procedure. The council convening, or citing the Brown Act
  // section it is convening under, is not public business — Sunnyvale's Aug 25
  // agenda is nothing but these, and "Convene to Closed Session" shipped as the
  // city's lead civic highlight for the week.
  /^convene to closed session\b/i,
  /^closed session held pursuant to\b/i,
  /^adjourn(?:ment)? (?:from|to) closed session\b/i,
  // Personnel matters heard in closed session. Mountain View posts the bare
  // Brown Act title with no "Conference with" prefix, so the rule above misses
  // it: "Public Employee Performance Evaluation (California Government Code
  // §54957(b)(1))" was the city's only listed item and became its highlight.
  /^public (?:employee|employment)\b/i,
  /government code\s*§?\s*(?:section\s*)?5495[6-9]/i,
  // Standing procedural report slots that appear on every agenda: excused
  // absences, councilmember travel reports, liaison reports, and the manager's
  // verbal report. Recurring housekeeping, never news.
  /^(?:mayor and )?council(?:member)?s? (?:excused absence|travel report)/i,
  /^report (?:from|of) the (?:council liaison|city manager|city attorney|mayor)\b/i,
  /^(?:city )?council travel reports?\b/i,
  // "Public Participation and Access" — the how-to-attend block, sibling of the
  // "public comment" prefix already listed above.
  /^public participation\b/i,
  // Section banners like "CONSENT CALENDAR (Items 5-18)" that escape the
  // all-caps filter because of the parenthetical.
  /^consent calendar\s*\(/i,
  /^closed session\s*\(/i,
  /^public hearings?\s*\(/i,
  // Clergy invocation speaker lines. These are people's names attached to a
  // church/temple/congregation — e.g. "Father Hugo Rojas, Our Lady of
  // Guadalupe Church". Drop them; they are not agenda business.
  /^(?:father|reverend|rev\.|pastor|rabbi|imam|bishop|deacon|chaplain|minister|monsignor|sister|brother)\b[^.]*?,\s*(?:[a-z' ]+ )?(?:church|temple|synagogue|mosque|congregation|parish|chapel|cathedral|fellowship|ministr(?:y|ies))\b/i,
  // San José meta-procedural explainer attached to most agendas — text
  // describing how items get added/dropped, not actual business.
  /^items?\s+recommended\s+to\s+be\s+(?:added|dropped|deferred)/i,
  // San José boilerplate translation/interpretation block. Two heading
  // variants appear on different agendas — "Language Access Information:"
  // (how to request written translation) and "Language Access
  // Instructions / Instrucciones de interpretación / Hướng dẫn diễn giải"
  // (the trilingual live-interpretation explainer). Both are agenda
  // boilerplate, not business items.
  /^language access (?:information|instructions)\b/i,
  // The Spanish/Vietnamese halves of the trilingual block sometimes lead
  // when the English heading is split off — match those defensively.
  /^instrucciones de interpretaci[óo]n\b/i,
  /^h[ưu][ớo]ng d[ẫa]n di[ễe]n gi[ảa]i\b/i,
  // Payment ratification — recurring consent items, not news. Catches:
  //   "Approve the List(s) of Claims and Bills..." (Sunnyvale)
  //   "Ratifying Accounts Payable for the periods..." (Cupertino)
  /^approve the list\(?s?\)? of claims and bills\b/i,
  /^ratifying accounts payable\b/i,
  // "Receipt of [Audit|Treasurer's|Quarterly Treasurer's] Report" — quarterly
  // and annual financial filings the council just acknowledges receipt of.
  /^receipt of (?:single audit|the treasurer'?s|treasurer'?s|quarterly treasurer'?s)\b/i,
  // Items annotated "- DEFERRED TO MM/DD/YYYY PER ADMINISTRATION" aren't
  // happening at the current meeting — drop them from the preview.
  /\s[-–]\s*deferred\s+to\b[^.]*\bper\s+administration\b/i,
  // Section-banner items like "Closed Session Agenda", "Land Use Agenda",
  // "Consent Agenda" — these are navigation headers, not business items.
  /^(?:closed session|public hearings?|consent|regular|land use|ceremonial|strategic support|special order(?:s)? of business)\s+agenda$/i,
];

// Strip raw addresses, Brown Act teleconference disclosures, and noise from
// scraped Legistar EventLocation strings so they render as a short venue label.
function cleanLocation(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  // Strip Brown Act teleconference compliance disclosures
  s = s.replace(/[;,]?\s*(and\s+)?Teleconference\s+Location[\s\S]*$/i, "").trim();
  s = s.replace(/[;,]?\s*Pursuant\s+to\s+Gov\.?\s+Code[\s\S]*$/i, "").trim();
  s = s.replace(/\s+and\s+via\s+Teleconference\s*$/i, "").trim();

  // Strip leading street addresses ("10300 Torre Avenue, Council Chamber" → "Council Chamber")
  const streetSuffix = "(?:Avenue|Ave\\.?|Street|St\\.?|Boulevard|Blvd\\.?|Road|Rd\\.?|Drive|Dr\\.?|Way|Lane|Ln\\.?|Court|Ct\\.?|Place|Pl\\.?|Plaza|Parkway|Pkwy\\.?)";
  const leadingAddr = new RegExp(`^\\d+\\s+\\S[^,]*?${streetSuffix}\\b[^,]*,\\s*`, "i");
  while (leadingAddr.test(s)) s = s.replace(leadingAddr, "").trim();
  s = s.replace(new RegExp(`^and\\s+\\d+\\s+\\S[^,]*?${streetSuffix}\\b[^,]*,\\s*`, "i"), "").trim();

  // Strip trailing street addresses ("Council Chambers, City Hall, 456 W. Olive
  // Ave., Sunnyvale, CA 94086" → "Council Chambers, City Hall"). The leading-
  // address strip above doesn't fire when the street number sits in a later
  // comma chunk.
  const trailingAddr = new RegExp(`,\\s*\\d+\\s+\\S[^,]*?${streetSuffix}\\.?[\\s\\S]*$`, "i");
  s = s.replace(trailingAddr, "").trim();
  // Also strip a trailing ", City, ST zip" tail with no street number.
  s = s.replace(/,\s*[A-Za-z][A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5}.*$/, "").trim();

  // Strip meeting join links and anything trailing them. These feed
  // civicMeetingSchema's `venue`, and the 80-char truncation below was cutting
  // San José's Zoom link mid-URL ("... and Virtually - https://sanjoseca.zoom.us/j...").
  s = s.replace(/https?:\/\/\S*[\s\S]*$/i, "").trim();
  // Drop the now-orphaned connector that introduced the link.
  s = s.replace(
    /[\s,;:—–-]*\b(?:and\s+)?(?:virtually|via\s+zoom|via\s+teleconference|online|teleconference|remotely)\b[\s,;:—–-]*$/i,
    "",
  ).trim();

  // Trim trailing punctuation
  s = s.replace(/[,;:—–-]+\s*$/, "").trim();

  if (!s) return null;
  if (s.length > 80) s = s.slice(0, 77) + "...";
  return s;
}

// Tidy a Legistar agenda title for display: take the first line, strip the
// "Subject:" wrapper that Cupertino/Saratoga/etc. prepend to every item, and
// collapse whitespace.
function cleanAgendaTitle(rawTitle) {
  if (!rawTitle) return "";
  let t = rawTitle.split(/\r?\n/)[0].trim();
  t = t.replace(/^subject:\s*/i, "").trim();
  t = t.replace(/\s+/g, " ");
  return t;
}

function isSubstantiveItem(rawTitle) {
  if (!rawTitle) return false;
  // Use only the first line (some items have addresses/details appended via \r\n)
  const t = rawTitle.split(/\r?\n/)[0].trim();
  if (t.length < 20 || t.length > 300) return false;

  const lower = t.toLowerCase();

  // Skip exact boilerplate
  if (SKIP_EXACT.has(lower)) return false;

  // Skip known boilerplate prefixes
  for (const prefix of SKIP_PREFIXES) {
    if (lower.startsWith(prefix)) return false;
  }

  // Skip SKIP_STARTS_WITH patterns
  for (const prefix of SKIP_STARTS_WITH) {
    if (lower.startsWith(prefix)) return false;
  }

  // Some Legistar feeds prefix every item with "Subject:" or "Subject:  ".
  // Run prefix/regex checks against the unwrapped title too so a procedural
  // item doesn't sneak through just because it's wrapped in a Subject:.
  const unwrapped = lower.replace(/^subject:\s*/, "");
  if (unwrapped !== lower) {
    if (SKIP_EXACT.has(unwrapped)) return false;
    for (const prefix of SKIP_PREFIXES) if (unwrapped.startsWith(prefix)) return false;
    for (const prefix of SKIP_STARTS_WITH) if (unwrapped.startsWith(prefix)) return false;
  }

  // Skip purely procedural / ratification / section-banner items
  for (const re of SKIP_REGEX) {
    if (re.test(t) || re.test(unwrapped)) return false;
  }

  // Skip all-caps section headers (e.g. "CONSENT CALENDAR", "PUBLIC PARTICIPATION INFORMATION")
  // Check: no lowercase letters present = it's a header/banner
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) return false;

  // Skip items that are just a URL
  if (/^https?:\/\//.test(t)) return false;

  // Skip items that are just phone numbers or generic procedural notices
  if (/^\d/.test(t) && t.length < 40) return false;

  return true;
}

async function fetchAgendaItems(client, eventId) {
  const url = `https://webapi.legistar.com/v1/${client}/Events/${eventId}/EventItems`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Was silent — swallowing a bad status here (rate limit, client
      // rename, dead eventId) is indistinguishable from "meeting genuinely
      // has no substantive items", which is how staleness investigations
      // for this file kept coming up empty-handed. D30/D31.
      console.warn(`[upcoming-meetings] fetchAgendaItems: ${client}/${eventId} -> HTTP ${res.status} (${url})`);
      return [];
    }
    const items = await res.json();

    // When the feed numbers its agenda items, an item with no number is not
    // business — it is a boilerplate text block or a ceremonial name-only entry.
    // San José's "Association of Indo Americans" (a commendation, unnumbered)
    // otherwise became the city's lead civic highlight while every numbered item
    // on the agenda was procedural. Self-calibrating: cities that never populate
    // EventItemAgendaNumber are unaffected.
    const hasNumbering = items.some((i) => String(i.EventItemAgendaNumber ?? "").trim());
    const numbered = (item) => !hasNumbering || String(item.EventItemAgendaNumber ?? "").trim();

    // Filter to substantive items and take up to 5
    return items
      .filter((item) => isSubstantiveItem(item.EventItemTitle) && numbered(item))
      .slice(0, 5)
      .map((item) => ({
        title: cleanAgendaTitle(item.EventItemTitle),
        sequence: item.EventItemAgendaSequence,
      }));
  } catch (err) {
    console.warn(`[upcoming-meetings] fetchAgendaItems: ${client}/${eventId} -> ${err.message} (${url})`);
    return [];
  }
}

async function fetchNextMeeting(client, site, body) {
  const today = ptDateISO();
  const url =
    `https://webapi.legistar.com/v1/${client}/Events` +
    `?$filter=EventBodyName eq '${body}' and EventDate ge datetime'${today}T00:00:00'` +
    `&$orderby=EventDate asc&$top=10`;

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const events = await res.json();
  const ev = events.find((event) => !/cancel(?:led|ed)|postponed/i.test([
    event.EventDescription,
    event.EventComment,
    event.EventAgendaStatusName,
  ].filter(Boolean).join(" ")));
  if (!ev) return null;
  const date = new Date(ev.EventDate);
  const dateIso = String(ev.EventDate).slice(0, 10);

  // Skip placeholder dates more than 60 days out (common Legistar calendar blocker)
  const daysOut = (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysOut > 60) return null;

  const agendaItems = await fetchAgendaItems(client, ev.EventId);

  const meeting = {
    date: dateIso,
    displayDate: date.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      timeZone: "America/Los_Angeles",
    }),
    // EventDate is midnight for every Legistar row; the wall clock lives in
    // EventTime. Without it nothing downstream could tell San José's 1:30 PM
    // council meeting from Sunnyvale's 5:30 PM one, and the 2026-08-11 email
    // filed both under "Civic meetings tonight".
    startTime: normalizeMeetingTime(ev.EventTime),
    bodyName: ev.EventBodyName,
    location: cleanLocation(ev.EventLocation),
    closedSession: isClosedSessionMeeting({
      bodyName: ev.EventBodyName,
      comment: ev.EventComment,
      description: ev.EventDescription,
    }),
    url: legistarMeetingUrl(site, dateIso, ev.EventInSiteURL),
    legistarEventId: ev.EventId,
    agendaItems,
  };
  return confirmMeeting(meeting, { provider: "legistar", sourceUrl: url, observedDate: dateIso });
}

// ── PrimeGov (Palo Alto) ────────────────────────────────────────────────────

// PrimeGov dateTime is a naive local wall clock ("2026-08-17T17:30:00"), so the
// Pacific calendar date is the literal prefix. The old path fed it through
// `new Date(...).toISOString()`, which re-reads it as UTC and rolls every
// evening meeting forward a day — enough for last night's 5:30 PM council
// sitting to survive the `>= today` filter and ship as the next one up.
function primeGovPacificIso(dateTime) {
  const iso = String(dateTime || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : "";
}

async function fetchPrimeGovMeeting(domain, committeeId) {
  const url = `https://${domain}/api/v2/PublicPortal/ListUpcomingMeetings`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const meetings = await res.json();

  // Filter to City Council (committeeId) and future dates. PT, not UTC — same
  // late-in-the-day off-by-one the date fields below already call out.
  const today = ptDateISO();
  const council = meetings
    .filter((m) => m.committeeId === committeeId && m.title?.toLowerCase().includes("city council"))
    // Skip canceled/postponed meetings — PrimeGov marks them in the title
    // ("City Council Regular Meeting - CANCELED"), and without this the
    // canceled sitting shipped as Palo Alto's next meeting. The Legistar
    // path above has had this guard; PrimeGov was missing it.
    .filter((m) => !/cancel(?:led|ed)|postponed/i.test(m.title || ""))
    .filter((m) => primeGovPacificIso(m.dateTime) >= today)
    .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));

  if (!council.length) return null;

  const ev = council[0];
  const pacificIso = primeGovPacificIso(ev.dateTime);
  // Noon anchor, same as every other provider here: the naive timestamp would
  // otherwise be read in the host's zone, and the horizon and display label
  // would disagree with the date field on any machine that isn't Pacific.
  const date = new Date(`${pacificIso}T12:00:00`);
  const daysOut = (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysOut > 60) return null;

  const meeting = overlayPaloAltoStateOfTheCity({
    date: pacificIso,
    displayDate: date.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      timeZone: "America/Los_Angeles",
    }),
    // PrimeGov dateTime is naive local ("2026-08-17T17:30:00" = 5:30 PM).
    startTime: normalizeMeetingTime(ev.dateTime),
    bodyName: ev.title || "City Council",
    location: null,
    closedSession: isClosedSessionMeeting({ bodyName: ev.title }),
    url: `https://${domain}/Portal/Meeting?meetingId=${ev.id}`,
    agendaItems: [],
  }, ev);
  return confirmMeeting(meeting, {
    provider: /paloalto\.gov\/stateofthecity/i.test(meeting.url) ? "city-of-palo-alto" : "primegov",
    sourceUrl: meeting.url,
    observedDate: pacificIso,
  });
}

const PRIMEGOV_CITIES = [
  { city: "palo-alto", domain: "cityofpaloalto.primegov.com", committeeId: 9 },
];

// ── CivicEngage HTML scraping (Saratoga) ────────────────────────────────────

async function fetchCivicEngageMeeting(baseUrl, calendarId) {
  // CivicEngage agenda centers have a predictable HTML structure
  // Scrape the agenda list page for the next upcoming meeting date
  const url = `${baseUrl}/AgendaCenter/${calendarId}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Parse meeting dates from the HTML — CivicEngage uses data-date attributes or date strings
  // Pattern: look for links with dates in format "MM/DD/YYYY" or agenda items with dates
  const todayIso = ptDateISO();

  // CivicEngage lists agendas with dates — find future ones
  // The HTML contains rows like: <td>04/15/2026</td> or dates in agenda links
  const datePattern = /(\d{1,2})\/(\d{1,2})\/(\d{4})/g;
  const dates = [];
  const allDates = [];
  let match;
  while ((match = datePattern.exec(html)) !== null) {
    const [, month, day, year] = match;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    allDates.push(iso);
    if (iso >= todayIso && parseInt(year) <= new Date().getFullYear() + 1) dates.push(iso);
  }

  // Deduplicate and sort
  const unique = [...new Set(dates)].sort();

  const nextDate = unique[0];
  if (!nextDate) {
    // Distinguish "council is between meetings" from "this scraper has rotted".
    // Campbell's Agenda Center froze in 2025 when the town moved to eScribe and
    // Los Altos left the platform entirely — both returned a healthy HTTP 200
    // and reported "none scheduled" for months before anyone noticed. (Both are
    // now read from their real portals above; Saratoga is the last CivicEngage
    // city.) A page whose newest date is far in the past, or that has no dates
    // at all, is a broken source and should say so.
    const newest = allDates.length ? allDates.slice().sort().at(-1) : null;
    const staleDays = newest
      ? (Date.parse(todayIso) - Date.parse(newest)) / 86_400_000
      : null;
    if (!newest) throw new Error("no dates parsed from agenda page (source likely JS-rendered)");
    if (staleDays > 120) {
      throw new Error(`agenda page frozen — newest posting ${newest} (${Math.round(staleDays)}d old)`);
    }
    return null;
  }

  const d = new Date(nextDate + "T12:00:00");
  const daysOut = (d.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysOut > 60) return null;

  const meeting = {
    date: nextDate,
    displayDate: d.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      timeZone: "America/Los_Angeles",
    }),
    // The Agenda Center lists dates only — no posted start time to read.
    startTime: null,
    bodyName: "City Council",
    location: null,
    closedSession: false,
    url: `${baseUrl}/AgendaCenter/${calendarId}`,
    agendaItems: [],
  };
  return confirmMeeting(meeting, {
    provider: "civicengage",
    sourceUrl: url,
    observedDate: nextDate,
  });
}

const CIVICENGAGE_CITIES = [
  { city: "saratoga",  baseUrl: "https://www.saratoga.ca.us",  calendarId: "City-Council-13" },
];

// ── eScribe (Campbell) ──────────────────────────────────────────────────────
//
// Campbell left CivicEngage for eScribe in late 2025; the old Agenda Center is
// frozen at 2025-10-07 and must never be read for council records again.
// eScribe exposes a JSON calendar endpoint, but it answers one *rendered month*
// at a time — a Jan–Dec range returns an empty array, while Aug 1–31 returns
// August. So walk month by month rather than asking for a single wide window.

const ESCRIBE_MONTHS_AHEAD = 2; // current month + 2 covers the 60-day horizon

// Some Node builds reject escribemeetings.com's chain with
// UNABLE_TO_GET_ISSUER_CERT_LOCALLY (the root resolves from Node's bundled CA
// store, not the OS keychain). System curl trusts it, so fall back to curl on
// a TLS failure instead of dropping the city. Don't collapse this to a plain
// fetch without testing on the Mini.
async function escribePost(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    const cause = err?.cause?.code || "";
    const tlsProblem = /CERT|TLS|SSL/i.test(`${cause} ${err.message}`);
    if (!tlsProblem) throw err;
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("curl", [
      "-s", "--max-time", "25", "-X", "POST", url,
      "-H", "Content-Type: application/json",
      "-H", `User-Agent: ${UA}`,
      "-d", JSON.stringify(body),
    ], { maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
}

function monthWindows(startIso, monthsAhead) {
  const [y, m] = startIso.split("-").map(Number);
  const windows = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const first = new Date(Date.UTC(y, m - 1 + i, 1));
    const last = new Date(Date.UTC(y, m + i, 0));
    windows.push([first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)]);
  }
  return windows;
}

async function fetchEscribeMeeting(host) {
  const url = `https://${host}/MeetingsCalendarView.aspx/GetCalendarMeetings`;
  const today = ptDateISO();
  let sawAnyMeeting = false;

  for (const [calendarStartDate, calendarEndDate] of monthWindows(today, ESCRIBE_MONTHS_AHEAD)) {
    const payload = await escribePost(url, { calendarStartDate, calendarEndDate });
    const rows = Array.isArray(payload?.d) ? payload.d : [];
    if (rows.length) sawAnyMeeting = true;

    // eScribe StartDate is "YYYY/MM/DD HH:mm:ss" in the city's local time.
    const upcoming = rows
      .map((row) => ({ row, date: String(row.StartDate || "").slice(0, 10).replace(/\//g, "-") }))
      .filter(({ row, date }) =>
        /^\d{4}-\d{2}-\d{2}$/.test(date)
        && date >= today
        && /council/i.test(row.MeetingName || "")
        // Executive/closed sessions aren't public business; skip them the way
        // the Legistar path skips closed session.
        && !/executive session|closed session/i.test(row.MeetingName || "")
        && !/cancel(?:led|ed)|postponed/i.test(`${row.MeetingName || ""} ${row.Description || ""}`))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!upcoming.length) continue;

    const { row, date } = upcoming[0];
    const d = new Date(`${date}T12:00:00`);
    if ((d.getTime() - Date.now()) / 86_400_000 > 60) return null;

    const meeting = {
      date,
      displayDate: d.toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric",
        timeZone: "America/Los_Angeles",
      }),
      // eScribe StartDate is "YYYY/MM/DD HH:mm:ss" in the city's local time.
      startTime: normalizeMeetingTime(row.StartDate),
      bodyName: row.MeetingName || "City Council",
      location: cleanLocation(row.Location),
      // Closed/executive sittings are already filtered out above; recorded so
      // the artifact says "checked and public" rather than "never looked".
      closedSession: isClosedSessionMeeting({
        bodyName: row.MeetingName,
        description: row.Description,
      }),
      url: typeof row.Url === "string" && row.Url.startsWith(`https://${host}/`)
        ? row.Url
        : `https://${host}/`,
      agendaItems: [],
    };
    return confirmMeeting(meeting, { provider: "escribe", sourceUrl: url, observedDate: date });
  }

  // No council meeting posted in the window. An eScribe calendar that returns
  // nothing at all for three straight months is more likely a moved portal
  // than a three-month recess — say so rather than reporting a clean recess.
  if (!sawAnyMeeting) throw new Error("eScribe calendar returned no meetings for the next 3 months");
  return null;
}

const ESCRIBE_CITIES = [
  { city: "campbell", host: "pub-campbell.escribemeetings.com" },
];

// ── CivicClerk (Milpitas, Los Altos) ────────────────────────────────────────

async function fetchCivicClerkMeeting({ apiHost, location = null, meetingUrl }) {
  const today = ptDateISO();
  const apiUrl = new URL(`https://${apiHost}/v1/Events`);
  apiUrl.searchParams.set("$filter", `categoryName eq 'City Council' and eventDate ge ${today}T00:00:00Z`);
  apiUrl.searchParams.set("$orderby", "eventDate asc");
  apiUrl.searchParams.set("$top", "100");
  const res = await fetch(apiUrl, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const event = pickCivicClerkMeeting(payload.value, today);
  if (!event) return null;

  const date = String(event.eventDate).slice(0, 10);
  const dateObject = new Date(`${date}T12:00:00Z`);
  const meeting = {
    date,
    displayDate: dateObject.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
    }),
    // CivicClerk stamps the city's own wall clock with a trailing Z that is not
    // UTC (see normalizeMeetingTime). Milpitas's 2026-08-11 special meeting
    // reads "…T16:00:00Z" and starts at 4:00 PM, not 9:00 AM.
    startTime: normalizeMeetingTime(event.startDateTime || event.eventDate),
    bodyName: event.eventName || "City Council",
    location,
    closedSession: isClosedSessionMeeting({
      bodyName: event.eventName,
      description: event.eventDescription,
    }),
    url: meetingUrl(event),
    civicClerkEventId: event.id,
    agendaItems: [],
  };
  return confirmMeeting(meeting, {
    provider: "civicclerk",
    sourceUrl: apiUrl.href,
    observedDate: date,
  });
}

const CIVICCLERK_CITIES = [
  {
    city: "milpitas",
    apiHost: "milpitasca.api.civicclerk.com",
    location: "Milpitas City Hall",
    meetingUrl: () => "https://www.milpitas.gov/129/Agendas-Minutes",
  },
  {
    // Los Altos moved off CivicEngage too — losaltosca.gov/AgendaCenter now
    // self-identifies as "Archived Agenda Center" and stops at 2025-04-22.
    city: "los-altos",
    apiHost: "losaltosca.api.civicclerk.com",
    meetingUrl: (event) => `https://losaltosca.portal.civicclerk.com/event/${event.id}/overview`,
  },
];

// ── Los Gatos (MuniCode) ────────────────────────────────────────────────────

async function fetchLosGatosMeeting() {
  // Los Gatos uses MuniCode Meetings, and losgatosca.gov links to it as the
  // town's only agenda source — there is no Legistar/CivicClerk/PrimeGov/
  // Granicus tenant to switch to. The host currently refuses our requests
  // outright (empty reply on HTTP/2 and HTTP/1.1). Treat that as the site
  // declining automated access: report it, don't work around it.
  const url = "https://losgatos-ca.municodemeetings.com/";
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `municodemeetings.com refused the connection (${err?.cause?.code || err.message}) — `
      + "town's only published agenda source; not worked around",
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const today = ptDateISO();

  // MuniCode pages have dates in various formats — look for ISO or US format
  const dates = [];
  // US date format
  const usPattern = /(\d{1,2})\/(\d{1,2})\/(\d{4})/g;
  let match;
  while ((match = usPattern.exec(html)) !== null) {
    const [, month, day, year] = match;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    if (iso >= today) dates.push(iso);
  }
  // Also check for "Month DD, YYYY" format
  const longPattern = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/gi;
  const monthMap = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
    july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };
  while ((match = longPattern.exec(html)) !== null) {
    const [, monthName, day, year] = match;
    const mm = monthMap[monthName.toLowerCase()];
    const iso = `${year}-${mm}-${day.padStart(2, "0")}`;
    if (iso >= today) dates.push(iso);
  }

  const unique = [...new Set(dates)].sort();

  const nextDate = unique[0];
  if (!nextDate) return null;

  const d = new Date(nextDate + "T12:00:00");
  const daysOut = (d.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysOut > 60) return null;

  const meeting = {
    date: nextDate,
    displayDate: d.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      timeZone: "America/Los_Angeles",
    }),
    // Scraped from a date list; MuniCode posts no machine-readable start time.
    startTime: null,
    bodyName: "Town Council",
    location: null,
    closedSession: false,
    url: "https://losgatos-ca.municodemeetings.com/",
    agendaItems: [],
  };
  return confirmMeeting(meeting, {
    provider: "municode",
    sourceUrl: url,
    observedDate: nextDate,
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching upcoming council meetings...\n");

  const candidates = {};
  const sourceHealth = {};

  // Run one city's fetcher and record whether it succeeded, genuinely had no
  // meeting on the calendar, or failed — so a broken scraper is never silently
  // indistinguishable from a council in recess.
  async function runSource(city, provider, fetchFn) {
    process.stdout.write(`  ⏳ ${city} (${provider})...`);
    try {
      const next = await fetchFn();
      if (next) {
        candidates[city] = next;
        sourceHealth[city] = { provider, status: "ok" };
        const itemCount = next.agendaItems?.length ?? 0;
        console.log(` ✅ ${next.displayDate}${itemCount ? ` (${itemCount} agenda items)` : ""}`);
      } else {
        sourceHealth[city] = { provider, status: "no-meeting" };
        console.log(` — none scheduled`);
      }
    } catch (err) {
      sourceHealth[city] = { provider, status: "error", detail: err.message };
      console.log(` ⚠️  ${err.message}`);
    }
  }

  for (const { city, client, site, body } of LEGISTAR_CITIES) {
    await runSource(city, "Legistar", () => fetchNextMeeting(client, site, body));
  }

  for (const { city, domain, committeeId } of PRIMEGOV_CITIES) {
    await runSource(city, "PrimeGov", () => fetchPrimeGovMeeting(domain, committeeId));
  }

  for (const { city, baseUrl, calendarId } of CIVICENGAGE_CITIES) {
    await runSource(city, "CivicEngage", () => fetchCivicEngageMeeting(baseUrl, calendarId));
  }

  for (const { city, host } of ESCRIBE_CITIES) {
    await runSource(city, "eScribe", () => fetchEscribeMeeting(host));
  }

  for (const { city, ...config } of CIVICCLERK_CITIES) {
    await runSource(city, "CivicClerk", () => fetchCivicClerkMeeting(config));
  }

  await runSource("los-gatos", "MuniCode", () => fetchLosGatosMeeting());

  const meetings = onlyConfirmedMeetings(candidates);
  const rejected = Object.keys(candidates).length - Object.keys(meetings).length;
  if (rejected > 0) console.warn(`⚠️  publication gate rejected ${rejected} unconfirmed meeting(s)`);

  const output = {
    generatedAt: new Date().toISOString(),
    meetings,
    // Per-city fetch outcome. A city absent from `meetings` is ambiguous on its
    // own — summer recess and a dead scraper look identical. This records which
    // one it was so health-report can flag broken sources instead of counting
    // them as "missing cities".
    sourceHealth,
  };

  writeFileAtomic(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  const count = Object.keys(meetings).length;
  const broken = Object.entries(sourceHealth).filter(([, s]) => s.status === "error");
  console.log(`\n✅ Done — ${count} cities with upcoming meetings → ${OUT_PATH}`);
  if (broken.length > 0) {
    console.warn(`\n⚠️  ${broken.length} source(s) failed — these are NOT "no meeting scheduled":`);
    for (const [city, s] of broken) console.warn(`   ${city} (${s.provider}): ${s.detail}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
