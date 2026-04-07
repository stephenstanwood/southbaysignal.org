#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Signal — SV History Post Generator
// Generates "On This Day in Silicon Valley" social posts for milestones
// whose anniversary falls on today's date.
//
// Usage:
//   node scripts/social/generate-sv-history.mjs [--dry-run] [--window N] [--all]
//
// --window N: match milestones within ±N days of today (default 0 = exact day)
// --all:      generate posts for ALL milestones (for frontloading review queue)
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSvHistoryCopy } from "./lib/copy-gen.mjs";
import { logStep, logSuccess, logSkip, logError, logItem } from "./lib/logger.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = "/tmp/sbs-social";
const ROOT = join(__dirname, "..", "..");

// ── Load env ────────────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const envPath = join(ROOT, ".env.local");
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

// ── Parse TECH_MILESTONES from TypeScript source ────────────────────────────

function loadMilestones() {
  const filePath = join(ROOT, "src", "data", "south-bay", "tech-companies.ts");
  const src = readFileSync(filePath, "utf8");

  // Extract the TECH_MILESTONES section
  const startMarker = "export const TECH_MILESTONES";
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error("TECH_MILESTONES not found in tech-companies.ts");

  // Get from the marker to the next "export" or end of file
  const nextExport = src.indexOf("\nexport ", startIdx + 1);
  const section = nextExport !== -1
    ? src.slice(startIdx, nextExport)
    : src.slice(startIdx);

  // Parse each object block with regex for the fields we need
  const milestones = [];
  const objectPattern = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let match;

  while ((match = objectPattern.exec(section)) !== null) {
    const block = match[0];

    const getString = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*["'\`]([\\s\\S]*?)["'\`]\\s*[,}]`));
      return m ? m[1] : null;
    };
    const getNumber = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(\\d+)`));
      return m ? parseInt(m[1]) : null;
    };
    const getBool = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(true|false)`));
      return m ? m[1] === "true" : false;
    };

    const id = getString("id");
    const month = getNumber("month");
    const day = getNumber("day");
    if (!id || month === null || day === null) continue;

    milestones.push({
      id,
      company: getString("company") || id,
      city: getString("city") || "",
      foundedYear: getNumber("foundedYear") || 0,
      month,
      day,
      tagline: getString("tagline") || "",
      anniversaryNote: getString("anniversaryNote") || "",
      url: getString("url") || "",
      chmExhibit: getString("chmExhibit") || null,
      defunct: getBool("defunct"),
    });
  }

  return milestones;
}

// ── Already-seen filter ────────────────────────────────────────────────────

function loadAlreadyPosted() {
  const seen = new Set();

  // Check approved queue
  const queuePath = join(ROOT, "src", "data", "south-bay", "social-approved-queue.json");
  try {
    const queue = JSON.parse(readFileSync(queuePath, "utf8"));
    for (const item of queue) {
      if (item.postType === "sv_history" && item.item?.milestoneId) {
        seen.add(item.item.milestoneId);
      }
    }
  } catch {}

  // Check review history
  const reviewPath = join(ROOT, "src", "data", "south-bay", "social-review-history.json");
  try {
    const history = JSON.parse(readFileSync(reviewPath, "utf8"));
    for (const entry of history) {
      if (entry.postType === "sv_history" && entry.milestoneId) {
        seen.add(entry.milestoneId);
      }
    }
  } catch {}

  // Check pending post files in /tmp
  try {
    const files = readdirSync(OUTPUT_DIR).filter(
      (f) => f.startsWith("post-") && f.endsWith(".json")
    );
    for (const f of files) {
      const post = JSON.parse(readFileSync(join(OUTPUT_DIR, f), "utf8"));
      if (post.postType === "sv_history" && post.item?.milestoneId) {
        seen.add(post.item.milestoneId);
      }
    }
  } catch {}

  // Check post history (already published)
  const historyPath = join(ROOT, "src", "data", "south-bay", "social-post-history.json");
  try {
    const history = JSON.parse(readFileSync(historyPath, "utf8"));
    for (const entry of history) {
      if (entry.postType === "sv_history" && entry.milestoneId) {
        seen.add(entry.milestoneId);
      }
    }
  } catch {}

  return seen;
}

// ── PT time helpers ────────────────────────────────────────────────────────

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

// ── Find milestones matching today ±window ────────────────────────────────

function matchingMilestones(milestones, ptTime, windowDays) {
  const todayMonth = ptTime.getMonth() + 1; // 1-indexed
  const todayDay = ptTime.getDate();

  // Build a set of (month, day) pairs within the window
  const matchDates = new Set();
  for (let offset = -windowDays; offset <= windowDays; offset++) {
    const d = new Date(ptTime);
    d.setDate(d.getDate() + offset);
    matchDates.add(`${d.getMonth() + 1}-${d.getDate()}`);
  }

  return milestones.filter((m) => matchDates.has(`${m.month}-${m.day}`));
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const ptTime = getPTTime();
  const timeOfDay = getTimeOfDay(ptTime);
  const today = ptTime.toISOString().split("T")[0];

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const allMode = args.includes("--all");
  const windowIdx = args.indexOf("--window");
  const windowDays = windowIdx !== -1 ? parseInt(args[windowIdx + 1]) || 0 : 0;

  logStep("🏛️", `SV History post generation — ${today}${allMode ? " (ALL milestones)" : ` (window: ±${windowDays} days)`}`);

  // 1. Load milestones
  const milestones = loadMilestones();
  logStep("📊", `Loaded ${milestones.length} total milestones`);

  // 2. Find matches (all milestones in --all mode, date-filtered otherwise)
  const matches = allMode ? milestones : matchingMilestones(milestones, ptTime, windowDays);
  if (matches.length === 0) {
    logSkip("No milestones match today's date — nothing to generate");
    console.log("\n**SV History Posts**: No milestones today");
    process.exit(0);
  }
  logStep("🎯", `${matches.length} milestone(s) match today:`);
  for (const m of matches) {
    const age = ptTime.getFullYear() - m.foundedYear;
    logItem(`${m.company} — ${age} years (${m.month}/${m.day}/${m.foundedYear})`);
  }

  // 3. Filter already posted/reviewed
  const seen = loadAlreadyPosted();
  const fresh = matches.filter((m) => !seen.has(m.id));
  if (fresh.length === 0) {
    logSkip("All matching milestones already posted/reviewed — nothing to generate");
    console.log("\n**SV History Posts**: All milestones already processed");
    process.exit(0);
  }
  logStep("✨", `${fresh.length} fresh milestone(s) to generate`);

  // 4. Generate posts
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const posts = [];

  for (const milestone of fresh) {
    const age = ptTime.getFullYear() - milestone.foundedYear;
    logStep("✍️", `Generating copy: ${milestone.company} (${age} years)`);

    if (dryRun) {
      logItem("[DRY RUN] Skipping Claude API call");
      continue;
    }

    try {
      const copy = await generateSvHistoryCopy(milestone, ptTime);

      const post = {
        postType: "sv_history",
        date: today,
        timeOfDay,
        generatedAt: new Date().toISOString(),
        item: {
          milestoneId: milestone.id,
          title: `On This Day: ${milestone.company} (${milestone.foundedYear})`,
          company: milestone.company,
          city: milestone.city,
          cityName: milestone.city,
          foundedYear: milestone.foundedYear,
          age,
          tagline: milestone.tagline,
          anniversaryNote: milestone.anniversaryNote,
          url: milestone.url,
          chmExhibit: milestone.chmExhibit || null,
          defunct: milestone.defunct || false,
          category: "tech",
          score: 25, // fixed high score — curated content
        },
        copy,
        cardPath: null,
        targetUrl: milestone.url,
      };

      const slug = milestone.id;
      const postPath = join(OUTPUT_DIR, `post-${today}-sv-history-${slug}.json`);
      writeFileSync(postPath, JSON.stringify(post, null, 2) + "\n");

      logStep("🐦", `X (${copy.x.length} chars)`);
      logStep("🧵", `Threads (${copy.threads.length} chars)`);
      logStep("🦋", `Bluesky (${copy.bluesky.length} chars)`);

      posts.push({ path: postPath, post });
    } catch (err) {
      logError(`Copy gen failed for ${milestone.company}: ${err.message}`);
    }

    // Rate limit between Claude calls
    if (fresh.indexOf(milestone) < fresh.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  logSuccess(`Generated ${posts.length} SV History post(s)`);

  for (const p of posts) {
    console.log(`POST_FILE=${p.path}`);
  }

  console.log(`\n**SV History Posts Generated**`);
  console.log(`- Date: ${today}`);
  console.log(`- Milestones checked: ${milestones.length} total → ${matches.length} matching → ${fresh.length} fresh`);
  console.log(`- Posts generated: ${posts.length}`);
  for (const p of posts) {
    console.log(`  • ${p.post.item.company} — ${p.post.item.age} years → ${p.post.item.url}`);
  }
}

main().catch((err) => {
  logError(err.message);
  console.error(err);
  process.exit(1);
});
