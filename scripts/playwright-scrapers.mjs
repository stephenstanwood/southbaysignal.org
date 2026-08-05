#!/usr/bin/env node
/**
 * playwright-scrapers.mjs
 *
 * Unified Playwright-based scraper for all event sources that need a real browser:
 *   - Sites returning 403/404 on bot requests (CivicPlus cities, Cloudflare)
 *   - JavaScript SPAs that don't render without a browser (Shopify, LibCal)
 *   - Fragile HTML scrapes that are more robust with DOM APIs
 *   - Venues with own calendars not covered by aggregator APIs
 *
 * Runs on Mac Mini as a scheduled task. Writes playwright-events.json
 * which generate-events.mjs merges into the main events feed.
 *
 * Requires: npx playwright install chromium
 *
 * Usage:
 *   node scripts/playwright-scrapers.mjs
 */

import { readFileSync, existsSync } from "fs";
import { writeFileAtomic } from "./lib/io.mjs";
import { todayPT } from "./lib/dates.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { loadEnvLocal } from "./lib/env.mjs";
import {
  normalizeMidpenOccurrenceUrl,
  normalizeMountainWineryCard,
} from "./lib/official-event-sources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "playwright-events.json");

loadEnvLocal();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function h(prefix, ...parts) {
  return createHash("sha256").update([prefix, ...parts].join("|")).digest("hex").slice(0, 12);
}

function displayDate(d) {
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short", month: "short", day: "numeric",
  });
}

function isoDate(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

const TODAY = todayPT();

/** Run async tasks with bounded concurrency */
async function pool(fns, concurrency = 4) {
  const results = [];
  const active = new Set();
  for (const fn of fns) {
    const p = fn().then((r) => { active.delete(p); return r; });
    active.add(p);
    results.push(p);
    if (active.size >= concurrency) await Promise.race(active);
  }
  return Promise.all(results);
}

/** Standard wrapper for each scraper */
async function runScraper(browser, name, fn) {
  const page = await browser.newPage();
  let events = [];
  let error = null;
  try {
    events = await fn(page);
  } catch (err) {
    error = err.message;
    console.log(`  ⚠️  ${name}: ${err.message}`);
  } finally {
    await page.close();
  }
  console.log(`  ${events.length > 0 ? "✅" : "⚠️ "} ${name}: ${events.length} events`);
  return { events, error };
}

/** Try to parse a date string into YYYY-MM-DD, return null on failure */
function tryParseDate(str) {
  if (!str) return null;
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // MM/DD/YYYY
  const slash = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) {
    const d = new Date(+slash[3], +slash[1] - 1, +slash[2]);
    return isNaN(d.getTime()) ? null : isoDate(d);
  }
  // Natural language
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : isoDate(d);
}

/** Normalize time string to "H:MM AM/PM" */
function normalizeTime(raw) {
  if (!raw) return null;
  const t = raw.trim().replace(/\s+/g, " ");
  if (/\d{1,2}:\d{2}\s*[ap]m/i.test(t)) return t;
  if (/\d{1,2}\s*[ap]m/i.test(t)) return t;
  return t || null;
}

const MONTH_RE = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const NAV_JUNK_RE = /^(skip\s+to|back\s+to\s+top|navigation|breadcrumb|close\s+menu|view\s+all|load\s+more|show\s+more|read\s+more|subscribe|donate|search|menu|events?\s+search|events?\s+search\s+and\s+views\s+navigation)$/i;
const KID_RE = /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i;

function yearAwareDate(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/\s+/g, " ").trim();
  if (!text) return null;

  const withYear = tryParseDate(text);
  if (withYear) return withYear;

  const monthDay = text.match(new RegExp(`\\b(${MONTH_RE})\\s+\\d{1,2}\\b`, "i"));
  if (!monthDay) return null;

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const candidateText = `${monthDay[0]}, ${currentYear}`;
  let parsed = tryParseDate(candidateText);
  if (!parsed) return null;

  const candidate = new Date(`${parsed}T12:00:00-07:00`);
  if (candidate.getMonth() < currentMonth - 3) {
    parsed = tryParseDate(`${monthDay[0]}, ${currentYear + 1}`);
  }
  return parsed;
}

function clockFromText(text) {
  if (!text) return null;
  const match = String(text).match(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i);
  return normalizeTime(match?.[0]?.replace(/\./g, ""));
}

function clockRangeFromText(text) {
  if (!text) return { time: null, endTime: null };
  const matches = [...String(text).matchAll(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi)]
    .map((m) => normalizeTime(m[0].replace(/\./g, "")));
  return { time: matches[0] || null, endTime: matches[1] || null };
}

function clockMinutes(time) {
  const m = String(time || "").match(/^0?(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2] || "0", 10);
}

function isUsefulTitle(title) {
  const t = (title || "").replace(/\s+/g, " ").trim();
  return t.length >= 4 && t.length <= 140 && !NAV_JUNK_RE.test(t);
}

function normalizeVenueText(raw, fallback) {
  const text = (raw || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  if (/^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/.test(text)) return fallback;
  if (/^\d{3,6}\s+/.test(text)) return fallback;
  if (/,\s*(CA|California)(\s+\d{5})?\b/i.test(text)) return fallback;
  return text.length > 80 ? fallback : text;
}

/** Convert an ISO datetime ("2026-05-02T19:00:00-07:00") to "H:MM AM/PM".
 *  Returns null if the string has no time component or is unparseable.
 *  Treats the offset literally — for sources that emit local-wall-clock with
 *  a Pacific offset, this gives the right human-readable time. */
function isoTimeToClock(iso) {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const h24 = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  // 00:00 looks like "midnight by default" — usually means time wasn't set.
  if (h24 === 0 && min === 0) return null;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);
  return min === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

/** Category inference from title */
function inferCategory(title) {
  const t = title.toLowerCase();
  // Family/kids events first — "Baby Storytime", "Preschool Storytime",
  // "Kids Knitting" should land in family, not community. Matches the
  // canonical rule in generate-events.mjs inferCategory.
  const hasBaby = /\bbaby\b/.test(t) && !/\bbaby\s+bash\b/.test(t);
  if (t.includes("story time") || t.includes("storytime") || t.includes("toddler") ||
      hasBaby || t.includes("preschool") || t.includes("kids") || t.includes("children") ||
      /\bbedtime\b/.test(t) || /\bpuppet\s+show\b/.test(t)) return "family";
  // Concerts belong in music, not arts. This returned "arts" while the comment
  // above claimed it mirrored generate-events.mjs, which returns "music" — so a
  // title that literally said "concert" landed in the wrong bucket.
  if (/\b(concert|music|jazz|band|orchestra|symphony|dj)\b/.test(t)) return "music";
  if (/\b(art|gallery|exhibit|museum|sculpture)\b/.test(t)) return "arts";
  if (/\b(theater|theatre|play|comedy|improv|show|performance)\b/.test(t)) return "arts";
  if (/\b(book|author|reading|poetry|literary|signing)\b/.test(t)) return "arts";
  if (/\b(yoga|meditation|wellness|mindful)\b/.test(t)) return "community";
  // Team matchups. This scraper feeds SAP Center / Tech CU Arena, where the
  // Sharks' listings are just "Sharks vs Golden Knights" — no keyword below
  // matches, so they were falling through to the "community" default.
  if (/\bvs\.?\b/.test(t) && !/\b(concert|tour|comedy|trivia|book)\b/.test(t)) return "sports";
  if (/\b(hockey|basketball|baseball|football|soccer|lacrosse|volleyball|rugby)\b/.test(t)) return "sports";
  // Charity/awareness walks (Walk a Mile, Walk to End X, NAMIWalks) are community events,
  // not sports — strip "walk" from the sports keywords.
  if (/\b(hike|run|fitness|sport|game)\b/.test(t)) return "sports";
  if (/\b(food|cook|wine|beer|tast|farm|restaurant)\b/.test(t)) return "food";
  // Must return a key from EventCategory in src/data/south-bay/events-data.ts:
  // market | family | music | arts | sports | community | outdoor | education | food
  if (/\b(tech|hack|code|startup|ai|data|developer)\b/.test(t)) return "education";
  if (/\b(council|city|civic|government|hearing|meeting)\b/.test(t)) return "community";
  if (/\b(family|teen|youth)\b/.test(t)) return "family";
  return "community";
}

// ═══════════════════════════════════════════════════════════════════════════
// TIER 1 — Currently blocked/broken sources
// ═══════════════════════════════════════════════════════════════════════════

// ── CivicPlus City Calendars (3 cities, 403 on iCal feed) ──

const CIVIC_PLUS_CITIES = [
  {
    name: "City of Mountain View",
    url: "https://www.mountainview.gov/Calendar.aspx",
    city: "mountain-view",
    source: "City of Mountain View",
  },
  {
    name: "City of Sunnyvale",
    url: "https://www.sunnyvale.ca.gov/Calendar.aspx",
    city: "sunnyvale",
    source: "City of Sunnyvale",
  },
  {
    name: "City of San Jose",
    url: "https://www.sanjoseca.gov/Calendar.aspx",
    city: "san-jose",
    source: "City of San Jose",
  },
];

async function scrapeCivicPlusCalendar(page, config) {
  await page.goto(config.url, { waitUntil: "networkidle", timeout: 30_000 });

  // CivicPlus calendars render event listings with dates and titles.
  // Try multiple selector strategies for their various themes.
  const raw = await page.evaluate(() => {
    const events = [];

    // Strategy 1: CivicPlus list view (.listItem, .calendarList, .event-item)
    const items = document.querySelectorAll(
      ".listItem, .calendarList .row, .event-item, .calendar-list-item, " +
      "[class*='calEvent'], [class*='calendar-event'], .fc-event, " +
      "table.calendar td[class*='event'], .cbCalendarList .cbItem"
    );
    for (const item of items) {
      const titleEl = item.querySelector("a, h2, h3, h4, .title, [class*='title'], [class*='name']");
      const dateEl = item.querySelector("time, .date, [class*='date'], [datetime]");
      const title = titleEl?.textContent?.trim();
      const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
      const link = titleEl?.closest("a")?.href || item.querySelector("a")?.href;
      if (title && title.length > 3) events.push({ title, date, link });
    }

    // Strategy 2: Generic structured data from list/detail blocks
    if (events.length === 0) {
      const links = document.querySelectorAll("a[href*='/Calendar/']");
      for (const a of links) {
        const title = a.textContent?.trim();
        const row = a.closest("tr, li, div, article");
        const dateEl = row?.querySelector("time, .date, [class*='date']");
        const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
        if (title && title.length > 3) events.push({ title, date, link: a.href });
      }
    }

    return events;
  });

  const events = [];
  for (const r of raw) {
    const date = tryParseDate(r.date);
    if (!date || date < TODAY) continue;
    events.push({
      title: r.title,
      date,
      time: null,
      endTime: null,
      venue: config.name.replace("City of ", "") + " Community Calendar",
      address: "",
      city: config.city,
      url: r.link || config.url,
      source: config.source,
      category: inferCategory(r.title),
      cost: null,
      kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(r.title),
    });
  }
  return events;
}

// ── The Tech Interactive ──

async function scrapeTheTech(page) {
  // Try multiple URL patterns since their RSS is dead
  const urls = [
    "https://www.thetech.org/visit",
    "https://www.thetech.org/events",
    "https://www.thetech.org/whats-on",
  ];

  for (const url of urls) {
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      if (!resp || resp.status() >= 400) continue;

      const raw = await page.evaluate(() => {
        const events = [];
        // Look for event cards, exhibition listings, etc.
        const cards = document.querySelectorAll(
          "[class*='event'], [class*='exhibit'], [class*='program'], " +
          "article, .card, [class*='card'], [class*='listing']"
        );
        for (const card of cards) {
          const titleEl = card.querySelector("h2, h3, h4, [class*='title'], [class*='name']");
          const dateEl = card.querySelector("time, [class*='date'], [datetime]");
          const title = titleEl?.textContent?.trim();
          const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
          const link = card.querySelector("a")?.href || card.closest("a")?.href;
          const timeEl = card.querySelector("[class*='time']");
          const time = timeEl?.textContent?.trim();
          if (title && title.length > 3) events.push({ title, date, link, time });
        }
        return events;
      });

      if (raw.length > 0) {
        return raw
          .map((r) => {
            const date = tryParseDate(r.date);
            if (!date || date < TODAY) return null;
            return {
              title: r.title,
              date,
              time: normalizeTime(r.time),
              endTime: null,
              venue: "The Tech Interactive",
              address: "201 S Market St, San Jose, CA 95113",
              city: "san-jose",
              url: r.link || "https://www.thetech.org",
              source: "The Tech Interactive",
              category: "community",
              cost: "paid",
              kidFriendly: true,
            };
          })
          .filter(Boolean);
      }
    } catch {
      continue;
    }
  }
  return [];
}

// ── LibCal Libraries (MV Public Library, Los Gatos, Milpitas) ──

// Bookmobile stops are labeled as such by LibCal itself — the listing card
// carries "Categories: Mobile Library Stop" / "Location: Mobile Library Stop".
// Prefer that first-party signal over guessing from the title shape: the title
// is just wherever the bookmobile parks, and those names don't follow a
// predictable pattern ("Villa Siena", "El Camino Hospital- Lower-Level Lobby",
// "Magical Bridge Playground" all slipped past the regex below and were then
// given invented blurbs — a stop at a hospital lobby became "a community health
// talk"). The regex stays as a fallback for layouts that don't expose the label.
function isMobileLibraryStop(cardText) {
  return /(?:Categories|Location)\s*:\s*Mobile Library Stop/i.test(cardText || "");
}

// Fallback: bookmobile/outreach stops use bare venue names as titles ("Ginzton
// Terrace Apartments", "Castro Elementary School", "Hope Services").
//
// Pattern is FULL-title match (anchored ^...$) so we don't drop real events
// like "Friends of the Los Altos Library Booksale @ Los Altos Community Center"
// — those have the venue suffix but additional event words.
const BOOKMOBILE_STOP_PATTERNS = [
  /^[A-Z][\w'.&-]*(\s+[A-Z][\w'.&-]*)*\s+Apartments?$/,
  /^[A-Z][\w'.&-]*(\s+[A-Z][\w'.&-]*)*\s+(Elementary|Middle|High|Senior)\s+School$/,
  /^[A-Z][\w'.&-]*(\s+[A-Z][\w'.&-]*)*\s+(Senior|Retirement)\s+(Living|Center|Community)$/,
  /^[A-Z][\w'.&-]*(\s+[A-Z][\w'.&-]*)*\s+(Community|Recreation)\s+Center$/,
  /^[A-Z][\w'.&-]*(\s+[A-Z][\w'.&-]*)*\s+Services$/,           // "Hope Services"
  /^[A-Z][\w'.&-]*(\s+[A-Z][\w'.&-]*)*\s+Mobile\s+Home\s+Park$/,
];
function isBookmobileStopTitle(title) {
  if (!title) return false;
  return BOOKMOBILE_STOP_PATTERNS.some((p) => p.test(title.trim()));
}

const LIBCAL_LIBRARIES = [
  {
    name: "Mountain View Public Library",
    urls: [
      "https://mountainview.libcal.com/calendar",
      "https://mountainview.libcal.com/events",
    ],
    city: "mountain-view",
    address: "585 Franklin St, Mountain View, CA 94041",
  },
  {
    name: "Los Gatos Library",
    urls: [
      "https://losgatosca.libcal.com/calendar",
    ],
    city: "los-gatos",
    address: "110 E Main St, Los Gatos, CA 95030",
  },
  // Milpitas: SCCL LibCal returns 404; covered by SCCL BiblioCommons in generate-events.mjs
];

async function scrapeLibCal(page, config) {
  for (const url of config.urls) {
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 25_000 });
      if (!resp || resp.status() >= 400) continue;

      // LibCal renders event listings client-side with Springshare JS
      await page.waitForTimeout(3000); // let JS hydrate

      const raw = await page.evaluate(() => {
        const events = [];
        const now = new Date();
        const currentYear = now.getFullYear();

        // Strategy 1: LibCal eventcard layout (Los Gatos style)
        // Cards have .s-lc-eventcard with h2.s-lc-eventcard-title containing the title link
        const cards = document.querySelectorAll(".s-lc-eventcard");
        const seenTitles = new Set();
        for (const card of cards) {
          // Title is in h2.s-lc-eventcard-title > a, or .s-lc-eventcard-body > a
          const titleLink = card.querySelector(".s-lc-eventcard-title a[href*='/event/'], .s-lc-eventcard-body a[href*='/event/']");
          if (!titleLink) continue;
          const title = titleLink.textContent?.trim();
          if (!title || title.length < 3 || /^(More|Show more|Register)/.test(title)) continue;
          if (seenTitles.has(title)) continue;
          seenTitles.add(title);
          // Date heading contains "Apr\n13\n...\nMon, 11:00am..." — extract just month + day
          const heading = card.querySelector(".s-lc-eventcard-heading");
          const headingText = heading?.textContent?.trim()?.replace(/\s+/g, " ") || "";
          const monthDay = headingText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}/i);
          const dateStr = monthDay ? `${monthDay[0]}, ${currentYear}` : null;
          // Time like "11:00am" from card body
          const timeMatch = card.textContent?.match(/\d{1,2}:\d{2}\s*[ap]m/i);
          events.push({ title, date: dateStr, time: timeMatch?.[0], link: titleLink.href, cardText: card.textContent || "" });
        }

        // Strategy 2: LibCal media-body layout (Mountain View style)
        // Events are in .media-body with a[href*="/event/"]
        if (events.length === 0) {
          const bodies = document.querySelectorAll(".media-body");
          for (const body of bodies) {
            const titleLink = body.querySelector("a[href*='/event/']");
            if (!titleLink) continue;
            const title = titleLink.textContent?.trim();
            if (!title || title.length < 3) continue;
            // No explicit date element — extract from event page URL or surrounding text
            // Date often appears in nearby text like "April 14" or "Tue, Apr 14"
            const bodyText = body.textContent || "";
            const dateMatch = bodyText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}/i);
            const date = dateMatch ? `${dateMatch[0]}, ${currentYear}` : null;
            const timeMatch = bodyText.match(/\d{1,2}:\d{2}\s*[ap]m/i);
            events.push({ title, date, time: timeMatch?.[0], link: titleLink.href, cardText: bodyText });
          }
        }

        // Strategy 3: Any a[href*="/event/"] as last resort
        if (events.length === 0) {
          const links = document.querySelectorAll('a[href*="/event/"]');
          const seen = new Set();
          for (const a of links) {
            const title = a.textContent?.trim();
            if (!title || title.length < 3 || seen.has(title) || /register|more|image/i.test(title)) continue;
            seen.add(title);
            events.push({ title, date: null, time: null, link: a.href });
          }
        }

        return events;
      });

      if (raw.length > 0) {
        return raw
          .map((r) => {
            const date = tryParseDate(r.date);
            if (!date || date < TODAY) return null;
            // Bookmobile stops live on the library's calendar but aren't public
            // events. LibCal labels them; fall back to title shape if it doesn't.
            if (isMobileLibraryStop(r.cardText) || isBookmobileStopTitle(r.title)) return null;
            return {
              title: r.title,
              date,
              time: normalizeTime(r.time),
              endTime: null,
              venue: config.name,
              address: config.address,
              city: config.city,
              url: r.link || url,
              source: config.name,
              category: inferCategory(r.title),
              cost: "free",
              // Prefix-only boundary so "Storytime" matches "story", "Babies"
            // matches "baby", "Grades K-6" matches "grade", etc. Library kid-
            // event titles use a wide variety of compounds: Storytime,
            // Storyteller, Lap-Sit, Preschool, Youth, plus explicit
            // "(Ages 0-5)" / "Grades K-6" suffixes — match all of them.
            kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(r.title),
            };
          })
          .filter(Boolean);
      }
    } catch {
      continue;
    }
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// TIER 2 — Fragile HTML scrapes → robust Playwright
// ═══════════════════════════════════════════════════════════════════════════

// ── San Jose Jazz ──

async function scrapeSJJazz(page) {
  // SJ Jazz returns 403 to headless browsers — evade detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  const allEvents = [];
  for (let p = 1; p <= 6; p++) {
    const url = p === 1
      ? "https://www.sanjosejazz.org/events/"
      : `https://sanjosejazz.org/events/page/${p}/`;
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      if (!resp || resp.status() >= 400) break;

      const raw = await page.evaluate(() => {
        const events = [];
        // SJ Jazz uses .sjz-event divs with .sjz-event-name, .sjz-event-date, .sjz-event-hour
        const cards = document.querySelectorAll(".sjz-event");
        for (const card of cards) {
          const name = card.querySelector(".sjz-event-name")?.textContent?.trim();
          const date = card.querySelector(".sjz-event-date")?.textContent?.trim(); // "Sat, Apr 18"
          const hour = card.querySelector(".sjz-event-hour")?.textContent?.trim()?.replace(/\s+/g, " "); // "8pm Pacific / ..."
          const venue = card.querySelector(".sjz-event-venue")?.textContent?.trim();
          const link = card.querySelector("a")?.href;
          if (name && name.length > 3) events.push({ title: name, date, venue, link, time: hour?.match(/\d+\s*[ap]m/i)?.[0] });
        }
        return events;
      });

      for (const r of raw) {
        // SJ Jazz dates are like "Sat, Apr 18" — append current year
        const dateStr = r.date ? `${r.date}, ${new Date().getFullYear()}` : null;
        const date = tryParseDate(dateStr);
        if (!date || date < TODAY) continue;
        allEvents.push({
          title: r.title,
          date,
          time: normalizeTime(r.time),
          endTime: null,
          venue: r.venue || "San Jose Jazz Venue",
          address: "",
          city: "san-jose",
          url: r.link || "https://www.sanjosejazz.org/events/",
          source: "San Jose Jazz",
          category: "arts",
          cost: null,
          kidFriendly: false,
        });
      }
    } catch {
      break;
    }
    await page.waitForTimeout(400);
  }
  return allEvents;
}

// ── SJ Museum of Art ──

// SJMA's calendar occasionally lists cross-promotions for other venues (e.g.
// a San Jose Giants game) that this scraper would otherwise stamp with
// SJMA's own venue/address — drop rather than publish a wrong "Directions"
// address. Mirrors the same guard in generate-events.mjs::fetchSjMuseumOfArtEvents.
const SJMA_CROSS_PROMO_TITLE_RE = /\bvs\.?\s|\bversus\b/i;

async function scrapeSJMuseumOfArt(page) {
  await page.goto("https://sjmusart.org/calendar", { waitUntil: "networkidle", timeout: 25_000 });

  const raw = await page.evaluate(() => {
    const events = [];
    // Drupal Views renders events with time elements and heading pairs
    const items = document.querySelectorAll(
      ".views-row, .calendar-item, [class*='event-item'], article"
    );
    for (const item of items) {
      const titleEl = item.querySelector("h2, h3, h4, [class*='title'], a[class*='title']");
      const dateEl = item.querySelector("time[datetime], .date-display-single, [class*='date']");
      const timeEl = item.querySelector("[class*='time'], .date-display-single");
      const title = titleEl?.textContent?.trim();
      const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
      const time = timeEl?.textContent?.trim();
      const link = titleEl?.closest("a")?.href || item.querySelector("a")?.href;
      if (title && title.length > 3) events.push({ title, date, time, link });
    }
    return events;
  });

  return raw
    .map((r) => {
      const date = tryParseDate(r.date);
      if (!date || date < TODAY) return null;
      if (SJMA_CROSS_PROMO_TITLE_RE.test(r.title)) return null; // off-site cross-promotion, wrong venue data
      return {
        title: r.title,
        date,
        time: normalizeTime(r.time),
        endTime: null,
        venue: "San Jose Museum of Art",
        address: "110 S Market St, San Jose, CA 95113",
        city: "san-jose",
        url: r.link || "https://sjmusart.org/calendar",
        source: "San Jose Museum of Art",
        category: "arts",
        cost: "paid",
        kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(r.title),
      };
    })
    .filter(Boolean);
}

// ── Linden Tree Books ──

async function scrapeLindenTree(page) {
  const occurrenceSourceUrl = "https://www.lindentreebooks.com/events-calendar/";
  // Linden Tree times out on networkidle due to slow resources — use domcontentloaded
  await page.goto(occurrenceSourceUrl, {
    waitUntil: "domcontentloaded", timeout: 20_000,
  });
  await page.waitForTimeout(3000); // let main content render

  const raw = await page.evaluate(() => {
    const events = [];
    const currentYear = new Date().getFullYear();

    // Linden Tree has h3 elements containing: "Title + Day, Month DD at time"
    // e.g. "Book Launch with Marissa Meyer & Tamara MossTuesday, April 7 at 6pm"
    const headings = document.querySelectorAll("h3");
    for (const h of headings) {
      const text = h.textContent?.trim();
      if (!text || text.length < 10) continue;

      // Try to split on day name (Monday, Tuesday, etc.)
      const dayMatch = text.match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s+at\s+(\d{1,2}(?::\d{2})?\s*[ap]m)/i);
      if (!dayMatch) continue;

      // Title is everything before the day name
      const dayIdx = text.indexOf(dayMatch[1]);
      const title = text.slice(0, dayIdx).trim();
      if (!title || title.length < 5) continue;

      const month = dayMatch[2];
      const day = dayMatch[3];
      const time = dayMatch[4];
      const dateStr = `${month} ${day}, ${currentYear}`;

      const link = h.querySelector("a")?.href || h.parentElement?.querySelector("a")?.href;
      events.push({ title, date: dateStr, time, link });
    }

    // Also check the text-based listing before the h3s
    // Format: "Day, Month DD at time: Title" in the body text
    if (events.length === 0) {
      const bodyText = document.body?.innerText || "";
      const eventPattern = /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s+at\s+(\d{1,2}(?::\d{2})?\s*[ap]m):\s*(.+?)(?=\n|$)/gi;
      let match;
      while ((match = eventPattern.exec(bodyText)) !== null) {
        const dateStr = `${match[2]} ${match[3]}, ${currentYear}`;
        events.push({ title: match[5].trim(), date: dateStr, time: match[4], link: null });
      }
    }

    return events;
  });

  return raw
    .map((r) => {
      const date = tryParseDate(r.date);
      if (!date || date < TODAY) return null;
      // Links ending in .html are Lightspeed PRODUCT pages — the "featured book"
      // anchor inside each listing, not an event page. Five events once shipped
      // all pointing at the same sticker-book product (and inherited its white
      // product-cover og:image). Only keep non-product links.
      let eventLink = null;
      try {
        const candidate = new URL(r.link || "");
        const isFirstParty = ["lindentreebooks.com", "www.lindentreebooks.com"]
          .includes(candidate.hostname.toLowerCase());
        if (isFirstParty && !/\.html(\?|$)/i.test(candidate.pathname)) eventLink = candidate.href;
      } catch { /* use the organizer calendar below */ }
      return {
        title: r.title,
        date,
        time: normalizeTime(r.time),
        endTime: null,
        venue: "Linden Tree Books",
        address: "265 State St, Los Altos, CA 94022",
        city: "los-altos",
        url: eventLink || occurrenceSourceUrl,
        source: "Linden Tree Books",
        category: "arts",
        cost: "free",
        kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9]|picture\s+book)/i.test(r.title),
        occurrenceEvidence: {
          kind: "first-party-occurrence-page",
          sourceUrl: occurrenceSourceUrl,
          date,
        },
      };
    })
    .filter(Boolean);
}

// ── Hicklebee's ──

async function scrapeHicklebees(page) {
  await page.goto("https://hicklebees.com/events", {
    waitUntil: "networkidle", timeout: 25_000,
  });

  const raw = await page.evaluate(() => {
    const events = [];
    const seen = new Set();

    // Hicklebee's IndieCommerce: events in .views-row with links like /event/YYYY-MM-DD/slug
    const rows = document.querySelectorAll(".views-row");
    for (const row of rows) {
      const link = row.querySelector("a[href*='/event/']");
      if (!link) continue;
      const title = link.textContent?.trim();
      if (!title || title.length < 5 || seen.has(title) || /view event|more|about/i.test(title)) continue;
      seen.add(title);
      // Extract date from URL: /event/2026-04-25/slug
      const dateMatch = link.href?.match(/\/event\/(\d{4}-\d{2}-\d{2})\//);
      events.push({ title, date: dateMatch?.[1] || null, link: link.href });
    }

    // Fallback: grab all unique /event/ links
    if (events.length === 0) {
      const links = document.querySelectorAll("a[href*='/event/']");
      for (const a of links) {
        const title = a.textContent?.trim();
        const dateMatch = a.href?.match(/\/event\/(\d{4}-\d{2}-\d{2})\//);
        if (!title || title.length < 5 || seen.has(title) || /view|more|about|log|register/i.test(title)) continue;
        seen.add(title);
        events.push({ title, date: dateMatch?.[1] || null, link: a.href });
      }
    }

    return events;
  });

  return raw
    .map((r) => {
      const date = tryParseDate(r.date);
      if (!date || date < TODAY) return null;
      return {
        title: r.title,
        date,
        time: null,
        endTime: null,
        venue: "Hicklebee's",
        address: "1378 Lincoln Ave, San Jose, CA 95125",
        city: "san-jose",
        url: r.link || "https://hicklebees.com/events",
        source: "Hicklebee's",
        category: "arts",
        cost: "free",
        kidFriendly: true, // children's bookstore
      };
    })
    .filter(Boolean);
}

// ── History San Jose ──

async function scrapeHistorySJ(page) {
  const allEvents = [];
  for (let p = 1; p <= 4; p++) {
    const url = p === 1
      ? "https://historysanjose.org/programs-events/"
      : `https://historysanjose.org/programs-events/page/${p}`;
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      if (!resp || resp.status() >= 400) break;

      const raw = await page.evaluate(() => {
        const events = [];
        const blocks = document.querySelectorAll(
          ".event-box, [class*='event_all_box'], [class*='event-content']"
        );
        for (const block of blocks) {
          const titleEl = block.querySelector("h2, h3, [class*='title']");
          const dateEl = block.querySelector("p, [class*='date']");
          const timeEls = block.querySelectorAll(".eventtime");
          const locEl = block.querySelector(".eventlocation");
          const linkEl = block.querySelector("a[class*='button'], a");

          const title = titleEl?.textContent?.replace(/\*/g, "").trim();
          const dateText = dateEl?.textContent?.trim();
          const time = timeEls[0]?.textContent?.trim() || null;
          const endTime = timeEls[1]?.textContent?.trim() || null;
          const location = locEl?.textContent?.trim() || "";
          const link = linkEl?.href;

          if (title && title.length > 3) {
            events.push({ title, date: dateText, time, endTime, location, link });
          }
        }
        return events;
      });

      for (const r of raw) {
        const date = tryParseDate(r.date);
        if (!date || date < TODAY) continue;

        const venue = r.location?.split("|")[0]?.trim() || "History Park";
        // Address can contain extra newlines + appeals ("Stay tuned for ticket information!",
        // "Cost: Free, Register Online", "Pumpkin and carving supplies included…") —
        // strip on first newline OR on those known suffix phrases.
        const rawAddress = r.location?.includes("|")
          ? r.location.split("|")[1]?.trim()
          : "635 Phelan Ave, San Jose, CA 95112";
        const cleanedAddress = rawAddress
          ?.split("\n")[0]
          ?.split(/\s+(?:Stay tuned|Cost:|Register Online|Pumpkin and carving)/i)[0]
          ?.trim()
          ?.replace(/[\s,]+$/, "");
        const address = cleanedAddress || "635 Phelan Ave, San Jose, CA 95112";

        allEvents.push({
          title: r.title,
          date,
          time: normalizeTime(r.time),
          endTime: normalizeTime(r.endTime),
          venue,
          address,
          city: "san-jose",
          url: r.link || "https://historysanjose.org/programs-events/",
          source: "History San Jose",
          category: inferCategory(r.title),
          cost: "paid",
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(r.title),
        });
      }
    } catch {
      break;
    }
    await page.waitForTimeout(400);
  }
  return allEvents;
}

// ── Montalvo Arts Center ──

async function scrapeMontalvo(page) {
  await page.goto("https://montalvoarts.org/experience/events-calendar/", {
    waitUntil: "domcontentloaded", timeout: 20_000,
  });
  await page.waitForTimeout(3000); // let content render

  const raw = await page.evaluate(() => {
    const events = [];

    // Try JSON-LD first (most reliable)
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of ldScripts) {
      try {
        const data = JSON.parse(s.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item["@type"] === "Event" || item["@type"]?.includes("Event")) {
            events.push({
              title: item.name,
              date: item.startDate,
              time: null,
              link: item.url,
              venue: item.location?.name,
            });
          }
        }
      } catch { /* ignore parse errors */ }
    }

    // Fallback: scrape rendered DOM
    if (events.length === 0) {
      const cards = document.querySelectorAll(
        "[class*='event'], article, .card, [class*='program']"
      );
      for (const card of cards) {
        const titleEl = card.querySelector("h2, h3, h4, [class*='title']");
        const dateEl = card.querySelector("time, [class*='date'], [datetime]");
        const title = titleEl?.textContent?.trim();
        const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
        const link = card.querySelector("a")?.href;
        const NAV_JUNK = /^(skip\s+to|back\s+to\s+top|navigation|breadcrumb|close\s+menu|view\s+all|load\s+more|show\s+more|read\s+more)/i;
        if (title && title.length > 5 && !NAV_JUNK.test(title)) events.push({ title, date, link });
      }
    }

    return events;
  });

  return raw
    .map((r) => {
      const date = tryParseDate(r.date);
      if (!date || date < TODAY) return null;
      return {
        title: r.title,
        date,
        time: normalizeTime(r.time),
        endTime: null,
        venue: r.venue || "Montalvo Arts Center",
        address: "15400 Montalvo Rd, Saratoga, CA 95071",
        city: "saratoga",
        url: r.link || "https://montalvoarts.org/experience/events-calendar/",
        source: "Montalvo Arts Center",
        category: "arts",
        cost: "paid",
        kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(r.title),
      };
    })
    .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// TIER 3 — Venues with own calendars, not currently scraped
// ═══════════════════════════════════════════════════════════════════════════

// ── City Lights Theater Company ──

async function scrapeCityLights(page) {
  // City Lights lists shows as menu items with class menu-item-object-event
  await page.goto("https://cltc.org/", { waitUntil: "networkidle", timeout: 20_000 });

  const shows = await page.evaluate(() => {
    return [...document.querySelectorAll("li.menu-item-object-event a")].map(a => ({
      title: a.textContent?.trim(),
      link: a.href,
    }));
  });

  const events = [];
  // Visit each show page to extract date ranges
  for (const show of shows) {
    if (!show.title || !show.link) continue;
    try {
      await page.goto(show.link, { waitUntil: "networkidle", timeout: 15_000 });
      const detail = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        // Look for date ranges like "April 3 – May 3, 2026" or "March 14 - April 12"
        const dateRange = text.match(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}\s*[–\-—]\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)?\s*\d{1,2},?\s*\d{4}/i);
        // Also try just a start date
        const startDate = text.match(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}/i);
        return {
          dateRange: dateRange?.[0],
          startDate: startDate?.[0],
        };
      });

      const dateStr = detail.startDate || detail.dateRange;
      if (dateStr) {
        const date = tryParseDate(dateStr);
        if (date && date >= TODAY) {
          events.push({
            title: show.title,
            date,
            time: null,
            endTime: null,
            venue: "City Lights Theater Company",
            address: "529 S Second St, San Jose, CA 95112",
            city: "san-jose",
            url: show.link,
            source: "City Lights Theater",
            category: "arts",
            cost: "paid",
            kidFriendly: false,
          });
        }
      }
    } catch {
      continue;
    }
    await page.waitForTimeout(300);
  }
  return events;
}

// ── ICA San Jose ──

async function scrapeICASanJose(page) {
  const events = [];

  for (const listUrl of [
    "https://www.icasanjose.org/exhibitions/current-exhibitions/",
    "https://www.icasanjose.org/exhibitions/upcoming-exhibitions/",
  ]) {
    try {
      const resp = await page.goto(listUrl, { waitUntil: "networkidle", timeout: 20_000 });
      if (!resp || resp.status() >= 400) continue;

      // ICA uses jeg_post articles with title links
      const articles = await page.evaluate(() => {
        return [...document.querySelectorAll("article.jeg_post")].map(a => ({
          title: a.querySelector("h3 a, .jeg_post_title a, h2 a")?.textContent?.trim(),
          link: a.querySelector("a")?.href,
        }));
      });

      // Follow each exhibition link to get dates
      for (const art of articles) {
        if (!art.title || !art.link) continue;
        try {
          await page.goto(art.link, { waitUntil: "networkidle", timeout: 15_000 });
          const detail = await page.evaluate(() => {
            const text = document.body?.innerText || "";
            // Look for date ranges like "January 16 – August 23, 2026"
            const dateMatch = text.match(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}\s*[–\-—]\s*(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+)?\d{4}/i);
            // Also try single date like "Opens January 16, 2026"
            const singleDate = text.match(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}/i);
            return { dateRange: dateMatch?.[0], singleDate: singleDate?.[0] };
          });

          const dateStr = detail.singleDate || detail.dateRange;
          const date = tryParseDate(dateStr);
          // For exhibitions, use today's date if the show is current (so it shows up)
          const effectiveDate = date || TODAY;
          events.push({
            title: art.title,
            date: effectiveDate,
            time: null,
            endTime: null,
            venue: "ICA San José",
            address: "560 S First St, San Jose, CA 95113",
            city: "san-jose",
            url: art.link,
            source: "ICA San José",
            category: "arts",
            cost: "free",
            kidFriendly: false,
          });
        } catch { continue; }
        await page.waitForTimeout(300);
      }
    } catch { continue; }
  }
  return events;
}

// ── SC County Fire Department (Eventbrite organizer page) ──

async function scrapeSCCCFD(page) {
  const url = "https://www.eventbrite.com/o/santa-clara-county-fire-department-11074830922";
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(3000);

    const raw = await page.evaluate(() => {
      const events = [];
      const seen = new Set();

      // Strategy 1: JSON-LD structured data (most reliable)
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent);
          // Look for itemListElement with Event items
          const items = data.itemListElement || (Array.isArray(data) ? data : [data]);
          for (const item of items) {
            const evt = item.item || item;
            if (!evt.startDate) continue;
            const title = evt.name || evt.description?.slice(0, 80);
            if (!title || seen.has(title)) continue;
            seen.add(title);
            events.push({
              title,
              date: evt.startDate,
              link: evt.url,
              location: evt.location?.name,
            });
          }
        } catch { /* ignore */ }
      }

      // Strategy 2: Event card DOM elements
      if (events.length === 0) {
        const cards = document.querySelectorAll(".event-card__vertical, [class*='event-card'][class*='vertical']");
        for (const card of cards) {
          const titleEl = card.querySelector("h3, [class*='clamp-line']");
          const linkEl = card.querySelector("a.event-card-link");
          const title = titleEl?.textContent?.trim();
          if (!title || title.length < 5 || seen.has(title)) continue;
          seen.add(title);
          // Date/price info is in the card details section
          const detailText = card.querySelector(".event-card-details")?.textContent || "";
          const priceMatch = detailText.match(/Free|\$[\d.]+/i);
          events.push({
            title,
            date: null, // dates from cards are unreliable, prefer JSON-LD
            link: linkEl?.href,
            cost: priceMatch?.[0]?.toLowerCase() === "free" ? "free" : "paid",
          });
        }
      }

      return events;
    });

    return raw
      .map((r) => {
        const date = tryParseDate(r.date);
        if (!date || date < TODAY) return null;
        return {
          title: r.title,
          date,
          time: null,
          endTime: null,
          venue: r.location || "Online / Various",
          address: "",
          city: "san-jose",
          url: r.link || url,
          source: "SC County Fire Dept",
          category: "community",
          cost: "free",
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(r.title),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOKSTORES — Consolidated from generate-bookstore-events.mjs
// ═══════════════════════════════════════════════════════════════════════════

const BOOKS_INC_SB_STORES = new Map([
  ["mountain view", "mountain-view"],
  ["palo alto", "palo-alto"],
  ["town & country", "palo-alto"],
  ["campbell", "campbell"],
  ["saratoga", "saratoga"],
]);

async function scrapeBooksInc(page) {
  // Domain moved from booksinc.net to booksinc.com; events at /pages/events.
  // Books Inc uses an Elfsight calendar widget. The widget's JSON-LD only
  // contains date (no time), but the rendered DOM has time as visible text
  // ("6:30 PM" or "11:15 AM - 12:15 PM"). We parse the rendered text instead.
  await page.goto("https://www.booksinc.com/pages/events", { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(7000); // Elfsight needs extra hydration time

  const raw = await page.evaluate(() => {
    const events = [];
    // Card pattern: each event renders as a block of lines like:
    //   APR
    //   28
    //   TUE
    //   AUTHOR EVENT
    //   EAST BAY EVENTS
    //   THE INVENTION OF SOLITUDE BOOK CLUB: MURDER BIMBO
    //   6:30 PM
    //   Books Inc. Alameda
    const CARD_RE = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*\n\s*(\d{1,2})\s*\n\s*(SUN|MON|TUE|WED|THU|FRI|SAT)\s*\n\s*(BOOK CLUB|AUTHOR EVENT|EVENT|STORYTIME|KIDS EVENT)\s*\n\s*[^\n]+\s*\n\s*([^\n]+)\s*\n\s*(\d{1,2}:\d{2}\s*(?:AM|PM))(\s*-\s*(\d{1,2}:\d{2}\s*(?:AM|PM)))?\s*\n?\s*([^\n]+)?/;
    const all = document.querySelectorAll("div, article, li");
    const seen = new Set();
    for (const el of all) {
      const txt = (el.innerText || "").trim();
      if (!txt || txt.length > 600) continue;
      const m = txt.match(CARD_RE);
      if (!m) continue;
      const key = `${m[1]}-${m[2]}|${m[5]}|${m[6]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        month: m[1],
        day: parseInt(m[2], 10),
        title: m[5].trim(),
        time: m[6].trim(),
        endTime: m[8] ? m[8].trim() : null,
        venue: m[9] ? m[9].trim() : "",
      });
    }
    return events;
  });

  const events = [];
  const now = new Date();
  const monthIdx = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  for (const r of raw) {
    const mIdx = monthIdx[r.month];
    if (mIdx === undefined) continue;
    let year = now.getFullYear();
    const candidate = new Date(year, mIdx, r.day);
    if (candidate < new Date(now.getTime() - 30 * 86400000)) year++;
    const dateObj = new Date(year, mIdx, r.day);
    const date = isoDate(dateObj);
    if (date < TODAY) continue;

    const venueLower = (r.venue || r.title).toLowerCase();
    let city = null;
    for (const [kw, cid] of BOOKS_INC_SB_STORES) {
      if (venueLower.includes(kw)) { city = cid; break; }
    }
    if (!city) continue;

    events.push({
      title: r.title,
      date,
      time: normalizeTime(r.time),
      endTime: normalizeTime(r.endTime),
      venue: r.venue || "Books Inc",
      address: "",
      city,
      url: "https://www.booksinc.com/pages/events",
      source: "Books Inc",
      category: "arts",
      cost: "free",
      kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(r.title),
    });
  }
  return events;
}

const BN_STORES = [
  { id: "1944", name: "Stevens Creek", city: "san-jose", address: "3600 Stevens Creek Blvd, San Jose" },
  { id: "2909", name: "Blossom Hill", city: "san-jose", address: "5630 Cottle Rd, San Jose" },
];

// ── Peninsula Open Space Trust (POST) ──
// openspacetrust.org/events — Cloudflare-protected, needs real browser + a
// desktop UA (default headless UA is blocked). Event cards are well-structured
// with article.card-event containing .event-date (month/day/dayofweek),
// p.event-title > a, ul.pills.badges (category + "In Person"/"Virtual"), and
// an optional .event-time sibling.
//
// POST runs events across the whole Peninsula. We only cover the South Bay,
// so we (a) drop events whose titles name a non-South-Bay location (San Mateo
// County coast, EPA, Portola Valley, etc.), (b) drop events in unincorporated
// SCC outside our 11-city footprint (Morgan Hill, Gilroy), and (c) map known
// preserve names to the city slug they're actually in. Events whose location
// can't be inferred fall back to santa-clara-county.

// Title fragments that mean "this event is outside South Bay coverage."
// Lowercase, matched as substrings.
const POST_OUT_OF_AREA_TOKENS = [
  "east palo alto", "ravenswood",
  "half moon bay", "cowell-purisima", "cowell purisima", "purisima creek",
  "pescadero", "la honda", "san gregorio", "tunitas", "pigeon point",
  "woodside", "portola valley", "windy hill", "skyline ridge",
  "russian ridge", "mindego",
  "menlo park", "atherton", "redwood city", "san mateo",
  "pacifica", "san bruno",
  "morgan hill", "gilroy", "san martin",
  // San Mateo County coastal/bayside sites POST runs walks at. The catch-all in
  // inferPostLocation already drops unmapped preserves, but name them so the
  // intent is explicit rather than incidental — these reached the published feed
  // before that catch-all existed, tagged "santa-clara-county".
  "wavecrest", "bair island", "pillar point",
];

// Map preserve / park names to South Bay city slug + canonical venue name.
// Order matters — longest / most specific keys first so a title like
// "Stevens Creek Trail" hits the mountain-view rule before the generic
// "stevens creek" cupertino rule.
const POST_LOCATION_RULES = [
  ["stevens creek trail",  "mountain-view", "Stevens Creek Trail"],
  ["pearson-arastradero",  "palo-alto",     "Pearson-Arastradero Preserve"],
  ["bear creek redwoods",  "los-gatos",     "Bear Creek Redwoods OSP"],
  ["lexington reservoir",  "los-gatos",     "Lexington Reservoir"],
  ["almaden quicksilver",  "san-jose",      "Almaden Quicksilver County Park"],
  ["rancho san antonio",   "los-altos",     "Rancho San Antonio OSP"],
  ["saratoga gap",         "saratoga",      "Saratoga Gap OSP"],
  ["fremont older",        "cupertino",     "Fremont Older OSP"],
  ["foothills park",       "palo-alto",     "Foothills Nature Preserve"],
  ["arastradero",          "palo-alto",     "Pearson-Arastradero Preserve"],
  ["alum rock",            "san-jose",      "Alum Rock Park"],
  ["coyote creek",         "san-jose",      "Coyote Creek"],
  ["sierra azul",          "los-gatos",     "Sierra Azul OSP"],
  ["st. joseph",           "los-gatos",     "St. Joseph's Hill OSP"],
  ["el sereno",            "saratoga",      "El Sereno OSP"],
  ["picchetti",            "cupertino",     "Picchetti Ranch OSP"],
  ["stevens creek",        "cupertino",     "Stevens Creek County Park"],
  ["shoreline",            "mountain-view", "Shoreline Park"],
  ["baylands",             "palo-alto",     "Baylands Nature Preserve"],
  ["hellyer",              "san-jose",      "Hellyer County Park"],
  ["calero",               "san-jose",      "Calero County Park"],
];

function inferPostLocation(title) {
  const t = (title || "").toLowerCase();
  for (const tok of POST_OUT_OF_AREA_TOKENS) {
    if (t.includes(tok)) return null; // signal: drop
  }
  for (const [name, slug, venue] of POST_LOCATION_RULES) {
    if (t.includes(name)) return { city: slug, venue };
  }
  // Unmapped preserve name — "santa-clara-county" isn't in the City union
  // (src/lib/south-bay/types.ts) and a generic "Various POST preserves"
  // venue gives Directions nothing real to point at. Drop rather than
  // publish an unlocatable event; add the preserve to POST_LOCATION_RULES
  // (in-area) or POST_OUT_OF_AREA_TOKENS (out-of-area) once known. D53.
  return null;
}

async function scrapePOST(page) {
  // Force a realistic desktop UA so Cloudflare serves the real page.
  await page.setExtraHTTPHeaders({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  try {
    await page.goto("https://openspacetrust.org/events/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch {
    return [];
  }
  await page.waitForTimeout(4000); // let Cloudflare settle and cards render

  const raw = await page.evaluate(() => {
    const out = [];
    const cards = document.querySelectorAll("article.card-event");
    for (const card of cards) {
      const month = card.querySelector(".event-month")?.textContent?.trim() ?? "";
      const day = card.querySelector(".event-day")?.textContent?.trim() ?? "";
      if (!month || !day) continue;

      const titleLink = card.querySelector("p.event-title a, .event-title a");
      const title = titleLink?.textContent?.trim() ?? "";
      const link = titleLink?.href ?? card.querySelector(".event-image a")?.href ?? "";
      if (!title || title.length < 4) continue;

      const tags = Array.from(card.querySelectorAll("ul.pills li, .pills li, .badges li"))
        .map((t) => t.textContent?.trim() ?? "")
        .filter(Boolean);
      const tagsLower = tags.join("|").toLowerCase();

      // Time pattern: "9:30 A.M. - 1:30 P.M." or "9:00 AM" — in the content area.
      const content = card.querySelector(".event-content")?.textContent ?? card.textContent ?? "";
      const timeMatch = content.match(/(\d{1,2}(?::\d{2})?\s*[AP]\.?\s*M\.?)(?:\s*[-–]\s*(\d{1,2}(?::\d{2})?\s*[AP]\.?\s*M\.?))?/i);

      out.push({
        month, day,
        title,
        link,
        time: timeMatch?.[1] ?? null,
        endTime: timeMatch?.[2] ?? null,
        tags,
        virtual: /\bvirtual\b|\bonline\b|webinar/i.test(tagsLower) || /\bvirtual\b|\bonline\b|webinar/i.test(title),
        volunteer: /\bvolunteer\b/i.test(tagsLower),
      });
    }
    return out;
  });

  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth();
  const seen = new Set();
  const events = [];

  for (const r of raw) {
    const m = MONTHS[r.month];
    if (m == null) continue;
    // Infer year: if the month is >= 4 months behind now, it's next year.
    const y = m < curMonth - 3 ? curYear + 1 : curYear;
    const d = new Date(y, m, parseInt(r.day, 10));
    const date = isoDate(d);
    if (date < TODAY) continue;

    const dedup = `${date}|${r.title.toLowerCase()}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    // Virtual webinars don't have a physical location — keep them as
    // santa-clara-county. Otherwise infer city + canonical venue from title;
    // a null result means "drop, this event is outside our area."
    let city, venue, address;
    if (r.virtual) {
      city = "santa-clara-county";
      venue = "Online (POST Webinar)";
      address = "";
    } else {
      const loc = inferPostLocation(r.title);
      if (loc === null) continue;
      city = loc.city;
      venue = loc.venue ?? "Peninsula Open Space Trust";
      address = loc.venue ? "" : "Various POST preserves + partner locations";
    }

    events.push({
      title: r.title,
      date,
      time: normalizeTime(r.time?.replace(/\./g, "") ?? null),
      endTime: normalizeTime(r.endTime?.replace(/\./g, "") ?? null),
      venue,
      address,
      city,
      url: r.link || "https://openspacetrust.org/events/",
      source: "Peninsula Open Space Trust",
      // EventCategory enum (src/data/south-bay/events-data.ts) doesn't include
      // "nature" or "volunteer" — UI filters drop those events. Map to valid keys.
      category: r.volunteer ? "community" : "outdoor",
      cost: "free",
      kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(r.title),
    });
  }
  return events;
}

async function scrapeBN(page) {
  const allEvents = [];
  for (const store of BN_STORES) {
    try {
      await page.goto(`https://stores.barnesandnoble.com/store/${store.id}?view=calendar`, {
        waitUntil: "networkidle", timeout: 30_000,
      });
      await page.waitForTimeout(2000);

      const raw = await page.evaluate(() => {
        const events = [];
        const cards = document.querySelectorAll(
          ".event-card, .store-event, [class*='event'], .calendar-event, article"
        );
        for (const card of cards) {
          const titleEl = card.querySelector("h2, h3, h4, .event-name, [class*='title']");
          const dateEl = card.querySelector("time, .event-date, [class*='date']");
          const timeEl = card.querySelector(".event-time, [class*='time']");
          const title = titleEl?.textContent?.trim();
          const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
          const time = timeEl?.textContent?.trim();
          const link = card.querySelector("a")?.href;
          if (title) events.push({ title, date, time, link });
        }
        return events;
      });

      for (const r of raw) {
        const date = tryParseDate(r.date);
        if (!date || date < TODAY) continue;
        allEvents.push({
          title: r.title,
          date,
          time: normalizeTime(r.time),
          endTime: null,
          venue: `Barnes & Noble ${store.name}`,
          address: store.address,
          city: store.city,
          url: r.link || `https://stores.barnesandnoble.com/store/${store.id}`,
          source: "Barnes & Noble",
          category: "arts",
          cost: "free",
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(r.title),
        });
      }
    } catch {
      // skip this store
    }
  }
  return allEvents;
}

const HPB_STORES = [
  { slug: "675-saratoga-ave", name: "San Jose", city: "san-jose", address: "675 Saratoga Ave, San Jose" },
  { slug: "21607b-stevens-creek", name: "Cupertino", city: "cupertino", address: "21607 Stevens Creek Blvd, Cupertino" },
];

async function scrapeHPB(page) {
  const allEvents = [];
  for (const store of HPB_STORES) {
    try {
      await page.goto(`https://hpb.com/store-events?location=${store.slug}`, {
        waitUntil: "networkidle", timeout: 30_000,
      });
      await page.waitForTimeout(2000);

      const raw = await page.evaluate(() => {
        const events = [];
        const cards = document.querySelectorAll(
          ".event, [class*='event-card'], [class*='event-item'], article"
        );
        for (const card of cards) {
          const titleEl = card.querySelector("h2, h3, h4, [class*='title']");
          const dateEl = card.querySelector("time, [class*='date']");
          const timeEl = card.querySelector("[class*='time']");
          const title = titleEl?.textContent?.trim();
          const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
          const time = timeEl?.textContent?.trim();
          const link = card.querySelector("a")?.href;
          if (title) events.push({ title, date, time, link });
        }
        return events;
      });

      for (const r of raw) {
        const date = tryParseDate(r.date);
        if (!date || date < TODAY) continue;
        allEvents.push({
          title: r.title,
          date,
          time: normalizeTime(r.time),
          endTime: null,
          venue: `Half Price Books ${store.name}`,
          address: store.address,
          city: store.city,
          url: r.link || "https://hpb.com/store-events",
          source: "Half Price Books",
          category: "arts",
          cost: "free",
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(r.title),
        });
      }
    } catch {
      // skip this store
    }
  }
  return allEvents;
}

// ═══════════════════════════════════════════════════════════════════════════
// HIGH-YIELD VENUES / DISTRICTS
// ═══════════════════════════════════════════════════════════════════════════

async function scrapeMountainWinery(page) {
  await page.setExtraHTTPHeaders({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  await page.goto("https://www.mountainwinery.com/concert-series", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  const raw = await page.evaluate(() => {
    const events = [];
    const seen = new Set();

    // The calendar exposes one first-party detail link and one event-specific
    // AXS image on each desktop card. Prefer that structured DOM over the old
    // whole-page text heuristic, which could only return the generic concert
    // series URL and left image resolution to a venue photo.
    for (const card of document.querySelectorAll('a.c-axs-event-card__header[href*="/events/detail"]')) {
      const title = card.querySelector(".c-axs-event-card__title")?.textContent?.trim() || "";
      const supporting = card.querySelector(".c-axs-event-card__supporting-text")?.textContent?.trim() || "";
      const day = card.querySelector(".day-date .day")?.textContent?.trim() || "";
      const date = card.querySelector(".day-date .date")?.textContent?.trim() || "";
      const time = card.querySelector(".show .show")?.textContent?.trim() || "";
      const image = card.querySelector("img.mediaImage") || card.querySelector("img");
      const link = card.href || "";
      if (!title || !date || !link) continue;
      const key = link;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        title,
        supporting,
        date: `${day} ${date}`.replace(/\s+/g, " ").trim(),
        time,
        link,
        image: image?.currentSrc || image?.src || "",
        imageAlt: image?.alt || title,
      });
    }
    if (events.length) return events;

    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        const stack = Array.isArray(data) ? [...data] : [data];
        while (stack.length) {
          const item = stack.shift();
          if (!item || typeof item !== "object") continue;
          if (Array.isArray(item)) { stack.push(...item); continue; }
          const type = Array.isArray(item["@type"]) ? item["@type"].join(" ") : item["@type"];
          if (/\bEvent\b/i.test(type || "") && item.name && item.startDate) {
            const key = `${item.name}|${item.startDate}`;
            if (!seen.has(key)) {
              seen.add(key);
              events.push({ title: item.name, date: item.startDate, link: item.url, venue: item.location?.name });
            }
          }
          for (const value of Object.values(item)) {
            if (value && typeof value === "object") stack.push(value);
          }
        }
      } catch { /* ignore */ }
    }

    const lines = (document.body?.innerText || "")
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const dateLine = lines[i];
      if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(dateLine)) continue;
      const time = lines[i + 1] && /\d/.test(lines[i + 1]) ? lines[i + 1] : null;
      const candidates = [];
      for (let j = i - 1; j >= 0; j--) {
        const line = lines[j];
        if (/^BUY TICKETS$/i.test(line)) break;
        if (/^(JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|JANUARY|FEBRUARY|MARCH|APRIL|MAY)\s*\d{4}$/i.test(line)) break;
        candidates.unshift(line);
      }
      const titleCandidates = candidates
        .filter((line) => !/^(BUY TICKETS|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|CANN PRESENTS|PALLADIUM ENTERTAINMENT PRESENTS|AN EVENING WITH|PRIMETIME)$/i.test(line))
        .filter((line) => !/\bpresents\b$/i.test(line))
        .filter((line) => !/^with special guests?/i.test(line))
        .filter((line) => !/^performed by\b/i.test(line))
        .filter((line) => !/\b(line dancing|tour)\b/i.test(line))
        .filter((line) => !/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(line))
        .filter((line) => !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/i.test(line));
      let title = titleCandidates[titleCandidates.length - 1];
      if (/^(celebrating|where it all began|usa meets|the very best)/i.test(title || "") && titleCandidates.length > 1) {
        title = titleCandidates[titleCandidates.length - 2];
      } else if (titleCandidates.length > 1 && !/^(with|featuring|special guests?|celebrating)/i.test(titleCandidates[titleCandidates.length - 1])) {
        const previous = titleCandidates[titleCandidates.length - 2];
        if (!/^(an evening with|cann presents|palladium entertainment presents|primetime)$/i.test(previous)) {
          title = `${previous} with ${titleCandidates[titleCandidates.length - 1]}`;
        }
      }
      if (!title) continue;
      const key = `${title}|${dateLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ title, date: dateLine, time, link: "https://www.mountainwinery.com/concert-series" });
    }
    return events;
  });

  const COMEDY_NAMES = /\b(Trevor Noah|Bill Burr|Jeff Dunham|John Mulaney|Dana Carvey|Chris Tucker|Jeff Foxworthy|David Spade|Sebastian Maniscalco|Tom Segura|Bert Kreischer|Nate Bargatze|Jerry Seinfeld|Ali Wong|Hasan Minhaj|Adam Sandler|Kevin Hart|Bo Burnham|Mike Birbiglia|Jim Gaffigan|Patton Oswalt|Iliza Shlesinger|Ronny Chieng|Pete Davidson)\b/i;
  return raw.map((r) => {
    const card = normalizeMountainWineryCard(r) || r;
    const date = yearAwareDate(card.date);
    if (!date || date < TODAY || !isUsefulTitle(card.title)) return null;
    // Drop billing fragments where the headliner couldn't be parsed —
    // "with Wang Chung…", "Special Guest Cheap Trick" — these would render
    // as a meaningless event title.
    if (/^(with\s|special guest)/i.test(card.title)) return null;
    const isComedy = /\b(comedy|comedian|stand-?up)\b/i.test(card.title) || COMEDY_NAMES.test(card.title);
    return {
      title: card.title,
      date,
      time: isoTimeToClock(card.date) || clockFromText(card.time) || clockFromText(card.date),
      endTime: null,
      venue: r.venue || "The Mountain Winery",
      address: "14831 Pierce Rd, Saratoga, CA 95070",
      city: "saratoga",
      url: card.link || "https://www.mountainwinery.com/concert-series",
      source: "Mountain Winery",
      category: isComedy ? "arts" : "music",
      cost: "paid",
      kidFriendly: KID_RE.test(card.title),
      ...(card.image ? { image: card.image } : {}),
      ...(card.imageAlt ? { imageAlt: card.imageAlt } : {}),
      ...(card.imageSourceUrl ? { imageSourceUrl: card.imageSourceUrl } : {}),
    };
  }).filter(Boolean);
}

const SAN_JOSE_THEATERS = [
  {
    name: "San Jose Theaters",
    url: "https://sanjosetheaters.org/calendar-condensed/",
    source: "San Jose Theaters",
    venue: "San Jose Theaters",
    address: "Downtown San Jose",
  },
  {
    name: "Hammer Theatre",
    url: "https://hammertheatre.com/events/",
    source: "Hammer Theatre",
    venue: "Hammer Theatre Center",
    address: "101 Paseo de San Antonio, San Jose, CA 95113",
  },
];

async function scrapeEventListPage(page, config) {
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(config.waitMs || 2500);

  const raw = await page.evaluate((monthReSource) => {
    const events = [];
    const seen = new Set();
    const monthRe = new RegExp(`\\b(${monthReSource})\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b`, "i");

    const push = (event) => {
      if (!event.title || !event.date) return;
      const key = `${event.title}|${event.date}|${event.link || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      events.push(event);
    };

    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const stack = Array.isArray(data) ? [...data] : [data];
        while (stack.length) {
          const item = stack.shift();
          if (!item || typeof item !== "object") continue;
          if (Array.isArray(item)) { stack.push(...item); continue; }
          const type = Array.isArray(item["@type"]) ? item["@type"].join(" ") : item["@type"];
          if (/\bEvent\b/i.test(type || "")) {
            push({
              title: item.name,
              date: item.startDate,
              endDate: item.endDate,
              link: item.url,
              venue: item.location?.name,
              eventStatus: item.eventStatus,
            });
          }
          for (const value of Object.values(item)) {
            if (value && typeof value === "object") stack.push(value);
          }
        }
      } catch { /* ignore */ }
    }

    const cards = document.querySelectorAll("article, [class*='event'], [class*='tribe'], [class*='calendar'], .card, li");
    for (const card of cards) {
      const text = card.textContent?.replace(/\s+/g, " ").trim() || "";
      if (text.length < 10 || text.length > 900) continue;
      const titleEl = card.querySelector("h1,h2,h3,h4,[class*='title'],[class*='name']");
      const title = titleEl?.textContent?.replace(/\s+/g, " ").trim();
      const date = card.querySelector("time")?.getAttribute("datetime")
        || card.querySelector("time")?.textContent
        || text.match(monthRe)?.[0];
      const link = titleEl?.closest("a")?.href || card.querySelector("a[href]")?.href;
      const venue = card.querySelector("[class*='venue'], [class*='location']")?.textContent?.replace(/\s+/g, " ").trim();
      push({ title, date, link, venue, text });
    }
    return events;
  }, MONTH_RE);

  return raw.map((r) => {
    const date = yearAwareDate(r.date);
    if (!date || date < TODAY || !isUsefulTitle(r.title)) return null;
    return {
      title: r.title,
      date,
      time: isoTimeToClock(r.date) || clockFromText(r.text || r.date),
      endTime: isoTimeToClock(r.endDate),
      venue: normalizeVenueText(r.venue, config.venue),
      address: config.address,
      city: config.city || "san-jose",
      url: r.link && !/^mailto:/i.test(r.link) ? r.link : config.url,
      source: config.source,
      category: config.category || inferCategory(r.title),
      cost: config.cost || null,
      kidFriendly: KID_RE.test(`${r.title} ${r.text || ""}`),
      ...(r.eventStatus ? { eventStatus: r.eventStatus } : {}),
      ...(config.occurrenceSourceUrl ? {
        occurrenceEvidence: {
          kind: "first-party-occurrence-page",
          sourceUrl: config.occurrenceSourceUrl,
          date,
        },
      } : {}),
    };
  }).filter(Boolean);
}

async function scrapeSanJoseTheaters(page) {
  const url = "https://events.timely.fun/jc0x91t0/stream?tags=677512582&notoolbar=1&nofilters=1&timely_id=timely-iframe-embed-0";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3500);

  const raw = await page.evaluate(() => {
    const lines = (document.body?.innerText || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    const venues = ["California Theatre", "Montgomery Theater", "San Jose Civic", "Center for the Performing Arts"];
    const dayHeader = /^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY),/;
    for (let i = 1; i < lines.length; i++) {
      const detail = lines[i];
      if (!/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+\d{4}/i.test(detail)) continue;
      const title = lines[i - 1];
      if (!title || dayHeader.test(title)) continue;
      const venue = venues.find((v) => detail.includes(v)) || "San Jose Theaters";
      const time = detail.match(/@\s*([^@]+?)\s+(?:California Theatre|Montgomery Theater|San Jose Civic|Center for the Performing Arts)/)?.[1] || null;
      out.push({ title, date: detail, time, venue });
    }
    return out;
  });

  const addressByVenue = {
    "California Theatre": "345 S 1st St, San Jose, CA 95113",
    "Montgomery Theater": "271 S Market St, San Jose, CA 95113",
    "San Jose Civic": "135 W San Carlos St, San Jose, CA 95113",
    "Center for the Performing Arts": "255 S Almaden Blvd, San Jose, CA 95113",
  };

  return raw.map((r) => {
    const date = yearAwareDate(r.date);
    if (!date || date < TODAY || !isUsefulTitle(r.title)) return null;
    return {
      title: r.title,
      date,
      time: clockFromText(r.time),
      endTime: null,
      venue: r.venue,
      address: addressByVenue[r.venue] || "Downtown San Jose",
      city: "san-jose",
      url: "https://sanjosetheaters.org/calendar-condensed/",
      source: "San Jose Theaters",
      category: inferCategory(r.title),
      cost: "paid",
      kidFriendly: KID_RE.test(r.title),
    };
  }).filter(Boolean);
}

async function scrapeHammerTheatre(page) {
  const events = await scrapeEventListPage(page, SAN_JOSE_THEATERS[1]);
  return events.filter((e) => !/\bthere are no upcoming events\b|events search/i.test(e.title));
}

async function scrapeChildrensDiscoveryMuseum(page) {
  await page.setExtraHTTPHeaders({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  await page.goto("https://www.cdm.org/calendar/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);

  const raw = await page.evaluate(() => {
    const lines = (document.body?.innerText || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    const labels = /^(Art Activity|Performance|Special Event|Ongoing|Always on)$/i;
    for (let i = 0; i < lines.length; i++) {
      const date = lines[i];
      if (!/^(Weekdays|Weekends|Every|Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|March|April|May|June|July|August|September|October|November|December)\b/i.test(date)) continue;
      const title = lines[i - 1];
      const type = lines[i - 2];
      if (!title || labels.test(title) || !labels.test(type || "Special Event")) continue;
      const time = lines[i + 1] && /\d{1,2}(:\d{2})?\s*(am|pm)/i.test(lines[i + 1]) ? lines[i + 1] : null;
      out.push({ title, date, time, type });
    }
    return out;
  });

  return raw.map((r) => {
    let date = yearAwareDate(r.date);
    if (/^(weekdays|weekends|every)/i.test(r.date)) date = TODAY;
    if (!date || date < TODAY || !isUsefulTitle(r.title)) return null;
    return {
      title: r.title,
      date,
      time: clockFromText(r.time),
      endTime: null,
      venue: "Children's Discovery Museum",
      address: "180 Woz Way, San Jose, CA 95110",
      city: "san-jose",
      url: "https://www.cdm.org/calendar/",
      source: "Children's Discovery Museum",
      category: "family",
      cost: "paid",
      kidFriendly: true,
    };
  }).filter(Boolean);
}

async function scrapePaloAltoArtCenter(page) {
  return scrapeEventListPage(page, {
    url: "https://www.cityofpaloalto.org/Departments/Community-Services/Arts-Sciences/Palo-Alto-Art-Center/Events",
    source: "Palo Alto Art Center",
    venue: "Palo Alto Art Center",
    address: "1313 Newell Rd, Palo Alto, CA 94303",
    city: "palo-alto",
    category: "arts",
    cost: "free",
  });
}

async function scrapeMidpen(page) {
  await page.goto("https://www.openspace.org/get-involved/events-activities", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);
  const raw = await page.evaluate(() => [...document.querySelectorAll("tbody tr")].map((row) => {
    const titleLink = row.querySelector(".views-field-title a[href]");
    return {
      activity: row.querySelector(".views-field-type")?.textContent?.trim() || "",
      title: titleLink?.textContent?.trim() || "",
      url: titleLink?.href || "",
      date: row.querySelector(".activity-search-date")?.textContent?.trim() || "",
      time: row.querySelector(".activity-search-time")?.textContent?.trim() || "",
      preserve: row.querySelector(".views-field-field-preserve-term-1")?.textContent?.trim() || "",
    };
  }).filter((row) => /^(GUIDED ACTIVITY|VOLUNTEER PROJECT)$/i.test(row.activity) && row.title));
  const locationRules = [
    [/bear creek redwoods|sierra azul/i, "los-gatos"],
    [/fremont older|monte bello/i, "cupertino"],
    [/rancho san antonio/i, "los-altos"],
    [/foothills|los trancos/i, "palo-alto"],
  ];
  const cityLabel = {
    "los-gatos": "Los Gatos",
    "cupertino": "Cupertino",
    "los-altos": "Los Altos",
    "palo-alto": "Palo Alto",
  };
  const outOfArea = /\b(la honda|pulgas ridge|purisima|long ridge|russian ridge|skyline ridge|windy hill|el corte de madera|pescadero|half moon bay|ravenswood)\b/i;
  return raw.map((r) => {
    const date = yearAwareDate(r.date);
    const url = normalizeMidpenOccurrenceUrl(r.url);
    if (!date || date < TODAY || !isUsefulTitle(r.title)) return null;
    if (!url) return null;
    if (/\b(meeting|budget|committee|board)\b/i.test(r.title)) return null;
    const place = (r.preserve || "Midpen Open Space Preserve").replace(/\t.*$/, "").trim();
    if (outOfArea.test(`${r.title} ${place}`)) return null;
    let city = null;
    for (const [re, slug] of locationRules) {
      if (re.test(`${r.title} ${place}`)) { city = slug; break; }
    }
    // Unmapped preserve — "santa-clara-county" isn't in the City union
    // (src/lib/south-bay/types.ts) and an unresolved preserve name gives
    // Directions nothing real to point at. Drop rather than publish an
    // unlocatable event; add the preserve to locationRules (in-area) or
    // outOfArea (out-of-area) once known. D53.
    if (!city) return null;
    return {
      title: r.title,
      date,
      time: clockFromText(r.time),
      endTime: null,
      venue: place,
      address: place === "Midpen Open Space Preserve" ? "" : `${place}, ${cityLabel[city] || "Santa Clara County"}`,
      city,
      url,
      source: "Midpen Open Space",
      category: r.activity === "VOLUNTEER PROJECT" ? "community" : "outdoor",
      cost: "free",
      kidFriendly: KID_RE.test(r.title),
    };
  }).filter(Boolean);
}

async function scrapeGuadalupeRiverPark(page) {
  const events = await scrapeEventListPage(page, {
    url: "https://www.grpg.org/events",
    occurrenceSourceUrl: "https://grpg.org/calendar/events/",
    source: "Guadalupe River Park Conservancy",
    venue: "Guadalupe River Park",
    address: "438 Coleman Ave, San Jose, CA 95110",
    city: "san-jose",
    category: "outdoor",
    cost: "free",
  });

  // GRPG's embedded calendar omits the location and description for this
  // event even though its registration details include both. Keep the
  // reader-confirmed facts here so the next scrape cannot undo the fix.
  const correctedEvents = events.map((event) => {
    if (
      event.date === "2026-07-18" &&
      /^Restore & Explore: Trail Clean Up and Trail Tour$/i.test(event.title)
    ) {
      return {
        ...event,
        title: "Restore & Explore: Trail Clean-Up & Trail Tour",
        endTime: "11:00 AM",
        venue: "Arena Green West",
        address: "N Autumn St, San Jose, CA 95110",
        description:
          "Trail clean-up and guided tour for ages 10+. Adult chaperones are required for participants 15 and under. Questions: events@grpg.org or volunteer@grpg.org.",
        kidFriendly: true,
      };
    }
    return event;
  });

  // Only return exact dated rows present on the organizer's current calendar.
  // A cadence such as "first Thursday" is a recheck hint, not proof that a
  // future occurrence is actually scheduled.
  return correctedEvents;
}

async function scrapeSantanaRow(page) {
  await page.goto("https://www.santanarow.com/events/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);
  const raw = await page.evaluate(() => {
    const out = [];
    const links = [...document.querySelectorAll('a[href*="/event/"]')];
    for (const a of links) {
      const text = a.textContent?.replace(/\s+/g, " ").trim() || "";
      const title = a.querySelector("h1,h2,h3,.title")?.textContent?.replace(/\s+/g, " ").trim();
      const date = a.querySelector(".date")?.textContent?.replace(/\s+/g, " ").trim();
      if (!title || !date) continue;
      out.push({ title, date, link: a.href, text });
    }
    return out;
  });
  return raw.map((r) => {
    const date = yearAwareDate(r.date);
    if (!date || date < TODAY || !isUsefulTitle(r.title) || /work on the row/i.test(r.title)) return null;
    return {
      title: r.title,
      date,
      time: clockFromText(r.text),
      endTime: null,
      venue: "Santana Row",
      address: "377 Santana Row, San Jose, CA 95128",
      city: "san-jose",
      url: r.link || "https://www.santanarow.com/events/",
      source: "Santana Row",
      category: inferCategory(r.title),
      cost: null,
      kidFriendly: KID_RE.test(r.text),
    };
  }).filter(Boolean);
}

async function scrapeDowntownMountainView(page) {
  return scrapeEventListPage(page, {
    url: "https://www.downtownmountainview.com/events",
    source: "Downtown Mountain View",
    venue: "Downtown Mountain View",
    address: "Castro Street, Mountain View, CA",
    city: "mountain-view",
    category: "community",
  });
}

async function scrapeCupertinoOpenCities(page) {
  const directoryUrl = "https://www.cupertino.gov/Events-directory";
  await page.goto(directoryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1500);

  const links = [];
  const seenLinks = new Set();
  const collectLinks = async () => {
    const pageLinks = await page.evaluate(() => {
      return [...document.querySelectorAll("a[href]")]
        .map((a) => ({
          text: a.textContent?.replace(/\s+/g, " ").trim() || "",
          href: a.href?.split("#")[0],
        }))
        .filter((a) => /\d{2}\s+[A-Z][a-z]{2}\s+20\d{2}/.test(a.text) && a.href?.includes("cupertino.gov"));
    });
    for (const link of pageLinks) {
      if (!link.href || seenLinks.has(link.href)) continue;
      seenLinks.add(link.href);
      links.push(link);
    }
  };

  for (let pageNo = 1; pageNo <= 4; pageNo++) {
    await collectLinks();
    const next = page.locator(`a[href$="#page-${pageNo + 1}"]`).first();
    if ((await next.count()) === 0) break;
    await next.click();
    await page.waitForTimeout(900);
  }

  const raw = [];
  for (const link of links.slice(0, 45)) {
    try {
      await page.goto(link.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(500);
      const detail = await page.evaluate(() => {
        const lines = (document.body?.innerText || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
        const title = document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()
          || document.title.replace(/\s+Cupertino CA\s*$/i, "").trim();
        const nextDate = document.querySelector(".event-date")?.textContent?.replace(/\s+/g, " ").trim().replace(/^Next date:\s*/i, "");
        const slots = [...document.querySelectorAll(".multi-date-item")]
          .map((li) => li.textContent?.replace(/\s+/g, " ").trim())
          .filter(Boolean);
        if (slots.length === 0 && nextDate) slots.push(nextDate);

        const titleIdx = lines.findIndex((line) => line === title);
        const whenIdx = lines.findIndex((line) => /^When$/i.test(line));
        const description = titleIdx >= 0 && whenIdx > titleIdx
          ? lines.slice(titleIdx + 2, whenIdx).join(" ").replace(/\s+/g, " ").trim()
          : "";
        const locationIdx = lines.findIndex((line) => /^Location$/i.test(line));
        const location = locationIdx >= 0 ? lines[locationIdx + 1] || "" : "";
        const costIdx = lines.findIndex((line) => /^Cost$/i.test(line));
        const cost = costIdx >= 0 ? lines[costIdx + 1] || "" : "";
        const taggedIdx = lines.findIndex((line) => /^Tagged as:$/i.test(line));
        const tags = taggedIdx >= 0 ? lines.slice(taggedIdx + 1, taggedIdx + 8).join(" ") : "";
        return { title, slots, description, location, cost, tags };
      });
      for (const slot of detail.slots) raw.push({ ...detail, slot, url: link.href });
    } catch {
      // OpenCities detail pages occasionally time out under load; keep the rest.
    }
  }

  const seen = new Set();
  return raw.map((r) => {
    if (/observed holidays|working group meetings/i.test(r.title)) return null;
    const date = yearAwareDate(r.slot);
    const { time, endTime } = clockRangeFromText(r.slot);
    if (!date || date < TODAY || !time || !isUsefulTitle(r.title)) return null;
    const venue = normalizeVenueText((r.location || "").split(",")[0], "Cupertino");
    const key = `${date}|${time}|${r.title}|${venue}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      title: r.title,
      date,
      time,
      endTime: clockMinutes(endTime) > clockMinutes(time) ? endTime : null,
      venue,
      address: r.location || "",
      city: "cupertino",
      url: r.url,
      source: "City of Cupertino",
      category: /\b(concert|music|disco|movie)\b/i.test(r.title) ? "music" : inferCategory(`${r.title} ${r.tags || ""}`),
      cost: /^free$/i.test(r.cost || "") ? "free" : null,
      description: r.description,
      kidFriendly: KID_RE.test(`${r.title} ${r.tags || ""}`),
    };
  }).filter(Boolean);
}

async function scrapeOperaSanJose(page) {
  await page.goto("https://www.operasj.org/events", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2000);
  const raw = await page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll(".tribe-events-calendar-list__event")) {
      const title = card.querySelector(".tribe-events-calendar-list__event-title-link")?.textContent?.replace(/\s+/g, " ").trim();
      const link = card.querySelector(".tribe-events-calendar-list__event-title-link")?.href;
      const timeEl = card.querySelector(".tribe-events-calendar-list__event-datetime");
      const date = timeEl?.getAttribute("datetime") || timeEl?.textContent;
      const timeText = timeEl?.textContent?.replace(/\s+/g, " ").trim();
      const description = card.querySelector(".tribe-events-calendar-list__event-description")?.textContent?.replace(/\s+/g, " ").trim() || "";
      if (title) out.push({ title, link, date, timeText, description });
    }
    return out;
  });

  const seen = new Set();
  return raw.map((r) => {
    const date = yearAwareDate(r.date || r.timeText);
    const time = clockFromText(r.timeText);
    if (!date || date < TODAY || !time || !isUsefulTitle(r.title)) return null;
    const key = `${date}|${time}|${r.title}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      title: r.title,
      date,
      time,
      endTime: null,
      venue: "California Theatre",
      address: "345 S 1st St, San Jose, CA 95113",
      city: "san-jose",
      url: r.link || "https://www.operasj.org/events",
      source: "Opera San José",
      category: "arts",
      cost: "paid",
      description: r.description,
      kidFriendly: false,
    };
  }).filter(Boolean);
}

async function scrapeTheatreWorks(page) {
  // Tessitura TNEW SPA — the list view renders every on-sale production with
  // its full performance calendar (12-month window). Only productions with
  // tickets on sale appear; later-season shows roll in as they go on sale.
  // Downstream generate-events caps non-sports events at 180 days out.
  await page.goto("https://my.theatreworks.org/events", { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForSelector(".tn-prod-list-item", { timeout: 20_000 });
  const raw = await page.evaluate(() => {
    const out = [];
    for (const item of document.querySelectorAll(".tn-prod-list-item")) {
      const title = item.querySelector("h1,h2,h3,h4")?.textContent?.replace(/\s+/g, " ").trim();
      const blob = (item.textContent || "").replace(/\s+/g, " ");
      // Listing body = run range + venue + credits + synopsis; the synopsis is
      // reliably the longest paragraph.
      const paragraphs = [...item.querySelectorAll("p")]
        .map((p) => p.textContent.replace(/\s+/g, " ").trim());
      const description = paragraphs.sort((a, b) => b.length - a.length)[0] || "";
      const venueKey = /Lucie Stern/i.test(blob)
        ? "lucie"
        : /Mountain View Center/i.test(blob) ? "mvcpa" : null;
      const perfs = [...item.querySelectorAll(".tn-prod-list-item__perf-list-item")].map((perf) => ({
        datetime: perf.querySelector(".tn-prod-list-item__perf-property--datetime")?.textContent?.replace(/\s+/g, " ").trim() || "",
        href: perf.querySelector(".tn-prod-list-item__perf-anchor")?.href || null,
      }));
      if (title && perfs.length) out.push({ title, venueKey, description, perfs });
    }
    return out;
  });

  const VENUES = {
    lucie: { venue: "Lucie Stern Theatre", address: "1305 Middlefield Rd, Palo Alto, CA 94301", city: "palo-alto" },
    mvcpa: { venue: "Mountain View Center for the Performing Arts", address: "500 Castro St, Mountain View, CA 94041", city: "mountain-view" },
  };

  const events = [];
  const seen = new Set();
  for (const prod of raw) {
    const loc = VENUES[prod.venueKey];
    if (!loc) continue; // unknown venue — skip rather than guess a city
    if (!isUsefulTitle(prod.title)) continue;
    for (const perf of prod.perfs) {
      const dm = perf.datetime.match(/([A-Za-z]+ \d{1,2}, \d{4})/);
      const date = dm ? tryParseDate(dm[1]) : null;
      // TNEW renders "7:30PM" with no space — normalize to "7:30 PM"
      const time = clockFromText(perf.datetime)?.replace(/(\d)\s*([ap]m)$/i, "$1 $2").toUpperCase();
      if (!date || date < TODAY || !time) continue;
      // Matinee + evening share a downstream id (it ignores time) — keep the
      // first listed performance per day (TNEW lists chronologically).
      const key = `${prod.title}|${date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        title: prod.title,
        date,
        time,
        endTime: null,
        venue: loc.venue,
        address: loc.address,
        city: loc.city,
        url: perf.href || "https://my.theatreworks.org/events",
        source: "TheatreWorks Silicon Valley",
        category: "arts",
        cost: "paid",
        description: prod.description,
        kidFriendly: false,
      });
    }
  }
  return events;
}

async function scrapeGreatAmerica(page) {
  await page.goto("https://www.sixflags.com/cagreatamerica/events", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);
  const raw = await page.evaluate(() => {
    const out = [];
    const lines = (document.body?.innerText || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const title = lines[i].match(/^(Fireworks|Tricks and Treats|Oktoberfest|Carnivale|Grand Carnivale|Kids Boo Fest|Holiday in the Park)$/i)?.[0];
      if (!title) continue;
      const dateText = lines.slice(i + 1, i + 4).find((line) => /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}/i.test(line));
      const link = [...document.querySelectorAll('a[href*="/events/"]')].find((a) => (a.href || "").toLowerCase().includes(title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")))?.href;
      if (dateText) out.push({ title, dateText, link });
    }
    return out;
  });

  const expanded = [];
  for (const r of raw) {
    const m = r.dateText.match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s*&\s*([A-Za-z]+)?\s*(\d{1,2}))?,\s*(\d{4})$/);
    if (!m) { expanded.push(r); continue; }
    expanded.push({ ...r, dateText: `${m[1]} ${m[2]}, ${m[5]}` });
    if (m[4]) expanded.push({ ...r, dateText: `${m[3] || m[1]} ${m[4]}, ${m[5]}` });
  }

  const seen = new Set();
  return expanded.map((r) => {
    const date = yearAwareDate(r.dateText);
    if (!date || date < TODAY || !isUsefulTitle(r.title)) return null;
    const key = `${date}|${r.title}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      title: r.title,
      date,
      time: null,
      endTime: null,
      venue: "California's Great America",
      address: "4701 Great America Pkwy, Santa Clara, CA 95054",
      city: "santa-clara",
      url: r.link || "https://www.sixflags.com/cagreatamerica/events",
      source: "California's Great America",
      category: "family",
      cost: "paid",
      kidFriendly: true,
    };
  }).filter(Boolean);
}

async function scrapeLevisStadium(page) {
  await page.goto("https://levisstadium.com/events/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);
  const raw = await page.evaluate(() => {
    const lines = (document.body?.innerText || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const months = new Set(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]);
    const out = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (!months.has(lines[i].toUpperCase()) || !/^\d{1,2}$/.test(lines[i + 1])) continue;
      const parts = [];
      for (let j = i + 2; j < lines.length && parts.length < 5; j++) {
        const line = lines[j];
        if (/^BUY TICKETS?|^BUY TICKET PACKAGE|^Later events/i.test(line)) break;
        if (!line || /^\s+$/.test(line)) continue;
        parts.push(line);
      }
      if (!parts.length) continue;
      out.push({ month: lines[i], day: lines[i + 1], parts });
    }
    return out;
  });
  const categoryPrefixes = /^(FIFA WORLD CUP)$/i;
  return raw.map((r) => {
    const date = yearAwareDate(`${r.month} ${r.day}, ${new Date().getFullYear()}`);
    if (!date || date < TODAY) return null;
    const cleanParts = r.parts.filter((p) => !new RegExp(`^${r.month}\\s+${r.day}$`, "i").test(p));
    let title = cleanParts[0] || "";
    if (categoryPrefixes.test(title) && cleanParts[1]) title = `${title}: ${cleanParts[1]}`;
    if (/^FIFA WORLD CUP\s*\|\s*/i.test(title)) title = title.replace(/^FIFA WORLD CUP\s*\|\s*/i, "FIFA World Cup: ");
    else if (title.includes("|")) {
      const pieces = title.split("|").map((p) => p.trim()).filter(Boolean);
      title = pieces.slice(0, 2).join(": ");
    }
    if (!isUsefulTitle(title)) return null;
    return {
      title,
      date,
      time: null,
      endTime: null,
      venue: "Levi's Stadium",
      address: "4900 Marie P DeBartolo Way, Santa Clara, CA 95054",
      city: "santa-clara",
      url: "https://levisstadium.com/events/",
      source: "Levi's Stadium",
      category: inferCategory(title),
      cost: "paid",
      kidFriendly: /\b(kids?|family)\b/i.test(cleanParts.join(" ")),
    };
  }).filter(Boolean);
}

async function scrapeSapCenter(page) {
  const calendarUrl = "https://www.sapcenter.com/events/";
  await page.goto(calendarUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);

  const detailUrls = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/events/detail/"]')) {
      const href = a.href?.split("#")[0];
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push(href);
    }
    return out;
  });

  const raw = [];
  for (const url of detailUrls.slice(0, 40)) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(600);
      const detail = await page.evaluate(() => {
        const lines = (document.body?.innerText || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
        const title = document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()
          || document.title.replace(/\s*\|\s*SAP Center\s*$/i, "").trim();
        const lineAfter = (label) => {
          const idx = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
          return idx >= 0 ? lines[idx + 1] : null;
        };
        const venue = lines.some((line) => /^at\s+Tech CU Arena$/i.test(line)) ? "Tech CU Arena" : "SAP Center";
        const dateLine = lineAfter("Date");
        const eventStarts = lineAfter("Event Starts");
        const year = dateLine?.match(/\b(20\d{2})\b/)?.[1] || new Date().getFullYear();
        const schedules = [];
        for (let i = 0; i < lines.length - 1; i++) {
          const date = lines[i].match(/^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY),\s+([A-Z]+)\s+(\d{1,2})$/i);
          if (!date) continue;
          const time = lines[i + 1];
          if (!/\b\d{1,2}(?::\d{2})?\s*(am|pm)\b/i.test(time)) continue;
          schedules.push({ dateText: `${date[2]} ${date[3]}, ${year}`, time });
        }
        const detailsStart = lines.findIndex((line) => /^Event Details$/i.test(line));
        const detailsEnd = detailsStart >= 0
          ? lines.findIndex((line, idx) => idx > detailsStart && /^(May|June|July|August|September|October|November|December)\s+20\d{2}$|^EVENTS & TICKETS$|^View all events/i.test(line))
          : -1;
        const description = detailsStart >= 0
          ? lines.slice(detailsStart + 1, detailsEnd > detailsStart ? detailsEnd : detailsStart + 8).join(" ").replace(/\s+/g, " ").trim()
          : "";
        return { title, venue, dateLine, eventStarts, schedules, description };
      });

      const slots = detail.schedules.length
        ? detail.schedules
        : [{ dateText: detail.dateLine, time: detail.eventStarts }];
      for (const slot of slots) {
        raw.push({ ...detail, dateText: slot.dateText, time: slot.time, url });
      }
    } catch {
      // Some older detail links intermittently 404; skip and keep the scraper moving.
    }
  }

  const seen = new Set();
  return raw.map((r) => {
    const date = yearAwareDate(r.dateText);
    const time = clockFromText(r.time);
    if (!date || date < TODAY || !time || !isUsefulTitle(r.title)) return null;
    const key = `${date}|${time}|${r.title}|${r.venue}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      title: r.title,
      date,
      time,
      endTime: null,
      venue: r.venue,
      address: r.venue === "Tech CU Arena" ? "1500 S 10th St, San Jose, CA 95112" : "525 W Santa Clara St, San Jose, CA 95113",
      city: "san-jose",
      url: r.url || calendarUrl,
      source: r.venue === "Tech CU Arena" ? "Tech CU Arena" : "SAP Center",
      category: inferCategory(r.title),
      cost: "paid",
      description: r.description || "",
      kidFriendly: KID_RE.test(`${r.title} ${r.description || ""}`),
    };
  }).filter(Boolean);
}

async function scrapeTheTechUpcoming(page) {
  await page.goto("https://www.thetech.org/explore/upcoming-events/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);
  const raw = await page.evaluate(() => {
    const lines = (document.body?.innerText || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const date = lines[i];
      if (!/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}/i.test(date)) continue;
      const title = lines[i - 1];
      const venue = lines[i + 1] && !/get tickets|plan your visit/i.test(lines[i + 1]) ? lines[i + 1] : "The Tech Interactive";
      out.push({ title, date, venue });
    }
    return out;
  });
  return raw.map((r) => {
    const date = yearAwareDate(r.date);
    if (!date || date < TODAY || !isUsefulTitle(r.title)) return null;
    return {
      title: r.title,
      date,
      time: clockFromText(r.date),
      endTime: null,
      venue: normalizeVenueText(r.venue, "The Tech Interactive"),
      address: "201 S Market St, San Jose, CA 95113",
      city: "san-jose",
      url: "https://www.thetech.org/explore/upcoming-events/",
      source: "The Tech Interactive",
      category: inferCategory(r.title),
      cost: "paid",
      kidFriendly: true,
    };
  }).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("Playwright unified scraper — scraping all browser-dependent sources...\n");

  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.error("❌ Playwright not installed. Run: npx playwright install chromium");
    console.error(`   ${err.message}`);
    process.exit(1);
  }

  // Build task list: each task returns { source, events }
  const tasks = [];

  // Tier 1: CivicPlus cities
  for (const city of CIVIC_PLUS_CITIES) {
    tasks.push({
      name: city.name,
      fn: (b) => runScraper(b, city.name, (page) => scrapeCivicPlusCalendar(page, city)),
    });
  }

  // Tier 1: The Tech
  tasks.push({ name: "The Tech Interactive", fn: (b) => runScraper(b, "The Tech Interactive", scrapeTheTech) });

  // Tier 1: LibCal libraries
  for (const lib of LIBCAL_LIBRARIES) {
    tasks.push({
      name: lib.name,
      fn: (b) => runScraper(b, lib.name, (page) => scrapeLibCal(page, lib)),
    });
  }

  // Tier 2: Fragile HTML scrapes
  tasks.push({ name: "San Jose Jazz", fn: (b) => runScraper(b, "San Jose Jazz", scrapeSJJazz) });
  tasks.push({ name: "SJ Museum of Art", fn: (b) => runScraper(b, "SJ Museum of Art", scrapeSJMuseumOfArt) });
  tasks.push({ name: "Linden Tree Books", fn: (b) => runScraper(b, "Linden Tree Books", scrapeLindenTree) });
  tasks.push({ name: "Hicklebee's", fn: (b) => runScraper(b, "Hicklebee's", scrapeHicklebees) });
  tasks.push({ name: "History San Jose", fn: (b) => runScraper(b, "History San Jose", scrapeHistorySJ) });
  tasks.push({ name: "Montalvo Arts Center", fn: (b) => runScraper(b, "Montalvo Arts Center", scrapeMontalvo) });

  // Tier 3: Venues with own calendars
  tasks.push({ name: "City Lights Theater", fn: (b) => runScraper(b, "City Lights Theater", scrapeCityLights) });
  tasks.push({ name: "ICA San Jose", fn: (b) => runScraper(b, "ICA San Jose", scrapeICASanJose) });
  tasks.push({ name: "SCCCFD (Eventbrite)", fn: (b) => runScraper(b, "SCCCFD (Eventbrite)", scrapeSCCCFD) });
  tasks.push({ name: "Mountain Winery", fn: (b) => runScraper(b, "Mountain Winery", scrapeMountainWinery) });
  tasks.push({ name: "San Jose Theaters", fn: (b) => runScraper(b, "San Jose Theaters", scrapeSanJoseTheaters) });
  tasks.push({ name: "Hammer Theatre", fn: (b) => runScraper(b, "Hammer Theatre", scrapeHammerTheatre) });
  tasks.push({ name: "Children's Discovery Museum", fn: (b) => runScraper(b, "Children's Discovery Museum", scrapeChildrensDiscoveryMuseum) });
  tasks.push({ name: "Palo Alto Art Center", fn: (b) => runScraper(b, "Palo Alto Art Center", scrapePaloAltoArtCenter) });
  tasks.push({ name: "Midpen Open Space", fn: (b) => runScraper(b, "Midpen Open Space", scrapeMidpen) });
  tasks.push({ name: "Guadalupe River Park", fn: (b) => runScraper(b, "Guadalupe River Park", scrapeGuadalupeRiverPark) });
  tasks.push({ name: "Santana Row", fn: (b) => runScraper(b, "Santana Row", scrapeSantanaRow) });
  tasks.push({ name: "Downtown Mountain View", fn: (b) => runScraper(b, "Downtown Mountain View", scrapeDowntownMountainView) });
  tasks.push({ name: "City of Cupertino", fn: (b) => runScraper(b, "City of Cupertino", scrapeCupertinoOpenCities) });
  tasks.push({ name: "Opera San José", fn: (b) => runScraper(b, "Opera San José", scrapeOperaSanJose) });
  tasks.push({ name: "TheatreWorks Silicon Valley", fn: (b) => runScraper(b, "TheatreWorks Silicon Valley", scrapeTheatreWorks) });
  tasks.push({ name: "California's Great America", fn: (b) => runScraper(b, "California's Great America", scrapeGreatAmerica) });
  tasks.push({ name: "Levi's Stadium", fn: (b) => runScraper(b, "Levi's Stadium", scrapeLevisStadium) });
  tasks.push({ name: "SAP Center", fn: (b) => runScraper(b, "SAP Center", scrapeSapCenter) });
  tasks.push({ name: "The Tech Upcoming", fn: (b) => runScraper(b, "The Tech Upcoming", scrapeTheTechUpcoming) });

  // Bookstores
  tasks.push({ name: "Books Inc", fn: (b) => runScraper(b, "Books Inc", scrapeBooksInc) });
  tasks.push({ name: "Barnes & Noble", fn: (b) => runScraper(b, "Barnes & Noble", scrapeBN) });
  tasks.push({ name: "Half Price Books", fn: (b) => runScraper(b, "Half Price Books", scrapeHPB) });
  tasks.push({ name: "POST (Peninsula Open Space Trust)", fn: (b) => runScraper(b, "POST (Peninsula Open Space Trust)", scrapePOST) });

  // Run all with bounded concurrency (4 pages at a time)
  console.log(`Running ${tasks.length} scrapers (4 concurrent)...\n`);
  const results = await pool(
    tasks.map((t) => () => t.fn(browser)),
    4
  );

  await browser.close();

  // Flatten and normalize to standard event schema
  const allRaw = results.flatMap((result) => result.events);
  const events = allRaw.map((e) => {
    const d = new Date(`${e.date}T12:00:00-07:00`);
    return {
      // Include time: same source/date/title/venue can carry multiple
      // showtimes on one day (e.g. SAP Center's Monster Jam 12pm + 6pm) —
      // omitting it collided two distinct events onto one id and broke
      // React keys downstream.
      id: h("pw", e.source, e.date, e.title, e.venue, e.time || ""),
      title: e.title,
      date: e.date,
      displayDate: displayDate(d),
      time: e.time || null,
      endTime: e.endTime || null,
      venue: e.venue,
      address: e.address || "",
      city: e.city,
      category: e.category || inferCategory(e.title),
      cost: e.cost || null,
      description: e.description || "",
      url: e.url,
      source: e.source,
      kidFriendly: e.kidFriendly || false,
      ...(e.eventStatus ? { eventStatus: e.eventStatus } : {}),
      ...(e.occurrenceEvidence ? { occurrenceEvidence: e.occurrenceEvidence } : {}),
    };
  });

  // Summary
  const bySrc = {};
  for (const e of events) bySrc[e.source] = (bySrc[e.source] || 0) + 1;
  const sourceHealth = tasks.map((task, index) => ({
    id: task.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    label: task.name,
    status: results[index].error ? "error" : (results[index].events.length > 0 ? "ok" : "empty"),
    count: results[index].events.length,
    error: results[index].error,
  }));

  let previous = null;
  try { previous = JSON.parse(readFileSync(OUT_PATH, "utf8")); } catch { /* first run */ }
  if (process.env.SBT_STRICT_EVENT_REFRESH === "1" && previous) {
    const previousEvents = Number(previous?._meta?.eventCount || previous?.events?.length || 0);
    const previousSources = Number(previous?._meta?.sources?.length || 0);
    const nextSources = Object.keys(bySrc).length;
    const lostSources = previousSources - nextSources;
    if (
      previousSources >= 10
      && (lostSources >= 4 || events.length < previousEvents * 0.6)
    ) {
      throw new Error(
        `Playwright coverage regression: ${previousSources}→${nextSources} sources, ${previousEvents}→${events.length} events`,
      );
    }
  }

  const output = {
    _meta: {
      generatedAt: new Date().toISOString(),
      generator: "playwright-scrapers",
      scrapersRun: tasks.length,
      eventCount: events.length,
      sourceCount: Object.keys(bySrc).length,
      sources: Object.entries(bySrc).map(([s, n]) => `${s} (${n})`),
      sourceHealth,
    },
    events,
  };

  writeFileAtomic(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✅ Wrote ${events.length} events from ${Object.keys(bySrc).length} sources to ${OUT_PATH}`);
  console.log("   Breakdown:", Object.entries(bySrc).map(([s, n]) => `${s}: ${n}`).join(", "));
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
