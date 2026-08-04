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
  legistarMeetingUrl,
  onlyConfirmedMeetings,
  pickCivicClerkMeeting,
  ptDateISO,
} from "./lib/civic-meetings.mjs";

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
  "you may speak", "by email", "members of the public", "to request",
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

  // Trim trailing punctuation
  s = s.replace(/[,;:]+\s*$/, "").trim();

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

    // Filter to substantive items and take up to 5
    return items
      .filter((item) => isSubstantiveItem(item.EventItemTitle))
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
    bodyName: ev.EventBodyName,
    location: cleanLocation(ev.EventLocation),
    url: legistarMeetingUrl(site, dateIso, ev.EventInSiteURL),
    legistarEventId: ev.EventId,
    agendaItems,
  };
  return confirmMeeting(meeting, { provider: "legistar", sourceUrl: url, observedDate: dateIso });
}

// ── PrimeGov (Palo Alto) ────────────────────────────────────────────────────

async function fetchPrimeGovMeeting(city, domain, committeeId) {
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
    .filter((m) => {
      const d = new Date(m.dateTime).toISOString().split("T")[0];
      return d >= today;
    })
    .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));

  if (!council.length) return null;

  const ev = council[0];
  const date = new Date(ev.dateTime);
  const daysOut = (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysOut > 60) return null;

  // Use Pacific Time for both date fields — toISOString() is UTC and causes off-by-one errors
  // when meetings are scheduled late in the day (UTC midnight crosses into the next calendar day)
  const pacificIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);

  const meeting = {
    date: pacificIso,
    displayDate: date.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      timeZone: "America/Los_Angeles",
    }),
    bodyName: ev.title || "City Council",
    location: null,
    url: `https://${domain}/Portal/Meeting?meetingId=${ev.id}`,
    agendaItems: [],
  };
  return confirmMeeting(meeting, {
    provider: "primegov",
    sourceUrl: meeting.url,
    observedDate: pacificIso,
  });
}

const PRIMEGOV_CITIES = [
  { city: "palo-alto", domain: "cityofpaloalto.primegov.com", committeeId: 9 },
];

// ── CivicEngage HTML scraping (Campbell, Saratoga, Los Altos) ───────────────

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
  let match;
  while ((match = datePattern.exec(html)) !== null) {
    const [, month, day, year] = match;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    if (iso >= todayIso && parseInt(year) <= new Date().getFullYear() + 1) dates.push(iso);
  }

  // Deduplicate and sort
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
    bodyName: "City Council",
    location: null,
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
  { city: "campbell",  baseUrl: "https://www.campbellca.gov",  calendarId: "City-Council-10" },
  { city: "saratoga",  baseUrl: "https://www.saratoga.ca.us",  calendarId: "City-Council-13" },
  { city: "los-altos", baseUrl: "https://www.losaltosca.gov",  calendarId: "City-Council-4" },
];

// ── Milpitas (CivicClerk / calendar page scraping) ──────────────────────────

async function fetchMilpitasMeeting() {
  const today = ptDateISO();
  const apiUrl = new URL("https://milpitasca.api.civicclerk.com/v1/Events");
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
    bodyName: event.eventName || "City Council",
    location: "Milpitas City Hall",
    url: "https://www.milpitas.gov/129/Agendas-Minutes",
    civicClerkEventId: event.id,
    agendaItems: [],
  };
  return confirmMeeting(meeting, {
    provider: "civicclerk",
    sourceUrl: apiUrl.href,
    observedDate: date,
  });
}

// ── Los Gatos (MuniCode) ────────────────────────────────────────────────────

async function fetchLosGatosMeeting() {
  // Los Gatos uses MuniCode Meetings — scrape the main page for next date
  const url = "https://losgatos-ca.municodemeetings.com/";
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
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
    bodyName: "Town Council",
    location: null,
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

  // Legistar cities
  for (const { city, client, site, body } of LEGISTAR_CITIES) {
    process.stdout.write(`  ⏳ ${city} (Legistar)...`);
    try {
      const next = await fetchNextMeeting(client, site, body);
      if (next) {
        candidates[city] = next;
        const itemCount = next.agendaItems?.length ?? 0;
        console.log(` ✅ ${next.displayDate} (${itemCount} agenda items)`);
      } else {
        console.log(` — none scheduled`);
      }
    } catch (err) {
      console.log(` ⚠️  ${err.message}`);
    }
  }

  // PrimeGov cities
  for (const { city, domain, committeeId } of PRIMEGOV_CITIES) {
    process.stdout.write(`  ⏳ ${city} (PrimeGov)...`);
    try {
      const next = await fetchPrimeGovMeeting(city, domain, committeeId);
      if (next) {
        candidates[city] = next;
        console.log(` ✅ ${next.displayDate}`);
      } else {
        console.log(` — none scheduled`);
      }
    } catch (err) {
      console.log(` ⚠️  ${err.message}`);
    }
  }

  // CivicEngage cities
  for (const { city, baseUrl, calendarId } of CIVICENGAGE_CITIES) {
    process.stdout.write(`  ⏳ ${city} (CivicEngage)...`);
    try {
      const next = await fetchCivicEngageMeeting(baseUrl, calendarId);
      if (next) {
        candidates[city] = next;
        console.log(` ✅ ${next.displayDate}`);
      } else {
        console.log(` — none scheduled`);
      }
    } catch (err) {
      console.log(` ⚠️  ${err.message}`);
    }
  }

  // Milpitas
  process.stdout.write(`  ⏳ milpitas (CivicClerk)...`);
  try {
    const next = await fetchMilpitasMeeting();
    if (next) {
      candidates["milpitas"] = next;
      console.log(` ✅ ${next.displayDate}`);
    } else {
      console.log(` — none scheduled`);
    }
  } catch (err) {
    console.log(` ⚠️  ${err.message}`);
  }

  // Los Gatos
  process.stdout.write(`  ⏳ los-gatos (MuniCode)...`);
  try {
    const next = await fetchLosGatosMeeting();
    if (next) {
      candidates["los-gatos"] = next;
      console.log(` ✅ ${next.displayDate}`);
    } else {
      console.log(` — none scheduled`);
    }
  } catch (err) {
    console.log(` ⚠️  ${err.message}`);
  }

  const meetings = onlyConfirmedMeetings(candidates);
  const rejected = Object.keys(candidates).length - Object.keys(meetings).length;
  if (rejected > 0) console.warn(`⚠️  publication gate rejected ${rejected} unconfirmed meeting(s)`);

  const output = {
    generatedAt: new Date().toISOString(),
    meetings,
  };

  writeFileAtomic(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  const count = Object.keys(meetings).length;
  console.log(`\n✅ Done — ${count} cities with upcoming meetings → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
