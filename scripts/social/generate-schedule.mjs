#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Today — 14-Day Schedule Generator
// Populates the 3-slot daily schedule with draft content:
//   07:15 — Day Plan (from default-plans.json)
//   11:45 — Tonight Pick (best evening event)
//   16:30 — Wildcard (SV history, restaurant, or general)
//
// Runs at 2 AM alongside generate-default-plans.
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
const daysAhead = parseInt(args.find((a, i) => args[i - 1] === "--days") || "14");

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

/** Call the plan API for a specific city + date. Returns plan data or null. */
async function fetchPlanFromApi(city, dateStr) {
  try {
    const res = await fetch(`${PLAN_API_BASE}/api/plan-day`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        city,
        kids: false,
        currentHour: 9,
        planDate: dateStr,
      }),
      signal: AbortSignal.timeout(30000),
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
    cards: plan.cards.map((c) => ({
      id: c.id, name: c.name, category: c.category, city: c.city,
      address: c.address, timeBlock: c.timeBlock, blurb: c.blurb, why: c.why,
      url: c.url || null, mapsUrl: c.mapsUrl || null,
      cost: c.cost || null, costNote: c.costNote || null,
      photoRef: c.photoRef || null, venue: c.venue || null, source: c.source,
    })),
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

/** Find the best evening event for a given date. Must start at 5 PM or later. */
function pickTonightEvent(candidates, dateStr) {
  const dateEvents = candidates.filter((c) => c.date === dateStr);
  if (dateEvents.length === 0) return null;

  // Only events starting at 5 PM or later qualify as "tonight"
  const evening = dateEvents.filter((c) => {
    const hour = parseHour(c.time);
    // No time = skip (don't assume evening)
    if (hour === null) return false;
    return hour >= 17;
  });

  if (evening.length === 0) return null;

  // Score and pick best
  const scored = evening.map((c) => ({
    ...c,
    _score: (c.score || 0) + (c.category === "arts" ? 3 : 0) + (c.category === "food" ? 2 : 0) + (c.venue ? 2 : 0),
  }));
  scored.sort((a, b) => b._score - a._score);
  return scored[0];
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

async function main() {
  const today = todayPT();
  console.log(`\n📅 Schedule generator — ${today} (${daysAhead} days ahead)`);

  const schedule = loadSchedule();
  const plansData = loadDefaultPlans();
  const allCandidates = loadAllCandidates();
  const upcoming = upcomingCandidates(allCandidates, daysAhead + 7);

  // Score candidates for ranking
  let scored;
  try {
    scored = scoreAndRank(upcoming);
  } catch {
    scored = upcoming;
  }

  let generated = 0;
  let skipped = 0;

  // Track recent wildcard/tonight titles to avoid repeats across days
  const recentWildcardTitles = new Set();
  const recentTonightTitles = new Set();

  for (let offset = 0; offset < daysAhead; offset++) {
    const dateStr = addDays(today, offset);
    const dayName = DAY_NAMES[new Date(dateStr + "T12:00:00").getDay()];

    if (!schedule.days[dateStr]) schedule.days[dateStr] = {};
    const day = schedule.days[dateStr];

    console.log(`\n  ${dayName} ${dateStr}:`);

    // ── Day Plan (7:15 AM) ──────────────────────────────────────────────
    if (!day["day-plan"] || day["day-plan"].status === "draft") {
      // Rotate city based on day-of-year
      const cityKeys = Object.keys(CITY_NAMES);
      const dayOfYear = Math.floor(
        (new Date(dateStr + "T12:00:00") - new Date(dateStr.split("-")[0] + "-01-01T00:00:00")) / 86400000
      );
      const citySlug = cityKeys[dayOfYear % cityKeys.length];
      const cityName = CITY_NAMES[citySlug] || citySlug;

      if (dryRun) {
        console.log(`    📋 Day Plan: ${cityName} [dry run]`);
      } else {
        try {
          // Call the plan API for a date-specific plan
          console.log(`    📋 Fetching plan for ${cityName} on ${dateStr}...`);
          let plan = await fetchPlanFromApi(citySlug, dateStr);

          // Fallback to default-plans.json if API is down
          if (!plan) {
            const fallback = pickPlanForDate(plansData, dateStr);
            if (fallback) {
              plan = fallback.plan;
              console.log(`      ↩ Fell back to default plan`);
            }
          }

          // Enrich cards missing venue photos (for in-app display)
          if (plan?.cards?.length) {
            await enrichCardPhotos(plan.cards);
          }

          if (!plan || !plan.cards?.length) {
            console.log(`    📋 Day Plan: no plan available — skipping`);
          } else {
            // Create a shared plan entry and get a shareable URL
            const planUrl = createSharedPlanUrl(plan, dateStr);
            console.log(`    📎 Plan link: ${planUrl}`);

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
          }
          } catch (err) {
            console.log(`    📋 Day Plan: ${cityName} ❌ ${err.message}`);
          }
        }
    } else {
      skipped++;
      console.log(`    📋 Day Plan: already ${day["day-plan"].status}`);
    }

    // ── Tonight Pick (11:45 AM) ─────────────────────────────────────────
    if (!day["tonight-pick"] || day["tonight-pick"].status === "draft") {
      const tonight = pickTonightEvent(scored, dateStr);
      if (tonight) {
        if (dryRun) {
          console.log(`    🌙 Tonight: ${tonight.title?.slice(0, 50)} [dry run]`);
        } else {
          try {
            const copy = await generateTonightPickCopy(tonight);
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
      console.log(`    🌙 Tonight: already ${day["tonight-pick"].status}`);
    }

    // ── Wildcard (4:30 PM) ──────────────────────────────────────────────
    if (!day["wildcard"] || day["wildcard"].status === "draft") {
      const wild = pickWildcard(scored, dateStr, recentWildcardTitles);
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

  // Clean up old dates (more than 2 days in the past)
  const cutoff = addDays(today, -2);
  for (const dateStr of Object.keys(schedule.days)) {
    if (dateStr < cutoff) {
      delete schedule.days[dateStr];
    }
  }

  if (!dryRun) {
    saveSchedule(schedule);
    console.log(`\n✅ Schedule saved: ${generated} new entries, ${skipped} preserved`);

    // Auto-commit shared-plans.json so plan pages are live by the time posts publish
    try {
      const repoRoot = join(__dirname, "..", "..");
      const dirty = execSync("git diff --name-only -- src/data/south-bay/shared-plans.json", { cwd: repoRoot, encoding: "utf8" }).trim();
      if (dirty) {
        execSync("git add src/data/south-bay/shared-plans.json", { cwd: repoRoot, stdio: "pipe" });
        execSync('git commit -m "data: update shared plans from schedule generator"', { cwd: repoRoot, stdio: "pipe" });
        execSync("git push", { cwd: repoRoot, stdio: "pipe" });
        console.log("   📎 shared-plans.json committed and pushed");
      }
    } catch (e) {
      console.warn("   ⚠️  Failed to auto-push shared-plans.json:", e.message);
    }
  } else {
    console.log(`\n🏜️  Dry run: would generate ${generated} entries`);
  }
}

main().catch((err) => {
  console.error("Schedule generation failed:", err);
  process.exit(1);
});
