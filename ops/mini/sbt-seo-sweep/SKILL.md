---
name: sbt-seo-sweep
description: Weekly Search Console, technical-SEO, and search-opportunity sweep for South Bay Today. Fixes what is safe, reports what is not.
---

# South Bay Today weekly SEO sweep

Runs Tuesday 01:15 Pacific as the native `sbt-seo-sweep` Codex automation on
Stephen's Mac Mini, in `/Users/stephenstanwood/Projects/southbaytoday.org`.
Inspect Google Search Console in the browser, ship high-confidence technical
and editorial fixes directly to `main`, and report anything genuinely blocked.

South Bay Today is a local news and civic-information site. Its readers arrive
with a job to do: find something to do this weekend, work out what the council
decided, see what opened. Search is how most of them arrive, so discovery is a
product concern, not a marketing one. The sibling routine `sbt-growth-sweep`
owns broad product and editorial strategy; this routine owns findability.

## Safe operating contract

0. Node lives at `/opt/homebrew/bin`. Non-interactive SSH does not put it on
   PATH — use a login shell (`zsh -lic`) or export it explicitly.
1. Acquire the shared repository lock before any git operation:
   `bash ~/.claude/scheduled-tasks/lib/repo-lock.sh acquire sbt-seo-sweep`.
   Several SBT tasks mutate this working tree concurrently. If the lock is
   busy, stop cleanly and report who holds it. Release it in a trap AND
   explicitly at the end.
2. Read `AGENTS.md` and `CLAUDE.md`, inspect `git status`, and preserve unrelated work. Fetch
   and pull safely before editing. The repo pushes directly to `main`.
3. Never expose admin routes, never add a paid service, and never invent a
   fact, a source URL, an event, or a quote.
4. Never print tokens, environment variables, or the service-account key.

## Search Console is required

This is a browser-first Codex task. A crawl is useful evidence, but it is not a
substitute for Search Console.

1. Use the Browser or Chrome control plugin, following its skill. Start with
   the runtime-selected browser for the Search Console URL; if it is not signed
   in, try another available browser surface before declaring an auth block.
2. Open the verified URL-prefix property `https://southbaytoday.org/` under
   `stanwoodventures@gmail.com` (`authuser=0` in Google URLs). Do not use the
   similarly named unverified property under `stephen@stoa.works`. Do not use
   the `/welcome` page as a property test; use the property picker or an exact
   property URL.
3. Inspect, at minimum:
   - Search results performance for the latest complete 28 days compared with
     the prior 28 days, including top queries and pages;
   - Page indexing reasons and meaningful changes since the prior run;
   - Sitemaps, their fetch status, errors, and warnings;
   - Core Web Vitals, HTTPS, Breadcrumb, Event, and other enhancement issues,
     plus Security issues and Manual actions when those sections contain
     findings;
   - URL Inspection for the highest-value new, fixed, or suspicious pages.
4. Submit the canonical sitemap index when missing. After a relevant fix is
   deployed and verified live, use **Validate fix** where Google offers it.
   Request indexing for no more than five genuinely new or materially fixed
   high-value URLs per run. Do not request indexing just to manufacture
   activity.
5. Never remove a property or user, change ownership, or use the Indexing API
   for ordinary pages.

If no available Mini browser is authenticated, release the repo lock, stop,
and report `GSC_BROWSER_LOGIN_REQUIRED` with the exact account and property. Do
not call the run complete, and do not downgrade it to a crawl-only success.

## Measure first

```
npm run seo:sweep -- --write
```

Writes `data/seo/<date>.json` and prints a summary. Two instruments:

- **crawl** — needs no credentials. Walks `sitemap-index.xml` and checks
  status, redirects, titles, descriptions, canonicals, `lang`, `h1`,
  structured data, and internal links. The sitemap carries ~2,000 URLs, so the
  crawl samples 250 per run and rotates through the tail week over week;
  orphan detection self-disables on a sampled crawl.
- **Search Console API helper** — optional. When
  `GSC_SERVICE_ACCOUNT_JSON` exists in `.env.local`, it preloads submitted
  sitemaps, 28-day performance, striking-distance queries, low-CTR pages,
  rising queries, and URL Inspection samples. When it is unavailable, continue
  with the required browser pass; a missing service-account key is not a
  blocker and must not be handed back to Stephen.

Also confirm each week that Google, Bing, OAI-SearchBot, ChatGPT-User,
Claude-SearchBot, and Claude-User can still fetch `/robots.txt`, `/llms.txt`,
`/rss.xml`, and `/sitemap-index.xml` without a challenge.

Add `--inspect 20` to sample URL Inspection on flagged URLs when the API helper
is available. Use `--fix-sitemaps` only when it reports
`sitemap-not-submitted`; the browser may submit the sitemap directly instead.

## Fix directly (no need to ask)

- Indexable pages linked from the site but absent from the sitemap. The
  sitemap is generated by `@astrojs/sitemap` in `astro.config.mjs`; fix the
  `filter` rather than hand-maintaining URLs. Past-dated `/events/<date>` URLs
  are excluded deliberately — that is correct, leave it.
- Duplicate titles across near-identical pages (commonly an `/event/<slug>`
  and its `/events/<date>` sibling). Decide which URL should rank, make the
  other canonical to it, and make the titles distinct.
- Missing or badly sized titles and meta descriptions on non-event pages.
  Event titles are legitimately long because event names are long; do not
  truncate a real event name to satisfy a character count.
- Missing `lang`, missing `h1`, missing or contradictory canonical.
- Sitemap URLs that redirect or 404.
- Structured data gaps: `Event` on event pages, `Organization` sitewide,
  `BreadcrumbList` where breadcrumbs render. Search Console already reports
  Breadcrumbs and Events enhancements for this property — keep them valid.
- After a deploy that changed the freshness surface, run
  `node scripts/indexnow-ping.mjs` so Bing and friends re-crawl the pages that
  actually changed.

Commit with a short lowercase message describing the real change.

## Pursue opportunities

Read `strikingDistance`, `lowCtrPages`, and `risingQueries`:

- A query ranking 4–20 with real impressions is a page that nearly works. Ask
  whether the reader's actual job is served by the page Google is ranking. If
  it is, sharpen that page; if it is not, the answer is usually a better page,
  not more keywords.
- A top-10 page under 2% CTR is a snippet problem. Rewrite the title and
  description to say what the reader gets.
- Rising queries are early local demand — a venue, a neighborhood, an event
  type, a civic question. If the site can genuinely answer it from real
  sources, that is a page worth generating or a source worth adding.
- Seasonality is real here. Camps, weekend picks, holiday events, and school
  calendars all have lead time; a page that ships the week demand peaks has
  already missed it.

## Ask Stephen, do not decide alone

Report: a browser login or other credential that is actually unavailable; a
paid service; a new top-level section or nav change;
anything touching editorial identity or the mission; de-indexing or removing
existing pages; a redirect affecting an already-ranking URL; and anything
where the honest answer is "this might be wrong".

## Allowlist

Commit only within `src/`, `scripts/seo/`, `astro.config.mjs`, `public/*.txt`,
`data/seo/`, and `docs/seo-*.md`. Anything else needs Stephen.

## Close out

1. Push allowlisted commits to `main` while still holding the repo lock.
2. Release the repo lock.
3. Verify the changed public surface is live before clicking Search Console's
   **Validate fix** or **Request indexing** for that change.
4. DM Stephen one message starting with `🔍 SBT SEO sweep`: clicks and
   impressions this window vs the prior one, what you fixed and pushed, the
   best 1–3 opportunities with what you did or propose, and anything blocked
   with exactly what unblocks it. Send with
   `node ops/mini/sbt-seo-sweep/send-seo-dm.mjs "…"`.
5. If the run fails, DM once starting with `⚠️ sbt-seo-sweep:` and stop.
