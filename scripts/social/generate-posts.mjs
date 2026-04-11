#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Signal — Single-Item Post Generator
// Replaces daily-pulse, tonight, weekend-roundup, civic-signal
// Runs multiple times per day, generates individual posts for top items
//
// Usage:
//   node scripts/social/generate-posts.mjs [--max N] [--dry-run]
//
// Picks the top N items (default 5) that pass URL + fact-check validation,
// generates single-item copy for each, and writes individual post JSONs.
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllCandidates, upcomingCandidates } from "./lib/data-loader.mjs";
import { scoreAndRank } from "./lib/scoring.mjs";
import { diverseSelect } from "./lib/diversity.mjs";
import { editorialFilter } from "./lib/editorial-filter.mjs";
import { recentHistory, flattenHistory } from "./lib/dedup.mjs";
import { enrichUrls } from "./lib/url-enrich.mjs";
import { filterByUrl, loadUrlRejectCache } from "./lib/url-check.mjs";
import { factCheckAll } from "./lib/fact-check.mjs";
import { generateSingleItemCopy } from "./lib/copy-gen.mjs";
import { generateAndSaveCard } from "./lib/card-gen.mjs";
import { CONFIG } from "./lib/constants.mjs";
import { logStep, logScore, logSuccess, logSkip, logError, logItem } from "./lib/logger.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Plan link generation ──────────────────────────────────────────────────
// For event candidates, pre-generate a day plan with the event locked,
// then save it to get a shareable plan URL.

const PLAN_API_BASE = process.env.SBT_API_BASE || "https://southbaytoday.org";
const SHARED_PLANS_PATH = join(__dirname, "..", "..", "src", "data", "south-bay", "shared-plans.json");

function loadSharedPlans() {
  try { return JSON.parse(readFileSync(SHARED_PLANS_PATH, "utf8")); } catch { return {}; }
}

function saveSharedPlans(plans) {
  writeFileSync(SHARED_PLANS_PATH, JSON.stringify(plans, null, 2) + "\n");
}

// Append a single plan to shared-plans.json, re-reading disk each time
// to avoid clobbering concurrent writes from parallel generate-posts runs.
function appendSharedPlan(planId, plan) {
  const current = loadSharedPlans();
  current[planId] = plan;
  writeFileSync(SHARED_PLANS_PATH, JSON.stringify(current, null, 2) + "\n");
}

function generatePlanId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Photo enrichment ─────────────────────────────────────────────────────────
// For event cards missing a photoRef, look up the venue via Google Places
// text search and attach the first photo ref.

const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

async function fetchVenuePhotoRef(venueName, cityName) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !venueName) return null;
  try {
    const query = cityName ? `${venueName} ${cityName}` : venueName;
    const res = await fetch(PLACES_TEXT_SEARCH_URL, {
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
  } catch {
    return null;
  }
}

async function enrichCardPhotos(cards) {
  const missing = cards.filter((c) => !c.photoRef && (c.venue || c.name));
  if (!missing.length) return;

  for (const card of missing) {
    const lookupName = card.venue || card.name;
    const ref = await fetchVenuePhotoRef(lookupName, card.city);
    if (ref) {
      card.photoRef = ref;
      logItem(`Photo found for "${lookupName}": ${ref.slice(0, 40)}…`);
    }
    // Polite delay between Places API calls
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function generatePlanLinks(candidates) {
  let generated = 0;

  for (const item of candidates) {
    // Need at least a city to generate a plan
    if (!item.city) continue;
    // Skip if already has a plan URL
    if (item.planUrl) continue;

    try {
      // 1. Generate a plan with this event locked via the prod API
      const rawId = item.id || item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      const eventId = `event:${rawId}`;
      const planRes = await fetch(`${PLAN_API_BASE}/api/plan-day`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city: item.city,
          kids: false,
          lockedIds: [eventId],
          currentHour: 9, // always generate full-day plans starting at 9 AM
          planDate: item.date || undefined, // generate for the event's actual date
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!planRes.ok) continue;
      const planData = await planRes.json();
      if (!planData.cards?.length) continue;

      // 2. Enrich any cards missing photos via Google Places lookup
      await enrichCardPhotos(planData.cards);

      // 3. Append plan to shared-plans.json using read-modify-write per plan
      //    so parallel generate-posts runs can't clobber each other.
      const planId = generatePlanId();
      const plan = {
        cards: planData.cards.map((c) => ({
          id: c.id, name: c.name, category: c.category, city: c.city,
          address: c.address, timeBlock: c.timeBlock, blurb: c.blurb, why: c.why,
          url: c.url || null, mapsUrl: c.mapsUrl || null,
          cost: c.cost || null, costNote: c.costNote || null,
          photoRef: c.photoRef || null, venue: c.venue || null, source: c.source,
        })),
        city: item.city,
        kids: false,
        weather: planData.weather,
        planDate: item.date || new Date().toISOString().split("T")[0],
        createdAt: new Date().toISOString(),
      };
      appendSharedPlan(planId, plan);

      item.planUrl = `https://southbaytoday.org/plan/${planId}`;
      generated++;
      logStep("📅", `Plan link: ${item.title} → ${item.planUrl}`);

      // Rate limit — don't hammer the API
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      // Silently skip — plan links are optional
      logItem(`Plan link failed for ${item.title}: ${err.message || err}`);
    }
  }

  return generated;
}

// ── Already-seen filter ────────────────────────────────────────────────────
// Skip items that are already approved, or were rejected in a previous review.

const REVIEW_HISTORY_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-review-history.json");

function loadAlreadySeen() {
  const seen = new Set();
  const queuePath = join(__dirname, "..", "..", "src", "data", "south-bay", "social-approved-queue.json");

  // Approved queue
  try {
    const queue = JSON.parse(readFileSync(queuePath, "utf8"));
    for (const item of queue) {
      if (item.item?.url) seen.add(item.item.url);
      if (item.item?.title) seen.add(item.item.title.toLowerCase());
    }
  } catch {}

  // Persistent review history (approved + rejected titles, syncs via git)
  try {
    const history = JSON.parse(readFileSync(REVIEW_HISTORY_FILE, "utf8"));
    for (const entry of history) {
      if (entry.title) seen.add(entry.title.toLowerCase());
      if (entry.url) seen.add(entry.url);
    }
  } catch {}

  // Currently pending post files (avoid regenerating what's already in /tmp)
  const feedbackDir = "/tmp/sbs-social";
  try {
    const files = readdirSync(feedbackDir).filter((f) => f.startsWith("post-") && f.endsWith(".json"));
    for (const f of files) {
      const post = JSON.parse(readFileSync(join(feedbackDir, f), "utf8"));
      if (post.item?.url) seen.add(post.item.url);
      if (post.item?.title) seen.add(post.item.title.toLowerCase());
    }
  } catch {}

  return seen;
}

function filterAlreadySeen(candidates, seen) {
  return candidates.filter((c) => {
    if (c.url && seen.has(c.url)) return false;
    if (c.title && seen.has(c.title.toLowerCase())) return false;
    return true;
  });
}

// Load env
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const envPath = join(__dirname, "..", "..", ".env.local");
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const OUTPUT_DIR = "/tmp/sbs-social";
const args = process.argv.slice(2);
const maxPosts = parseInt(args.find((a, i) => args[i - 1] === "--max") || "20");

// ── Time awareness ──────────────────────────────────────────────────────────

function getPTTime() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
}

function getTimeOfDay(ptTime) {
  const hour = ptTime.getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

function parseEventHour(timeStr) {
  if (!timeStr) return null;
  const lower = timeStr.toLowerCase().trim();
  const match = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!match) return null;
  let hour = parseInt(match[1]);
  const ampm = match[3];
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  return hour;
}

/**
 * Filter out events that have already happened today.
 */
function filterPastEvents(candidates, ptTime) {
  const today = ptTime.toISOString().split("T")[0];
  const currentHour = ptTime.getHours();

  return candidates.filter((c) => {
    // Future dates always pass
    if (c.date && c.date > today) return true;

    // Past dates fail
    if (c.date && c.date < today) return false;

    // Today: check time
    if (c.date === today && c.time) {
      const eventHour = parseEventHour(c.time);
      if (eventHour !== null && eventHour < currentHour) {
        return false; // already started
      }
    }

    // Ongoing items pass (no specific time)
    return true;
  });
}

// ── Main pipeline ───────────────────────────────────────────────────────────

async function main() {
  const ptTime = getPTTime();
  const timeOfDay = getTimeOfDay(ptTime);
  const today = ptTime.toISOString().split("T")[0];

  logStep(
    "📡",
    `Social post generation — ${today} ${timeOfDay} (${ptTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })})`
  );

  // 1. Load all candidates
  const allCandidates = loadAllCandidates();
  logStep("📊", `Loaded ${allCandidates.length} total candidates`);

  // 2. Filter to upcoming only
  const upcoming = upcomingCandidates(allCandidates);
  logStep("📅", `${upcoming.length} upcoming candidates`);

  // 3. Filter out events that already happened today
  const timely = filterPastEvents(upcoming, ptTime);
  logStep("🕐", `${timely.length} candidates after time filter (${upcoming.length - timely.length} past events removed)`);

  // 3b. Filter out items already approved, rejected, or pending review
  const seen = loadAlreadySeen();
  const fresh = filterAlreadySeen(timely, seen);
  logStep("👀", `${fresh.length} fresh candidates (${timely.length - fresh.length} already reviewed/queued)`);

  // 3c. Drop items whose URL was recently rejected (401, 404, cancelled, etc.)
  //     so they don't keep consuming editorial-filter and Claude-call budget.
  const urlRejectCache = loadUrlRejectCache();
  const prereject = fresh.filter((c) => !c.url || !urlRejectCache[c.url]);
  const cachedKilled = fresh.length - prereject.length;
  if (cachedKilled > 0) logStep("🚫", `Dropped ${cachedKilled} candidates with cached URL rejects`);

  // 4. Score with dedup history
  const history = flattenHistory(recentHistory(7));
  const scored = scoreAndRank(prereject, history);

  // 4b. Hard cutoff: drop anything with a negative score. A negative score
  //     means an INTERNAL_EVENT_SIGNALS, political, or blacklist hit — those
  //     should never make it into the pool regardless of how thin candidates are.
  const viable = scored.filter((c) => c.score > 0);
  const dropped = scored.length - viable.length;
  if (dropped > 0) logStep("🚫", `Dropped ${dropped} candidates with negative score (blocked)`);

  // 5. Diverse selection (oversample — editorial filter will cut)
  const diversePool = diverseSelect(viable, maxPosts * 4);
  logStep("📈", `Top ${diversePool.length} diverse candidates by score`);

  // 5b. Editorial pre-filter — one Claude call picks the top (maxPosts * 1.5)
  //     items genuinely worth writing about, rejects boring/narrow/bureaucratic
  //     things that score fine on heuristics but are bad social posts.
  logStep("🎯", "Editorial filter...");
  const topCandidates = await editorialFilter(diversePool, Math.ceil(maxPosts * 1.5));

  // 6. URL enrichment — find better URLs for generic/missing links
  logStep("🔗", "Enriching URLs...");
  await enrichUrls(topCandidates);

  // 7. URL validation — filter out items without good direct links
  logStep("🔗", "Validating URLs...");
  const urlValid = await filterByUrl(topCandidates);

  if (urlValid.length === 0) {
    logSkip("No candidates with valid URLs — skipping");
    process.exit(0);
  }

  // 7. Fact check — verify items are accurate
  logStep("🔍", "Fact-checking...");
  const factChecked = await factCheckAll(urlValid, ptTime);

  if (factChecked.length === 0) {
    logSkip("No candidates passed fact check — skipping");
    process.exit(0);
  }

  // 8. Take the final top N
  const selected = factChecked.slice(0, maxPosts);
  logStep("✅", `Selected ${selected.length} items for posting:`);
  for (const item of selected) {
    logScore(item.title, item.score);
    logItem(`${item.cityName || item.city} · ${item.venue || "no venue"} · ${item.url?.slice(0, 60) || "no url"}`);
  }

  // 8b. Generate plan links for FINAL selection only (not all candidates).
  //     Done after selection so we don't waste API calls on items we won't post.
  logStep("📅", "Generating plan links for selected items...");
  const planCount = await generatePlanLinks(selected);
  logStep("📅", `Generated ${planCount} plan links`);

  // 9. Generate copy for each item individually
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const posts = [];

  for (const item of selected) {
    logStep("✍️", `Generating copy: ${item.title}`);

    try {
      const copy = await generateSingleItemCopy(item, timeOfDay);

      const post = {
        postType: "single",
        date: today,
        timeOfDay,
        generatedAt: new Date().toISOString(),
        item: {
          title: item.title,
          city: item.city,
          cityName: item.cityName,
          venue: item.venue,
          category: item.category,
          score: item.score,
          date: item.date,
          time: item.time,
          url: item.url,
          planUrl: item.planUrl || null,
        },
        copy,
        cardPath: null,
        targetUrl: item.planUrl || item.url,
      };

      // Write individual post JSON
      const slug = item.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);
      const postPath = join(OUTPUT_DIR, `post-${today}-${slug}.json`);
      writeFileSync(postPath, JSON.stringify(post, null, 2) + "\n");

      logStep("🐦", `X (${copy.x.length} chars)`);
      logStep("🧵", `Threads (${copy.threads.length} chars)`);
      logStep("🦋", `Bluesky (${copy.bluesky.length} chars)`);

      posts.push({ path: postPath, post });
    } catch (err) {
      logError(`Copy gen failed for ${item.title}: ${err.message}`);
    }

    // Rate limit between Claude calls
    await new Promise((r) => setTimeout(r, 500));
  }

  logSuccess(`Generated ${posts.length} individual posts`);

  // Auto-commit shared-plans.json so plan pages are live by the time the
  // user reviews/approves these posts. Without this, plan links 404 until
  // the nightly data sync runs.
  if (posts.length > 0) {
    try {
      const { execSync } = await import("node:child_process");
      const repoRoot = join(__dirname, "..", "..");
      const dirty = execSync("git diff --name-only -- src/data/south-bay/shared-plans.json", { cwd: repoRoot, encoding: "utf8" }).trim();
      if (dirty) {
        execSync("git add src/data/south-bay/shared-plans.json", { cwd: repoRoot, stdio: "pipe" });
        execSync(`git commit -m "data: batch plans for ${posts.length} new drafts"`, { cwd: repoRoot, stdio: "pipe" });
        try { execSync("git pull --rebase", { cwd: repoRoot, stdio: "pipe", timeout: 20000 }); } catch (e) { /* ignore rebase noise */ }
        execSync("git push origin main", { cwd: repoRoot, stdio: "pipe", timeout: 30000 });
        console.log("   📎 shared-plans.json committed and pushed");
      }
    } catch (e) {
      console.warn("   ⚠️  Failed to auto-push shared-plans.json:", e.message);
    }
  }

  // Print post file paths for publish.mjs
  for (const p of posts) {
    console.log(`POST_FILE=${p.path}`);
  }

  // Summary for scheduled task reporting
  console.log(`\n**Social Posts Generated (${timeOfDay})**`);
  console.log(`- Time: ${ptTime.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`);
  console.log(`- Candidates: ${allCandidates.length} total → ${timely.length} timely → ${fresh.length} fresh → ${urlValid.length} URL-valid → ${factChecked.length} fact-checked`);
  console.log(`- Posts generated: ${posts.length}`);
  for (const p of posts) {
    console.log(`  • ${p.post.item.title} (${p.post.item.cityName || ""}) → ${p.post.item.url?.slice(0, 60)}`);
  }
}

main().catch((err) => {
  logError(err.message);
  console.error(err);
  process.exit(1);
});
