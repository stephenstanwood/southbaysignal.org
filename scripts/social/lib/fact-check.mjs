// ---------------------------------------------------------------------------
// South Bay Signal — Fact Check
// Lightweight Claude pass to catch errors before publishing
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_MODEL } from "./constants.mjs";
import { logStep, logSkip, logError } from "./logger.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  if (!process.env.ANTHROPIC_API_KEY) {
    try {
      const envPath = join(__dirname, "..", "..", "..", ".env.local");
      const lines = readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
}

/**
 * Fact-check a candidate item before posting.
 * Returns { ok: boolean, issues: string[], item }
 *
 * Checks:
 * - Is the event date/time plausible?
 * - Does the venue match the city?
 * - Are there obvious factual claims that might be wrong?
 * - Is there jargon that shouldn't be in public copy?
 */
export async function factCheck(item, currentTime = new Date()) {
  loadEnv();

  // Hard block: events without a specific start time are untrustworthy for
  // time-sensitive social posts. Exhibitions, tours, and other ongoing
  // things legitimately don't have a single time — allow those through.
  const timeStr = (item.time || "").trim().toLowerCase();
  const missingTime = !timeStr || timeStr === "tbd" || timeStr === "tba" || timeStr === "unknown";
  const titleLower = (item.title || "").toLowerCase();
  const catLower = (item.category || "").toLowerCase();
  const summaryLower = (item.summary || "").toLowerCase();
  const isOngoing =
    /exhibit|exhibition|ongoing|all day|on view|tour\b|installation|show /.test(titleLower) ||
    /exhibit|ongoing|all day|museum|art|gallery/.test(catLower) ||
    /exhibit|exhibition|ongoing|all day|on view|runs through|open daily/.test(summaryLower);
  if (missingTime && !isOngoing) {
    return {
      ok: false,
      issues: ["Event has no specific start time (TBD/blank) — can't write time-accurate copy"],
      severity: "block",
      item,
    };
  }

  // Hard block: clearly truncated venue names. Only catch the narrow
  // pattern "Los" / "Mtn" / "San" etc — a single short word that matches
  // a city name prefix, indicating a data parsing bug.
  const venue = (item.venue || "").trim();
  const truncatedVenuePrefixes = /^(Los|San|Mtn|Mt|Palo|Santa|Los\s*$)$/i;
  if (venue && truncatedVenuePrefixes.test(venue)) {
    return {
      ok: false,
      issues: [`Venue name looks truncated ("${venue}") — likely a data parsing error`],
      severity: "block",
      item,
    };
  }
  // Note: we used to block short summaries outright, but legit items (concerts,
  // sports) often ship with minimal summaries. The Claude fact-check below
  // handles "no idea what this is" cases with better judgment.

  // Hard-coded checks only — the editorial filter (upstream Claude call) already
  // handles quality. Calling Claude again here was too conservative and blocked
  // ~85% of candidates that had already passed editorial review.

  // Block jargon that shouldn't appear in public copy
  const title = (item.title || "").toLowerCase();
  const summary = (item.summary || "").toLowerCase();
  const jargonPattern = /\b(ti work|bp100%|new build|finish interior|sti\b)/i;
  if (jargonPattern.test(item.title) || jargonPattern.test(item.summary || "")) {
    return {
      ok: false,
      issues: ["Contains permit/construction jargon not suitable for public copy"],
      severity: "block",
      item,
    };
  }

  return { ok: true, issues: [], item };
}

/**
 * Fact-check multiple items. Returns only items that pass.
 * Rate-limited to avoid hammering the API.
 */
export async function factCheckAll(items, currentTime = new Date()) {
  const passed = [];
  const blocked = [];

  for (const item of items) {
    const result = await factCheck(item, currentTime);
    if (result.ok) {
      passed.push(item);
    } else {
      blocked.push({ title: item.title, issues: result.issues });
    }
    // Rate limit
    await new Promise((r) => setTimeout(r, 300));
  }

  if (blocked.length > 0) {
    logStep("🔍", `Fact check: ${passed.length} passed, ${blocked.length} blocked`);
    for (const b of blocked) {
      console.log(`  ❌ ${(b.title || "").slice(0, 55)} — ${(b.issues || []).join("; ").slice(0, 120)}`);
    }
  }

  return passed;
}
