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
  // time-sensitive social posts. Ongoing exhibits (category: exhibit/ongoing)
  // are the only allowed exception.
  const timeStr = (item.time || "").trim().toLowerCase();
  const missingTime = !timeStr || timeStr === "tbd" || timeStr === "tba" || timeStr === "unknown";
  const isOngoing = /exhibit|ongoing|all day/i.test(item.category || "") ||
    /ongoing|all day|on view/i.test(item.summary || "");
  if (missingTime && !isOngoing) {
    return {
      ok: false,
      issues: ["Event has no specific start time (TBD/blank) — can't write time-accurate copy"],
      severity: "block",
      item,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logError("ANTHROPIC_API_KEY not set — skipping fact check");
    return { ok: true, issues: [], item };
  }

  const prompt = `You are a fact-checker for The South Bay Signal, a hyperlocal site for the South Bay (San Jose, Campbell, Los Gatos, Saratoga, Cupertino, Sunnyvale, Mountain View, Palo Alto, Santa Clara, Los Altos, Milpitas).

Current time: ${currentTime.toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "full", timeStyle: "short" })}

Review this item for potential issues:

Title: ${item.title}
City: ${item.cityName || item.city || "unknown"}
Venue: ${item.venue || "none"}
Date: ${item.date || "unknown"}
Time: ${item.time || "unknown"}
Category: ${item.category || "unknown"}
Source: ${item.source || "unknown"}
Summary: ${item.summary || "none"}
URL: ${item.url || "none"}

Check for:
1. TIME: Has this event already happened given the current time? (If the event time has passed today, flag it)
2. VENUE: Does the venue make sense for the city? (e.g., PayPal Park is in San Jose, Cantor is in Stanford/Palo Alto)
3. GEOGRAPHY (block): Is this event actually in the South Bay? If the URL, venue, or summary references a place outside California (e.g., Fredericksburg VA, any East Coast city, Central Rappahannock Regional Library, etc.), BLOCK it — our feed only covers the 11 South Bay cities listed above.
4. CLAIMS: Are there any claims in the title/summary that sound uncertain or potentially wrong? (e.g., calling something a "home opener" without certainty, wrong sport gender, wrong cuisine type)
5. JARGON: Does the title/summary contain construction/permit jargon that shouldn't appear in public copy? (e.g., "new build", "finish interior", "TI work", "Bp100%", "Sti")
6. STALENESS: Is the date more than 2 days in the past?

Return a JSON object:
{
  "ok": true/false,
  "issues": ["list of issues found, empty if ok"],
  "severity": "none" | "warning" | "block"
}

"block" = do not post this item
"warning" = could post but fix the issue first
"none" = looks good

Return ONLY the JSON.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      logError(`Fact check API error: ${res.status}`);
      return { ok: true, issues: [], item }; // fail open
    }

    const data = await res.json();
    const text = data.content?.[0]?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: true, issues: [], item };

    const result = JSON.parse(match[0]);

    if (result.severity === "block") {
      logSkip(`Fact check BLOCKED: ${item.title} — ${result.issues.join("; ")}`);
      return { ok: false, issues: result.issues, item };
    }

    if (result.severity === "warning") {
      logStep("⚠️", `Fact check WARNING: ${item.title} — ${result.issues.join("; ")}`);
    }

    return { ok: result.severity !== "block", issues: result.issues || [], item };
  } catch (err) {
    logError(`Fact check error: ${err.message}`);
    return { ok: true, issues: [], item }; // fail open
  }
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
  }

  return passed;
}
