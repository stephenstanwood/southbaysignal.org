#!/usr/bin/env node
/**
 * generate-bookstore-events.mjs
 *
 * Playwright-based scraper for bookstore events that block standard HTTP fetches:
 *   - Books Inc (Shopify SPA) — Mountain View, Palo Alto, Campbell, Saratoga
 *   - Barnes & Noble (Cloudflare) — Stevens Creek, Blossom Hill
 *   - Half Price Books (Cloudflare) — San Jose, Cupertino
 *
 * Runs on the Mac Mini as a scheduled task. Writes bookstore-events.json
 * which generate-events.mjs merges into the main events feed.
 *
 * Requires: npx playwright install chromium
 *
 * Usage:
 *   node scripts/generate-bookstore-events.mjs
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "bookstore-events.json");

// Auto-load .env.local if present
const envLocalPath = join(__dirname, "..", ".env.local");
if (existsSync(envLocalPath)) {
  const lines = readFileSync(envLocalPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function h(prefix, ...parts) {
  const raw = [prefix, ...parts].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

function displayDate(d) {
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function isoDate(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

// South Bay Books Inc locations we care about
const BOOKS_INC_STORES = new Map([
  ["mountain view", "mountain-view"],
  ["palo alto", "palo-alto"],
  ["town & country", "palo-alto"],
  ["campbell", "campbell"],
  ["saratoga", "saratoga"],
]);

// B&N store pages
const BN_STORES = [
  { id: "1944", name: "Stevens Creek", city: "san-jose", address: "3600 Stevens Creek Blvd, San Jose" },
  { id: "2909", name: "Blossom Hill", city: "san-jose", address: "5630 Cottle Rd, San Jose" },
];

// Half Price Books stores
const HPB_STORES = [
  { slug: "675-saratoga-ave", name: "San Jose", city: "san-jose", address: "675 Saratoga Ave, San Jose" },
  { slug: "21607b-stevens-creek", name: "Cupertino", city: "cupertino", address: "21607 Stevens Creek Blvd, Cupertino" },
];

async function launchBrowser() {
  // Dynamic import so the script fails gracefully if Playwright isn't installed
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
}

// ---------------------------------------------------------------------------
// Books Inc — Shopify SPA
// ---------------------------------------------------------------------------

async function scrapeBookstoreInc(page) {
  console.log("  ⏳ Books Inc...");
  const events = [];
  const today = new Date().toISOString().split("T")[0];

  try {
    await page.goto("https://booksinc.net/events", { waitUntil: "networkidle", timeout: 30_000 });
    // Wait for Shopify to hydrate event content
    await page.waitForTimeout(3000);

    // Grab all event entries from the rendered page
    const items = await page.evaluate(() => {
      const results = [];
      // Shopify event pages typically render event cards — try multiple selectors
      const cards = document.querySelectorAll(
        '.event-card, .events-list .event, [class*="event-item"], article'
      );
      for (const card of cards) {
        const title = card.querySelector("h2, h3, .event-title, [class*='title']")?.textContent?.trim();
        const dateEl = card.querySelector("time, .event-date, [class*='date']");
        const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
        const link = card.querySelector("a")?.href;
        const locationEl = card.querySelector(".event-location, [class*='location'], .event-store");
        const location = locationEl?.textContent?.trim() || "";
        const timeEl = card.querySelector(".event-time, [class*='time']");
        const time = timeEl?.textContent?.trim() || "";
        if (title) results.push({ title, date, link, location, time });
      }
      return results;
    });

    for (const item of items) {
      if (!item.title || !item.date) continue;

      // Try to parse the date
      const parsed = new Date(item.date);
      if (isNaN(parsed.getTime())) continue;
      const dateStr = isoDate(parsed);
      if (dateStr < today) continue;

      // Filter to South Bay locations
      const locLower = (item.location || item.title).toLowerCase();
      let city = null;
      for (const [keyword, cityId] of BOOKS_INC_STORES) {
        if (locLower.includes(keyword)) { city = cityId; break; }
      }
      if (!city) continue; // not a South Bay store

      events.push({
        title: item.title,
        date: dateStr,
        time: item.time || null,
        venue: `Books Inc ${item.location || ""}`.trim(),
        address: "", // filled per-store if possible
        city,
        url: item.link || "https://booksinc.net/events",
        source: "Books Inc",
      });
    }
  } catch (err) {
    console.log(`  ⚠️  Books Inc: ${err.message}`);
  }

  console.log(`  ✅ Books Inc: ${events.length} events`);
  return events;
}

// ---------------------------------------------------------------------------
// Barnes & Noble — Cloudflare-protected store calendars
// ---------------------------------------------------------------------------

async function scrapeBN(page) {
  console.log("  ⏳ Barnes & Noble...");
  const events = [];
  const today = new Date().toISOString().split("T")[0];

  for (const store of BN_STORES) {
    try {
      const url = `https://stores.barnesandnoble.com/store/${store.id}?view=calendar`;
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(2000);

      const items = await page.evaluate(() => {
        const results = [];
        const cards = document.querySelectorAll(
          '.event-card, .store-event, [class*="event"], .calendar-event'
        );
        for (const card of cards) {
          const title = card.querySelector("h2, h3, h4, .event-name, [class*='title']")?.textContent?.trim();
          const dateEl = card.querySelector("time, .event-date, [class*='date']");
          const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
          const timeEl = card.querySelector(".event-time, [class*='time']");
          const time = timeEl?.textContent?.trim() || "";
          const link = card.querySelector("a")?.href;
          if (title) results.push({ title, date, time, link });
        }
        return results;
      });

      for (const item of items) {
        if (!item.title || !item.date) continue;
        const parsed = new Date(item.date);
        if (isNaN(parsed.getTime())) continue;
        const dateStr = isoDate(parsed);
        if (dateStr < today) continue;

        events.push({
          title: item.title,
          date: dateStr,
          time: item.time || null,
          venue: `Barnes & Noble ${store.name}`,
          address: store.address,
          city: store.city,
          url: item.link || `https://stores.barnesandnoble.com/store/${store.id}`,
          source: "Barnes & Noble",
        });
      }
    } catch (err) {
      console.log(`  ⚠️  B&N ${store.name}: ${err.message}`);
    }
  }

  console.log(`  ✅ Barnes & Noble: ${events.length} events`);
  return events;
}

// ---------------------------------------------------------------------------
// Half Price Books — Cloudflare-protected
// ---------------------------------------------------------------------------

async function scrapeHPB(page) {
  console.log("  ⏳ Half Price Books...");
  const events = [];
  const today = new Date().toISOString().split("T")[0];

  for (const store of HPB_STORES) {
    try {
      const url = `https://hpb.com/store-events?location=${store.slug}`;
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(2000);

      const items = await page.evaluate(() => {
        const results = [];
        const cards = document.querySelectorAll(
          '.event, [class*="event-card"], [class*="event-item"], article'
        );
        for (const card of cards) {
          const title = card.querySelector("h2, h3, h4, [class*='title']")?.textContent?.trim();
          const dateEl = card.querySelector("time, [class*='date']");
          const date = dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim();
          const timeEl = card.querySelector("[class*='time']");
          const time = timeEl?.textContent?.trim() || "";
          const link = card.querySelector("a")?.href;
          if (title) results.push({ title, date, time, link });
        }
        return results;
      });

      for (const item of items) {
        if (!item.title || !item.date) continue;
        const parsed = new Date(item.date);
        if (isNaN(parsed.getTime())) continue;
        const dateStr = isoDate(parsed);
        if (dateStr < today) continue;

        events.push({
          title: item.title,
          date: dateStr,
          time: item.time || null,
          venue: `Half Price Books ${store.name}`,
          address: store.address,
          city: store.city,
          url: item.link || "https://hpb.com/store-events",
          source: "Half Price Books",
        });
      }
    } catch (err) {
      console.log(`  ⚠️  HPB ${store.name}: ${err.message}`);
    }
  }

  console.log(`  ✅ Half Price Books: ${events.length} events`);
  return events;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Scraping bookstore events (Playwright)...\n");

  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    console.error("❌ Playwright not installed. Run: npx playwright install chromium");
    console.error(`   ${err.message}`);
    process.exit(1);
  }

  const page = await browser.newPage();
  // Polite: identify ourselves
  await page.setExtraHTTPHeaders({ "X-Bot": "SouthBaySignal/1.0 (public event aggregator)" });

  const [booksInc, bn, hpb] = await Promise.all([
    scrapeBookstoreInc(page),
    // B&N and HPB need separate page contexts (different domains)
    (async () => { const p = await browser.newPage(); const r = await scrapeBN(p); await p.close(); return r; })(),
    (async () => { const p = await browser.newPage(); const r = await scrapeHPB(p); await p.close(); return r; })(),
  ]);

  await page.close();
  await browser.close();

  // Normalize all events to standard schema
  const allRaw = [...booksInc, ...bn, ...hpb];
  const events = allRaw.map((e) => {
    const d = new Date(`${e.date}T12:00:00-07:00`);
    return {
      id: h("bookstore", e.date, e.title, e.venue),
      title: e.title,
      date: e.date,
      displayDate: displayDate(d),
      time: e.time,
      endTime: null,
      venue: e.venue,
      address: e.address,
      city: e.city,
      category: "arts",
      cost: "free",
      description: "",
      url: e.url,
      source: e.source,
      kidFriendly: /\b(kids|children|story.?time|family)\b/i.test(e.title),
    };
  });

  const output = {
    _meta: {
      generatedAt: new Date().toISOString(),
      generator: "generate-bookstore-events",
      sourceCount: events.length,
      sources: [...new Set(events.map((e) => e.source))],
    },
    events,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✅ Wrote ${events.length} bookstore events to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
