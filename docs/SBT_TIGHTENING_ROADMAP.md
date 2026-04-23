# SBT Tightening Roadmap

Generated 2026-04-22. Sequences the 10-item improvement list into
executable chunks with natural session boundaries. Each session is
self-contained — paste the "Session prompt" block at the start of a
fresh Claude Code session and it'll know exactly what to do.

## Context for every session

- Repo: `/Users/stephenstanwood/Projects/southbaytoday.org`
- Astro 6 + Vercel + React + Tailwind v4; Anthropic SDK direct (not AI SDK)
- Mini (10.0.0.234 / 100.117.24.89) is source of truth for cron/regens
- Memory at `~/.claude/projects/-Users-stephenstanwood-Projects-southbaytoday-org/memory/`
- Read `MEMORY.md` first in every new session
- Stephen prefers: push PRs with `--admin` squash, no cost flag under 100 images, fix upstream root causes, Astro (not Next.js)

## Session plan

### ✅ Session 1 — Item #1: Canonical event blurbs at ingest time [2026-04-22]

Shipped. `src/lib/south-bay/eventBlurbs.mjs` resolver + persistent cache at `src/data/south-bay/event-blurb-cache.json`, wired into `generate-events.mjs` after images and into every DayCard write site in `plan-day.ts` (sequencer, locked force-insert, back-to-back replacement, padder). Backfilled 706/706 events from the Mini — ≈$0.05, 4.5 min. Memory: `reference_event_blurb_pipeline.md`. **Pending:** add `RESOLVE_EVENT_BLURBS=1` to Mini's `.env.local` so nightly regens pick up new events.

**Scope:** One Haiku batch call per event ingest generates a 1-sentence "what is this" description. Plan-day.ts stops asking Claude to improvise blurbs per shuffle.

**Why this first:** Biggest single quality lever. Kills the "swing by X and see what's going on" root cause (we only templated the fallback — better to never need one). Plus eliminates the variance where the same event gets different blurbs on every shuffle.

**Files:**
- New: `src/lib/south-bay/eventBlurbs.mjs` (resolver + cache)
- New: `src/data/south-bay/event-blurb-cache.json` (persistent cache, keyed by event URL or fingerprint)
- Edit: `scripts/generate-events.mjs` — call resolver before write, like `resolveEventImages` does
- Edit: `src/pages/api/plan-day.ts` — prefer `evt.blurb` in the prompt instead of re-generating; update the main planner prompt

**Design notes:**
- Batch: send ~30 events per Haiku call, get back 30 blurbs, parse. Typical regen has ~530 events = ~18 batch calls.
- Cost estimate: Haiku at ~300 input + 60 output tokens × 530 events ≈ $0.05/run. Under-100 threshold — no flag needed.
- Blurb length: 1–2 sentences, casual, no "real event" / "only today" / distance mentions (memory: `feedback_ai_speak_bans`).
- Tone: match the existing planner prompt's blurb rules.
- Cache keyed by event URL (stable across date variants of the same recurring event).

**Watch-outs:**
- Don't regenerate blurbs for events that already have a non-empty `description` worth using — that's real data. Only backfill empty/stub descriptions.
- The `description` field is what the planner currently falls back to. If we add a new `blurb` field, plan-day should prefer `evt.blurb > evt.description > fallbackBlurb()` pool.

**Session prompt to paste:**
```
Read /Users/stephenstanwood/Projects/southbaytoday.org/docs/SBT_TIGHTENING_ROADMAP.md (Session 1) and execute it.
Start by reading MEMORY.md, then the referenced files. Ship it end-to-end:
build the resolver, wire into generate-events.mjs, update plan-day.ts to
prefer blurbs, run a backfill on the Mini (RESOLVE_EVENT_BLURBS=1),
commit/push, update memory. Flag cost if it turns out >100-event batch.
```

---

### ⬛ Session 2 — Item #2: Kids/adult event purity filter

**Scope:** Kids events (age-specific) filtered out of adult plans; 18+ venues filtered out of kids plans.

**Why next:** Visible quality issue — Stephen already flagged "Kids Knitting" in an adult plan. Self-contained, no Mini regen required.

**Files:**
- Edit: `src/pages/api/plan-day.ts` (`buildCandidatePool` — add kids/adult filters)
- Maybe edit: `scripts/generate-events.mjs` (tag events with `audienceAge: "kids" | "adult" | "all"` at ingest so the filter has clean data)

**Design notes:**
- Signal words for kids-only: `/\b(kids|kids'|toddler|story time|preschool|ages? ?\d+\+?|ages? ?\d+\s*-\s*\d+)\b/i`
- 18+ signals: `/\b(21\+|wine|cocktail|speakeasy|bar|brewery|nightclub|lounge|drag show)\b/i` — BUT careful, brewpubs often serve food and are family OK. Prefer venue types over title keywords for adult exclusion.
- New candidate property `audienceAge` computed once; filter at pool-build.
- For kids mode: allow `audienceAge === "kids" || "all"`. For adults: allow `"adult" || "all"`; show `"kids"` only if it's clearly family-friendly (family events, community events).

**Session prompt to paste:**
```
Read /Users/stephenstanwood/Projects/southbaytoday.org/docs/SBT_TIGHTENING_ROADMAP.md (Session 2) and execute it.
Start with MEMORY.md. Ship with decision-log coverage so we can see
drop reasons, and commit/push.
```

---

### ⬛ Session 3 — Items #3 + #4 combined: Weather-aware scoring + duration fit check

**Scope:** Real weather teeth in scoring (rain → penalize outdoor, boost indoor) + hard overlap check (back-to-back cards can't time-collide).

**Why combined:** Both are ~30-line scoring tightens in plan-day.ts. Neither needs Mini work. Can ship together in one commit.

**Files:**
- Edit: `src/pages/api/plan-day.ts` — scoreCandidates (rain/cold penalties, indoor boosts), plus a post-sequence validator that drops cards with time overlaps.

**Design notes:**
- Rain probability ≥40%: outdoor -30, indoor (museum/entertainment/food/shopping) +10.
- Cold (high < 55°F): outdoor -15.
- Overlap validator: for i in cards, if `parseEndTime(cards[i].timeBlock) > parseStartTime(cards[i+1].timeBlock)`, drop the later card. Log to decision log.

**Session prompt to paste:**
```
Read /Users/stephenstanwood/Projects/southbaytoday.org/docs/SBT_TIGHTENING_ROADMAP.md (Session 3) and execute it.
Start with MEMORY.md. No Mini work needed. Commit/push.
```

---

### ⬛ Session 4 — Items #5 + #6: OG image quality gate + cross-source event dedup

**Scope:** Reject low-quality OG images (falls through to Recraft). Normalize+dedup events in generate-events.mjs by (title, date, venue).

**Why combined:** Both are ingest-pipeline tightens, both touch `generate-events.mjs` / `eventImages.mjs`, both benefit from one Mini regen.

**Files:**
- Edit: `src/lib/south-bay/eventImages.mjs` — add validate step between OG fetch and cache-store: head-request the image, check content-type + content-length, reject if <400px width (need to actually fetch + inspect, or use image-size library), reject filename pattern `/logo|icon|favicon/i`.
- Edit: `scripts/generate-events.mjs` — right after `collapsedEvents` is built, run a dedup pass keyed by `normalizeName(title) + date + normalizeName(venue)`. Keep the entry with richest data (longest description, non-null time, photoRef).

**Design notes:**
- For image dimensions, use node's built-in fetch + `image-size` package (lightweight, no browser). Add to deps.
- For dedup, the "richest entry" heuristic: prefer entries with `description.length > 0`, then `time !== null`, then `photoRef || image`.
- Backfill by running `node scripts/dry-run-event-images.mjs` on the Mini after pushing — will re-validate cached OG entries.

**Session prompt to paste:**
```
Read /Users/stephenstanwood/Projects/southbaytoday.org/docs/SBT_TIGHTENING_ROADMAP.md (Session 4) and execute it.
MEMORY.md first. Ship with a backfill on the Mini so current
upcoming-events.json is rewritten with deduped entries + validated
images. Commit/push from Mini.
```

---

### ⬛ Session 5 — Items #7 + #8: Shuffle variety ledger + default-plan freshness stamp

**Scope:** Prevent same anchor/event on consecutive shuffles. Force default-plan refresh when cached plan is stale.

**Why combined:** Both are homepage-UX tightens in SouthBayTodayView.tsx. Both ~20 lines. Natural pair.

**Files:**
- Edit: `src/components/south-bay/homepage/SouthBayTodayView.tsx`
  - Variety ledger: Stephen already has `lastAnchorRef` for anchor dedup. Extend: track last 3 anchors (not just 1), and last 10 event IDs. Pass as a `recentlyShown` payload to the API so the scorer can penalize them.
  - Edit: `src/pages/api/plan-day.ts` — accept `recentlyShown: string[]`, score -20 on matching event/place IDs.
  - Freshness stamp: `default-plans.json._meta.generatedAt` already exists. If `Date.now() - generatedAt > 26h`, don't use the cached plan — fire an inline API call and show loading state.

**Session prompt to paste:**
```
Read /Users/stephenstanwood/Projects/southbaytoday.org/docs/SBT_TIGHTENING_ROADMAP.md (Session 5) and execute it.
MEMORY.md first. Test with multiple shuffles in preview before
committing — should see different events every click.
```

---

### ⬛ Session 6 — Items #9 + #10: Empty-state upgrade + minimal test harness

**Scope:** Don't show "Couldn't plan your day" when API returns 0 cards — fall back to a curated template plan. Also land a 30-line vitest for the brittle plan-day math.

**Why last:** Lowest user-facing impact but best long-term hygiene. Test harness protects everything above.

**Files:**
- Edit: `src/components/south-bay/homepage/SouthBayTodayView.tsx` — when `error || cards.length === 0 && !loading`, render a "Try this classic instead" card with weather + 3 always-good picks + Events-tab CTA.
- New: `src/pages/api/plan-day.test.ts` (or adjacent) — vitest covering `timeBlockFromEventTime`, `fallbackBlurb`, `getEffectiveTime` (client-side, port to the test), past-event filter logic.
- Update: `package.json` if vitest isn't set up.

**Session prompt to paste:**
```
Read /Users/stephenstanwood/Projects/southbaytoday.org/docs/SBT_TIGHTENING_ROADMAP.md (Session 6) and execute it.
MEMORY.md first. After landing, run the test suite to prove it catches
regressions. Commit/push.
```

---

## After all sessions

Run a final shuffle sweep — 20 shuffles across kids/adults × today/tomorrow modes. Note anything still odd. Ship one final cleanup commit if needed.

## Check-ins

- **After Session 2**: Stephen reviews for tone (kids/adult filter can feel too aggressive if it drops mixed events).
- **After Session 4**: Confirm dedup didn't lose legitimate distinct events (two "Book Club" events at same venue on same date are probably one event, but one "Food Truck Rally" and one "Taco Festival" at same venue same date are two).
- **After Session 5**: Sanity check on variety — shuffle 10×, confirm different anchors + different events.
