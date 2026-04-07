#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Signal — Publish From Queue
// Pulls approved posts from the queue, checks time-relevance,
// rewrites time references for publish day, and posts to all platforms.
//
// Usage: node scripts/social/publish-from-queue.mjs [--max N] [--dry-run]
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { CONFIG } from "./lib/constants.mjs";

import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-approved-queue.json");
const HISTORY_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-post-history.json");
const SHORT_URLS_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "short-urls.json");

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

const args = process.argv.slice(2);
const maxPosts = parseInt(args.find((a, i) => args[i - 1] === "--max") || "2");
const dryRun = args.includes("--dry-run") || CONFIG.DRY_RUN;

// ── Time helpers ───────────────────────────────────────────────────────────

function getPTTime() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
}

function parseEventDate(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr + "T12:00:00");
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
 * Get the effective event date from a post entry.
 * Checks both post-level date and item-level date.
 */
function getEventDate(post) {
  return post.item?.date || post.date || null;
}

/**
 * Check if an event is still relevant for posting right now.
 * Must be at least 2 hours in the future.
 * Accepts a full post entry (not just item) to check both date sources.
 */
function isTimeRelevant(post, ptTime) {
  const today = ptTime.toISOString().split("T")[0];
  const currentHour = ptTime.getHours();
  const currentMinute = ptTime.getMinutes();
  const currentTotalMinutes = currentHour * 60 + currentMinute;

  const eventDate = getEventDate(post);

  // No date = ongoing, always relevant
  if (!eventDate) return true;

  // Past dates = expired
  if (eventDate < today) return false;

  // Future dates = relevant
  if (eventDate > today) return true;

  // Today: check if event is at least 2 hours away
  const item = post.item || post;
  if (eventDate === today && item.time) {
    const eventHour = parseEventHour(item.time);
    if (eventHour !== null) {
      const eventMinutes = eventHour * 60;
      if (eventMinutes - currentTotalMinutes < 120) {
        return false; // less than 2 hours away or already passed
      }
    }
  }

  return true;
}

// ── Time reference rewriting ───────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function getRelativeDayLabel(eventDate, publishDate) {
  if (!eventDate) return null;
  const event = new Date(eventDate + "T12:00:00");
  const publish = new Date(publishDate + "T12:00:00");
  const diffDays = Math.round((event - publish) / 86400000);

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return null; // yesterday, shouldn't happen
  if (diffDays >= 2 && diffDays <= 6) return DAY_NAMES[event.getDay()];
  return null; // more than a week out, leave as-is
}

/**
 * Rewrite day/time references in copy to match the actual publish date.
 * e.g., if event is on Wednesday and we're posting on Wednesday,
 * replace "Wednesday" with "today" / "Tonight" etc.
 */
function rewriteTimeReferences(text, item, ptTime) {
  const publishDate = ptTime.toISOString().split("T")[0];
  const relativeLabel = getRelativeDayLabel(item.date, publishDate);

  if (!relativeLabel) return text;

  const eventDate = new Date(item.date + "T12:00:00");
  const eventDayName = DAY_NAMES[eventDate.getDay()];

  let result = text;

  // Replace day name references
  // "Wednesday" → "today", "Tuesday" → "tomorrow", etc.
  const dayPattern = new RegExp(`\\b${eventDayName}\\b`, "gi");
  result = result.replace(dayPattern, (match) => {
    // Preserve capitalization
    if (relativeLabel === "today" || relativeLabel === "tomorrow") {
      return match[0] === match[0].toUpperCase()
        ? relativeLabel.charAt(0).toUpperCase() + relativeLabel.slice(1)
        : relativeLabel;
    }
    return match; // same day name, no change needed
  });

  // Handle "this afternoon/evening/morning" references for today
  if (relativeLabel === "today") {
    const hour = ptTime.getHours();
    const eventHour = parseEventHour(item.time);

    // Replace "this afternoon" with "tonight" if it's evening
    if (hour >= 17 && eventHour && eventHour >= 17) {
      result = result.replace(/\bthis afternoon\b/gi, "tonight");
    }
    // Replace "tonight" with "this afternoon" if it's morning/afternoon event
    if (hour < 17 && eventHour && eventHour < 17) {
      result = result.replace(/\btonight\b/gi, "this afternoon");
    }
  }

  // "Tomorrow" references when event is actually today
  if (relativeLabel === "today") {
    result = result.replace(/\btomorrow\b/gi, (match) =>
      match[0] === match[0].toUpperCase() ? "Today" : "today"
    );
  }

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const ptTime = getPTTime();
  const today = ptTime.toISOString().split("T")[0];
  const timeStr = ptTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  console.log(`\n📤 Publish from queue — ${today} ${timeStr}`);

  // Load queue
  if (!existsSync(QUEUE_FILE)) {
    console.log("No queue file found.");
    return;
  }
  const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  const unpublished = queue.filter((p) => !p.published);
  console.log(`   ${unpublished.length} unpublished in queue`);

  if (unpublished.length === 0) {
    console.log("   Nothing to publish.");
    return;
  }

  // Sweep: expire items whose date is fully in the past (before today in PT)
  let expiredCount = 0;
  for (const p of queue) {
    if (p.published) continue;
    const eventDate = getEventDate(p);
    if (eventDate && eventDate < today) {
      p.published = true;
      p.publishedAt = new Date().toISOString();
      p.publishResult = "expired";
      expiredCount++;
    }
  }
  if (expiredCount > 0) {
    console.log(`   ${expiredCount} expired (date in the past)`);
  }

  // Filter remaining unpublished to time-relevant items (today <2hr, etc.)
  const stillUnpublished = queue.filter((p) => !p.published);
  const relevant = stillUnpublished.filter((p) => isTimeRelevant(p, ptTime));
  const tooSoon = stillUnpublished.length - relevant.length;
  if (tooSoon > 0) {
    console.log(`   ${tooSoon} skipped (<2hr lead time)`);
    // Mark too-soon items as expired
    for (const p of stillUnpublished) {
      if (!isTimeRelevant(p, ptTime)) {
        p.published = true;
        p.publishedAt = new Date().toISOString();
        p.publishResult = "expired";
      }
    }
  }

  if (relevant.length === 0) {
    console.log("   No time-relevant items to publish.");
    writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
    return;
  }

  // ── Smart scheduling: score posts by publish-time relevance ──────────
  // Principles:
  // - Today/tomorrow events get top priority (urgent)
  // - Weekend events shouldn't be promoted Mon-Tue (too early, awkward)
  //   → best promoted starting Thu/Fri
  // - Between equal-quality posts, pick the soonest event
  // - Events 5+ days out get low priority (wait until closer)
  function publishRelevanceScore(post) {
    const eventDate = getEventDate(post);
    if (!eventDate) return 50; // no date = filler, medium priority

    const event = new Date(eventDate + "T12:00:00");
    const publish = new Date(today + "T12:00:00");
    const daysUntil = Math.round((event - publish) / 86400000);
    const publishDow = ptTime.getDay(); // 0=Sun, 6=Sat
    const eventDow = event.getDay();

    // Already past = should not be here, but just in case
    if (daysUntil < 0) return -100;

    // Today = highest priority
    if (daysUntil === 0) return 100;

    // Tomorrow = very high priority
    if (daysUntil === 1) return 90;

    // Weekend events (Sat/Sun)
    const isWeekendEvent = eventDow === 0 || eventDow === 6;
    if (isWeekendEvent) {
      // Mon/Tue: too early to promote weekend events
      if (publishDow === 1 || publishDow === 2) return 10;
      // Wed: acceptable but not ideal
      if (publishDow === 3) return 40;
      // Thu/Fri: perfect time to promote weekend events
      if (publishDow === 4 || publishDow === 5) return 80;
    }

    // 2-3 days out = good timing
    if (daysUntil >= 2 && daysUntil <= 3) return 70;

    // 4-5 days out = acceptable
    if (daysUntil >= 4 && daysUntil <= 5) return 40;

    // 6+ days out = wait, too far
    return 15;
  }

  // Combine timing relevance with item quality for final ranking.
  // Timing is the primary signal (is now the right moment to post this?),
  // quality is the secondary signal (given equal timing, prefer better stuff).
  function combinedScore(post) {
    const timing = publishRelevanceScore(post);
    const quality = post.item?.score || 0;
    // Timing dominates (scaled 0-100), quality adds refinement (typically 20-30)
    return timing * 10 + quality;
  }

  relevant.sort((a, b) => {
    const scoreA = combinedScore(a);
    const scoreB = combinedScore(b);
    if (scoreB !== scoreA) return scoreB - scoreA;
    // Tie-break: soonest event first
    const dateA = getEventDate(a) || "9999";
    const dateB = getEventDate(b) || "9999";
    return dateA.localeCompare(dateB);
  });

  // Log the scoring for transparency
  for (const p of relevant.slice(0, 5)) {
    const timing = publishRelevanceScore(p);
    const quality = p.item?.score || 0;
    const title = (p.item?.title || "").slice(0, 40);
    const eventDate = getEventDate(p);
    console.log(`   ${timing >= 70 ? "🟢" : timing >= 40 ? "🟡" : "🔴"} [t:${timing} q:${quality}] ${title} (${eventDate})`);
  }
  if (relevant.length > 5) console.log(`   ... and ${relevant.length - 5} more`);
  console.log();

  // Filter out low-relevance posts — they'll score better later in the week
  const MIN_TIMING_SCORE = 30;
  const publishable = relevant.filter((p) => publishRelevanceScore(p) >= MIN_TIMING_SCORE);
  if (publishable.length < relevant.length) {
    console.log(`   ${relevant.length - publishable.length} posts held back (low relevance score, will promote later)`);
  }

  // Take up to maxPosts
  const toPublish = publishable.slice(0, maxPosts);
  console.log(`   Publishing ${toPublish.length} posts:\n`);

  for (const post of toPublish) {
    const item = post.item || {};
    const effectiveDate = getEventDate(post);
    console.log(`   📌 ${item.title} (${item.cityName || ""}, ${effectiveDate} ${item.time || ""})`);

    // Rewrite time references — use effective date (post-level or item-level)
    const rewriteItem = { ...item, date: effectiveDate };
    const rewrittenCopy = {};
    for (const [platform, text] of Object.entries(post.copy || {})) {
      rewrittenCopy[platform] = rewriteTimeReferences(text, rewriteItem, ptTime);
      if (rewrittenCopy[platform] !== text) {
        console.log(`      ✏️  ${platform}: time refs rewritten`);
      }
    }

    // Fetch og:image from the target URL for richer social cards
    const targetUrl = item.url || post.targetUrl;
    let ogImage = "";
    if (targetUrl) {
      try {
        const ogRes = await fetch(targetUrl, {
          headers: { "User-Agent": "SouthBaySignalBot/1.0 (link preview)" },
          redirect: "follow",
          signal: AbortSignal.timeout(8000),
        });
        if (ogRes.ok) {
          const html = await ogRes.text();
          const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
          if (m) ogImage = m[1];
        }
      } catch { /* skip — og:image is best-effort */ }
      if (ogImage) console.log(`      🖼️  og:image: ${ogImage.slice(0, 80)}...`);
    }

    // Shorten long URLs for cleaner posts
    if (targetUrl && targetUrl.length > 80) {
      const shortSlug = randomBytes(4).toString("hex");
      const shortUrl = `https://southbaysignal.org/go/${shortSlug}`;
      // Save to short-urls.json with metadata for OG tags
      let shortUrls = {};
      try { shortUrls = JSON.parse(readFileSync(SHORT_URLS_FILE, "utf8")); } catch {}
      const entry = {
        url: targetUrl,
        title: item.title || "",
        description: (item.summary || item.description || "").slice(0, 200),
      };
      if (ogImage) entry.image = ogImage;
      shortUrls[shortSlug] = entry;
      writeFileSync(SHORT_URLS_FILE, JSON.stringify(shortUrls, null, 2) + "\n");
      // Replace URL in all platform copies
      for (const [platform, text] of Object.entries(rewrittenCopy)) {
        rewrittenCopy[platform] = text.replace(targetUrl, shortUrl);
      }
      console.log(`      🔗 URL shortened: ${shortUrl} → ${targetUrl.slice(0, 60)}...`);
    }

    if (dryRun) {
      console.log(`      🏜️  DRY RUN — would publish:`);
      for (const [platform, text] of Object.entries(rewrittenCopy)) {
        console.log(`      [${platform}] ${text.slice(0, 100)}...`);
      }
      console.log();
      continue;
    }

    // ── PRE-PUBLISH GUARD ──────────────────────────────────────────────
    // Final timeliness check right before posting. Even if the post passed
    // the earlier filter, time may have elapsed (og:image fetch, URL
    // shortening, etc.) or the date fields may have been missed earlier.
    // This is the last line of defense against posting stale events.
    const guardTime = getPTTime();
    const guardToday = guardTime.toISOString().split("T")[0];
    const eventDate = getEventDate(post);
    if (eventDate && eventDate < guardToday) {
      console.log(`      ⛔ PRE-PUBLISH GUARD: event date ${eventDate} is in the past — skipping`);
      post.published = true;
      post.publishedAt = new Date().toISOString();
      post.publishResult = "expired-guard";
      continue;
    }
    // Also check the copy itself for obviously stale day-of-week references
    const guardDayName = DAY_NAMES[guardTime.getDay()];
    const eventDayName = eventDate ? DAY_NAMES[new Date(eventDate + "T12:00:00").getDay()] : null;
    const firstCopy = Object.values(rewrittenCopy)[0] || "";
    if (eventDate && eventDate === guardToday && eventDayName) {
      // If copy says "Sunday" but it's Tuesday, something is wrong
      const wrongDayPattern = new RegExp(`\\b${eventDayName}\\b`, "i");
      if (eventDayName !== guardDayName && wrongDayPattern.test(firstCopy)) {
        console.log(`      ⛔ PRE-PUBLISH GUARD: copy references "${eventDayName}" but today is ${guardDayName} — skipping`);
        post.published = true;
        post.publishedAt = new Date().toISOString();
        post.publishResult = "expired-guard-dayname";
        continue;
      }
    }

    // Publish to each platform
    const platforms = ["x", "bluesky", "threads", "facebook"];
    const publishResults = [];

    for (const platform of platforms) {
      const copy = rewrittenCopy[platform];
      if (!copy) continue;

      try {
        const client = await import(`./lib/platforms/${platform}.mjs`);
        // Pass og:image to Threads as image URL (it needs a public URL, not a buffer)
        const result = platform === "threads" && ogImage
          ? await client.publish(copy, ogImage)
          : await client.publish(copy);
        console.log(`      ✅ ${platform}: ${JSON.stringify(result)}`);
        publishResults.push({
          platform,
          ok: true,
          postId: result.id || result.uri || null,
          ...result,
        });
      } catch (err) {
        console.log(`      ❌ ${platform}: ${err.message}`);
        publishResults.push({ platform, ok: false, error: err.message });
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    // Mark as published in queue with structured results
    post.published = true;
    post.publishedAt = new Date().toISOString();
    post.publishedTo = publishResults;
    post.rewrittenCopy = rewrittenCopy;
    console.log();
  }

  // Save updated queue
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");

  // Commit and push queue changes
  const repoRoot = join(__dirname, "..", "..");
  try {
    const status = execSync("git status --porcelain src/data/south-bay/social-approved-queue.json src/data/south-bay/social-review-history.json", { cwd: repoRoot, encoding: "utf8" }).trim();
    if (status) {
      execSync("git add src/data/south-bay/social-approved-queue.json", { cwd: repoRoot });
      const historyPath = join(repoRoot, "src", "data", "south-bay", "social-review-history.json");
      if (existsSync(historyPath)) {
        execSync("git add src/data/south-bay/social-review-history.json", { cwd: repoRoot });
      }
      execSync('git commit -m "social: auto-publish queue update"', { cwd: repoRoot });
      execSync("git push", { cwd: repoRoot });
      console.log("   📦 Queue changes committed and pushed");
    } else {
      console.log("   📦 No queue changes to commit");
    }
  } catch (err) {
    console.error("   ⚠️  Git commit/push failed:", err.message);
  }

  // Summary + structured output for discord-notify.py
  const processedPosts = toPublish.filter((p) => p.publishedTo);
  const totalPublished = processedPosts.length;
  console.log(`\n✅ Published ${totalPublished} posts`);
  console.log(`   ${queue.filter((p) => !p.published).length} remaining in queue`);

  if (!dryRun && toPublish.length > 0) {
    const allResults = processedPosts.flatMap((p) => p.publishedTo || []);
    const succeededPlatforms = [...new Set(allResults.filter((r) => r.ok).map((r) => r.platform))];
    const failedPlatforms = [...new Set(allResults.filter((r) => !r.ok).map((r) => r.platform))];
    const summaryItems = processedPosts.map((p) => ({
      title: p.item?.title || "(unknown)",
      platforms: (p.publishedTo || []).filter((r) => r.ok).map((r) => r.platform),
      postIds: Object.fromEntries(
        (p.publishedTo || []).filter((r) => r.ok && r.postId).map((r) => [r.platform, r.postId])
      ),
      copy: Object.values(p.rewrittenCopy || {})[0]?.slice(0, 100) || "",
    }));
    const publishSummary = {
      published: totalPublished,
      succeeded: succeededPlatforms,
      failed: failedPlatforms,
      items: summaryItems,
    };
    console.log(`\nPUBLISH_SUMMARY:${JSON.stringify(publishSummary)}`);

    if (totalPublished > 0 && succeededPlatforms.length === 0) {
      console.error("PUBLISH_FAILED: All platforms failed");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Publish error:", err);
  process.exit(1);
});
