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
]);

// Prefixes that indicate procedural/non-substantive items
const SKIP_STARTS_WITH = [
  "call to order", "roll call", "regular session,", "closed session,",
  "public comment", "subject:  conference with legal counsel",
  "subject:  conference with real property",
];

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
    if (!res.ok) return [];
    const items = await res.json();

    // Filter to substantive items and take up to 5
    return items
      .filter((item) => isSubstantiveItem(item.EventItemTitle))
      .slice(0, 5)
      .map((item) => ({
        title: item.EventItemTitle.split(/\r?\n/)[0].trim(),
        sequence: item.EventItemAgendaSequence,
      }));
  } catch {
    return [];
  }
}

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

  const agendaItems = await fetchAgendaItems(client, ev.EventId);

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
    agendaItems,
  };
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

  // Filter to City Council (committeeId) and future dates
  const today = new Date().toISOString().split("T")[0];
  const council = meetings
    .filter((m) => m.committeeId === committeeId && m.title?.toLowerCase().includes("city council"))
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

  return {
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
}

const PRIMEGOV_CITIES = [
  { city: "palo-alto", domain: "cityofpaloalto.primegov.com", committeeId: 9 },
];

// ── CivicEngage HTML scraping (Campbell, Saratoga, Los Altos) ───────────────

function nextScheduledDate(dayOfWeek, weeksOfMonth) {
  const today = new Date();
  const todayIso = today.toISOString().split("T")[0];
  for (let offset = 0; offset < 45; offset++) {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    if (d.getDay() !== dayOfWeek) continue;
    const weekOfMonth = Math.ceil(d.getDate() / 7);
    if (!weeksOfMonth.includes(weekOfMonth)) continue;
    const iso = d.toISOString().split("T")[0];
    if (iso < todayIso) continue;
    return { date: d, iso };
  }
  return null;
}

async function fetchCivicEngageMeeting(city, baseUrl, calendarId, fallbackSchedule) {
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
  const today = new Date();
  const todayIso = today.toISOString().split("T")[0];

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

  let nextDate;
  if (unique.length) {
    nextDate = unique[0];
  } else if (fallbackSchedule) {
    // No future dates on the page — use known meeting schedule
    const fb = nextScheduledDate(fallbackSchedule.dayOfWeek, fallbackSchedule.weeksOfMonth);
    if (fb) nextDate = fb.iso;
  }
  if (!nextDate) return null;

  const d = new Date(nextDate + "T12:00:00");
  const daysOut = (d.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysOut > 60) return null;

  return {
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
}

const CIVICENGAGE_CITIES = [
  { city: "campbell",  baseUrl: "https://www.campbellca.gov",  calendarId: "City-Council-10",
    fallbackSchedule: { dayOfWeek: 2, weeksOfMonth: [1, 3] } }, // 1st & 3rd Tuesdays
  { city: "saratoga",  baseUrl: "https://www.saratoga.ca.us",  calendarId: "City-Council-13",
    fallbackSchedule: { dayOfWeek: 3, weeksOfMonth: [1, 3] } }, // 1st & 3rd Wednesdays
  { city: "los-altos", baseUrl: "https://www.losaltosca.gov",  calendarId: "City-Council-4",
    fallbackSchedule: { dayOfWeek: 2, weeksOfMonth: [2, 4] } }, // 2nd & 4th Tuesdays
];

// ── Milpitas (CivicClerk / calendar page scraping) ──────────────────────────

async function fetchMilpitasMeeting() {
  // Milpitas City Council meets 1st and 3rd Tuesdays at 7pm
  // CivicClerk portal is client-rendered — no server-side dates to scrape
  // Compute next meeting from known schedule
  const today = new Date();
  const todayIso = today.toISOString().split("T")[0];

  for (let offset = 0; offset < 45; offset++) {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    if (d.getDay() !== 2) continue; // not Tuesday
    const weekOfMonth = Math.ceil(d.getDate() / 7);
    if (weekOfMonth !== 1 && weekOfMonth !== 3) continue;
    const iso = d.toISOString().split("T")[0];
    if (iso < todayIso) continue;

    return {
      date: iso,
      displayDate: d.toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric",
        timeZone: "America/Los_Angeles",
      }),
      bodyName: "City Council",
      location: "455 E. Calaveras Blvd, Milpitas",
      url: "https://www.milpitas.gov/129/Agendas-Minutes",
      agendaItems: [],
    };
  }
  return null;
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

  const today = new Date().toISOString().split("T")[0];

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

  let nextDate;
  if (unique.length) {
    nextDate = unique[0];
  } else {
    // Fallback: Los Gatos Town Council meets 1st and 3rd Tuesdays
    const fb = nextScheduledDate(2, [1, 3]);
    if (fb) nextDate = fb.iso;
  }
  if (!nextDate) return null;

  const d = new Date(nextDate + "T12:00:00");
  const daysOut = (d.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysOut > 60) return null;

  return {
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
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching upcoming council meetings...\n");

  const meetings = {};

  // Legistar cities
  for (const { city, client, body } of LEGISTAR_CITIES) {
    process.stdout.write(`  ⏳ ${city} (Legistar)...`);
    try {
      const next = await fetchNextMeeting(city, client, body);
      if (next) {
        meetings[city] = next;
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
        meetings[city] = next;
        console.log(` ✅ ${next.displayDate}`);
      } else {
        console.log(` — none scheduled`);
      }
    } catch (err) {
      console.log(` ⚠️  ${err.message}`);
    }
  }

  // CivicEngage cities
  for (const { city, baseUrl, calendarId, fallbackSchedule } of CIVICENGAGE_CITIES) {
    process.stdout.write(`  ⏳ ${city} (CivicEngage)...`);
    try {
      const next = await fetchCivicEngageMeeting(city, baseUrl, calendarId, fallbackSchedule);
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

  // Milpitas
  process.stdout.write(`  ⏳ milpitas (CivicClerk)...`);
  try {
    const next = await fetchMilpitasMeeting();
    if (next) {
      meetings["milpitas"] = next;
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
      meetings["los-gatos"] = next;
      console.log(` ✅ ${next.displayDate}`);
    } else {
      console.log(` — none scheduled`);
    }
  } catch (err) {
    // MuniCode is slow — fall back to known schedule (1st & 3rd Tuesdays)
    const fb = nextScheduledDate(2, [1, 3]);
    if (fb) {
      const d = new Date(fb.iso + "T12:00:00");
      meetings["los-gatos"] = {
        date: fb.iso,
        displayDate: d.toLocaleDateString("en-US", {
          weekday: "short", month: "short", day: "numeric",
          timeZone: "America/Los_Angeles",
        }),
        bodyName: "Town Council",
        location: null,
        url: "https://losgatos-ca.municodemeetings.com/",
        agendaItems: [],
      };
      console.log(` ⚠️  ${err.message} → fallback ${meetings["los-gatos"].displayDate}`);
    } else {
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
