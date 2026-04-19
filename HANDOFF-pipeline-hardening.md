# Handoff: Social Pipeline Hardening

**Written:** 2026-04-19, end-of-day
**For:** the next Claude session digging into `southbaytoday.org`'s social post generation pipeline
**Goal:** make this system robust enough that Stephen spends ~10 minutes reviewing, not ~8 hours fighting.

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

### Tier 1: source-data hygiene (high ROI, low risk)

These prevent bad data from ever reaching a plan.

#### 1.1 Scan all of `places.json` for cross-state contamination
Today we caught 18 NY/UT places in `city: saratoga`. Check every other city slug the same way.

- Script: for each `city` value, flag any place whose address doesn't contain that city's real name or the correct CA ZIP range. Cross-reference address city name vs slug.
- Also flag addresses with **any US state code that isn't CA** or any non-US country.
- Output a report; don't delete without review. Commit a `places-suspected-contamination.json` diff for Stephen to approve.
- Bonus: add a `scripts/validate-places.mjs` that runs on every `generate-places` regen and fails the commit if contamination is detected.

**Check:** After the scan, `grep -E "\b(NY|UT|NV|OR|WA|AZ)\s+\d{5}" src/data/south-bay/places.json` returns zero results. A CI job or a git pre-commit hook catches it if regressions sneak in.

#### 1.2 Address-verify events the same way
Events in `upcoming-events.json` and `inbound-events.json` can have similar issues. Same pass:
- Flag events whose `city` slug doesn't match the address/venue.
- Flag events tagged as "Education" but with meeting/commission title patterns.
- Flag virtual events not marked as virtual.

**Check:** `grep -iE "zoom|virtual|online|dial-?in" src/data/south-bay/upcoming-events.json` cross-referenced with the `virtual` field returns no false negatives.

#### 1.3 Fix title casing at scraper source
The "Aids:" capitalization came from the SJSU Events scraper. Investigate:
- Where is that scraper? (Likely in `scripts/generate-events.mjs` — search for `sjsu`.)
- Add a title-casing normalizer that handles acronyms: AIDS, HIV, COVID, DMV, CPR, etc. should be fully capitalized regardless of source casing.
- Also normalize "& " vs " and " so padding dedup actually works (today's Hakone duplicate happened because dedup couldn't match "Hakone Estate & Gardens" against "Hakone Estate and Gardens").

**Check:** Run scraper in a test mode; titles like "aids", "AIDS:", "Aids:" all normalize to "AIDS:".

---

### Tier 2: plan-day.ts generation quality

These improve what Claude produces in the first place.

#### 2.1 Context-aware padding when Claude returns <6 stops
Today we padded thin plans with generic top-rated places + generic blurbs ("Saratoga pick worth the stop"). That's passable but flat.

Better approach:
- When `sequenceWithClaude` returns <6 cards, call Claude AGAIN with the partial plan + a padding-only prompt: "Add N more stops that fit this day's geographic cluster and fill the gaps in timeline. Return only the new cards."
- Preserve the existing cards; model only generates the pads.

**Check:** Force a thin initial response (e.g. by constraining candidate pool), verify the padding call returns cards with proper blurbs + why fields + real venue descriptions.

#### 2.2 Surface week-level context in the plan-day prompt
Today `plan-day` only knew about `blockedNames`. That stops Ichika from appearing twice, but doesn't stop "5 spas in 14 days."

Add to the prompt:
- "This week's other plans are anchored in: [city list]. Pick stops that complement, not duplicate."
- "Already used in this batch: [venue names]."
- Category saturation hint: "This batch already has N spa stops. Pick non-spa if possible."

This is mostly just extending the context the caller (`generate-schedule.mjs`) passes in. `blockedNames` is the existing hook.

**Check:** Generate a fresh 10-day batch and verify no venue/POI appears more than once, no category appears more than 2× (spa 1×, food-type-x not saturated, etc.).

#### 2.3 Write tests for `post-gen-review.mjs`
Today's review module is the heart of the safety net. It needs tests.

- Create `scripts/social/lib/post-gen-review.test.mjs` (or equivalent).
- Feed fixture plans covering each failure mode: virtual, out-of-area, DOW mismatch, thin plan, city sprawl, spa saturation, venue repeat, commission meeting, bare URL, etc.
- Assert the right `autoFixed` or `flagged` entries come out.
- Run tests in CI.

**Check:** `npm test` (or whatever the runner is — there may not be one yet; set it up if not) produces green output.

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

#### 4.2 Pre-commit quality gate
Today's bad batch got pushed and reviewed. A pre-commit gate could've caught hard-blocks.

- Git hook or `pre-push` that runs `runQualityReview` on `social-schedule.json`.
- If any hard-block flag fires, abort the commit.
- Soft flags (thin plan, weak tonight) warn but allow.

**Check:** `git commit` a bad schedule (virtual event, out-of-area tonight-pick) and verify the hook blocks it.

#### 4.3 Consolidate config
Today the TITLE_BLOCKLIST, weak-tonight patterns, spa patterns, and city lists are in 3+ files. Changes require touching all of them.

- Create `scripts/social/lib/content-rules.mjs` as the single source of truth for:
  - Bad title patterns
  - Weak tonight patterns  
  - Category keywords
  - In-area / out-of-area city lists
  - Virtual signals
  - DOW aliases
- All three of `post-gen-review.mjs`, `plan-day.ts`, and `generate-events.mjs` import from here.

**Check:** Adding a new bad pattern requires changing one file.

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

By the end of your session, next Saturday's 3:30 AM batch should produce a schedule where Stephen's review is ~10 minutes, not ~8 hours. Specifically:

- [ ] Zero cross-state contaminated places in padding picks
- [ ] Zero commission/gov meetings in day-plans
- [ ] Zero virtual events in tonight-picks
- [ ] Zero venue repeats across consecutive days in the batch
- [ ] Every day-plan has 6+ stops with breakfast before 10 AM and an evening activity after 6 PM
- [ ] Zero bare `https://southbaytoday.org` URLs in copy (all are full `/plan/XXX`)
- [ ] Zero DOW mismatches in blurbs ("Sunday afternoon" on a Monday plan)
- [ ] Review portal shows issues visually so Stephen doesn't have to read every copy variant
- [ ] `/plan/XXX` URLs return 200 for every generated plan

Each unchecked box is a concrete thing to work on.

---

## 🗂️ Key files reference

| File | Role |
|------|------|
| `scripts/social/generate-schedule.mjs` | Orchestrates batch generation across N days |
| `scripts/social/lib/post-gen-review.mjs` | Quality review that runs after each batch |
| `scripts/social/lib/copy-gen.mjs` | Claude calls for social copy (6 platforms) |
| `scripts/social/copy-review-server.mjs` | The review portal on port 3456 |
| `src/pages/api/plan-day.ts` | Day-plan generation engine (Claude Sonnet sequencing) |
| `src/pages/plan/[id].ts` | Public shareable plan page — reads shared-plans.json |
| `src/data/south-bay/social-schedule.json` | The authoritative batch state |
| `src/data/south-bay/shared-plans.json` | Plans referenced by `/plan/XXX` URLs |
| `src/data/south-bay/places.json` | Curated POI list (2500+ entries) |
| `src/data/south-bay/upcoming-events.json` | Scraped events |
| `scripts/generate-events.mjs` | Main event scraper/aggregator |

---

## 📬 End-of-session expectation

When you're done, leave Stephen with:
1. A clear list of what you changed (git log is fine).
2. A clear list of what you tested.
3. Any remaining Tier 1–2 items you didn't get to, so he knows what's next.
4. **No touched approved data.** If you had to edit `social-schedule.json` for testing, roll it back or test against a separate date range.

Good luck.
