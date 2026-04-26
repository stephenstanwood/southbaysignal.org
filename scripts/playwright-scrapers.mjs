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

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { loadEnvLocal } from "./lib/env.mjs";

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

const TODAY = new Date().toISOString().split("T")[0];

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
  try {
    events = await fn(page);
  } catch (err) {
    console.log(`  ⚠️  ${name}: ${err.message}`);
  } finally {
    await page.close();
  }
  console.log(`  ${events.length > 0 ? "✅" : "⚠️ "} ${name}: ${events.length} events`);
  return events;
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
  if (/\b(concert|music|jazz|band|orchestra|symphony|dj)\b/.test(t)) return "arts";
  if (/\b(art|gallery|exhibit|museum|sculpture)\b/.test(t)) return "arts";
  if (/\b(theater|theatre|play|comedy|improv|show|performance)\b/.test(t)) return "arts";
  if (/\b(book|author|reading|poetry|literary|signing)\b/.test(t)) return "arts";
  if (/\b(yoga|meditation|wellness|mindful)\b/.test(t)) return "community";
  if (/\b(hike|walk|run|fitness|sport|game)\b/.test(t)) return "sports";
  if (/\b(food|cook|wine|beer|tast|farm|restaurant)\b/.test(t)) return "food";
  if (/\b(tech|hack|code|startup|ai|data|developer)\b/.test(t)) return "technology";
  if (/\b(council|city|civic|government|hearing|meeting)\b/.test(t)) return "meetings";
  if (/\b(kids|children|family|story.?time|toddler|teen)\b/.test(t)) return "community";
  return "community";
}

// ═══════════════════════════════════════════════════════════════════════════
// TIER 1 — Currently blocked/broken sources
// ═══════════════════════════════════════════════════════════════════════════

// ── CivicPlus City Calendars (4 cities, all 403 on iCal feed) ──

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
  {
    name: "City of Cupertino",
    url: "https://www.cupertino.org/Calendar.aspx",
    city: "cupertino",
    source: "City of Cupertino",
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
      kidFriendly: /\b(kids|children|family)\b/i.test(r.title),
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

// Bookmobile/outreach stops on libcal use bare venue names as titles ("Ginzton
// Terrace Apartments", "Castro Elementary School", "Hope Services"). They live
// on the library's calendar but aren't public events — the library's bookmobile
// just visits that location.
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
          events.push({ title, date: dateStr, time: timeMatch?.[0], link: titleLink.href });
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
            events.push({ title, date, time: timeMatch?.[0], link: titleLink.href });
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
            // MV bookmobile / outreach stops surface as bare venue-name titles
            // ("Ginzton Terrace Apartments", "Castro Elementary School", "Hope
            // Services"). They're internal stops on the library's bookmobile
            // calendar, not public events. Filter by title pattern.
            if (isBookmobileStopTitle(r.title)) return null;
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
              kidFriendly: /\b(kids|children|family|story|toddler|teen)\b/i.test(r.title),
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
        kidFriendly: /\b(kids|children|family)\b/i.test(r.title),
      };
    })
    .filter(Boolean);
}

// ── Linden Tree Books ──

async function scrapeLindenTree(page) {
  // Linden Tree times out on networkidle due to slow resources — use domcontentloaded
  await page.goto("https://www.lindentreebooks.com/events-calendar", {
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
      return {
        title: r.title,
        date,
        time: normalizeTime(r.time),
        endTime: null,
        venue: "Linden Tree Books",
        address: "265 State St, Los Altos, CA 94022",
        city: "los-altos",
        url: r.link || "https://www.lindentreebooks.com/events-calendar",
        source: "Linden Tree Books",
        category: "arts",
        cost: "free",
        kidFriendly: /\b(kids|children|story|picture book)\b/i.test(r.title),
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
        const address = r.location?.includes("|")
          ? r.location.split("|")[1]?.trim()
          : "635 Phelan Ave, San Jose, CA 95112";

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
          kidFriendly: /\b(kids|children|family)\b/i.test(r.title),
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
        kidFriendly: /\b(kids|children|family)\b/i.test(r.title),
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
            venue: "ICA San Jose",
            address: "560 S First St, San Jose, CA 95113",
            city: "san-jose",
            url: art.link,
            source: "ICA San Jose",
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
          kidFriendly: /\b(kids|children|family)\b/i.test(r.title),
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
    const date = new Date(year, mIdx, r.day);
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
      kidFriendly: /\b(kids|children|story.?time|family)\b/i.test(r.title),
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
  return { city: "santa-clara-county", venue: null };
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
      category: r.volunteer ? "volunteer" : "nature",
      cost: "free",
      kidFriendly: /\b(family|kids|children|youth)\b/i.test(r.title),
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
          kidFriendly: /\b(kids|children|story.?time|family)\b/i.test(r.title),
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
          kidFriendly: /\b(kids|children|story.?time|family)\b/i.test(r.title),
        });
      }
    } catch {
      // skip this store
    }
  }
  return allEvents;
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
  const allRaw = results.flat();
  const events = allRaw.map((e) => {
    const d = new Date(`${e.date}T12:00:00-07:00`);
    return {
      id: h("pw", e.source, e.date, e.title, e.venue),
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
      description: "",
      url: e.url,
      source: e.source,
      kidFriendly: e.kidFriendly || false,
    };
  });

  // Summary
  const bySrc = {};
  for (const e of events) bySrc[e.source] = (bySrc[e.source] || 0) + 1;

  const output = {
    _meta: {
      generatedAt: new Date().toISOString(),
      generator: "playwright-scrapers",
      scrapersRun: tasks.length,
      sourceCount: events.length,
      sources: Object.entries(bySrc).map(([s, n]) => `${s} (${n})`),
    },
    events,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✅ Wrote ${events.length} events from ${Object.keys(bySrc).length} sources to ${OUT_PATH}`);
  console.log("   Breakdown:", Object.entries(bySrc).map(([s, n]) => `${s}: ${n}`).join(", "));
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
