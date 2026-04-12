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

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "playwright-events.json");

// Auto-load .env.local
const envLocalPath = join(__dirname, "..", ".env.local");
if (existsSync(envLocalPath)) {
  for (const line of readFileSync(envLocalPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
}

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

/** Category inference from title */
function inferCategory(title) {
  const t = title.toLowerCase();
  if (/\b(concert|music|jazz|band|orchestra|symphony|dj)\b/.test(t)) return "arts";
  if (/\b(art|gallery|exhibit|museum|sculpture)\b/.test(t)) return "arts";
  if (/\b(theater|theatre|play|comedy|improv|show|performance)\b/.test(t)) return "arts";
  if (/\b(book|author|reading|poetry|literary|signing)\b/.test(t)) return "arts";
  if (/\b(hike|walk|run|yoga|fitness|sport|game)\b/.test(t)) return "sports";
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
      "https://losgatosca.libcal.com/events",
      "https://sccl.libcal.com/calendar?lid=6930", // SCCL Los Gatos branch
    ],
    city: "los-gatos",
    address: "110 E Main St, Los Gatos, CA 95030",
  },
  {
    name: "Milpitas Library",
    urls: [
      "https://sccl.libcal.com/calendar?lid=6922", // SCCL Milpitas branch
      "https://milpitas.libcal.com/calendar",
    ],
    city: "milpitas",
    address: "160 N Main St, Milpitas, CA 95035",
  },
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
        // LibCal v2 common selectors
        const cards = document.querySelectorAll(
          ".s-lc-ea-item, .s-lc-ea-event, .event-item, " +
          "[class*='event-card'], [class*='cal-event'], " +
          ".s-lc-content .card, #s-lc-ea-events-list .row"
        );
        for (const card of cards) {
          const titleEl = card.querySelector(
            ".s-lc-ea-ttl, .s-lc-ea-event-title, h3, h4, a[class*='title'], [class*='event-name']"
          );
          const dateEl = card.querySelector(
            ".s-lc-ea-date, time, [class*='date'], [datetime]"
          );
          const timeEl = card.querySelector(
            ".s-lc-ea-time, [class*='time']"
          );
          const title = titleEl?.textContent?.trim();
          const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
          const time = timeEl?.textContent?.trim();
          const link = titleEl?.closest("a")?.href || card.querySelector("a")?.href;
          if (title && title.length > 3) events.push({ title, date, time, link });
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
        const cards = document.querySelectorAll(
          "[class*='sjz-event'], .event-card, article[class*='event'], .tribe-events-list .type-tribe_events"
        );
        for (const card of cards) {
          const titleEl = card.querySelector("h2, h3, h4, .tribe-events-list-event-title, [class*='title']");
          const dateEl = card.querySelector("time, .tribe-event-schedule-details, [class*='date'], [datetime]");
          const venueEl = card.querySelector(".tribe-venue, [class*='venue'], [class*='location']");
          const title = titleEl?.textContent?.trim();
          const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
          const venue = venueEl?.textContent?.trim();
          const link = card.querySelector("a")?.href || titleEl?.closest("a")?.href;
          if (title && title.length > 3) events.push({ title, date, venue, link });
        }
        return events;
      });

      for (const r of raw) {
        const date = tryParseDate(r.date);
        if (!date || date < TODAY) continue;
        allEvents.push({
          title: r.title,
          date,
          time: null,
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
  await page.goto("https://www.lindentreebooks.com/events-calendar", {
    waitUntil: "networkidle", timeout: 25_000,
  });

  const raw = await page.evaluate(() => {
    const events = [];
    // Linden Tree uses hand-coded HTML with events in headings + date text
    const headings = document.querySelectorAll("h3, h2, [class*='event']");
    for (const heading of headings) {
      const titleEl = heading.querySelector("b, strong") || heading;
      const title = titleEl?.textContent?.trim();
      if (!title || title.length < 5) continue;

      // Date is usually in the same block or following text
      const block = heading.closest("div, article, section, li") || heading.parentElement;
      const text = block?.textContent || "";
      // Try multiple date patterns
      const datePatterns = [
        /(\w+day),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i,
        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i,
        /(\d{1,2})\/(\d{1,2})\/(\d{4})/,
      ];
      let dateStr = null;
      for (const pat of datePatterns) {
        const m = text.match(pat);
        if (m) { dateStr = m[0]; break; }
      }

      // Time pattern
      const timeMatch = text.match(/(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i);
      const time = timeMatch ? timeMatch[1].replace(/\./g, "") : null;

      const link = block?.querySelector("a")?.href;
      events.push({ title, date: dateStr, time, link });
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
    const cards = document.querySelectorAll(
      "[class*='event-block'], [class*='event-item'], .event, article, " +
      ".views-row, [class*='node--event']"
    );
    for (const card of cards) {
      const titleEl = card.querySelector("h2, h3, h4, [class*='title'], a[class*='title']");
      const dateEl = card.querySelector("time, [class*='date'], [datetime]");
      const title = titleEl?.textContent?.trim();
      const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
      const link = titleEl?.closest("a")?.href || card.querySelector("a")?.href;
      if (title && title.length > 3) events.push({ title, date, link });
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
    waitUntil: "networkidle", timeout: 25_000,
  });

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
        if (title && title.length > 3) events.push({ title, date, link });
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

// ── 3Below Theaters ──

async function scrape3Below(page) {
  const urls = [
    "https://www.3belowtheaters.com/events",
    "https://www.3belowtheaters.com/shows",
    "https://www.3belowtheaters.com/",
  ];
  for (const url of urls) {
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      if (!resp || resp.status() >= 400) continue;

      const raw = await page.evaluate(() => {
        const events = [];
        const cards = document.querySelectorAll(
          "[class*='event'], [class*='show'], article, .card, [class*='performance']"
        );
        for (const card of cards) {
          const titleEl = card.querySelector("h2, h3, h4, [class*='title'], [class*='name']");
          const dateEl = card.querySelector("time, [class*='date'], [datetime]");
          const title = titleEl?.textContent?.trim();
          const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
          const link = card.querySelector("a")?.href || titleEl?.closest("a")?.href;
          if (title && title.length > 3) events.push({ title, date, link });
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
              time: null,
              endTime: null,
              venue: "3Below Theaters",
              address: "288 S Second St, San Jose, CA 95113",
              city: "san-jose",
              url: r.link || "https://www.3belowtheaters.com/",
              source: "3Below Theaters",
              category: "arts",
              cost: "paid",
              kidFriendly: false,
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

// ── City Lights Theater Company ──

async function scrapeCityLights(page) {
  const urls = [
    "https://cltc.org/shows/",
    "https://cltc.org/season/",
    "https://cltc.org/",
  ];
  for (const url of urls) {
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      if (!resp || resp.status() >= 400) continue;

      const raw = await page.evaluate(() => {
        const events = [];
        // Theater sites often list shows with dates
        const cards = document.querySelectorAll(
          "[class*='show'], [class*='production'], [class*='event'], article, " +
          ".card, [class*='season-item'], [class*='performance']"
        );
        for (const card of cards) {
          const titleEl = card.querySelector("h2, h3, h4, [class*='title'], [class*='name']");
          const dateEl = card.querySelector("time, [class*='date'], [datetime], [class*='run']");
          const title = titleEl?.textContent?.trim();
          const dateText = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
          const link = card.querySelector("a")?.href || titleEl?.closest("a")?.href;
          if (title && title.length > 3) events.push({ title, date: dateText, link });
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
              time: null,
              endTime: null,
              venue: "City Lights Theater Company",
              address: "529 S Second St, San Jose, CA 95112",
              city: "san-jose",
              url: r.link || "https://cltc.org/",
              source: "City Lights Theater",
              category: "arts",
              cost: "paid",
              kidFriendly: false,
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

// ── ICA San Jose ──

async function scrapeICASanJose(page) {
  const urls = [
    "https://www.icasanjose.org/exhibitions",
    "https://www.icasanjose.org/events",
    "https://www.icasanjose.org/programs",
  ];
  for (const url of urls) {
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      if (!resp || resp.status() >= 400) continue;

      const raw = await page.evaluate(() => {
        const events = [];
        const cards = document.querySelectorAll(
          "[class*='event'], [class*='exhibit'], [class*='program'], " +
          "article, .card, [class*='listing'], [class*='item']"
        );
        for (const card of cards) {
          const titleEl = card.querySelector("h2, h3, h4, [class*='title'], [class*='name']");
          const dateEl = card.querySelector("time, [class*='date'], [datetime]");
          const title = titleEl?.textContent?.trim();
          const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
          const link = card.querySelector("a")?.href || titleEl?.closest("a")?.href;
          if (title && title.length > 3) events.push({ title, date, link });
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
              time: null,
              endTime: null,
              venue: "ICA San Jose",
              address: "560 S First St, San Jose, CA 95113",
              city: "san-jose",
              url: r.link || "https://www.icasanjose.org/",
              source: "ICA San Jose",
              category: "arts",
              cost: "free",
              kidFriendly: false,
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

// ── SC County Fire Department (Eventbrite organizer page) ──

async function scrapeSCCCFD(page) {
  // Search Eventbrite for their events since the API is dead
  const url = "https://www.eventbrite.com/o/santa-clara-county-fire-department-7542498853";
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(2000);

    const raw = await page.evaluate(() => {
      const events = [];
      // Eventbrite organizer pages list events as cards
      const cards = document.querySelectorAll(
        "[class*='event-card'], [data-testid*='event'], article, " +
        "[class*='eds-event-card'], a[href*='/e/']"
      );
      for (const card of cards) {
        const el = card.tagName === "A" ? card : card;
        const titleEl = el.querySelector("h2, h3, [class*='title'], [class*='name'], [data-testid*='title']");
        const dateEl = el.querySelector("time, [class*='date'], [datetime], p");
        const title = titleEl?.textContent?.trim() || el.querySelector("[class*='event-card__clamp']")?.textContent?.trim();
        const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
        const link = el.tagName === "A" ? el.href : (el.querySelector("a")?.href);
        if (title && title.length > 5) events.push({ title, date, link });
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
          venue: "Online / Various",
          address: "",
          city: "san-jose",
          url: r.link || url,
          source: "SC County Fire Dept",
          category: "community",
          cost: "free",
          kidFriendly: false,
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
  await page.goto("https://booksinc.net/events", { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(3000); // Shopify hydration

  const raw = await page.evaluate(() => {
    const events = [];
    const cards = document.querySelectorAll(
      ".event-card, .events-list .event, [class*='event-item'], article, .card"
    );
    for (const card of cards) {
      const titleEl = card.querySelector("h2, h3, .event-title, [class*='title']");
      const dateEl = card.querySelector("time, .event-date, [class*='date']");
      const locEl = card.querySelector(".event-location, [class*='location'], [class*='store']");
      const timeEl = card.querySelector(".event-time, [class*='time']");
      const title = titleEl?.textContent?.trim();
      const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
      const location = locEl?.textContent?.trim() || "";
      const time = timeEl?.textContent?.trim();
      const link = card.querySelector("a")?.href;
      if (title) events.push({ title, date, location, time, link });
    }
    return events;
  });

  const events = [];
  for (const r of raw) {
    const date = tryParseDate(r.date);
    if (!date || date < TODAY) continue;
    const locLower = (r.location || r.title).toLowerCase();
    let city = null;
    for (const [kw, cid] of BOOKS_INC_SB_STORES) {
      if (locLower.includes(kw)) { city = cid; break; }
    }
    if (!city) continue; // not a South Bay store
    events.push({
      title: r.title,
      date,
      time: normalizeTime(r.time),
      endTime: null,
      venue: `Books Inc ${r.location || ""}`.trim(),
      address: "",
      city,
      url: r.link || "https://booksinc.net/events",
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
  tasks.push({ name: "3Below Theaters", fn: (b) => runScraper(b, "3Below Theaters", scrape3Below) });
  tasks.push({ name: "City Lights Theater", fn: (b) => runScraper(b, "City Lights Theater", scrapeCityLights) });
  tasks.push({ name: "ICA San Jose", fn: (b) => runScraper(b, "ICA San Jose", scrapeICASanJose) });
  tasks.push({ name: "SCCCFD (Eventbrite)", fn: (b) => runScraper(b, "SCCCFD (Eventbrite)", scrapeSCCCFD) });

  // Bookstores
  tasks.push({ name: "Books Inc", fn: (b) => runScraper(b, "Books Inc", scrapeBooksInc) });
  tasks.push({ name: "Barnes & Noble", fn: (b) => runScraper(b, "Barnes & Noble", scrapeBN) });
  tasks.push({ name: "Half Price Books", fn: (b) => runScraper(b, "Half Price Books", scrapeHPB) });

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
