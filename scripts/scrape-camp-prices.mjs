#!/usr/bin/env node
/**
 * scrape-camp-prices.mjs
 *
 * One-shot Playwright scraper that visits city/college camp registration
 * portals and extracts 2026 pricing. Writes a report JSON for human review
 * — does NOT auto-modify camps-data.ts because prices need sanity-checking.
 *
 * Requires: npx playwright install chromium
 *
 * Usage:
 *   node scripts/scrape-camp-prices.mjs
 *   open /tmp/camp-prices-scraped.json
 */

import { chromium } from "playwright";
import { writeFileSync } from "fs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const OUT_PATH = "/tmp/camp-prices-scraped.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull every visible $-prefixed number on the page (filtered by sane range). */
async function extractPrices(page, { min = 50, max = 3000 } = {}) {
  return page.evaluate(
    ({ min, max }) => {
      const txt = document.body.innerText || "";
      const prices = [];
      const re = /\$(\d{2,4}(?:,\d{3})?(?:\.\d{2})?)/g;
      let m;
      while ((m = re.exec(txt))) {
        const n = parseFloat(m[1].replace(/,/g, ""));
        if (n >= min && n <= max) prices.push(n);
      }
      return prices;
    },
    { min, max }
  );
}

function summarizePrices(prices) {
  if (!prices.length) return null;
  const uniq = Array.from(new Set(prices)).sort((a, b) => a - b);
  return {
    min: uniq[0],
    max: uniq[uniq.length - 1],
    median: uniq[Math.floor(uniq.length / 2)],
    sampleCount: prices.length,
    uniqueCount: uniq.length,
    samples: uniq.slice(0, 20),
  };
}

async function tryScraper(page, name, fn) {
  console.log(`\n⏳ ${name}`);
  const start = Date.now();
  try {
    const result = await fn(page);
    console.log(`   ✓ ${Date.now() - start}ms — ${JSON.stringify(result).slice(0, 200)}`);
    return { name, ok: true, ...result };
  } catch (err) {
    console.log(`   ✗ ${Date.now() - start}ms — ${err.message.slice(0, 180)}`);
    return { name, ok: false, error: err.message.slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// Individual scrapers
// ---------------------------------------------------------------------------

async function scrapeStanfordCampCardinal(page) {
  await page.goto("https://rec.stanford.edu/play/youth-programs/camp-cardinal", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  const body = await page.evaluate(() => document.body.innerText || "");
  const prices = await extractPrices(page);
  // Look for per-week phrasing
  const perWeek = body.match(/\$(\d{2,4})[^\n]{0,30}(?:per week|\/week|\/wk|weekly)/i);
  const camperDay = body.match(/\$(\d{2,4})[^\n]{0,30}(?:per day|\/day|daily)/i);
  return {
    url: page.url(),
    pricesSpotted: summarizePrices(prices),
    perWeekMatch: perWeek?.[0] ?? null,
    perDayMatch: camperDay?.[0] ?? null,
    bodyExcerpt: body.slice(0, 800),
  };
}

async function scrapePajmz(page) {
  await page.goto("https://www.paloaltozoo.org/Programs/Summer-Camps", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(2000);
  const body = await page.evaluate(() => document.body.innerText || "");
  const prices = await extractPrices(page);
  return {
    url: page.url(),
    pricesSpotted: summarizePrices(prices),
    registrationText: body.match(/registration[^\n]{0,200}/i)?.[0] ?? null,
    bodyExcerpt: body.slice(0, 1200),
  };
}

async function scrapeRec1Catalog(page, agency, searchTerm) {
  // Rec1 catalogs are SPA-ish — load catalog and let items render
  await page.goto(`https://secure.rec1.com/CA/${agency}/catalog`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(3000);
  // Try to search
  try {
    const searchInput = await page.$(
      'input[type="search"], input[placeholder*="earch" i], input[name*="search" i]'
    );
    if (searchInput) {
      await searchInput.fill(searchTerm);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2500);
    }
  } catch {}
  const prices = await extractPrices(page);
  const body = await page.evaluate(() => document.body.innerText || "");
  const campRows = body.match(/[^\n]{5,80}camp[^\n]{0,80}\$\d{2,4}[^\n]{0,80}/gi) ?? [];
  return {
    url: page.url(),
    pricesSpotted: summarizePrices(prices),
    sampleRows: campRows.slice(0, 10),
  };
}

async function scrapeActiveCommunities(page, agency, searchTerm) {
  const url = `https://apm.activecommunities.com/${agency}/ActivitySearch`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);
  try {
    const searchInput = await page.$(
      'input[placeholder*="earch" i], input[name*="earch" i], input[aria-label*="earch" i]'
    );
    if (searchInput) {
      await searchInput.fill(searchTerm);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(3000);
    }
  } catch {}
  const prices = await extractPrices(page);
  const body = await page.evaluate(() => document.body.innerText || "");
  const campRows = body.match(/[^\n]{5,80}camp[^\n]{0,80}\$\d{2,4}[^\n]{0,80}/gi) ?? [];
  return {
    url: page.url(),
    pricesSpotted: summarizePrices(prices),
    sampleRows: campRows.slice(0, 10),
  };
}

async function scrapeCupertinoCamps(page) {
  await page.goto("https://www.cupertino.gov/camps", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(2000);
  const body = await page.evaluate(() => document.body.innerText || "");
  const prices = await extractPrices(page);
  return {
    url: page.url(),
    pricesSpotted: summarizePrices(prices),
    campMentions: (body.match(/[^\n]{0,60}camp[^\n]{0,60}/gi) ?? []).slice(0, 20),
  };
}

async function scrapeCivicRec(page, agency, searchTerm) {
  const url = `https://ca-${agency}.civicrec.com/CA/${agency}-ca/catalog`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);
  try {
    const searchInput = await page.$('input[type="search"], input[placeholder*="earch" i]');
    if (searchInput) {
      await searchInput.fill(searchTerm);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(3000);
    }
  } catch {}
  const prices = await extractPrices(page);
  const body = await page.evaluate(() => document.body.innerText || "");
  return {
    url: page.url(),
    pricesSpotted: summarizePrices(prices),
    sampleRows: (body.match(/[^\n]{5,80}camp[^\n]{0,80}\$\d{2,4}[^\n]{0,80}/gi) ?? []).slice(0, 10),
  };
}

async function scrapeLgsPerfectMind(page) {
  // PerfectMind booking widget — try the public URL directly
  await page.goto(
    "https://losgatos.perfectmind.com/22167/Clients/BookMe4?widgetId=fdd7404c-01ad-4422-a2fd-241ded98c6eb",
    { waitUntil: "domcontentloaded", timeout: 30_000 }
  );
  await page.waitForTimeout(4000);
  const prices = await extractPrices(page);
  const body = await page.evaluate(() => document.body.innerText || "");
  return {
    url: page.url(),
    pricesSpotted: summarizePrices(prices),
    bodyExcerpt: body.slice(0, 1200),
  };
}

async function scrapeDeAnzaAcademy(page) {
  await page.goto("https://www.deanza.edu/academy/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  const body = await page.evaluate(() => document.body.innerText || "");
  const prices = await extractPrices(page);
  return {
    url: page.url(),
    pricesSpotted: summarizePrices(prices),
    bodyExcerpt: body.slice(0, 1500),
  };
}

async function scrapeCampCmt(page) {
  await page.goto("https://www.cmtsj.org/campcmt/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  const body = await page.evaluate(() => document.body.innerText || "");
  const prices = await extractPrices(page);
  // pricing is often in an img — list all image alt/src
  const imageHints = await page.evaluate(() =>
    Array.from(document.querySelectorAll("img"))
      .map((img) => ({ alt: img.alt, src: img.src }))
      .filter((i) => /tuition|price|cost|fee|camp/i.test(i.alt + " " + i.src))
      .slice(0, 10)
  );
  return {
    url: page.url(),
    pricesSpotted: summarizePrices(prices),
    imageHints,
    bodyExcerpt: body.slice(0, 1500),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: UA,
  viewport: { width: 1280, height: 900 },
  locale: "en-US",
});
const page = await context.newPage();

const report = [];

report.push(await tryScraper(page, "Stanford Camp Cardinal",     scrapeStanfordCampCardinal));
report.push(await tryScraper(page, "Palo Alto Junior Museum & Zoo", scrapePajmz));
report.push(await tryScraper(page, "Cupertino Summer Camps",     scrapeCupertinoCamps));
report.push(await tryScraper(page, "Campbell (Rec1 catalog)",    (p) => scrapeRec1Catalog(p, "campbell-ca", "camp")));
report.push(await tryScraper(page, "Los Altos (Rec1 catalog)",   (p) => scrapeRec1Catalog(p, "LosAltosRecreation", "redwood grove")));
report.push(await tryScraper(page, "Santa Clara (ActiveCommunities)", (p) => scrapeActiveCommunities(p, "santaclara", "day camp")));
report.push(await tryScraper(page, "Milpitas (ActiveCommunities)",    (p) => scrapeActiveCommunities(p, "milpitasrec", "camp")));
report.push(await tryScraper(page, "Palo Alto Enjoy! (CivicRec)",     (p) => scrapeCivicRec(p, "paloalto", "summer camp")));
report.push(await tryScraper(page, "LGS Summer Camps (PerfectMind)",  scrapeLgsPerfectMind));
report.push(await tryScraper(page, "De Anza College Academy",   scrapeDeAnzaAcademy));
report.push(await tryScraper(page, "Camp CMT (image pricing)",  scrapeCampCmt));

await browser.close();

writeFileSync(OUT_PATH, JSON.stringify({ scrapedAt: new Date().toISOString(), report }, null, 2));
console.log(`\n📄 Report written to ${OUT_PATH}`);
console.log(`   Total scrapers: ${report.length} · OK: ${report.filter((r) => r.ok).length}`);
