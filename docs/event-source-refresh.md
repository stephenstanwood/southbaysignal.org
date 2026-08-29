# Event source refresh reliability

The event database is refreshed by a guarded Mini job and independently checked
by GitHub Actions. Source adapters must fail closed: an unknown fetch or parser
failure must never be represented as a successful empty season.

## Production path

1. `org.southbaytoday.events-refresh` runs on the Mini at 7:15 PM PT, with an
   8:45 PM retry.
2. `scripts/events/scheduled-refresh.mjs` acquires the shared repo lock, refreshes
   Playwright and inbound snapshots, runs every adapter in strict mode, commits
   generated data, preflights again, pushes, and writes the success heartbeat.
3. `org.southbaytoday.events-refresh-watchdog` runs every three hours. It restores
   the primary launch agent if it is missing and forces one guarded refresh when
   the pushed success or generated output is stale.
4. The primary job restores the watchdog if that companion agent disappears.
5. `.github/workflows/refresh-events.yml` runs after the Mini with an eight-hour
   snapshot ceiling. It is an independent same-night check and alerts on any
   workflow failure.

Install or repair both Mini agents — and relink the tracked pre-commit hook —
with:

```bash
bash scripts/events/install-mini-refresh.sh
```

## Fail-closed contract

- Every adapter exception blocks a strict refresh, including errors that legacy
  adapters used to swallow and return as an empty array.
- Shared HTTP fetches (including Ticketmaster Discovery) retry temporary
  network failures, rate limits, and 5xx responses with bounded backoff before
  strict mode fails. Permanent 4xx responses fail immediately.
- If a critical adapter still fails on a transient status after retries, the
  refresh reuses that source's previous rows when available and continues
  without paging. Optional adapters that 429 are absorbed unless many fail at
  once; the heartbeat matches that tolerance so a single Heritage Theatre rate
  limit cannot keep Discord red.
- Missing credentials, stale/empty snapshots, critical empty sources, and
  aggregate event/source regressions block the output write.
- A Playwright task that returns an empty array after previously contributing
  still-future rows is retried once, sequentially. If that retry is also empty,
  it is recorded as an error and only those still-future rows carry forward.
  Sources with no future rows still age out normally; the aggregate regression
  gate and its thresholds remain unchanged.
- Every adapter records per-date raw counts in `sourceHealth`. The next run
  blocks a source that suddenly loses most or all records that were still
  scheduled for the future. Past date buckets age out automatically, so a
  legitimate seasonal ending needs no allowlist.
- Stable primary routes are preferred over year-specific URLs. For example, San
  Jose Jazz starts at `/lineup`; if that official view is semantically empty,
  it tries `/chronological` and the current day pages discovered from the
  first-party menu instead of hardcoding yearly filter slugs.
- San Jose Museum of Art is owned by the Playwright snapshot. Its redundant
  direct HTTP adapter was retired after Cloudflare began returning a managed
  403 challenge; browser failures retain that source's last healthy future rows.
- SJDA (Downtown San Jose) was retired 2026-08-24, and unlike SJMA the whole
  site is walled rather than one endpoint: the events API, `/events/feed/`,
  `?ical=1` and the sitemap that sjdowntown.com's own robots.txt advertises all
  answer 403 with a Cloudflare interstitial. The refusal is deliberate and
  stated, not just a bot wall — robots.txt names and disallows ClaudeBot, GPTBot,
  CCBot, Bytespider, Amazonbot, Google-Extended and meta-externalagent, and it
  disallows `CloudflareBrowserRenderingCrawler` too, so a headless browser is
  refused as explicitly as an HTTP client. Do not re-register the adapter, give
  it a browser User-Agent, or move it to the Playwright snapshot the way SJMA
  went; every one of those is the sidestep the host has asked us not to make.
  The coverage cost is real — roughly 332 upcoming downtown records, and no other
  adapter covers that beat, though downtown venues with their own adapters (SAP
  Center, San Jose Theaters, Hammer, City Lights) are unaffected. SJDA does still
  reach us through the sanctioned channel: sjda@sjdowntown.com mails events to
  the inbound intake address, at a couple of events rather than hundreds. If
  downtown coverage needs restoring, ask SJDA for a feed — do not re-scrape.
- Inbound events arrive as one Vercel Blob shard per intake email (866 as of
  2026-08). Shard reads are bounded to 24 at a time and retry transient
  failures. What still fails is weighed, not simply counted: a subset (up to 5%,
  minimum 2) degrades the pull with a warning and a `shardFailures` stamp in
  `_meta`, while a larger share blocks. This is not a catch-and-empty path — the
  failures are reported, and the zero-events and coverage-regression guards
  still gate the write. A failed shard *listing* always blocks, because without
  a denominator a silent undercount is indistinguishable from a clean read.
  Three unreachable shards out of 860 aborted the 2026-08-23/24 refreshes after
  the 40-minute Playwright stage had already produced good data.
- `eventCount` in `upcoming-events.json` is derived data. `generate-events`
  writes it with `events` so they cannot disagree, but the editing routines
  (fact-check, copy-edit, one-off backfills) mutate `events` directly. The
  tracked `scripts/hooks/pre-commit` hook normalizes the stamp whenever anything
  under `src/data/south-bay/` is staged, and never blocks a commit. It is
  installed by `install-mini-refresh.sh`, which the scheduled refresh runs on
  every pass, so the link self-heals.
- A failed Mini run rolls back only its uncommitted generated data, leaves the
  last known-good database deployed, alerts, and retries.

## Verification and recovery

```bash
node scripts/events/verify-refresh-output.mjs --max-age-hours 30 --snapshot-max-age-hours 30
node scripts/events/refresh-watchdog.mjs --check-only
node scripts/events/scheduled-refresh.mjs --force
launchctl print gui/$(id -u)/org.southbaytoday.events-refresh
launchctl print gui/$(id -u)/org.southbaytoday.events-refresh-watchdog
tail -n 200 ~/Library/Logs/sbt-events-refresh.log
tail -n 200 ~/Library/Logs/sbt-events-refresh-watchdog.log
```

When adding a source, register it in the main `sources` array and return actual
event dates. Do not add a degraded catch-and-empty path for strict mode; date
buckets and the health verifier depend on the adapter exposing failures and
future occurrences honestly.
