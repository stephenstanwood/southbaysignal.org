# Handoff: Social Pipeline Hardening

**Written:** 2026-04-19, end-of-day
**Updated:** 2026-04-19 (third pass — tier 3.1, 3.3, 4.1 now shipped)
**For:** the next Claude session digging into `southbaytoday.org`'s social post generation pipeline
**Goal:** make this system robust enough that Stephen spends ~10 minutes reviewing, not ~8 hours fighting.

---

## 📌 Update — 2026-04-19, third session

**Shipped this session:**
- **Tier 3.1** — Review portal surfaces `runQualityReview` output inline. `GET /api/schedule` runs the review on a deep-cloned schedule (so auto-fix mutations don't leak to disk) and attaches `_review: {autoFixed, flagged}` to the response. The calendar renders red/amber/green banners next to each affected slot, plus a colored dot in the slot-type header so hard-blocks are visible even on collapsed approved slots.
- **Tier 3.3** — Race guard on `saveScheduleFile()`. Server tracks the `mtimeMs` it last observed; before every write it re-stats the file, and if the disk mtime is newer (external script, surgery, cron), it merges missing days/slots from disk into the in-memory copy before writing. Eliminates the "review-server clobbers surgery script" class of bug.
- **Tier 4.1** — `canonicalizeCard()` helper at `src/lib/south-bay/canonicalizeCard.mjs`. Every writer to `shared-plans.json` now goes through it: `share-plan.ts`, `copy-review-server.mjs` regen-plan, `generate-posts.mjs`, `generate-schedule.mjs`, `surgery-round2.mjs`, `surgery-2026-04-19.mjs`, `backfill-plan-photos.mjs`. The `/plan/[id]` renderer also runs `canonicalizePlanCards()` at read time as belt-and-suspenders and hardened `esc()` to accept `unknown`. No more 500s on thin cards.

**Still outstanding:** Tier 2.1 (context-aware padding), Tier 3.2 (quick-swap button), Tier 3.4 (decision rationale + debug route), Tier 4.4 (structured decision logs).

**Open policy question (unchanged):** 25 Kepler's Books events at 1010 El Camino Real Menlo Park tagged `palo-alto`.
**Policy also outstanding (unchanged):** 12 `santa-cruz` + `santa-clara-county` slug events in `upcoming-events.json`.

---

## 📌 Update — 2026-04-19, second session (commit `e1c2951`)

**Shipped this session:**
- **Tier 1.1** — `scripts/audit-places.mjs` + `scripts/validate-places.mjs` wired into `generate-places` regen. One BC Canada entry purged. 22 remaining "info" flags are legitimate curated landmarks.
- **Tier 1.2** — `scripts/audit-events.mjs`. Virtual-flag auto-detection + acronym normalization added to BOTH `generate-events.mjs` (tail pass) and `pull-inbound-events.mjs` (intake) so every ingestion path normalizes.
- **Tier 1.3** — `src/lib/south-bay/normalizeName.ts` + `scripts/social/lib/normalizeName.mjs`. "Hakone Estate & Gardens" now dedups against "Hakone Estate and Gardens" in plan-day blocked-names, generate-schedule usedDayPlanNames, and post-gen-review venue-repeat detection. AIDS/HIV/COVID/DMV/CPR/DIY/LGBTQ/NASA/TED/STEM title-casing fixes applied in generate-events.
- **Tier 2.2** — `weekContext { anchorCities, categorySaturation }` flows from `generate-schedule.mjs` into the plan-day Claude prompt so batches diversify across the week.
- **Tier 2.3** — `scripts/social/lib/post-gen-review.test.mjs`, 19 tests covering every failure class. Surfaced + fixed 2 real source bugs:
  - DOW regex didn't match "Sunday afternoon" (no whitespace allowance). Now does.
  - `outOfArea()` was scanning slot summary → false-positive on the 4/24 Kepler's event ("San Francisco Chronicle" referenced a speaker's former employer). Now scans venue/title/name/address/city only.
- **Tier 4.2** — `scripts/validate-schedule.mjs` + `npm run check` runs `validate-places && validate-schedule && test`.
- **Tier 4.3** — `scripts/social/lib/content-rules.mjs` is the single source of truth for `SLUG_TO_CITY_TOKENS`, `IN/OUT_OF_AREA_CITIES`, `NON_CA_STATES`, virtual signals, meeting patterns, acronym fixes. Six files import from it.
- **Plan-day side quest** — threaded `targetDate` through `sequenceWithClaude` signature (pre-existing TS error surfaced by the test suite).

**Still outstanding:** Tier 3.1, 3.2, 3.3, 3.4, Tier 4.1, Tier 4.4 — details below in the original list.

**Open policy question (not blocking):** 25 Kepler's Books events at 1010 El Camino Real, Menlo Park are tagged `palo-alto`. The audit flags them as out-of-area. They're premium cultural content and losing them hurts. Options: (a) keep as-is, accept the audit flag, (b) re-slug to a new "near-area cultural" bucket, (c) drop entirely. Stephen hasn't decided.

**Policy also outstanding:** 12 `santa-cruz` + `santa-clara-county` slug events in `upcoming-events.json`. Currently harmless (plan-day filters by CITY_MAP nearness + `CITY_NAMES` rotation doesn't include Santa Cruz, so they can't enter plans), but clutter the audit. Decide whether to drop the hardcoded Santa Cruz entries from `generate-events.mjs:2004+`.

**New npm scripts:** `audit-places`, `validate-places`, `audit-events`, `validate-schedule`, `test`, `check`.

---

## 🛑 Do NOT touch

- Anything in `src/data/south-bay/social-schedule.json` for dates **2026-04-17 → 2026-04-28**. All 24 slots across 12 days are approved/published. Touching them will undo Stephen's manual approval work.
- `src/data/south-bay/shared-plans.json` entries for those dates' plan IDs. The live `/plan/` pages depend on them.
- Do not run `generate-schedule.mjs` during your session. The next scheduled run is **Saturday 2026-04-25 at 3:30 AM PT** (launchd on the Mini — `org.southbaysignal.generate-schedule`).

**If you need to test the pipeline end-to-end, use a separate date range** (e.g. `--days 3 --startDate 2026-05-10`) or a dry-run flag so you don't clobber live data.

---

## 🧭 Context: what happened on 2026-04-19

Stephen sat down to review a batch and it was bad in a hundred small ways. Over ~8 hours we patched it through live. A rough taxonomy of what went wrong:

### Bad data leaking into plans
- Commission/gov meetings in day-plans (Milpitas Science Tech Commission)
- Non-CA places tagged as local: "Saratoga Springs" had **18 contaminated entries** (NY and UT) — Sweet Mimi's, Dairy Haus, Mrs. London's, FatCats, etc.
- Virtual events pitched as in-person (tUrn climate talks)
- Out-of-area events (Santa Cruz Shakespeare, etc.)
- Events scheduled on the wrong day (Penny Lane tribute)
- Kids-only activities (Junior Musical, Knit Circle, Story Time)
- Niche meetups (Bridge SIG, Book Clubs, Band Jam)
- Boring gov workshops (Property Assessment)
- Broken venue strings ("457" — truncated Legistar summary)
- Internal commemoration events

### Plan quality issues
- Thin plans (3–4 stops when 6+ required)
- City sprawl across 4+ cities
- Same venue across consecutive days (Rosicrucian Egyptian Museum Mon+Tue, SJSU Music Building Mon+Tue)
- Same POI repeated across the week (Ichika in two Milpitas plans)
- Spa/massage saturation (**5 in 14 days**, some weeks 3+)
- Food-food adjacency (lunch → "eat crab")
- Missing breakfast / started after 11 AM
- Missing dinner / ended at 5 PM
- Generic padding blurbs ("Top-rated food spot in Santa Clara")
- Anchor city label mismatch (plan labeled "Milpitas" but all cards in Santa Clara)
- Day-of-week bug: Claude writing "a great Sunday afternoon" on a Monday plan (because the prompt used generation-time's DOW, not plan-date's)

### Copy quality issues
- Bare URLs: `https://southbaytoday.org` instead of `/plan/XXX` (64 of them)
- "Aids:" capitalization (should be AIDS)
- "Pandemic history" read as COVID instead of HIV/AIDS epidemic
- DOW mismatches in social copy text
- Same event pitched as tonight-pick AND featured stop in day-plan
- Venue typos (Xfyd instead of XFYD, Milipitas instead of Milpitas)

### Operational/workflow issues
- **Review server race condition**: server keeps `social-schedule.json` in memory, writes full file on approve — a parallel surgery script got clobbered twice today
- Shared-plans card shapes inconsistent → `/plan/XXX` 500s on live site
- Shared-plans out of sync with schedule after surgery (live plan showed removed events)
- Copy text wasn't editable in the portal (fixed mid-session)
- No in-portal flag surface — Stephen had to manually read each plan top-to-bottom to find issues

---

## ✅ What was fixed today (committed, running)

Don't redo these — they're already in place. Verify the code/behavior before assuming a bug is present.

### `scripts/social/lib/post-gen-review.mjs`
- **Card-level pruning**: removes individual bad cards from a plan instead of nuking the whole plan. Patterns: spas, book clubs, SIGs, knit/crochet circles, Junior Musical, Commemorations, practices/rehearsals, story times, regular/commission/committee meetings, study sessions.
- **Spa frequency cap**: max 1 spa/massage per 7-day rolling window.
- **Hard-block checks** that fire regardless of status: day-of-week mismatch, out-of-area, virtual/online, city sprawl (≥5 cities), weak tonight (property assessment, town council, wildfire workshop, etc.), venue repeat on adjacent day, venue saturation ≥3× in 7 days.
- **Auto terminology fixes**: Aids→AIDS, "AIDS pandemic"→"AIDS epidemic", "pandemic history"→"epidemic history".
- **Chronological card sort**.
- **Thin-plan flag** at <6 cards.

### `scripts/social/generate-schedule.mjs`
- Default days: **10** (was 14)
- Runs post-review pass after generation, with a second regen pass for missing-only slots
- `seedUsedFromSchedule()` seeds dedup sets from already-approved content so drafts don't overlap
- Wildcard slot gated to SV-history anniversaries only (no general wildcards)

### `src/pages/api/plan-day.ts`
- `NEARBY_KM = 20` (was 8) — fixes thin anchor-city pools
- `MAX_CARDS = 7`, `CANDIDATE_POOL_SIZE = 35`, `max_tokens: 2500`
- Accepts `blockedNames` and filters them from the candidate pool
- Prompt: FULL-DAY SHAPE (6-7 stops, meals required, ≤10AM start, evening activity)
- Prompt: GEOGRAPHIC CLUSTERING (anchor + neighbors, 15-min cluster, no zigzag)
- Prompt date uses **planDate** not generation time (fixes "Sunday afternoon on Monday" bug)
- Day-of-week matching for ongoing past-dated events (fixes Campbell Farmers Market showing on Wed)

### `scripts/generate-events.mjs`
- `TITLE_BLOCKLIST` extended with: commission meetings, regular meetings, special meetings, subcommittee, study session patterns

### `scripts/social/copy-review-server.mjs`
- Editable `<textarea>` per platform with auto-sizing + Save button
- Mastodon column
- Hide empty wildcard slots
- 10-day calendar loop
- "Day Plan ↗" pill in each day's header linking to the plan URL

### `src/data/south-bay/places.json`
- 18 non-CA "Saratoga Springs" entries purged (NY + UT)

### Cron / launchd
- `org.southbaysignal.generate-schedule` now runs **Saturday 3:30 AM weekly** (was daily 2:15 AM)
- `--days 10`

### Memory files (`/Users/stephenstanwood/.claude/projects/-Users-stephenstanwood-Projects-southbaytoday-org/memory/`)
- `feedback_ten_day_horizon.md`
- `feedback_review_server_race.md`
- Plus many others from prior sessions (see `MEMORY.md`)

---

## 🎯 What to tackle (prioritized)

Work your way down. Each item has a concrete acceptance check.

### ✅ Completed (see 2026-04-19 second-session update above)

- Tier 1.1 — places contamination scan + validator gate
- Tier 1.2 — events audit + virtual-flag normalization at source (both generate-events and pull-inbound-events)
- Tier 1.3 — acronym title-casing fixes + "&"↔"and" name canonicalization (shared `normalizeName` util)
- Tier 2.2 — week-level context (anchorCities + categorySaturation) in the plan-day prompt
- Tier 2.3 — 19 fixture tests for `post-gen-review.mjs`, surfaced/fixed DOW-regex + summary-scan source bugs
- Tier 4.2 — `validate-schedule.mjs` + `npm run check` one-command gate
- Tier 4.3 — `scripts/social/lib/content-rules.mjs` single source of truth

### Tier 2 remainder

#### 2.1 Context-aware padding when Claude returns <6 stops
Today we padded thin plans with generic top-rated places + generic blurbs ("Saratoga pick worth the stop"). That's passable but flat.

Better approach:
- When `sequenceWithClaude` returns <6 cards, call Claude AGAIN with the partial plan + a padding-only prompt: "Add N more stops that fit this day's geographic cluster and fill the gaps in timeline. Return only the new cards."
- Preserve the existing cards; model only generates the pads.

**Check:** Force a thin initial response (e.g. by constraining candidate pool), verify the padding call returns cards with proper blurbs + why fields + real venue descriptions.

---

### Tier 3: review portal improvements

These reduce Stephen's cognitive load during review.

#### 3.1 Surface review-module issues in the portal UI
Currently the portal shows status + copy. It doesn't show WHY a plan might be bad.

Add:
- Run `runQualityReview` on the current schedule when the portal loads.
- For each day/slot, display any flags as a red banner ("⚠ City sprawl: 5 cities" / "⚠ Spa in 3 of last 7 days" / "⚠ 'Sunday afternoon' ref on a Monday").
- Auto-fixes show as a green note ("✓ Scrubbed stale DOW reference").

**Check:** Open the portal after a fresh batch, issues are visible without reading copy top-to-bottom.

#### 3.2 Quick-swap button on problematic cards
When Stephen sees a bad stop (FatCats Utah, Thompson Gallery repeat), he has to ping me to fix it.

Add:
- Per-card "Swap" button in the expanded day-plan view.
- Click → opens a picker with 5–10 alternative stops for that time block, filtered by anchor city + time-of-day + category.
- Select one → API route updates the card, re-syncs shared-plans, regenerates copy (single Claude call).

**Check:** Stephen can swap a card without needing a Claude session.

#### 3.3 Guard the review server against race conditions
The review server writes `social-schedule.json` on every approve. A parallel script writing the same file gets clobbered.

Options (pick one):
- (a) File lock: server acquires a lock before writing. Scripts do the same. Simplest, may not fully solve race.
- (b) All mutations go through a server API: scripts call `POST /api/schedule/:date/:slot/update` instead of editing the JSON directly. Cleaner.
- (c) Scripts must stop the review-server first (documented in `feedback_review_server_race.md`).

**Check:** Run a script that edits `social-schedule.json` at the same time as clicking "Approve" in the portal. The script's changes survive.

#### 3.4 Add a "replay" button
Stephen wants to understand why a particular stop is in a plan. Logging every decision gives him that.

- Every card added to a plan should have a `rationale` field: "candidate pool: top rated in Saratoga with food type" or "picked by Claude, ID from pool".
- A `/plan/XXX/debug` route (or expanded view in the portal) shows each card's rationale.

**Check:** Stephen can answer "why is California's Great America in the Monday plan?" without pinging me.

---

### Tier 4: infrastructure & observability

Lower priority but high leverage.

#### 4.1 Canonicalize shared-plan card shape at write-time
Today's `/plan/` 500s were caused by thin cards missing fields the renderer expects. A normalizer was written (`/tmp/sync-all-shared.mjs`) — fold it into the write path.

- Every place that writes to `shared-plans.json` should call a `canonicalizeCard(card)` helper.
- The helper fills in defaults for all renderer-expected fields: id, name, category, city, address, timeBlock, blurb, why, url, mapsUrl, cost, costNote, photoRef, venue, source.
- Make `src/pages/plan/[id].ts` defensive too — it should never 500 on a card missing a field.

**Check:** Deliberately write a thin card to shared-plans, hit the `/plan/` URL, verify it renders (with some fields empty) instead of 500ing.

#### 4.4 Observability: log every decision
Today's debugging was painful because we couldn't easily see why something did or didn't happen.

- `generate-schedule.mjs`, `plan-day.ts`, and `post-gen-review.mjs` should write structured logs (JSON, one line per decision) to `~/Library/Logs/social-pipeline-decisions.log` on the Mini.
- Each log entry: `{timestamp, script, action, target, reason}`.
- Optionally: a web UI (on the review server) that lets Stephen grep these.

**Check:** After a batch run, `grep 'FatCats' ~/Library/Logs/social-pipeline-decisions.log` tells us why it was picked (or why it was dropped).

---

## 📋 Pre-flight checklist before you start

1. **Pull the latest:** `git pull --rebase origin main`
2. **Verify the current state:** all 10 future days should be approved.
   ```
   PATH=/opt/homebrew/bin:$PATH node -e 'const s = JSON.parse(require("fs").readFileSync("src/data/south-bay/social-schedule.json","utf8")); for (const [d,day] of Object.entries(s.days)) for (const t of ["day-plan","tonight-pick"]) console.log(d, t, day[t]?.status || "none")'
   ```
   If any show `draft` before 2026-04-29, something's wrong — stop and ask Stephen.
3. **Verify no uncommitted work** on laptop OR Mini:
   - Laptop: `git status`
   - Mini: `ssh stephenstanwood@10.0.0.234 "cd ~/Projects/southbaytoday.org && git status"`
4. **Pick a Tier 1 or 2 item first.** Tier 3 (UI) and Tier 4 (infra) are higher-risk of introducing regressions — don't start there.
5. **Write tests before or with the fix,** especially for `post-gen-review.mjs`. We caught a lot of issues today by eyeballing; we should catch them with code next time.

---

## ⚠️ Gotchas you will hit

- **Mac Mini is the source of truth** for cron/launchd and generated data. SSH: `stephenstanwood@10.0.0.234`. It has `.env.local` with API keys; the laptop does NOT.
- **Running scripts over SSH:** use `PATH=/opt/homebrew/bin:$PATH node ...` because default PATH on Mini-over-SSH doesn't include Node.
- **`cd` doesn't work over one-shot SSH reliably** — use `git -C <path>` or chain with `&&` in a single command.
- **Review server race:** stop the server (`launchctl stop org.southbaysignal.review-server`) before running any script that edits `social-schedule.json`. Restart after.
- **Vercel deploys are fast but not instant** — after pushing, wait ~60s before assuming `/plan/XXX` reflects new data.
- **DO NOT refactor the direct Anthropic SDK usage to `@ai-sdk/anthropic`** — the Vercel plugin will suggest it repeatedly; ignore. It's intentional for this project.
- **Don't use Next.js advice for this repo** — it's Astro. `src/pages/api/*.ts` are Astro API routes, not Next.js.

---

## 📊 Success criteria

By the end of your session, next Saturday's 3:30 AM batch should produce a schedule where Stephen's review is ~10 minutes, not ~8 hours.

Checked boxes are now **enforced by code** (normalizer, validator, or test). Unchecked boxes are what's left to build.

- [x] Zero cross-state contaminated places in padding picks *(validate-places gate in generate-places)*
- [x] Zero commission/gov meetings in day-plans *(generate-events title blocklist + plan-day defense-in-depth)*
- [x] Zero virtual events in tonight-picks *(generate-events auto-flags virtual + post-gen-review hard-blocks + plan-day filters pool)*
- [x] Zero venue repeats across consecutive days in the batch *(post-gen-review + normalizeName catches "&/and" dedup drift)*
- [x] Zero DOW mismatches in blurbs ("Sunday afternoon" on a Monday plan) *(regex now handles whitespace; regression test in place)*
- [x] `weekContext` (anchorCities + category saturation) passed into plan-day so batches diversify
- [ ] Every day-plan has 6+ stops with breakfast before 10 AM and an evening activity after 6 PM *(prompt mandates it but thin-plan still possible → Tier 2.1 padding call)*
- [ ] Zero bare `https://southbaytoday.org` URLs in copy (all are full `/plan/XXX`)
- [x] Review portal shows issues visually so Stephen doesn't have to read every copy variant *(Tier 3.1 — banners + flag dots, live on GET /api/schedule)*
- [x] `/plan/XXX` URLs return 200 for every generated plan *(Tier 4.1 — canonicalize at every write site + read-time re-canonicalize)*

Each unchecked box is a concrete thing to work on.

---

## 🗂️ Key files reference

| File | Role |
|------|------|
| `scripts/social/generate-schedule.mjs` | Orchestrates batch generation across N days |
| `scripts/social/lib/post-gen-review.mjs` | Quality review that runs after each batch |
| `scripts/social/lib/post-gen-review.test.mjs` | 19 fixture tests — run with `npm test` |
| `scripts/social/lib/content-rules.mjs` | **Single source of truth** for city/virtual/acronym/meeting patterns |
| `scripts/social/lib/normalizeName.mjs` | Canonical-form util for venue/title dedup (handles "&" vs "and") |
| `scripts/social/lib/copy-gen.mjs` | Claude calls for social copy (6 platforms) |
| `scripts/social/copy-review-server.mjs` | The review portal on port 3456 |
| `src/pages/api/plan-day.ts` | Day-plan generation engine (Claude Sonnet sequencing) |
| `src/pages/plan/[id].ts` | Public shareable plan page — reads shared-plans.json |
| `src/lib/south-bay/normalizeName.ts` | TS mirror of the normalizer (keep in sync with .mjs) |
| `src/data/south-bay/social-schedule.json` | The authoritative batch state |
| `src/data/south-bay/shared-plans.json` | Plans referenced by `/plan/XXX` URLs |
| `src/data/south-bay/places.json` | Curated POI list (2500+ entries) |
| `src/data/south-bay/upcoming-events.json` | Scraped events |
| `scripts/generate-events.mjs` | Main event scraper/aggregator (tail-pass normalizers live here) |
| `scripts/pull-inbound-events.mjs` | Mirrors inbound-events Blob → local JSON (normalizes on intake) |
| `scripts/audit-places.mjs` / `scripts/validate-places.mjs` | `npm run audit-places` + CI gate |
| `scripts/audit-events.mjs` | `npm run audit-events` — report, not gate |
| `scripts/validate-schedule.mjs` | `npm run validate-schedule` — fails on any hard-block |

---

## 📬 End-of-session expectation

When you're done, leave Stephen with:
1. A clear list of what you changed (git log is fine).
2. A clear list of what you tested.
3. Any remaining Tier 1–2 items you didn't get to, so he knows what's next.
4. **No touched approved data.** If you had to edit `social-schedule.json` for testing, roll it back or test against a separate date range.

Good luck.
