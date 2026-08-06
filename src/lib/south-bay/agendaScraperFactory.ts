// ---------------------------------------------------------------------------
// South Bay Today — generalized agenda scraper factory
// Extends the Campbell scraper pattern to support multiple cities.
// ---------------------------------------------------------------------------

import { fetchWithTimeout } from "../apiHelpers";
import type { City } from "./types";

// ── Types ──

export interface AgendaCityConfig {
  city: City;
  cityName: string;
  platform: "civicengage" | "legistar" | "custom";
  agendaUrl: string;
  baseUrl: string; // for resolving relative links
  body: string; // "City Council", "Planning Commission", etc.
  schedule: string; // "1st and 3rd Tuesday"
  agendaFilePattern?: RegExp;
  dateHeadingPattern?: RegExp;
  legistarClientId?: string; // e.g., "sanjose" for webapi.legistar.com/v1/sanjose/
  legistarBodyName?: string; // override if exact Legistar body name differs from body
}

export interface AgendaInfo {
  city: City;
  cityName: string;
  body: string;
  date: string;
  title: string;
  url: string;
  pdfUrl: string;
  schedule: string;
  legistarEventId?: number; // set for Legistar cities
  legistarClientId?: string; // set for Legistar cities
}

// ── City configurations ──
// Cities are added as their agenda systems are verified.

export const AGENDA_CITIES: AgendaCityConfig[] = [
  // ── CivicEngage cities (same scraper pattern) ──
  //
  // Campbell and Los Altos used to live here and had to be removed: both left
  // CivicEngage, and both left their old Agenda Center standing as a frozen
  // archive that still answers HTTP 200. Because scrapeCivicEngage takes the
  // newest *listed* agenda, "Generate digest" was summarizing Campbell's
  // 2025-10-07 agenda and Los Altos's 2025-04-22 agenda as if they were the
  // current meeting. Campbell is on eScribe (pub-campbell.escribemeetings.com)
  // and Los Altos on CivicClerk (losaltosca.portal.civicclerk.com) — neither is
  // scrapeable by this factory, so they fall through to a clean 404 until
  // someone teaches it those platforms. Do not re-add the CivicEngage configs.
  //
  // Los Gatos: CivicEngage but no Town Council category — skipped
  {
    city: "saratoga",
    cityName: "Saratoga",
    platform: "civicengage",
    agendaUrl: "https://www.saratoga.ca.us/AgendaCenter/City-Council-13",
    baseUrl: "https://www.saratoga.ca.us",
    body: "City Council",
    schedule: "1st and 3rd Wednesday",
  },

  // ── Legistar cities ──

  {
    city: "san-jose",
    cityName: "San José",
    platform: "legistar",
    agendaUrl: "https://sanjose.legistar.com/Calendar.aspx",
    baseUrl: "https://sanjose.legistar.com",
    body: "City Council",
    schedule: "1st and 3rd Tuesday",
    legistarClientId: "sanjose",
  },
  {
    city: "mountain-view",
    cityName: "Mountain View",
    platform: "legistar",
    agendaUrl: "https://mountainview.legistar.com/Calendar.aspx",
    baseUrl: "https://mountainview.legistar.com",
    body: "City Council",
    schedule: "2nd and 4th Tuesday",
    legistarClientId: "mountainview",
  },
  {
    city: "sunnyvale",
    cityName: "Sunnyvale",
    platform: "legistar",
    agendaUrl: "https://sunnyvaleca.legistar.com/Calendar.aspx",
    baseUrl: "https://sunnyvaleca.legistar.com",
    body: "City Council",
    schedule: "2nd and 4th Tuesday",
    legistarClientId: "sunnyvaleca",
  },
  {
    city: "cupertino",
    cityName: "Cupertino",
    platform: "legistar",
    agendaUrl: "https://cupertino.legistar.com/Calendar.aspx",
    baseUrl: "https://cupertino.legistar.com",
    body: "City Council",
    schedule: "1st and 3rd Tuesday",
    legistarClientId: "cupertino",
  },
  {
    city: "santa-clara",
    cityName: "Santa Clara",
    platform: "legistar",
    agendaUrl: "https://santaclara.legistar.com/Calendar.aspx",
    baseUrl: "https://santaclara.legistar.com",
    body: "City Council",
    schedule: "2nd and 4th Tuesday",
    legistarClientId: "santaclara",
  },

  // ── Other platforms (future) ──
  // Palo Alto: PrimeGov (cityofpaloalto.primegov.com)
  // Milpitas: CivicClerk (embedded, no AgendaCenter)
];

// ── CivicEngage scraper ──

// Longest gap we'll accept between "newest posted agenda" and today before
// calling the source dead rather than the council idle. Councils recess for
// summer and the winter holidays, but never for four months.
const STALE_AGENDA_DAYS = 120;

async function scrapeCivicEngage(
  config: AgendaCityConfig,
): Promise<AgendaInfo | null> {
  const filePattern =
    config.agendaFilePattern ??
    /\/AgendaCenter\/ViewFile\/Agenda\/_(\d{8})-(\d+)/;
  const datePattern =
    config.dateHeadingPattern ??
    /<h3[^>]*>\s*([\w]+\s+\d{1,2},?\s+\d{4})\s*<\/h3>/gi;

  const res = await fetchWithTimeout(config.agendaUrl, {}, 15_000);
  if (!res.ok) return null;

  const html = await res.text();

  // Find agenda PDF links
  const agendaLinks = [
    ...html.matchAll(
      new RegExp(
        `<a[^>]*href="([^"]*${filePattern.source})"[^>]*>`,
        "gi",
      ),
    ),
  ];

  if (agendaLinks.length === 0) return null;

  const firstLink = agendaLinks[0];
  const href = firstLink[1];
  const pdfUrl = href.startsWith("http") ? href : `${config.baseUrl}${href}`;

  // Extract date from URL
  const dateMatch = href.match(filePattern);
  let dateStr = "Unknown date";
  if (dateMatch) {
    const raw = dateMatch[1];
    const month = raw.substring(0, 2);
    const day = raw.substring(2, 4);
    const year = raw.substring(4, 8);
    dateStr = `${month}/${day}/${year}`;

    // A city that leaves CivicEngage tends to leave the old Agenda Center
    // standing, frozen and still answering HTTP 200. Since we take the newest
    // listed agenda, that silently turns into "here is Campbell's latest
    // meeting" on top of a year-old PDF. Refuse anything older than a long
    // recess; the caller turns null into an honest 404.
    const agendaTime = Date.parse(`${year}-${month}-${day}T12:00:00Z`);
    if (Number.isFinite(agendaTime)) {
      const ageDays = (Date.now() - agendaTime) / 86_400_000;
      if (ageDays > STALE_AGENDA_DAYS) {
        console.warn(
          `[agenda-scraper] ${config.city}: newest agenda is ${dateStr} `
          + `(${Math.round(ageDays)}d old) — treating source as stale, not current`,
        );
        return null;
      }
    }
  }

  // Try heading date for nicer format
  const headings = [...html.matchAll(datePattern)];
  if (headings.length > 0) {
    dateStr = headings[0][1].trim();
  }

  return {
    city: config.city,
    cityName: config.cityName,
    body: config.body,
    date: dateStr,
    title: `${config.cityName} ${config.body} — ${dateStr}`,
    url: config.agendaUrl,
    pdfUrl,
    schedule: config.schedule,
  };
}

// ── Legistar scraper ──
// Uses the free Legistar Web API (webapi.legistar.com) — no auth required.

const LEGISTAR_HEADERS = {
  "User-Agent": "SouthBayToday/1.0 (southbaytoday.org; public information aggregator)",
};

async function scrapeLegistar(
  config: AgendaCityConfig,
): Promise<AgendaInfo | null> {
  const clientId = config.legistarClientId!;
  const bodyName = config.legistarBodyName ?? config.body;

  // Fetch the 5 most recent meetings for this body, newest first
  const filter = `EventBodyName eq '${bodyName}'`;
  const eventsUrl =
    `https://webapi.legistar.com/v1/${clientId}/Events` +
    `?$filter=${encodeURIComponent(filter)}&$orderby=EventDate desc&$top=5`;

  const res = await fetchWithTimeout(eventsUrl, { headers: LEGISTAR_HEADERS }, 15_000);
  if (!res.ok) return null;

  let events: any[];
  try {
    events = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(events) || events.length === 0) return null;

  // Prefer the most recent past meeting; fall back to the first result
  const now = new Date();
  const recentEvent =
    events.find((e) => new Date(e.EventDate) <= now) ?? events[0];
  if (!recentEvent) return null;

  const meetingDate = new Date(recentEvent.EventDate);
  const dateStr = meetingDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  });

  // EventInSiteURL is the provider-owned public identifier. EventId belongs
  // to the Web API and is not interchangeable with the public site's ID
  // parameter, so a missing provider URL must fall back to the calendar.
  const meetingUrl =
    recentEvent.EventInSiteURL ??
    config.agendaUrl;

  return {
    city: config.city,
    cityName: config.cityName,
    body: config.body,
    date: dateStr,
    title: `${config.cityName} ${config.body} — ${dateStr}`,
    url: meetingUrl,
    pdfUrl: recentEvent.EventAgendaFile ?? meetingUrl,
    schedule: config.schedule,
    legistarEventId: recentEvent.EventId,
    legistarClientId: clientId,
  };
}

// ── Public API ──

/** Fetch the latest agenda for a specific city. */
export async function fetchCityAgenda(
  cityId: City,
): Promise<AgendaInfo | null> {
  const config = AGENDA_CITIES.find((c) => c.city === cityId);
  if (!config) return null;

  switch (config.platform) {
    case "civicengage":
      return scrapeCivicEngage(config);
    case "legistar":
      return scrapeLegistar(config);
    default:
      return null;
  }
}

/** Fetch the latest agendas for all configured cities. */
export async function fetchAllCityAgendas(): Promise<AgendaInfo[]> {
  const results = await Promise.allSettled(
    AGENDA_CITIES.map((config) => fetchCityAgenda(config.city)),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<AgendaInfo | null> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value)
    .filter((a): a is AgendaInfo => a !== null);
}

/** Fetch agenda text content from a URL — handles both HTML and PDF responses. */
export async function fetchAgendaContent(
  pdfUrl: string,
): Promise<string | null> {
  const res = await fetchWithTimeout(pdfUrl, {}, 15_000);
  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("application/pdf")) {
    try {
      const buf = new Uint8Array(await res.arrayBuffer());
      const { extractText, getDocumentProxy } = await import("unpdf");
      const doc = await getDocumentProxy(buf);
      const { text } = await extractText(doc, { mergePages: true });
      const flat = (Array.isArray(text) ? text.join("\n") : text)
        .replace(/\s+/g, " ")
        .trim();
      return flat ? flat.substring(0, 12_000) : null;
    } catch {
      return null;
    }
  }

  const html = await res.text();

  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

  return text.substring(0, 12_000);
}

/**
 * Fetch agenda content for a Legistar meeting via the EventItems API.
 * Returns structured agenda items formatted as readable text for Claude.
 */
export async function fetchLegistarContent(
  clientId: string,
  eventId: number,
): Promise<string | null> {
  const filter = `EventItemEventId eq ${eventId}`;
  const url =
    `https://webapi.legistar.com/v1/${clientId}/EventItems` +
    `?AgendaNote=1&$filter=${encodeURIComponent(filter)}&$orderby=EventItemAgendaSequence asc`;

  const res = await fetchWithTimeout(url, { headers: LEGISTAR_HEADERS }, 15_000);
  if (!res.ok) return null;

  let items: any[];
  try {
    items = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(items) || items.length === 0) return null;

  const lines: string[] = [];
  for (const item of items) {
    if (!item.EventItemTitle) continue;

    const num = item.EventItemAgendaNumber
      ? `${item.EventItemAgendaNumber}. `
      : "";
    lines.push(`${num}${item.EventItemTitle}`);

    if (item.EventItemAgendaNote) {
      const note = String(item.EventItemAgendaNote)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 500);
      if (note) lines.push(`   ${note}`);
    }
  }

  if (lines.length === 0) return null;
  return lines.join("\n").substring(0, 12_000);
}

/** Get list of cities that have agenda scraping configured. */
export function getConfiguredCities(): City[] {
  return AGENDA_CITIES.map((c) => c.city);
}
