// ---------------------------------------------------------------------------
// South Bay Today — Editorial Pre-Filter
// One Claude call ranks a batch of scored candidates and picks the best N
// worth writing a social post about. Catches stuff heuristics miss:
// - boring bureaucratic meetings that score fine locally
// - narrow-audience programs (toddler storytime, adults-only book clubs)
// - internal/niche events that slipped past the signal blocklist
// - generic events with nothing interesting to say
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_MODEL } from "./constants.mjs";
import { logStep, logError } from "./logger.mjs";

const __editorial_dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  if (!process.env.ANTHROPIC_API_KEY) {
    try {
      const envPath = join(__editorial_dirname, "..", "..", "..", ".env.local");
      const lines = readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
}

/**
 * Run an editorial filter pass on a scored candidate list.
 * Single Claude call. Returns items sorted by editorial rank.
 *
 * @param {Array} candidates - Scored candidates from scoreAndRank
 * @param {number} targetCount - How many to pick
 * @returns {Promise<Array>} Picked candidates in editorial order
 */
export async function editorialFilter(candidates, targetCount) {
  loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logError("ANTHROPIC_API_KEY not set — skipping editorial filter");
    return candidates.slice(0, targetCount);
  }

  if (candidates.length <= targetCount) return candidates;

  // Consider up to 60 candidates — enough to be thorough, cheap to evaluate.
  const pool = candidates.slice(0, Math.min(60, candidates.length));

  const manifest = pool.map((c, i) => ({
    id: i,
    title: (c.title || "").slice(0, 120),
    city: c.cityName || c.city || "",
    venue: (c.venue || "").slice(0, 60),
    date: c.date || "",
    time: c.time || "",
    category: c.category || "",
    source: c.source || "",
    summary: (c.summary || "").slice(0, 180),
  }));

  const prompt = `You are the social editor for South Bay Today, a hyperlocal social feed (Instagram/Bluesky/Threads/X) for the South Bay (San Jose, Palo Alto, Campbell, Los Gatos, Saratoga, Cupertino, Sunnyvale, Mountain View, Santa Clara, Los Altos, Milpitas).

Your job: pick the ${targetCount} items below that are actually WORTH a social post. We want things people would stop scrolling for.

CANDIDATES (${pool.length}):
${JSON.stringify(manifest, null, 2)}

EDITORIAL RULES (reject any that violate):
- REJECT routine civic meetings (commission meetings, council regular meetings, task force meetings, planning hearings) unless the agenda is genuinely newsworthy
- REJECT narrow-audience library programs for very specific age bands (toddler storytime, "Grades 3-4 book club", "Ages 2-5") — they're fine events but not social-post-worthy for a general feed
- REJECT university staff/faculty trainings, internal events, Greek life, campus ministry, student-only events
- REJECT generic recurring programs ("weekly yoga", "monthly book club") unless the specific session has a distinctive hook
- REJECT events with vague/missing descriptions — if you can't tell what it is, don't post about it
- REJECT anything that sounds like a press release, dry announcement, or bureaucratic notice
- PREFER named artists/performers (concerts, comedy, author talks)
- PREFER one-time unique events (festivals, markets, openings, exhibits, fundraisers)
- PREFER sports with named teams and specific matchups
- PREFER family events with specific appeal ("butterfly release", "dinosaur show") over generic kids programs
- PREFER things with a clear interesting hook you can actually write about

Date awareness: we want spread across the next 1-2 weeks. Don't pick 10 things on the same day.

Return ONLY a JSON object with this shape:
{
  "picks": [
    {"id": 0, "reason": "short one-sentence rationale"},
    ...
  ]
}

Order picks from best to worst. Return exactly ${targetCount} items (or fewer if fewer than ${targetCount} are genuinely worth posting about). Do not include any text outside the JSON.`;

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
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      logError(`Editorial filter API error ${res.status} — falling back to score order`);
      return candidates.slice(0, targetCount);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logError("Editorial filter returned no JSON — falling back to score order");
      return candidates.slice(0, targetCount);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const picks = Array.isArray(parsed.picks) ? parsed.picks : [];
    const picked = [];
    for (const p of picks) {
      if (typeof p.id === "number" && pool[p.id]) {
        // Return the ORIGINAL full candidate (with .url, .id, etc.), not the
        // manifest projection. Attach the editorial reason for logging.
        picked.push({ ...pool[p.id], editorialReason: p.reason });
      }
    }

    logStep("🎯", `Editorial filter kept ${picked.length}/${pool.length} candidates`);
    for (const p of picked.slice(0, 10)) {
      console.log(`  ✓ ${(p.title || "").slice(0, 60)} — ${p.editorialReason || ""}`);
    }
    if (picked.length < picks.length) {
      console.log(`  (${picks.length - picked.length} invalid IDs from model)`);
    }

    return picked;
  } catch (err) {
    logError(`Editorial filter failed: ${err.message || err} — falling back to score order`);
    return candidates.slice(0, targetCount);
  }
}
