#!/usr/bin/env node
// Build-output audit for the site's search and AI-discovery surfaces.
// Run after `npm run build`; exits nonzero only for actionable regressions.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const SITE = "https://southbaytoday.org";
const jsonMode = process.argv.includes("--json");
const dirArg = process.argv.find((arg) => arg.startsWith("--dir="))?.slice(6);
const outputDir = dirArg
  ? dirArg
  : ["dist/client", ".vercel/output/static"].find((candidate) => existsSync(candidate));

const errors = [];
const warnings = [];
const metrics = {
  sitemapUrls: 0,
  htmlPagesChecked: 0,
  jsonLdBlocks: 0,
  eventLeafPages: 0,
  ssrPagesSkipped: 0,
};

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].trim());
}

function count(html, pattern) {
  return [...html.matchAll(pattern)].length;
}

// `<` and `>` are legal inside a quoted HTML attribute value, and event titles
// really do contain them (the Taemin "<LiMiNaL>" tour). Skipping over quoted
// runs keeps a naive `[^>]*` from ending the tag at the first bracket inside
// content=, which read as a missing description on a page that was fine.
const META_TAG = /<meta\s+(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;

function metaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const tag of html.match(META_TAG) ?? []) {
    const key = /(?:name|property)=(["'])(.*?)\1/i.exec(tag)?.[2];
    if (!key || !new RegExp(`^${escaped}$`, "i").test(key)) continue;
    return /content=(["'])(.*?)\1/i.exec(tag)?.[2] ?? null;
  }
  return null;
}

function canonicalHref(html) {
  const first = /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(html);
  if (first) return first[1];
  return /<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i.exec(html)?.[1] ?? null;
}

// A sitemap URL can legitimately have no prerendered HTML: pages that opt out
// with `export const prerender = false` are rendered per request (e.g.
// /newsletters, whose issue list lives in Vercel Blob rather than build-time
// data). Resolve the page source instead of hardcoding a list, so a route that
// later flips back to static is checked again automatically. Only the
// build-output assertions are skipped — the live checks still cover these.
function ssrPageSourceFor(pathname) {
  const route = pathname.replace(/^\/+|\/+$/g, "");
  if (!route) return null;
  const candidates = [
    join("src/pages", route, "index.astro"),
    join("src/pages", `${route}.astro`),
    join("src/pages", route, "index.ts"),
    join("src/pages", `${route}.ts`),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (/export\s+const\s+prerender\s*=\s*false/.test(read(candidate))) return candidate;
  }
  return null;
}

function collectTypedObjects(value, type, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectTypedObjects(item, type, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const object = value;
  const objectTypes = Array.isArray(object["@type"]) ? object["@type"] : [object["@type"]];
  if (objectTypes.includes(type)) found.push(object);
  for (const child of Object.values(object)) collectTypedObjects(child, type, found);
  return found;
}

if (!outputDir) {
  fail("No build output found. Run `npm run build` first or pass --dir=<path>.");
} else {
  const sitemapIndexPath = join(outputDir, "sitemap-index.xml");
  const robotsPath = join(outputDir, "robots.txt");
  const llmsPath = join(outputDir, "llms.txt");

  if (!existsSync(sitemapIndexPath)) fail("sitemap-index.xml is missing from the build.");
  if (!existsSync(robotsPath)) fail("robots.txt is missing from the build.");
  if (!existsSync(llmsPath)) fail("llms.txt is missing from the build.");

  if (existsSync(robotsPath)) {
    const robots = read(robotsPath);
    for (const bot of ["OAI-SearchBot", "Claude-SearchBot", "Claude-User"]) {
      if (!robots.includes(`User-agent: ${bot}`)) fail(`robots.txt does not explicitly allow ${bot}.`);
    }
    if (!robots.includes(`Sitemap: ${SITE}/sitemap-index.xml`)) fail("robots.txt does not advertise the canonical sitemap index.");
  }

  if (existsSync(llmsPath)) {
    const llms = read(llmsPath);
    for (const expected of ["/event/", "/rss.xml", "/api/south-bay/upcoming-events", "/about", "/sitemap-index.xml"]) {
      if (!llms.includes(expected)) fail(`llms.txt is missing the ${expected} discovery pointer.`);
    }
  }

  if (existsSync(sitemapIndexPath)) {
    const sitemapFiles = extractLocs(read(sitemapIndexPath));
    const urls = [];
    for (const sitemapUrl of sitemapFiles) {
      const childPathname = new URL(sitemapUrl).pathname;
      const childPath = join(outputDir, basename(childPathname));
      if (!existsSync(childPath)) {
        // A sitemap child can opt out of prerendering just like a page:
        // sitemap-newsletters.xml enumerates issues held in Vercel Blob, so it
        // has no build-time output to read. Resolve the route source rather
        // than hardcoding the name, and let the live checks cover it.
        if (ssrPageSourceFor(childPathname)) {
          metrics.ssrPagesSkipped += 1;
          continue;
        }
        fail(`Sitemap child is missing: ${basename(childPath)}`);
        continue;
      }
      urls.push(...extractLocs(read(childPath)));
    }

    metrics.sitemapUrls = urls.length;
    if (urls.length < 500) fail(`Sitemap unexpectedly contains only ${urls.length} URLs.`);
    if (new Set(urls).size !== urls.length) fail("Sitemap contains duplicate URLs.");

    for (const url of urls) {
      const parsed = new URL(url);
      if (parsed.origin !== SITE) {
        fail(`Sitemap contains an off-domain URL: ${url}`);
        continue;
      }
      if (/\/(admin|api)(\/|$)|\/logo-preview(?:\/|$)/.test(parsed.pathname)) {
        fail(`Sitemap exposes a non-public route: ${url}`);
      }

      const relative = parsed.pathname === "/" ? "index.html" : `${parsed.pathname.slice(1)}/index.html`;
      const htmlPath = join(outputDir, relative);
      if (!existsSync(htmlPath)) {
        const ssrSource = ssrPageSourceFor(parsed.pathname);
        if (ssrSource) {
          metrics.ssrPagesSkipped += 1;
          warn(`${url} is server-rendered (${ssrSource}) — build-output checks skipped.`);
        } else {
          fail(`Sitemap URL has no generated HTML: ${url}`);
        }
        continue;
      }

      const html = read(htmlPath);
      metrics.htmlPagesChecked += 1;
      if (count(html, /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/gi) !== 1) fail(`${url} must have exactly one title.`);
      if (!metaContent(html, "description")) fail(`${url} is missing a meta description.`);
      const canonical = canonicalHref(html);
      if (canonical !== url) fail(`${url} has mismatched canonical ${canonical ?? "(missing)"}.`);
      if (count(html, /<h1(?:\s[^>]*)?>/gi) !== 1) fail(`${url} must have exactly one h1.`);
      if (/and\s+6\s+more\s+South Bay cities/i.test(html)) fail(`${url} regressed to numeral 6 in the search description; use “six”.`);

      const blocks = [...html.matchAll(/<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      const parsedBlocks = [];
      for (const [, raw] of blocks) {
        metrics.jsonLdBlocks += 1;
        try {
          parsedBlocks.push(JSON.parse(raw));
        } catch (error) {
          fail(`${url} contains invalid JSON-LD: ${error.message}`);
        }
      }

      if (parsed.pathname.startsWith("/event/")) {
        metrics.eventLeafPages += 1;
        const passed = /class=["']cal-passed["']/.test(html);
        const events = parsedBlocks.flatMap((block) => collectTypedObjects(block, "Event"));
        if (passed) {
          if (events.length !== 0) {
            fail(`${url} is a passed archive page but still exposes ${events.length} Event object(s).`);
          }
        } else {
          if (events.length !== 1) fail(`${url} must expose exactly one Event object; found ${events.length}.`);
          const event = events[0];
          if (event && event.url !== url) fail(`${url} Event.url must point to its canonical leaf page.`);
          if (event && !event.sameAs) warn(`${url} has no primary-source sameAs URL.`);
          if (
            event &&
            event.eventStatus === "https://schema.org/EventScheduled" &&
            typeof event.startDate === "string" &&
            event.startDate.slice(0, 10) < new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
          ) {
            fail(`${url} advertises EventScheduled for a startDate that has already passed.`);
          }
        }
        if (!/<time\s+[^>]*datetime=["'][^"']+["']/i.test(html)) warn(`${url} does not show a machine-readable refresh time.`);
      }
    }
  }
}

const report = { outputDir: outputDir ?? null, metrics, errors, warnings };
if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Discovery audit: ${errors.length ? "FAILED" : "OK"}`);
  console.log(`  ${metrics.sitemapUrls} sitemap URLs; ${metrics.htmlPagesChecked} HTML pages; ${metrics.ssrPagesSkipped} server-rendered; ${metrics.eventLeafPages} event leaves; ${metrics.jsonLdBlocks} JSON-LD blocks`);
  for (const message of errors) console.error(`  ERROR: ${message}`);
  for (const message of warnings) console.warn(`  WARN: ${message}`);
}

if (errors.length) process.exit(1);
