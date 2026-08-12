#!/usr/bin/env node
// Crawl-based technical SEO and AI-discovery audit.
//
// This is the leg of the weekly sweep that needs no credentials: it reads the
// live site the way a crawler does and reports what a crawler would hold
// against us. Search Console tells us what Google already decided; this tells
// us what it is about to decide.
//
// Parsing is regex-based rather than DOM-based on purpose — the checks only
// need a handful of head tags and anchor hrefs, and staying dependency-free
// keeps this file byte-identical across stoa.works and southbaytoday.org.
//
// Usage: node scripts/seo/audit.mjs [--json] [--limit N]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = JSON.parse(readFileSync(join(__dirname, "seo.config.json"), "utf8"));

const USER_AGENT =
  "StoaSEOSweep/1.0 (+weekly self-audit; contact stephen@stanwood.dev)";
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;

// Google truncates around these; outside the range is a warning, not an error.
const TITLE_MIN = 15;
// ~600px is where Google truncates; 70 characters is the practical equivalent.
// 65 flagged every /work/<slug> case study for being two characters long.
const TITLE_MAX = 70;
const DESCRIPTION_MIN = 70;
const DESCRIPTION_MAX = 165;
const THIN_CONTENT_WORDS = 150;

// ---------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------

async function getText(url, { redirect = "follow" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    const body = response.headers.get("content-type")?.includes("image/")
      ? ""
      : await response.text();
    return {
      status: response.status,
      url: response.url,
      headers: response.headers,
      body,
    };
  } catch (error) {
    return { status: 0, url, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Walk a redirect chain by hand so the sweep can report the hops, not just the destination. */
async function traceRedirects(url, maxHops = 5) {
  const chain = [];
  let current = url;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const response = await getText(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get("location");
      if (!location) break;
      const next = new URL(location, current).toString();
      chain.push({ from: current, to: next, status: response.status });
      current = next;
      continue;
    }
    return { chain, final: current, status: response.status, response };
  }
  return { chain, final: current, status: 0, response: null };
}

/** Bounded-concurrency map — polite to our own origin, and fast enough for a weekly run. */
async function mapPool(items, worker, limit = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// HTML extraction
// ---------------------------------------------------------------------------

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const tag of html.match(/<meta\s+[^>]*>/gi) ?? []) {
    const name = /(?:name|property)=(["'])(.*?)\1/i.exec(tag)?.[2];
    if (!name || name.toLowerCase() !== escaped.toLowerCase()) continue;
    return /content=(["'])([\s\S]*?)\1/i.exec(tag)?.[2]?.trim() ?? null;
  }
  return null;
}

function linkHref(html, rel) {
  for (const tag of html.match(/<link\s+[^>]*>/gi) ?? []) {
    const relValue = /rel=(["'])(.*?)\1/i.exec(tag)?.[2];
    if (relValue?.toLowerCase() !== rel) continue;
    return /href=(["'])(.*?)\1/i.exec(tag)?.[2] ?? null;
  }
  return null;
}

function textOnly(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePage(html, url) {
  const jsonLdTypes = [];
  for (const block of html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ) ?? []) {
    const inner = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
    try {
      const parsed = JSON.parse(inner);
      for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
        const type = node?.["@type"];
        if (type) jsonLdTypes.push(...(Array.isArray(type) ? type : [type]));
        for (const child of node?.["@graph"] ?? []) {
          if (child?.["@type"]) jsonLdTypes.push(child["@type"]);
        }
      }
    } catch {
      jsonLdTypes.push("__invalid__");
    }
  }

  const headings = html.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) ?? [];
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  const words = textOnly(bodyMatch?.[1] ?? html).split(" ").filter(Boolean).length;

  const links = new Set();
  for (const anchor of html.match(/<a\s+[^>]*href=(["'])[^"']*\1[^>]*>/gi) ?? []) {
    const href = /href=(["'])(.*?)\1/i.exec(anchor)?.[2];
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    try {
      const resolved = new URL(href, url);
      resolved.hash = "";
      links.add(resolved.toString());
    } catch {
      /* unparseable href — the markup check below is not what this audit is for */
    }
  }

  return {
    title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null,
    description: metaContent(html, "description"),
    canonical: linkHref(html, "canonical"),
    robots: metaContent(html, "robots"),
    ogTitle: metaContent(html, "og:title"),
    ogImage: metaContent(html, "og:image"),
    lang: /<html[^>]*\slang=(["'])(.*?)\1/i.exec(html)?.[2] ?? null,
    h1Count: headings.length,
    jsonLdTypes,
    words,
    links: [...links],
  };
}

// ---------------------------------------------------------------------------
// sitemap
// ---------------------------------------------------------------------------

function extractTags(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, "g"))].map((match) =>
    match[1].trim(),
  );
}

/** Follow a sitemap index one level down; both sites are well under the 50k cap. */
async function collectSitemapUrls(sitemapUrl, seen = new Set()) {
  if (seen.has(sitemapUrl)) return { urls: [], sitemaps: [], errors: [] };
  seen.add(sitemapUrl);

  const response = await getText(sitemapUrl);
  if (response.status !== 200) {
    return {
      urls: [],
      sitemaps: [sitemapUrl],
      errors: [`sitemap ${sitemapUrl} returned ${response.status || response.error}`],
    };
  }

  // A sitemap index and a urlset both use <loc>; only the root element says which.
  if (/<sitemapindex/i.test(response.body)) {
    const children = extractTags(response.body, "loc");
    const nested = await Promise.all(children.map((child) => collectSitemapUrls(child, seen)));
    return {
      urls: nested.flatMap((entry) => entry.urls),
      sitemaps: [sitemapUrl, ...nested.flatMap((entry) => entry.sitemaps)],
      errors: nested.flatMap((entry) => entry.errors),
    };
  }

  return { urls: extractTags(response.body, "loc"), sitemaps: [sitemapUrl], errors: [] };
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

function finding(severity, code, message, detail = {}) {
  return { severity, code, message, ...detail };
}

/**
 * Pick which sitemap URLs to crawl when the sitemap is larger than the budget.
 *
 * Taking the first N would re-crawl the same alphabetical head every week and
 * never reach the tail. Instead: always crawl the shallow, high-value routes,
 * then rotate through the deep ones a slice at a time so a month of runs covers
 * the whole site. The rotation is keyed on the ISO week, so a given week's run
 * is reproducible when debugging.
 */
function selectCrawlTargets(urls, limit) {
  if (urls.length <= limit) return urls;

  const depth = (url) => new URL(url).pathname.replace(/\/$/, "").split("/").length;
  const shallow = urls.filter((url) => depth(url) <= 2);
  const deep = urls.filter((url) => depth(url) > 2);

  const budget = Math.max(0, limit - shallow.length);
  if (budget === 0) return shallow.slice(0, limit);

  const week = Math.floor(Date.now() / (7 * 86_400_000));
  const slices = Math.max(1, Math.ceil(deep.length / budget));
  const offset = (week % slices) * budget;
  const rotated = [...deep.slice(offset), ...deep.slice(0, offset)];

  return [...shallow, ...rotated.slice(0, budget)];
}

export async function runAudit({ limit = config.crawlLimit ?? Infinity } = {}) {
  const { site, sitemap, discoverySurfaces = [], expectedJsonLd = [] } = config;
  const origin = site.replace(/\/+$/, "");
  const findings = [];

  // --- discovery surfaces (robots.txt, llms.txt, feeds) ---------------------
  const surfaces = {};
  for (const path of ["/robots.txt", ...discoverySurfaces]) {
    const response = await getText(`${origin}${path}`);
    surfaces[path] = { status: response.status, bytes: response.body?.length ?? 0 };
    if (response.status !== 200) {
      findings.push(
        finding("error", "surface-unreachable", `${path} returned ${response.status || response.error}`, {
          url: `${origin}${path}`,
        }),
      );
      continue;
    }
    if (path === "/robots.txt") {
      surfaces[path].body = response.body;
      if (!/^\s*Sitemap:/im.test(response.body)) {
        findings.push(
          finding("error", "robots-no-sitemap", "robots.txt does not declare a Sitemap:"),
        );
      } else if (!response.body.includes(sitemap)) {
        findings.push(
          finding(
            "warn",
            "robots-sitemap-mismatch",
            `robots.txt Sitemap: does not point at the configured sitemap (${sitemap})`,
          ),
        );
      }
      if (/^\s*Disallow:\s*\/\s*$/im.test(response.body)) {
        findings.push(
          finding("error", "robots-disallow-all", "robots.txt disallows the whole site"),
        );
      }
    }
  }

  // --- sitemap --------------------------------------------------------------
  const { urls: sitemapUrls, sitemaps, errors: sitemapErrors } = await collectSitemapUrls(sitemap);
  for (const message of sitemapErrors) findings.push(finding("error", "sitemap-error", message));
  if (sitemapUrls.length === 0) {
    findings.push(finding("error", "sitemap-empty", `no URLs found in ${sitemap}`));
    return { site: origin, checkedAt: new Date().toISOString(), surfaces, sitemaps, pages: [], findings };
  }

  // --- crawl ---------------------------------------------------------------
  const targets = selectCrawlTargets(sitemapUrls, limit);
  const pages = await mapPool(targets, async (url) => {
    const traced = await traceRedirects(url);
    if (traced.status !== 200 || !traced.response?.body) {
      return { url, status: traced.status, redirects: traced.chain, error: traced.response?.error };
    }
    return {
      url,
      status: 200,
      redirects: traced.chain,
      ...parsePage(traced.response.body, traced.final),
    };
  });

  // --- per-page findings ----------------------------------------------------
  const titles = new Map();
  const descriptions = new Map();

  for (const page of pages) {
    if (page.status !== 200) {
      findings.push(
        finding("error", "sitemap-url-broken", `sitemap URL returns ${page.status || page.error}`, {
          url: page.url,
        }),
      );
      continue;
    }
    if (page.redirects.length > 0) {
      findings.push(
        finding("warn", "sitemap-url-redirects", "sitemap URL redirects instead of serving 200", {
          url: page.url,
          to: page.redirects.at(-1).to,
        }),
      );
    }
    if (/noindex/i.test(page.robots ?? "")) {
      findings.push(
        finding("error", "sitemap-url-noindex", "sitemap URL is meta noindex", { url: page.url }),
      );
    }
    if (!page.title) {
      findings.push(finding("error", "title-missing", "page has no <title>", { url: page.url }));
    } else {
      if (page.title.length < TITLE_MIN || page.title.length > TITLE_MAX) {
        findings.push(
          finding("warn", "title-length", `title is ${page.title.length} chars`, {
            url: page.url,
            title: page.title,
          }),
        );
      }
      titles.set(page.title, [...(titles.get(page.title) ?? []), page.url]);
    }
    if (!page.description) {
      findings.push(
        finding("warn", "description-missing", "page has no meta description", { url: page.url }),
      );
    } else {
      if (page.description.length < DESCRIPTION_MIN || page.description.length > DESCRIPTION_MAX) {
        findings.push(
          finding("info", "description-length", `meta description is ${page.description.length} chars`, {
            url: page.url,
          }),
        );
      }
      descriptions.set(page.description, [...(descriptions.get(page.description) ?? []), page.url]);
    }
    if (!page.canonical) {
      findings.push(finding("warn", "canonical-missing", "page has no canonical", { url: page.url }));
    } else {
      const canonical = new URL(page.canonical, page.url).toString().replace(/\/$/, "");
      if (canonical !== page.url.replace(/\/$/, "")) {
        findings.push(
          finding("warn", "canonical-mismatch", "canonical points away from the sitemap URL", {
            url: page.url,
            canonical: page.canonical,
          }),
        );
      }
    }
    if (!page.lang) {
      findings.push(finding("error", "lang-missing", "<html> has no lang attribute", { url: page.url }));
    }
    if (page.h1Count === 0) {
      findings.push(finding("warn", "h1-missing", "page has no <h1>", { url: page.url }));
    } else if (page.h1Count > 1) {
      findings.push(
        finding("info", "h1-multiple", `page has ${page.h1Count} <h1> elements`, { url: page.url }),
      );
    }
    if (!page.ogImage) {
      findings.push(finding("info", "og-image-missing", "page has no og:image", { url: page.url }));
    }
    if (page.jsonLdTypes.includes("__invalid__")) {
      findings.push(
        finding("error", "jsonld-invalid", "page has a JSON-LD block that does not parse", {
          url: page.url,
        }),
      );
    }
    if (page.jsonLdTypes.length === 0) {
      findings.push(
        finding("info", "jsonld-missing", "page has no structured data", { url: page.url }),
      );
    }
    if (page.words < THIN_CONTENT_WORDS) {
      findings.push(
        finding("info", "thin-content", `page has ~${page.words} words`, { url: page.url }),
      );
    }
  }

  for (const [title, urls] of titles) {
    if (urls.length > 1) {
      findings.push(
        finding("warn", "title-duplicate", `${urls.length} pages share the title "${title}"`, { urls }),
      );
    }
  }
  for (const [, urls] of descriptions) {
    if (urls.length > 1) {
      findings.push(
        finding("info", "description-duplicate", `${urls.length} pages share a meta description`, {
          urls,
        }),
      );
    }
  }

  // --- expected structured data --------------------------------------------
  const seenTypes = new Set(pages.flatMap((page) => page.jsonLdTypes ?? []));
  for (const type of expectedJsonLd) {
    if (!seenTypes.has(type)) {
      findings.push(
        finding("warn", "jsonld-type-absent", `no page emits expected structured-data type ${type}`),
      );
    }
  }

  // --- internal link graph --------------------------------------------------
  const inSitemap = new Set(sitemapUrls.map((url) => url.replace(/\/$/, "")));
  const internalLinks = new Set();
  for (const page of pages) {
    for (const link of page.links ?? []) {
      if (link.startsWith(origin)) internalLinks.add(link.replace(/\/$/, ""));
    }
  }

  // "Nothing links here" is only true if we actually looked everywhere. Under
  // --limit the crawl is a sample, so every uncrawled page would read as an
  // orphan — a guaranteed false positive. Skip the check instead of crying wolf.
  const completeCrawl = targets.length === sitemapUrls.length;
  if (completeCrawl) {
    const unlinked = [...inSitemap].filter(
      (url) => url !== origin && !internalLinks.has(url) && !internalLinks.has(`${url}/`),
    );
    for (const url of unlinked) {
      findings.push(
        finding("warn", "orphan-page", "sitemap URL is not linked from any other page", { url }),
      );
    }
  }

  // robots.txt Disallow is the site telling us these paths are deliberately out
  // of the index — /api/, /admin/, and friends must not be reported as gaps.
  const disallowed = [
    ...(surfaces["/robots.txt"]?.body?.matchAll(/^\s*Disallow:\s*(\S+)\s*$/gim) ?? []),
  ].map((match) => match[1]);
  const isDisallowed = (url) => {
    const path = new URL(url).pathname;
    return disallowed.some((rule) => rule !== "/" && path.startsWith(rule));
  };
  // Documents and assets are legitimately linked without belonging in a page sitemap.
  const isAsset = (url) => /\.(pdf|xml|json|txt|png|jpe?g|webp|svg|ico|css|js|zip|woff2?)$/i.test(
    new URL(url).pathname,
  );

  const uncatalogued = [...internalLinks].filter(
    (url) => !inSitemap.has(url) && !isDisallowed(url) && !isAsset(url),
  );
  const uncataloguedStatuses = await mapPool(uncatalogued.slice(0, 60), async (url) => {
    // Follow redirects here: a linked page that 301s to an indexable page is not
    // broken, and the noindex meta we care about lives on the destination.
    const response = await getText(url);
    return {
      url,
      status: response.status,
      robots: response.body ? metaContent(response.body, "robots") : null,
    };
  });
  for (const entry of uncataloguedStatuses) {
    if (entry.status === 404 || entry.status === 0) {
      findings.push(
        finding("error", "broken-internal-link", `internal link returns ${entry.status || "no response"}`, {
          url: entry.url,
        }),
      );
    } else if (entry.status === 200 && !/noindex/i.test(entry.robots ?? "")) {
      findings.push(
        finding("warn", "page-missing-from-sitemap", "indexable page is linked but absent from the sitemap", {
          url: entry.url,
        }),
      );
    }
  }

  return {
    site: origin,
    checkedAt: new Date().toISOString(),
    surfaces,
    sitemaps,
    sitemapUrlCount: sitemapUrls.length,
    crawled: pages.filter((page) => page.status === 200).length,
    pages,
    findings,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit"));
  const limit = limitArg ? Number(limitArg.split("=")[1] ?? process.argv[process.argv.indexOf(limitArg) + 1]) : Infinity;
  const report = await runAudit({ limit });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const bySeverity = { error: [], warn: [], info: [] };
    for (const item of report.findings) bySeverity[item.severity]?.push(item);
    console.log(`${report.site} — ${report.crawled}/${report.sitemapUrlCount} sitemap URLs crawled`);
    for (const severity of ["error", "warn", "info"]) {
      const items = bySeverity[severity];
      if (items.length === 0) continue;
      console.log(`\n${severity.toUpperCase()} (${items.length})`);
      for (const item of items.slice(0, 25)) {
        console.log(`  [${item.code}] ${item.message}${item.url ? ` — ${item.url}` : ""}`);
      }
      if (items.length > 25) console.log(`  … ${items.length - 25} more`);
    }
  }
  process.exit(report.findings.some((item) => item.severity === "error") ? 1 : 0);
}
