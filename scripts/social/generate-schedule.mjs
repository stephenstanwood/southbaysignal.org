#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Today — 10-Day Schedule Generator
// Populates the 3-slot daily schedule with draft content:
//   07:15 — Day Plan (one /api/plan-day call per day)
//   11:45 — Tonight Pick (best evening event)
//   16:30 — Wildcard (SV history, restaurant, or general)
//
// Also writes today's adults + kids plans into default-plans.json so the
// homepage first-paint reuses the social day-plan instead of recomputing.
// (Replaces the now-deleted scripts/generate-default-plans.mjs.)
//
// Runs at 2 AM on the Mini.
// Usage: node scripts/social/generate-schedule.mjs [--dry-run] [--days N]
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { loadAllCandidates, upcomingCandidates } from "./lib/data-loader.mjs";
import { scoreAndRank } from "./lib/scoring.mjs";
import { generateDayPlanCopy, generateTonightPickCopy, generateWildcardCopy } from "./lib/copy-gen.mjs";
import { SLOT_TYPES, TYPED_SLOTS, todayPT, addDays } from "./lib/slot-scheduler.mjs";
import { CITY_NAMES } from "./lib/constants.mjs";
import { runQualityReview } from "./lib/post-gen-review.mjs";
import { normalizeName } from "./lib/normalizeName.mjs";
import { canonicalizePlanCards } from "../../src/lib/south-bay/canonicalizeCard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEDULE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-schedule.json");
const PLANS_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "default-plans.json");
const SHARED_PLANS_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "shared-plans.json");
const MILESTONES_DIR = join(__dirname, "..", "..", "src", "lib", "south-bay");
const RESTAURANT_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "scc-food-openings.json");

// Load env
const ENV_FILE = join(__dirname, "..", "..", ".env.local");
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const lines = readFileSync(ENV_FILE, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const daysAhead = parseInt(args.find((a, i) => args[i - 1] === "--days") || "10");
// --hero-only: skip the 10-day social generation entirely and just refresh
// default-plans.json (today's adults plan pulled from the existing social
// schedule + a fresh kids plan for the homepage). Intended for the daily
// 2:30 AM cron that keeps the homepage first-paint fresh between the
// weekly Saturday social run.
const heroOnly = args.includes("--hero-only");

// ── Helpers ───────────────────────────────────────────────────────────────

function loadSchedule() {
  if (!existsSync(SCHEDULE_FILE)) return { days: {} };
  try { return JSON.parse(readFileSync(SCHEDULE_FILE, "utf8")); } catch { return { days: {} }; }
}

function saveSchedule(schedule) {
  schedule._meta = {
    generatedAt: new Date().toISOString(),
    generator: "generate-schedule",
    daysAhead,
  };
  writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2) + "\n");
}

function loadDefaultPlans() {
  try { return JSON.parse(readFileSync(PLANS_FILE, "utf8")); } catch { return { plans: {} }; }
}

/** Extract card names from the *previous* default-plans.json, split by mode.
 *  Used to feed `recentlyShown` (with daysAgo: 1 → -25 penalty) into today's
 *  plan generation so day-over-day variety actually happens. Without this the
 *  homepage kids plan picked Bill's Cafe + Vasona Lake + Smoking Pig BBQ in a
 *  loop because the nightly generator had no memory of yesterday's picks. */
function extractPreviousPlanNames(plansData) {
  const adults = new Set();
  const kids = new Set();
  for (const [key, plan] of Object.entries(plansData?.plans || {})) {
    const target = key.startsWith("kids:") ? kids : adults;
    for (const c of (plan?.cards || [])) {
      const n = normalizeName(c.name);
      if (n) target.add(n);
    }
  }
  return { adults: [...adults], kids: [...kids] };
}

const PLAN_API_BASE = process.env.SBT_API_BASE || "https://southbaytoday.org";
const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

/** Look up a Google Places photo ref for a venue name. For in-app display only. */
async function lookupPhotoRef(name, city) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !name) return null;
  try {
    const query = city ? `${name} ${city.replace(/-/g, " ")}` : name;
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.photos",
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.places?.[0]?.photos?.[0]?.name || null;
  } catch { return null; }
}

/** Enrich plan cards that are missing photoRef. */
async function enrichCardPhotos(cards) {
  for (const card of cards) {
    if (card.photoRef) continue;
    const name = card.venue || card.name;
    if (!name) continue;
    const ref = await lookupPhotoRef(name, card.city);
    if (ref) card.photoRef = ref;
    await new Promise(r => setTimeout(r, 300));
  }
}

// Category → Unsplash URL cache so we only call once per category per run.
// Cards whose photoRef + image are both null would otherwise flash the
// category emoji on homepage load before the client-side Unsplash fallback
// resolves; pre-baking the URL means the browser renders the image on
// first paint.
const unsplashByCategory = new Map();

async function unsplashForCategory(category) {
  if (!category) return null;
  if (unsplashByCategory.has(category)) return unsplashByCategory.get(category);
  try {
    const res = await fetch(`${PLAN_API_BASE}/api/unsplash-photo?query=${encodeURIComponent(category)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) { unsplashByCategory.set(category, null); return null; }
    const data = await res.json();
    const url = data?.url || null;
    unsplashByCategory.set(category, url);
    return url;
  } catch {
    unsplashByCategory.set(category, null);
    return null;
  }
}

/** Fill card.image with an Unsplash URL for cards still missing a photoRef
 *  after venue-lookup, so the homepage doesn't flash the emoji placeholder. */
async function enrichMissingImages(cards) {
  for (const c of cards) {
    if (c.photoRef || c.image) continue;
    const url = await unsplashForCategory(c.category);
    if (url) c.image = url;
  }
}

/** Call the plan API for a specific city + date. Returns plan data or null. */
async function fetchPlanFromApi(city, dateStr, opts = {}) {
  const { blockedNames = [], weekContext, kids = false, recentlyShown = [] } = opts;
  try {
    const res = await fetch(`${PLAN_API_BASE}/api/plan-day`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        city,
        kids,
        currentHour: 7, // start with breakfast — enforced by plan-day prompt
        planDate: dateStr,
        blockedNames,
        weekContext,
        recentlyShown,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.cards?.length) return null;
    return data;
  } catch (err) {
    console.log(`      ⚠️  Plan API failed: ${err.message}`);
    return null;
  }
}

/** Check whether a plan qualifies — full-day arc + no in-week overlap. */
function planPassesQuality(plan, usedNames) {
  if (!plan?.cards?.length) return { ok: false, reason: "empty" };
  const cards = plan.cards;
  // Require at least 5 stops
  if (cards.length < 5) return { ok: false, reason: `only ${cards.length} stops` };
  // Require a morning stop (starts <= 11 AM)
  const firstHour = parseHour(cards[0].timeBlock?.split("-")[0]);
  if (firstHour === null || firstHour > 11) {
    return { ok: false, reason: `starts too late (${cards[0].timeBlock})` };
  }
  // Reject if >= 2 anchor POIs repeat a previously-used name this run
  const names = cards.map((c) => normalizeName(c.name)).filter(Boolean);
  const overlap = names.filter((n) => usedNames.has(n));
  if (overlap.length >= 2) {
    return { ok: false, reason: `${overlap.length} repeats: ${overlap.slice(0, 3).join(", ")}` };
  }
  return { ok: true };
}

function loadSharedPlans() {
  try { return JSON.parse(readFileSync(SHARED_PLANS_FILE, "utf8")); } catch { return {}; }
}

function saveSharedPlans(plans) {
  writeFileSync(SHARED_PLANS_FILE, JSON.stringify(plans, null, 2) + "\n");
}

function generatePlanId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Save a day plan to shared-plans.json and return the plan URL. */
function createSharedPlanUrl(plan, dateStr) {
  const planId = generatePlanId();
  const entry = {
    cards: canonicalizePlanCards(plan.cards),
    city: plan.cards[0]?.city || "san-jose",
    kids: false,
    weather: plan.weather,
    planDate: dateStr,
    createdAt: new Date().toISOString(),
  };
  const current = loadSharedPlans();
  current[planId] = entry;
  saveSharedPlans(current);
  return `https://southbaytoday.org/plan/${planId}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Pick the best plan for a given date, rotating through cities. */
function pickPlanForDate(plansData, dateStr) {
  const plans = plansData.plans || {};
  const planKeys = Object.keys(plans).filter((k) => !k.includes(":kids"));
  if (planKeys.length === 0) return null;

  // Rotate based on day-of-year so each day gets a different city
  const dayOfYear = Math.floor(
    (new Date(dateStr + "T12:00:00") - new Date(dateStr.split("-")[0] + "-01-01T00:00:00")) / 86400000
  );
  const key = planKeys[dayOfYear % planKeys.length];
  return { key, plan: plans[key] };
}

/** Parse a time string like "7:30 PM", "14:00", "noon" into 24h hour. Returns null if unparseable. */
function parseHour(timeStr) {
  if (!timeStr) return null;
  const lower = timeStr.toLowerCase().trim();
  if (lower.includes("noon")) return 12;
  if (lower.includes("midnight")) return 0;

  // "7:30 PM", "7 PM", "7:30PM"
  const ampm = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const isPM = ampm[3] === "pm";
    if (isPM && h !== 12) h += 12;
    if (!isPM && h === 12) h = 0;
    return h;
  }

  // 24h: "14:00", "17:30"
  const mil = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (mil) return parseInt(mil[1]);

  return null;
}

/** Find the best evening event for a given date. Must start at 5 PM or later.
 *  Dedups against recent venues + titles used earlier in the run — once an
 *  artist or venue shows up once in a week, it can't show again. */
function pickTonightEvent(candidates, dateStr, recentVenues = new Set(), recentTitles = new Set()) {
  const dateEvents = candidates.filter((c) => c.date === dateStr);
  if (dateEvents.length === 0) return null;

  // Boring event patterns — skip these as tonight picks
  const BORING_TONIGHT = /\b(board of|trustees|commission|committee|council meeting|task force|budget hearing|town hall meeting|book club|chess club|book sale)\b/i;

  const norm = normalizeName;

  // Only events starting at 5 PM or later, not boring government/library stuff
  const evening = dateEvents.filter((c) => {
    const hour = parseHour(c.time);
    if (hour === null) return false;
    if (hour < 17) return false;
    const title = (c.title || c.name || "").toLowerCase();
    if (BORING_TONIGHT.test(title)) return false;
    if (c.category === "government") return false;
    // Dedup within the week — venue OR title already used
    if (recentVenues.has(norm(c.venue))) return false;
    if (recentTitles.has(norm(c.title || c.name))) return false;
    return true;
  });

  if (evening.length === 0) return null;

  // Score and pick from top candidates with some randomness
  const scored = evening.map((c) => ({
    ...c,
    _score: (c.score || 0) + (c.category === "arts" ? 3 : 0) + (c.category === "food" ? 2 : 0) + (c.venue ? 2 : 0),
  }));
  return weightedRandomPick(scored);
}

/** Find wildcard content for a given date. Avoids repeating recent picks. */
function pickWildcard(candidates, dateStr, recentTitles = new Set()) {
  // 1. Check for SV history anniversary
  const date = new Date(dateStr + "T12:00:00");
  const month = date.getMonth() + 1;
  const day = date.getDate();

  try {
    // Load milestones from tech-companies data
    const techFile = join(MILESTONES_DIR, "tech-companies.ts");
    if (existsSync(techFile)) {
      const content = readFileSync(techFile, "utf8");
      // Simple regex to find milestones matching this month/day
      const milestoneRegex = new RegExp(`month:\\s*${month},\\s*day:\\s*${day}`, "g");
      if (milestoneRegex.test(content)) {
        // Extract the company name from nearby context
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(`month: ${month}`) && lines[i].includes(`day: ${day}`)) {
            // Look backwards for company name
            for (let j = i; j >= Math.max(0, i - 10); j--) {
              const companyMatch = lines[j].match(/company:\s*"([^"]+)"/);
              if (companyMatch) {
                return {
                  subtype: "sv-history",
                  item: {
                    title: companyMatch[1],
                    company: companyMatch[1],
                    foundedYear: 0, // Will be filled by the copy generator
                    name: companyMatch[1],
                    month, day,
                  },
                };
              }
            }
          }
        }
      }
    }
  } catch {}

  // 2. Check for restaurant openings
  try {
    const restaurants = JSON.parse(readFileSync(RESTAURANT_FILE, "utf8"));
    const openings = (restaurants.openings || []).filter((r) => r.date === dateStr);
    if (openings.length > 0) {
      return { subtype: "restaurant", item: openings[0] };
    }
  } catch {}

  // 3. Fall back to general event — prefer events 1-3 days out from post date
  //    Skip events already used in recent days (dedup)
  const postDate = new Date(dateStr + "T12:00:00");
  const nearFuture = candidates.filter((c) => {
    if (c.sourceType !== "event" || !c.date) return false;
    // Skip if we already posted about this recently
    const title = (c.title || c.name || "").toLowerCase();
    if (recentTitles.has(title)) return false;
    const eventDate = new Date(c.date + "T12:00:00");
    const daysOut = Math.round((eventDate - postDate) / 86400000);
    return daysOut >= 0 && daysOut <= 3;
  });
  if (nearFuture.length > 0) {
    return { subtype: "general", item: weightedRandomPick(nearFuture) };
  }

  // 4. Same-date events as fallback (also deduped)
  const dateItems = candidates.filter((c) => {
    if (c.date !== dateStr || c.sourceType !== "event") return false;
    const title = (c.title || c.name || "").toLowerCase();
    return !recentTitles.has(title);
  });
  if (dateItems.length > 0) {
    return { subtype: "general", item: weightedRandomPick(dateItems) };
  }

  return null;
}

/** Pick from top candidates with weighted randomness — top 5 eligible, weighted by score. */
function weightedRandomPick(items) {
  items.sort((a, b) => (b.score || 0) - (a.score || 0));
  const pool = items.slice(0, Math.min(5, items.length));
  // Weight: first gets 5, second 4, etc.
  const weights = pool.map((_, i) => pool.length - i);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[0];
}

// ── Main ──────────────────────────────────────────────────────────────────

/** One pass of generation over `daysAhead` days.
 *  Mutates `schedule` in place. Callable multiple times: the second call will
 *  regen any slot that was deleted between calls (e.g. by the quality review).
 *
 *  @param {object} opts
 *  @param {"draft-or-missing"|"missing-only"} [opts.regenMode="draft-or-missing"]
 *    - "draft-or-missing": replace existing draft slots and fill missing slots
 *      (used for Pass 1)
 *    - "missing-only": only fill missing slots, leave existing drafts alone
 *      (used for Pass 2 — flagged slots were deleted, everything else is keep)
 */
async function runGenerationPass(schedule, plansData, scored, { passLabel = "pass", regenMode = "draft-or-missing", yesterdayAdultsNames = [] } = {}) {
  const shouldFill = (slot) => {
    if (!slot) return true;
    if (regenMode === "missing-only") return false;
    return slot.status === "draft";
  };
  const today = todayPT();
  let generated = 0;
  let skipped = 0;

  // Track recent wildcard/tonight titles to avoid repeats across days
  const recentWildcardTitles = new Set();
  const recentTonightTitles = new Set();
  const recentTonightVenues = new Set();
  const usedDayPlanNames = new Set();
  // Week-level context for plan-day — anchor cities seen this batch + category counts.
  const anchorCitiesThisWeek = [];
  const categorySaturation = {};
  const recordPlanForContext = (plan, cityName) => {
    if (cityName) anchorCitiesThisWeek.push(cityName);
    for (const c of (plan?.cards || [])) {
      const cat = (c.category || "").toLowerCase();
      if (!cat) continue;
      categorySaturation[cat] = (categorySaturation[cat] || 0) + 1;
    }
  };
  const seedUsedFromSchedule = () => {
    for (const d of Object.keys(schedule.days)) {
      const day = schedule.days[d];
      const dp = day["day-plan"];
      if (dp?.plan?.cards) {
        for (const c of dp.plan.cards) {
          const n = normalizeName(c.name);
          if (n) usedDayPlanNames.add(n);
        }
        recordPlanForContext(dp.plan, dp.cityName);
      }
      const tp = day["tonight-pick"];
      if (tp?.item) {
        const t = normalizeName(tp.item.title || tp.item.name);
        const v = normalizeName(tp.item.venue);
        if (t) recentTonightTitles.add(t);
        if (v) recentTonightVenues.add(v);
      }
      const wc = day["wildcard"];
      if (wc?.item) {
        const t = normalizeName(wc.item.title || wc.item.name);
        if (t) recentWildcardTitles.add(t);
      }
    }
  };
  seedUsedFromSchedule();

  for (let offset = 0; offset < daysAhead; offset++) {
    const dateStr = addDays(today, offset);
    const dayName = DAY_NAMES[new Date(dateStr + "T12:00:00").getDay()];

    if (!schedule.days[dateStr]) schedule.days[dateStr] = {};
    const day = schedule.days[dateStr];

    console.log(`\n  ${dayName} ${dateStr}:`);

    // ── Day Plan (7:15 AM) ──────────────────────────────────────────────
    if (shouldFill(day["day-plan"])) {
      // Anchor city rotates by day-of-year for flavor. The plan-day API
      // pulls candidates from the full South Bay region (20km radius), so
      // the "city" is more of a center-of-gravity than a hard filter.
      const cityKeys = Object.keys(CITY_NAMES);
      const dayOfYear = Math.floor(
        (new Date(dateStr + "T12:00:00") - new Date(dateStr.split("-")[0] + "-01-01T00:00:00")) / 86400000
      );
      const citySlug = cityKeys[dayOfYear % cityKeys.length];
      const cityName = CITY_NAMES[citySlug] || citySlug;

      if (dryRun) {
        console.log(`    📋 Day Plan: ${cityName} [dry run]`);
      } else {
        let plan = null;
        let lastReason = null;

        console.log(`    📋 Fetching plan for ${cityName} on ${dateStr}...`);
        try {
          const blockedNames = Array.from(usedDayPlanNames);
          const weekContext = {
            anchorCities: anchorCitiesThisWeek.slice(),
            categorySaturation: { ...categorySaturation },
          };
          // Penalize (not hard-block) yesterday's adults picks so today's
          // plan shuffles even when seedUsedFromSchedule missed anything.
          // daysAgo: 1 → -25 points in plan-day's scoreCandidates.
          const recentlyShown = yesterdayAdultsNames.map((n) => ({ name: n, daysAgo: 1 }));
          const candidate = await fetchPlanFromApi(citySlug, dateStr, { blockedNames, weekContext, recentlyShown });
          if (!candidate) {
            lastReason = "api returned nothing";
          } else {
            const quality = planPassesQuality(candidate, usedDayPlanNames);
            if (!quality.ok) {
              console.log(`      ⚠️  Quality warning: ${quality.reason} — accepting anyway`);
            }
            plan = candidate;
          }
        } catch (err) {
          lastReason = err.message;
          console.log(`      ⚠️  ${cityName} plan fetch error: ${err.message}`);
        }

        // Fall back to default plan only if the API gave us nothing
        if (!plan) {
          const fallback = pickPlanForDate(plansData, dateStr);
          if (fallback) {
            plan = fallback.plan;
            console.log(`      ↩ Fell back to default plan after: ${lastReason}`);
          }
        }

        if (!plan || !plan.cards?.length) {
          console.log(`    📋 Day Plan: no acceptable plan — skipping (${lastReason})`);
        } else {
          // Enrich cards missing venue photos (for in-app display)
          await enrichCardPhotos(plan.cards);

          // Register every featured POI as used for the rest of this run
          for (const c of plan.cards) {
            const n = normalizeName(c.name);
            if (n) usedDayPlanNames.add(n);
          }
          recordPlanForContext(plan, cityName);

          // Create a shared plan entry and get a shareable URL
          const planUrl = createSharedPlanUrl(plan, dateStr);
          console.log(`    📎 Plan link: ${planUrl}`);

          try {
            const copy = await generateDayPlanCopy(plan, dateStr, planUrl);
            day["day-plan"] = {
              status: "draft",
              slotType: "day-plan",
              city: citySlug,
              cityName,
              planUrl,
              plan: { cards: plan.cards, weather: plan.weather },
              copy,
              imageUrl: null,
              imageStyle: null,
              copyApprovedAt: null,
              imageApprovedAt: null,
              generatedAt: new Date().toISOString(),
            };
            generated++;
            console.log(`    📋 Day Plan: ${cityName} (${plan.cards.length} stops) ✅`);
          } catch (err) {
            console.log(`    📋 Day Plan: ${cityName} ❌ ${err.message}`);
          }
        }
      }
    } else {
      skipped++;
      console.log(`    📋 Day Plan: already ${day["day-plan"].status}`);
      // Still register its cards so future days dedup against it
      const existing = day["day-plan"].plan?.cards || [];
      for (const c of existing) {
        const n = normalizeName(c.name);
        if (n) usedDayPlanNames.add(n);
      }
      recordPlanForContext(day["day-plan"].plan, day["day-plan"].cityName);
    }

    // ── Tonight Pick (11:45 AM) ─────────────────────────────────────────
    if (shouldFill(day["tonight-pick"])) {
      const tonight = pickTonightEvent(scored, dateStr, recentTonightVenues, recentTonightTitles);
      if (tonight) {
        if (dryRun) {
          console.log(`    🌙 Tonight: ${tonight.title?.slice(0, 50)} [dry run]`);
        } else {
          try {
            const copy = await generateTonightPickCopy(tonight);
            const tTitle = normalizeName(tonight.title || tonight.name);
            const tVenue = normalizeName(tonight.venue);
            if (tTitle) recentTonightTitles.add(tTitle);
            if (tVenue) recentTonightVenues.add(tVenue);
            day["tonight-pick"] = {
              status: "draft",
              slotType: "tonight-pick",
              item: {
                title: tonight.title, city: tonight.city, cityName: tonight.cityName,
                venue: tonight.venue, date: tonight.date, time: tonight.time,
                category: tonight.category, summary: tonight.summary,
                url: tonight.url, cost: tonight.cost, costNote: tonight.costNote,
              },
              copy,
              imageUrl: null,
              imageStyle: null,
              copyApprovedAt: null,
              imageApprovedAt: null,
              generatedAt: new Date().toISOString(),
            };
            generated++;
            console.log(`    🌙 Tonight: ${tonight.title?.slice(0, 50)} ✅`);
          } catch (err) {
            console.log(`    🌙 Tonight: ❌ ${err.message}`);
          }
        }
      } else {
        console.log(`    🌙 Tonight: no evening events found`);
      }
    } else {
      skipped++;
      const existing = day["tonight-pick"].item || {};
      const t = normalizeName(existing.title || existing.name);
      const v = normalizeName(existing.venue);
      if (t) recentTonightTitles.add(t);
      if (v) recentTonightVenues.add(v);
      console.log(`    🌙 Tonight: already ${day["tonight-pick"].status}`);
    }

    // ── Wildcard (4:30 PM) — SV History only ────────────────────────────
    // General/restaurant wildcards are paused; only create the slot on
    // anniversary dates that match a SV tech milestone.
    if (shouldFill(day["wildcard"])) {
      const wildRaw = pickWildcard(scored, dateStr, recentWildcardTitles);
      const wild = wildRaw && wildRaw.subtype === "sv-history" ? wildRaw : null;
      if (!wild && wildRaw) {
        console.log(`    🎲 Wildcard: skipping ${wildRaw.subtype} (paused — SV history only)`);
      }
      if (wild) {
        if (dryRun) {
          console.log(`    🎲 Wildcard: [${wild.subtype}] ${wild.item.title?.slice(0, 50) || wild.item.name?.slice(0, 50)} [dry run]`);
        } else {
          try {
            const copy = await generateWildcardCopy(wild.item, wild.subtype);
            day["wildcard"] = {
              status: "draft",
              slotType: "wildcard",
              subtype: wild.subtype,
              item: {
                title: wild.item.title || wild.item.name,
                city: wild.item.city, cityName: wild.item.cityName,
                venue: wild.item.venue, date: wild.item.date, time: wild.item.time,
                category: wild.item.category, summary: wild.item.summary || wild.item.blurb,
                url: wild.item.url, cost: wild.item.cost, costNote: wild.item.costNote,
                company: wild.item.company, foundedYear: wild.item.foundedYear,
              },
              copy,
              imageUrl: null,
              imageStyle: null,
              copyApprovedAt: null,
              imageApprovedAt: null,
              generatedAt: new Date().toISOString(),
            };
            generated++;
            recentWildcardTitles.add((wild.item.title || wild.item.name || "").toLowerCase());
            console.log(`    🎲 Wildcard: [${wild.subtype}] ${(wild.item.title || wild.item.name || "").slice(0, 50)} ✅`);
          } catch (err) {
            console.log(`    🎲 Wildcard: ❌ ${err.message}`);
          }
        }
      } else {
        console.log(`    🎲 Wildcard: no content found — skipping`);
      }
    } else {
      skipped++;
      // Track existing wildcard title for dedup
      const existingTitle = day["wildcard"]?.item?.title || day["wildcard"]?.item?.name || "";
      if (existingTitle) recentWildcardTitles.add(existingTitle.toLowerCase());
      console.log(`    🎲 Wildcard: already ${day["wildcard"].status}`);
    }

    // Rate limit between days
    if (!dryRun && offset < daysAhead - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return { generated, skipped };
}

async function main() {
  const today = todayPT();

  // Hero-only fast path: skip the 10-day social batch and just refresh
  // default-plans.json for the homepage. Runs daily on the Mini.
  if (heroOnly) {
    console.log(`\n🏠 Hero-only refresh — ${today}`);
    const schedule = loadSchedule();
    const plansData = loadDefaultPlans();
    const { kids: yesterdayKidsNames } = extractPreviousPlanNames(plansData);
    if (dryRun) {
      console.log(`\n🏜️  Dry run (hero-only)`);
      return;
    }
    await writeHomepageDefaultPlans(schedule, today, yesterdayKidsNames);
    try {
      const repoRoot = join(__dirname, "..", "..");
      const dirty = execSync("git diff --name-only -- src/data/south-bay/default-plans.json", { cwd: repoRoot, encoding: "utf8" }).trim();
      if (dirty) {
        execSync("git add src/data/south-bay/default-plans.json", { cwd: repoRoot, stdio: "pipe" });
        execSync('git commit -m "data: refresh homepage default plans"', { cwd: repoRoot, stdio: "pipe" });
        execSync("git push", { cwd: repoRoot, stdio: "pipe" });
        console.log("   📎 default-plans.json committed and pushed");
      } else {
        console.log("   (default-plans.json unchanged)");
      }
    } catch (e) {
      console.warn("   ⚠️  Failed to auto-push default-plans.json:", e.message);
    }
    return;
  }

  console.log(`\n📅 Schedule generator — ${today} (${daysAhead} days ahead)`);

  const schedule = loadSchedule();
  const plansData = loadDefaultPlans();
  const allCandidates = loadAllCandidates();
  const upcoming = upcomingCandidates(allCandidates, daysAhead + 7);

  let scored;
  try { scored = scoreAndRank(upcoming); } catch { scored = upcoming; }

  // Cross-day variety seed: extract yesterday's picks (split by mode) from
  // the existing default-plans.json before we overwrite it. These flow into
  // every plan API call as recentlyShown{daysAgo: 1} → -25 score penalty.
  // Without this the nightly generator has no memory and serves the same
  // "obviously good" Bill's Cafe + Vasona Lake stack day after day.
  const { adults: yesterdayAdultsNames, kids: yesterdayKidsNames } = extractPreviousPlanNames(plansData);
  console.log(`   🔁 variety seed: ${yesterdayAdultsNames.length} adults + ${yesterdayKidsNames.length} kids names from yesterday`);

  // ── Pass 1: initial generation ─────────────────────────────────────────
  const p1 = await runGenerationPass(schedule, plansData, scored, { passLabel: "initial", yesterdayAdultsNames });
  console.log(`\n▶︎ Pass 1: ${p1.generated} generated, ${p1.skipped} preserved`);

  // ── Quality review ────────────────────────────────────────────────────
  // Restrict to the active generation window — we don't want to delete a
  // slot we can't refill on Pass 2.
  const windowDates = Array.from({ length: daysAhead }, (_, i) => addDays(today, i));
  if (!dryRun) {
    console.log(`\n🔍 Running quality review...`);
    const review = runQualityReview(schedule, { dates: windowDates, resetFlaggedToDraft: true });
    for (const a of review.autoFixed) {
      console.log(`   🔧 auto-fix [${a.date} ${a.slotType}] ${a.kind}: ${a.details}`);
    }
    for (const f of review.flagged) {
      console.log(`   🚩 flag [${f.date} ${f.slotType}] ${f.reason} — will regen`);
    }

    // ── Pass 2: regenerate only the slots that were deleted by review ────
    if (review.flagged.length) {
      console.log(`\n🔁 Pass 2: regenerating ${review.flagged.length} flagged slot(s)...`);
      const p2 = await runGenerationPass(schedule, plansData, scored, { passLabel: "regen", regenMode: "missing-only", yesterdayAdultsNames });
      console.log(`✅ Pass 2: ${p2.generated} regenerated`);

      // Re-run the deterministic portion of the review (terminology,
      // chronological sort) on the newly-regenerated slots. Don't reset
      // flags this time — avoid regen loops.
      const review2 = runQualityReview(schedule, { dates: windowDates, resetFlaggedToDraft: false });
      for (const a of review2.autoFixed) {
        console.log(`   🔧 auto-fix [${a.date} ${a.slotType}] ${a.kind}: ${a.details}`);
      }
      for (const f of review2.flagged) {
        console.log(`   ⚠️  still flagged [${f.date} ${f.slotType}] ${f.reason} (keeping — regen didn't resolve)`);
      }
    }
  }

  // Clean up old dates (more than 2 days in the past)
  const cutoff = addDays(today, -2);
  for (const dateStr of Object.keys(schedule.days)) {
    if (dateStr < cutoff) {
      delete schedule.days[dateStr];
    }
  }

  if (!dryRun) {
    saveSchedule(schedule);
    console.log(`\n✅ Schedule saved`);

    // ── Homepage hero plans ──────────────────────────────────────────────
    // The homepage's SouthBayTodayView reads default-plans.json for instant
    // first-paint. Today's adults plan is the one social just generated; we
    // only need an extra Claude call for today's kids plan. Client-side the
    // card list is filtered by current time, so we don't need anchor
    // variants — one plan per mode is enough.
    await writeHomepageDefaultPlans(schedule, today, yesterdayKidsNames);

    // Auto-commit shared-plans.json so plan pages are live by the time posts publish
    try {
      const repoRoot = join(__dirname, "..", "..");
      const dirty = execSync("git diff --name-only -- src/data/south-bay/shared-plans.json src/data/south-bay/default-plans.json", { cwd: repoRoot, encoding: "utf8" }).trim();
      if (dirty) {
        execSync("git add src/data/south-bay/shared-plans.json src/data/south-bay/default-plans.json", { cwd: repoRoot, stdio: "pipe" });
        execSync('git commit -m "data: update shared + default plans from schedule generator"', { cwd: repoRoot, stdio: "pipe" });
        execSync("git push", { cwd: repoRoot, stdio: "pipe" });
        console.log("   📎 shared + default plans committed and pushed");
      }
    } catch (e) {
      console.warn("   ⚠️  Failed to auto-push plan JSONs:", e.message);
    }
  } else {
    console.log(`\n🏜️  Dry run`);
  }
}

const DEFAULT_PLANS_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "default-plans.json");

async function writeHomepageDefaultPlans(schedule, todayStr, yesterdayKidsNames = []) {
  const todayAdults = schedule.days?.[todayStr]?.["day-plan"];
  if (!todayAdults?.plan?.cards?.length) {
    console.warn("   ⚠️  Today's adults plan is missing — skipping default-plans.json update");
    return;
  }
  const citySlug = todayAdults.city;
  const cityName = todayAdults.cityName;

  // Enrich the adults plan's cards with Unsplash for any still missing a
  // photoRef, so the homepage renders images on first paint.
  await enrichMissingImages(todayAdults.plan.cards);

  // Generate today's kids plan — this is the only extra Claude call option 2
  // introduces relative to the social-only baseline.
  console.log(`\n📋 Generating today's kids plan (${cityName}) for homepage...`);
  let kidsPlan = null;
  try {
    // Penalize yesterday's kids picks so the homepage doesn't serve
    // Bill's Cafe + Vasona Lake + Smoking Pig every day in a row.
    // daysAgo: 1 → -25 points in plan-day's scoreCandidates.
    const recentlyShown = yesterdayKidsNames.map((n) => ({ name: n, daysAgo: 1 }));
    kidsPlan = await fetchPlanFromApi(citySlug, todayStr, { kids: true, recentlyShown });
    if (kidsPlan) {
      await enrichCardPhotos(kidsPlan.cards);
      await enrichMissingImages(kidsPlan.cards);
    }
  } catch (err) {
    console.warn(`   ⚠️  Kids plan fetch failed: ${err.message}`);
  }

  const adultsEntry = {
    cards: todayAdults.plan.cards,
    weather: todayAdults.plan.weather || null,
    city: citySlug,
    kids: false,
    anchorHour: 9,
    generatedAt: new Date().toISOString(),
  };
  const kidsEntry = kidsPlan ? {
    cards: kidsPlan.cards,
    weather: kidsPlan.weather || null,
    city: citySlug,
    kids: true,
    anchorHour: 9,
    generatedAt: new Date().toISOString(),
  } : null;

  const plans = { "adults:h9": adultsEntry };
  if (kidsEntry) plans["kids:h9"] = kidsEntry;

  const output = {
    _meta: {
      generatedAt: new Date().toISOString(),
      generator: "generate-schedule (homepage hero)",
      anchorHours: [9],
      planCount: Object.keys(plans).length,
    },
    plans,
  };
  writeFileSync(DEFAULT_PLANS_FILE, JSON.stringify(output, null, 2));
  const kidsMsg = kidsEntry ? `+ ${kidsEntry.cards.length} kids` : "(no kids plan — fetch failed)";
  console.log(`   🏠 default-plans.json: ${adultsEntry.cards.length} adults ${kidsMsg}`);
}

main().catch((err) => {
  console.error("Schedule generation failed:", err);
  process.exit(1);
});
