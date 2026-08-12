#!/usr/bin/env node
// Weekly SEO sweep: the measurement pass the scheduled Mini job runs before it
// decides what to fix.
//
// Two legs, deliberately independent:
//   crawl  — what a crawler would hold against us right now (needs nothing)
//   gsc    — optional API preload of what Google decided (needs a Search
//            Console service account). The native Codex task still performs a
//            browser pass because UI-only actions cannot be replaced by this.
//
// A missing API key is not a blocker: the native Codex automation uses the
// signed-in Search Console UI. The helper remains useful for bulk query data.
//
// Usage:
//   node scripts/seo/sweep.mjs              # human summary
//   node scripts/seo/sweep.mjs --json       # full report to stdout
//   node scripts/seo/sweep.mjs --write      # persist to <reportDir>/<date>.json
//   node scripts/seo/sweep.mjs --fix-sitemaps   # resubmit sitemaps GSC has lost
//   node scripts/seo/sweep.mjs --inspect N  # sample N URLs through URL Inspection

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runAudit, config } from "./audit.mjs";
import { createClient, daysAgo } from "./search-console.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

// Search Console data lags ~2 days; comparing a fresh window against a stale one
// invents a decline that is really just missing data.
const DATA_LAG_DAYS = 3;
const WINDOW_DAYS = 28;

// A query already on page 1–2 is where a small change actually moves clicks.
const STRIKING_DISTANCE = { minPosition: 4, maxPosition: 20, minImpressions: 25 };
// Well-ranked and still ignored means the title/description is the problem.
const LOW_CTR = { maxCtr: 0.02, minImpressions: 100, maxPosition: 10 };

function readNumericFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Match the configured property against what the service account can actually
 * see. Domain and URL-prefix properties are different resource ids for the same
 * site, and only one of them will exist — resolve rather than assume.
 */
function resolveProperty(sites, configured, site) {
  const permitted = sites.filter((entry) => entry.permissionLevel !== "siteUnverifiedUser");
  const exact = permitted.find((entry) => entry.siteUrl === configured);
  if (exact) return exact;

  const host = new URL(site).hostname.replace(/^www\./, "");
  return (
    permitted.find((entry) => entry.siteUrl === `sc-domain:${host}`) ??
    permitted.find((entry) => entry.siteUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") === host) ??
    null
  );
}

async function runSearchConsole({ fixSitemaps, inspectSample, inspectionQueue = [] }) {
  const client = await createClient();
  if (!client.ok) return { available: false, reason: client.reason, findings: [] };

  const findings = [];
  const push = (severity, code, message, detail = {}) =>
    findings.push({ severity, code, message, ...detail });

  let sites;
  try {
    sites = await client.listSites();
  } catch (error) {
    return { available: false, reason: `listSites failed: ${error.message}`, findings: [] };
  }

  const property = resolveProperty(sites, config.searchConsoleProperty, config.site);
  if (!property) {
    return {
      available: false,
      reason:
        `service account ${client.serviceAccount} can see ${sites.length} propert${sites.length === 1 ? "y" : "ies"} ` +
        `but none matching ${config.site} — add it as a Full user on the property`,
      findings: [],
      visibleProperties: sites.map((entry) => entry.siteUrl),
    };
  }

  const siteUrl = property.siteUrl;
  const result = {
    available: true,
    property: siteUrl,
    permissionLevel: property.permissionLevel,
    serviceAccount: client.serviceAccount,
    findings,
  };

  // --- sitemaps ------------------------------------------------------------
  try {
    const sitemaps = await client.listSitemaps(siteUrl);
    result.sitemaps = sitemaps.map((entry) => ({
      path: entry.path,
      lastSubmitted: entry.lastSubmitted,
      lastDownloaded: entry.lastDownloaded,
      isPending: entry.isPending,
      errors: Number(entry.errors ?? 0),
      warnings: Number(entry.warnings ?? 0),
    }));

    const known = new Set(sitemaps.map((entry) => entry.path));
    if (!known.has(config.sitemap)) {
      push("error", "sitemap-not-submitted", `${config.sitemap} is not submitted to Search Console`);
      if (fixSitemaps) {
        await client.submitSitemap(siteUrl, config.sitemap);
        result.submitted = [config.sitemap];
        push("info", "sitemap-submitted", `submitted ${config.sitemap}`);
      }
    }
    for (const entry of result.sitemaps ?? []) {
      if (entry.errors > 0) {
        push("error", "sitemap-errors", `Search Console reports ${entry.errors} errors in ${entry.path}`);
      }
      if (entry.warnings > 0) {
        push("warn", "sitemap-warnings", `Search Console reports ${entry.warnings} warnings in ${entry.path}`);
      }
      // A sitemap Google has not re-fetched in a month is usually a sign the
      // submitted URL now 404s or redirects.
      const downloaded = entry.lastDownloaded ? Date.parse(entry.lastDownloaded) : 0;
      if (downloaded && Date.now() - downloaded > 30 * 86_400_000) {
        push("warn", "sitemap-stale", `${entry.path} was last fetched ${entry.lastDownloaded}`);
      }
    }
  } catch (error) {
    push("warn", "sitemap-read-failed", `could not read sitemaps: ${error.message}`);
  }

  // --- performance + opportunities -----------------------------------------
  const endDate = daysAgo(DATA_LAG_DAYS);
  const startDate = daysAgo(DATA_LAG_DAYS + WINDOW_DAYS);
  const priorEnd = daysAgo(DATA_LAG_DAYS + WINDOW_DAYS + 1);
  const priorStart = daysAgo(DATA_LAG_DAYS + WINDOW_DAYS * 2 + 1);

  try {
    const [queries, pages, priorQueries] = await Promise.all([
      client.searchAnalytics(siteUrl, { startDate, endDate, dimensions: ["query"], rowLimit: 1000 }),
      client.searchAnalytics(siteUrl, { startDate, endDate, dimensions: ["page"], rowLimit: 500 }),
      client.searchAnalytics(siteUrl, {
        startDate: priorStart,
        endDate: priorEnd,
        dimensions: ["query"],
        rowLimit: 1000,
      }),
    ]);

    const totals = (rows) =>
      rows.reduce(
        (accumulator, row) => ({
          clicks: accumulator.clicks + row.clicks,
          impressions: accumulator.impressions + row.impressions,
        }),
        { clicks: 0, impressions: 0 },
      );

    result.window = { startDate, endDate, ...totals(queries) };
    result.priorWindow = { startDate: priorStart, endDate: priorEnd, ...totals(priorQueries) };

    // Ranked 4–20 with real impressions: the cheapest clicks on the board.
    result.strikingDistance = queries
      .filter(
        (row) =>
          row.position >= STRIKING_DISTANCE.minPosition &&
          row.position <= STRIKING_DISTANCE.maxPosition &&
          row.impressions >= STRIKING_DISTANCE.minImpressions,
      )
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 25)
      .map((row) => ({
        query: row.keys[0],
        impressions: row.impressions,
        clicks: row.clicks,
        position: Number(row.position.toFixed(1)),
      }));

    // Ranking well and still not clicked — a snippet problem, not a rank problem.
    result.lowCtrPages = pages
      .filter(
        (row) =>
          row.impressions >= LOW_CTR.minImpressions &&
          row.ctr <= LOW_CTR.maxCtr &&
          row.position <= LOW_CTR.maxPosition,
      )
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 15)
      .map((row) => ({
        page: row.keys[0],
        impressions: row.impressions,
        clicks: row.clicks,
        ctr: Number((row.ctr * 100).toFixed(2)),
        position: Number(row.position.toFixed(1)),
      }));

    // Demand that appeared this window and has no established page behind it.
    const priorByQuery = new Map(priorQueries.map((row) => [row.keys[0], row]));
    result.risingQueries = queries
      .filter((row) => row.impressions >= 20)
      .map((row) => {
        const before = priorByQuery.get(row.keys[0])?.impressions ?? 0;
        return { query: row.keys[0], impressions: row.impressions, before, delta: row.impressions - before };
      })
      .filter((row) => row.delta > 0 && (row.before === 0 || row.delta / row.before > 0.5))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 20);

    if (result.strikingDistance.length > 0) {
      push(
        "info",
        "striking-distance",
        `${result.strikingDistance.length} queries rank 4–20 with ≥${STRIKING_DISTANCE.minImpressions} impressions`,
      );
    }
    if (result.lowCtrPages.length > 0) {
      push(
        "warn",
        "low-ctr-pages",
        `${result.lowCtrPages.length} pages rank in the top 10 but earn under ${LOW_CTR.maxCtr * 100}% CTR`,
      );
    }
  } catch (error) {
    push("warn", "analytics-read-failed", `could not read Search Analytics: ${error.message}`);
  }

  // --- index coverage sample ------------------------------------------------
  // URL Inspection is quota-limited (2k/property/day) and slow, so the sweep
  // samples rather than sweeping the whole sitemap.
  if (inspectSample > 0) {
    const sample = inspectionQueue.slice(0, inspectSample);
    result.inspections = [];
    for (const url of sample) {
      try {
        const inspection = await client.inspectUrl(siteUrl, url);
        const index = inspection.indexStatusResult ?? {};
        result.inspections.push({
          url,
          verdict: index.verdict,
          coverageState: index.coverageState,
          googleCanonical: index.googleCanonical,
          userCanonical: index.userCanonical,
          robotsTxtState: index.robotsTxtState,
          lastCrawlTime: index.lastCrawlTime,
        });
        if (index.verdict && index.verdict !== "PASS") {
          push("error", "url-not-indexed", `${index.coverageState ?? index.verdict}`, { url });
        } else if (index.googleCanonical && index.userCanonical && index.googleCanonical !== index.userCanonical) {
          push("warn", "canonical-overridden", "Google chose a different canonical", {
            url,
            googleCanonical: index.googleCanonical,
          });
        }
      } catch (error) {
        push("warn", "inspection-failed", `URL Inspection failed for ${url}: ${error.message}`);
        break; // A quota or permission error will fail for every remaining URL too.
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------

const fixSitemaps = process.argv.includes("--fix-sitemaps");
const inspectSample = readNumericFlag("--inspect", 0);

const crawl = await runAudit();

// Inspect the URLs the crawl already flagged first — those are the ones whose
// index status we actually have a question about.
const suspect = new Set(
  crawl.findings.filter((item) => item.url && item.severity !== "info").map((item) => item.url),
);
const inspectionQueue = [
  ...suspect,
  ...crawl.pages.filter((page) => page.status === 200).map((page) => page.url),
];

const gsc = await runSearchConsole({ fixSitemaps, inspectSample, inspectionQueue });

const report = {
  site: config.site,
  generatedAt: new Date().toISOString(),
  crawl: {
    sitemapUrlCount: crawl.sitemapUrlCount,
    crawled: crawl.crawled,
    surfaces: crawl.surfaces,
    findings: crawl.findings,
  },
  searchConsole: gsc,
};

if (process.argv.includes("--write")) {
  const outputDir = join(repoRoot, config.reportDir);
  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, `${report.generatedAt.slice(0, 10)}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`report written to ${path}`);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const all = [...crawl.findings, ...(gsc.findings ?? [])];
  const counts = { error: 0, warn: 0, info: 0 };
  for (const item of all) counts[item.severity] += 1;

  console.log(`${config.site} — weekly SEO sweep`);
  console.log(`  crawl: ${crawl.crawled}/${crawl.sitemapUrlCount} sitemap URLs`);
  if (gsc.available) {
    console.log(`  search console API helper: ${gsc.property} (${gsc.permissionLevel})`);
    if (gsc.window) {
      console.log(
        `  last ${WINDOW_DAYS}d: ${gsc.window.clicks} clicks / ${gsc.window.impressions} impressions` +
          ` (prior ${gsc.priorWindow.clicks} / ${gsc.priorWindow.impressions})`,
      );
    }
  } else {
    console.log(`  search console API helper: unavailable — ${gsc.reason}`);
    console.log("  search console browser pass: REQUIRED (API credentials are optional)");
  }
  console.log(`  findings: ${counts.error} error, ${counts.warn} warn, ${counts.info} info\n`);

  // One template defect repeated across 24 case studies is one thing to fix, not
  // 24 findings. Collapse by code so the summary stays readable; --json keeps
  // every instance for whoever is actually doing the fixing.
  for (const severity of ["error", "warn"]) {
    const items = all.filter((item) => item.severity === severity);
    if (items.length === 0) continue;
    console.log(`${severity.toUpperCase()}`);

    const byCode = new Map();
    for (const item of items) byCode.set(item.code, [...(byCode.get(item.code) ?? []), item]);
    for (const [code, group] of [...byCode].sort((a, b) => b[1].length - a[1].length)) {
      if (group.length === 1) {
        const [item] = group;
        console.log(`  [${code}] ${item.message}${item.url ? ` — ${item.url}` : ""}`);
        continue;
      }
      console.log(`  [${code}] ×${group.length}`);
      for (const item of group.slice(0, 3)) {
        console.log(`      ${item.url ?? item.message}`);
      }
      if (group.length > 3) console.log(`      … ${group.length - 3} more`);
    }
    console.log("");
  }

  for (const [label, rows, format] of [
    ["Striking distance (rank 4–20)", gsc.strikingDistance, (row) => `${row.query} — pos ${row.position}, ${row.impressions} impr`],
    ["Low CTR in top 10", gsc.lowCtrPages, (row) => `${row.page} — ${row.ctr}% CTR, ${row.impressions} impr`],
    ["Rising queries", gsc.risingQueries, (row) => `${row.query} — ${row.before} → ${row.impressions} impr`],
  ]) {
    if (!rows || rows.length === 0) continue;
    console.log(label);
    for (const row of rows.slice(0, 10)) console.log(`  ${format(row)}`);
    console.log("");
  }
}

process.exit(0);
