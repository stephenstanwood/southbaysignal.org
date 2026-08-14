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

Install or repair both Mini agents with:

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
