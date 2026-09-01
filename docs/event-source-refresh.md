# Event source refresh reliability

The event database is refreshed by a guarded Mini job and independently checked
by GitHub Actions. Source adapters must fail closed: an unknown fetch or parser
failure must never be represented as a successful empty season.

## Production path

1. `org.southbaytoday.events-refresh` runs on the Mini at 7:15 PM PT, with an
   8:45 PM retry. A success under three hours old coalesces the retry; older
   daytime recoveries never suppress the whole nightly cycle.
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
- Hicklebee's is the opposite of the SJMA/SJDA cases and must not be "fixed"
  the way they were. It answered 403 from 2026-08-07 to 2026-08-29 **because**
  the adapter sent a spoofed Safari User-Agent: hicklebees.com uses Cloudflare
  bot management, which compares the claimed UA against the client's TLS/HTTP2
  fingerprint, so a Node client claiming to be Safari is a contradiction and
  gets the "Just a moment..." interstitial. Node's default headers are served
  200, and robots.txt (stock Drupal) allows `/events` with no bot rules, so
  nothing here is a host refusing automated access. Do not add a browser
  User-Agent, Accept, or Sec-Fetch headers to that adapter — adding them is what
  breaks it, and `scripts/lib/hicklebees-events.test.mjs` fails the suite if a
  User-Agent reappears in its fetch calls. Note also that `/events` renders the
  current month only, so the adapter walks `/events/YYYY/MM` forward; the page
  footer's "Upcoming Event" widget uses `event-block__*` classes and is not the
  event list, which uses `event-list__*`.
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
- An "empty" source is not automatically an honest off-season. Three of the ten
  reporting `status: "empty"` on 2026-09-01 turned out to be adapters looking in
  the wrong place, and a hand-curated list nobody had a reason to revisit is the
  same failure as a broken selector — it just fails quietly and on a delay:
  - **Heritage Theatre (Campbell)** read Ticketmaster's Discovery feed for venue
    `KovZpZAAnItA`. That id is right — it is the only "Heritage Theatre"
    Ticketmaster lists in California — but the feed returns `totalElements: 0`
    with no date filter at all, and had for long enough that a whole Campbell
    season was invisible: eight shows inside the same 180-day window, Neil
    Diamond Superstar three days out. The adapter now reads the theatre's own
    Wix calendar, which is a primary source and an easier one: `robots.txt`
    allows everything but `*?lightbox=` and advertises
    `event-pages-sitemap.xml`, and every event page carries schema.org Event
    JSON-LD with a Pacific offset on `startDate`. Two shapes to know: a
    sitemap `…/form` entry is the registration form for an event page Wix
    sometimes omits (the live Oct 3 2026 AIM for Seva concert is only reachable
    that way, while the sitemap's bare slug for it points at a cancelled
    duplicate), and `eventStatus` marks scrapped shows *and* retired drafts
    `EventCancelled`, so it is the filter that keeps "Testing Event" out. This
    is not the SJMA/SJDA situation — nothing here is a host refusing automated
    access.
  - **San Jose Giants** asked StatsAPI for `gameType=R`, so the postseason was
    never in scope. On 2026-09-01 the Giants had clinched the California League
    North first half (standings API, `standingsTypes=firstHalf`, 37–29,
    `clinched: true`) and held two home Division Series dates at Excite
    Ballpark, while every remaining regular-season game was in Fresno — the
    source reported "empty" for all of September. The query now spans
    `R,F,D,L,W` and runs to Oct 5. Postseason rows carry the placeholder
    franchise "To Be Determined" (team id 41) on the undecided side, which
    matches no California League market and so hits the same guard that keeps
    Copa de la Diversión promo identities out; and a slot the league has not
    timed yet carries a filler stamp flagged by `status.startTimeTBD` (the
    Sep 8 game reads 3:33 a.m. PT) that must not be published as a clock time.
  - **Santa Clara County Fire Department** was a hardcoded array carrying the
    note "Update annually or when the organizer posts new events," and nobody
    did — every date in it ran Apr–Aug 2026. Eventbrite's
    `/v3/events/search/` API really is gone, which is why the list existed, but
    the organizer page needs no API: it embeds `upcomingEvents` as JSON in
    `__NEXT_DATA__` with dates, times, timezone, venue address, online flag,
    cancellation flag, and minimum ticket price, and `robots.txt` allows `/o/`
    for `User-agent: *`. Two shapes to know: "ON DEMAND" listings are evergreen
    recordings dated whenever they went up (one reads 2025-05-07) and are not
    calendar events, and the organizer packs metadata into its own titles
    ("… | $15 | Campbell | 1.5 hrs - 2026") where the price contradicts the
    card — $15 is the class fee, checkout starts at $17.85 with the Eventbrite
    fee. Monte Sereno has no `City` slug; the canonical `SLUG_TO_CITY_TOKENS`
    map already folds it into Los Gatos, and the venue and street stay as
    published.
- A failed Mini run rolls back only its uncommitted generated data, leaves the
  last known-good database deployed, alerts, and retries.
- Host saturation is reported as host saturation, not as a source outage. A
  pinned Mini makes every `page.goto` burn its full timeout and return zero
  rows, which trips the coverage gate with counts that look like a mass
  adapter failure. The gate still fails closed; its message now carries the
  host's load-per-core and the share of source errors that were timeouts, so
  a saturated machine names itself. On 2026-08-29 the refresh reported
  "22→17 sources, 615→575 events" while load average sat at 84 on 10 cores and
  every "down" venue answered curl with a 200 in under half a second — 23
  leaked Discord plugin `bun` processes (orphaned to PID 1 by exited Claude
  sessions) held ~9 of the 10 cores. Reaping them restored the run to 613
  events from 22 sources in 2 minutes. Check `uptime` on the Mini before
  investigating any adapter that reports a navigation timeout.
- A dirty scheduled checkout names the job that dirtied it. The preflight
  refuses to publish from a tree with tracked changes and that guard is
  deliberate — do not weaken it. What the alert adds is attribution: when this
  run stole a stale lock from a crashed prior holder, the block message says
  whose abandoned output the modified files most likely are. The 2026-08-17
  alert listed 20 modified data files with no hint that
  `southbaysignal-data-refresh` had crashed 124 minutes earlier holding the
  lock; that crash also left `upcoming-events.json` without its
  `inputSnapshots` array, which is what turned the heartbeat red alongside it.

## Verification and recovery

```bash
uptime  # load-per-core first: a saturated Mini fakes a mass source outage
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
