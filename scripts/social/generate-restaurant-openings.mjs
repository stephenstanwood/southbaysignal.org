#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Signal — Restaurant Opening Post Generator
// Generates social posts for newly opened restaurants from SCC food openings.
//
// Two-tier strategy:
//   - All openings get a "now open" post
//   - Restaurants without blurbs are skipped (not enough info for a quality post)
//
// Usage:
//   node scripts/social/generate-restaurant-openings.mjs [--dry-run] [--all]
//
// --all:      generate for ALL openings (ignore already-posted filter)
// --dry-run:  skip Claude API calls
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { CLAUDE_MODEL } from "./lib/constants.mjs";
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

// ── System prompt for restaurant copy ─────────────────────────────────────

const SYSTEM_PROMPT = `You are the social voice of South Bay Today, a hyperlocal community tool for the South Bay (San Jose, Palo Alto, Campbell, Los Gatos, Saratoga, Cupertino, Sunnyvale, Mountain View, Santa Clara, Los Altos, Milpitas). Always refer to us as "South Bay Today" (no "The") when using our name.

VOICE:
- Sound like a friend who went there and liked it, NOT marketing copy
- Warm, specific, natural rhythm, slightly playful
- 1-3 emojis placed naturally, adding warmth not replacing words
- We INFORM, we don't ENDORSE — excited is fine, ad copy is not
- Never generic, never forced, never vague
- Never sound like the restaurant's PR team or homepage copy
- No permit/construction jargon ("new build", "finish interior", "TI work")

STRUCTURE:
- ONE restaurant per post. Full detail. ONE direct link.
- Keep within platform character limits
- The URL is part of the character count

TRUST MODEL:
- We do the legwork so people don't have to
- If we consistently deliver useful info, people seek us out
- We don't need to mention our site — it's in the bio`;

// ── Load restaurant openings ──────────────────────────────────────────────

function loadOpenings() {
  const filePath = join(ROOT, "src", "data", "south-bay", "scc-food-openings.json");
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  return data.opened || [];
}

// ── Already-seen filter ──────────────────────────────────────────────────

function loadAlreadyPosted() {
  const seen = new Set();

  // Check approved queue
  const queuePath = join(ROOT, "src", "data", "south-bay", "social-approved-queue.json");
  try {
    const queue = JSON.parse(readFileSync(queuePath, "utf8"));
    for (const item of queue) {
      if (item.postType === "restaurant_opening" && item.item?.restaurantId) {
        seen.add(item.item.restaurantId);
      }
    }
  } catch {}

  // Check review history
  const reviewPath = join(ROOT, "src", "data", "south-bay", "social-review-history.json");
  try {
    const history = JSON.parse(readFileSync(reviewPath, "utf8"));
    for (const entry of history) {
      if (entry.postType === "restaurant_opening" && entry.restaurantId) {
        seen.add(entry.restaurantId);
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
      if (post.postType === "restaurant_opening" && post.item?.restaurantId) {
        seen.add(post.item.restaurantId);
      }
    }
  } catch {}

  // Check post history (already published)
  const historyPath = join(ROOT, "src", "data", "south-bay", "social-post-history.json");
  try {
    const history = JSON.parse(readFileSync(historyPath, "utf8"));
    for (const entry of history) {
      if (entry.postType === "restaurant_opening" && entry.restaurantId) {
        seen.add(entry.restaurantId);
      }
    }
  } catch {}

  return seen;
}

// ── PT time helpers ──────────────────────────────────────────────────────

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

// ── City display names ───────────────────────────────────────────────────

const CITY_NAMES = {
  "san-jose": "San Jose",
  "palo-alto": "Palo Alto",
  campbell: "Campbell",
  "los-gatos": "Los Gatos",
  saratoga: "Saratoga",
  cupertino: "Cupertino",
  sunnyvale: "Sunnyvale",
  "mountain-view": "Mountain View",
  "santa-clara": "Santa Clara",
  "los-altos": "Los Altos",
  milpitas: "Milpitas",
};

// ── Short URL generation ─────────────────────────────────────────────────

const SHORT_URLS_FILE = join(ROOT, "src", "data", "south-bay", "short-urls.json");

function createShortUrl(longUrl, title, description) {
  const slug = randomBytes(4).toString("hex");
  const shortUrl = `https://southbaytoday.org/go/${slug}`;

  let shortUrls = {};
  try { shortUrls = JSON.parse(readFileSync(SHORT_URLS_FILE, "utf8")); } catch {}
  shortUrls[slug] = {
    url: longUrl,
    title: title || "",
    description: (description || "").slice(0, 200),
  };
  writeFileSync(SHORT_URLS_FILE, JSON.stringify(shortUrls, null, 2) + "\n");

  return shortUrl;
}

// ── Copy generation ──────────────────────────────────────────────────────

async function generateRestaurantCopy(restaurant) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const cityName = CITY_NAMES[restaurant.cityId] || restaurant.cityName;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(restaurant.name + " " + restaurant.address + " " + cityName + " CA")}`;

  // Pre-shorten the ugly Maps URL so copy is clean and has more char budget
  const shortUrl = createShortUrl(mapsUrl, `Now Open: ${restaurant.name}`, restaurant.blurb || "");
  const urlLen = shortUrl.length; // ~42 chars vs ~120+ for raw Maps URL

  const xBudget = 280 - urlLen - 2;
  const bskyBudget = 300 - urlLen - 2 - 45;
  const threadsBudget = 500 - urlLen - 2 - 45;
  const fbBudget = 500 - urlLen - 2;

  const prompt = `Write a social post announcing a new restaurant opening in the South Bay.

RESTAURANT:
- Name: ${restaurant.name}
- Address: ${restaurant.address}
- City: ${cityName}
- Opened: ${restaurant.date}
${restaurant.blurb ? `- Vibe/description: ${restaurant.blurb}` : ""}
- Link (MUST include this exact URL): ${shortUrl}

TONE:
- This is a "now open" announcement — the restaurant has already opened its doors
- Lead with the restaurant name and what makes it interesting
- Mention the neighborhood/city naturally
- If you know the cuisine type from the name or description, mention it
- Be genuinely excited but not over-the-top — treat it like telling a friend about a new spot
- Don't make up details about the menu or atmosphere that aren't in the description

CHARACTER BUDGETS — these are HARD LIMITS. The URL is ${urlLen} chars. Stay under these totals (text + URL + hashtags combined):
1. X: max 280 chars total. You have ${xBudget} chars for text, then the URL. No hashtags.
2. Threads: max 500 chars total. You have ~${threadsBudget} chars for text, then URL + 3 hashtags.
3. Bluesky: max 300 chars total. You have ~${bskyBudget} chars for text, then URL + 3 hashtags.
4. Facebook: max 500 chars total. You have ${fbBudget} chars for text, then the URL. No hashtags.

CRITICAL: Count your characters carefully. The URL "${shortUrl}" is ${urlLen} characters and MUST be included exactly as-is in every variant. If your text is too long, CUT WORDS rather than exceeding the limit.

HASHTAG RULES (for Bluesky and Threads only):
- Always include #SouthBay
- Add a city hashtag: #${cityName.replace(/\s+/g, "")}
- Add 1 topic hashtag: #NewRestaurant, #NowOpen, or #FoodScene
- Max 3 hashtags total. Place them at the very end, space-separated.

Return ONLY a JSON object with keys "x", "threads", "bluesky", "facebook" — each a string. No other text.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to extract JSON from Claude response: ${text.slice(0, 200)}`);
  }

  const variants = JSON.parse(jsonMatch[0]);

  if (!variants.x || !variants.threads || !variants.bluesky || !variants.facebook) {
    throw new Error("Missing platform variant in Claude response");
  }

  // Enforce hard character limits
  const HARD_LIMITS = { x: 280, threads: 500, bluesky: 300, facebook: 500 };
  for (const [platform, limit] of Object.entries(HARD_LIMITS)) {
    if (variants[platform].length > limit) {
      variants[platform] = trimToLimit(variants[platform], limit);
    }
  }

  return { copy: variants, mapsUrl, shortUrl };
}

/**
 * Trim a social post to fit within a character limit.
 * Preserves the URL and hashtags at the end, trims body sentences.
 */
function trimToLimit(text, limit) {
  if (text.length <= limit) return text;

  const lines = text.split("\n");
  let hashtagSuffix = "";
  while (lines.length > 1 && /^#/.test(lines[lines.length - 1].trim())) {
    hashtagSuffix = "\n" + lines.pop().trim() + hashtagSuffix;
  }
  let body = lines.join("\n").trim();

  const urlMatch = body.match(/(https?:\/\/\S+)\s*$/);
  let urlSuffix = "";
  if (urlMatch) {
    urlSuffix = " " + urlMatch[1];
    body = body.slice(0, urlMatch.index).trim();
  }

  const inlineHashMatch = body.match(/(\s+#\S+(?:\s+#\S+)*)$/);
  if (inlineHashMatch) {
    hashtagSuffix = inlineHashMatch[1] + hashtagSuffix;
    body = body.slice(0, inlineHashMatch.index).trim();
  }

  const suffix = urlSuffix + hashtagSuffix;

  while (body.length + suffix.length > limit && body.includes(". ")) {
    const lastSentence = body.lastIndexOf(". ");
    body = body.slice(0, lastSentence + 1).trim();
  }

  const maxBody = limit - suffix.length - 1;
  if (body.length > maxBody) {
    body = body.slice(0, maxBody - 1).trim() + "…";
  }

  return (body + suffix).trim();
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const ptTime = getPTTime();
  const timeOfDay = getTimeOfDay(ptTime);
  const today = ptTime.toISOString().split("T")[0];

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const allMode = args.includes("--all");

  logStep("🍽️", `Restaurant opening post generation — ${today}`);

  // 1. Load openings
  const openings = loadOpenings();
  logStep("📊", `Loaded ${openings.length} recent restaurant openings`);

  // 2. Filter to ones with blurbs (quality gate) + chain/restaurant blocklist
  // Add IDs here to permanently suppress a specific restaurant (e.g. user feedback)
  const BLOCKED_IDS = new Set([
    "opened-SR0881234", // Itaiwan Food — user feedback: do not suggest
  ]);

  const CHAIN_BLOCKLIST = [
    "sbarro", "starbucks", "subway", "mcdonald", "burger king", "wendy", "taco bell",
    "chipotle", "panera", "dunkin", "jack in the box", "carl's jr", "popeyes", "kfc",
    "domino", "pizza hut", "papa john", "little caesars", "panda express", "chick-fil-a",
    "jersey mike", "jimmy john", "quiznos", "baskin-robbins", "dairy queen", "7-eleven",
  ];
  const isChain = (r) => {
    const name = (r.name || r.title || "").toLowerCase();
    return CHAIN_BLOCKLIST.some((c) => name.includes(c));
  };
  const withBlurbs = openings.filter((r) => r.blurb && !isChain(r) && !BLOCKED_IDS.has(r.id));
  logStep("✅", `${withBlurbs.length} have blurbs (quality-gated, chains excluded)`);

  if (withBlurbs.length === 0) {
    logSkip("No restaurant openings with blurbs — nothing to generate");
    process.exit(0);
  }

  // 3. Filter already posted/reviewed
  const seen = loadAlreadyPosted();
  const fresh = allMode ? withBlurbs : withBlurbs.filter((r) => !seen.has(r.id));
  if (fresh.length === 0) {
    logSkip("All restaurant openings already posted/reviewed — nothing to generate");
    console.log("\n**Restaurant Posts**: All openings already processed");
    process.exit(0);
  }
  logStep("✨", `${fresh.length} fresh opening(s) to generate`);

  // 4. Generate posts
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const posts = [];

  for (const restaurant of fresh) {
    const cityName = CITY_NAMES[restaurant.cityId] || restaurant.cityName;
    logStep("✍️", `Generating copy: ${restaurant.name} (${cityName})`);

    if (dryRun) {
      logItem("[DRY RUN] Skipping Claude API call");
      continue;
    }

    try {
      const { copy, mapsUrl, shortUrl } = await generateRestaurantCopy(restaurant);

      const post = {
        postType: "restaurant_opening",
        date: today,
        timeOfDay,
        generatedAt: new Date().toISOString(),
        item: {
          restaurantId: restaurant.id,
          title: `Now Open: ${restaurant.name}`,
          name: restaurant.name,
          address: restaurant.address,
          city: restaurant.cityId,
          cityName,
          date: restaurant.date,
          blurb: restaurant.blurb,
          category: "food",
          score: 22, // slightly below curated sv_history but above average events
          url: shortUrl,
          mapsUrl,
        },
        copy,
        cardPath: null,
        targetUrl: shortUrl,
      };

      const slug = restaurant.id.replace(/[^a-z0-9-]/gi, "-");
      const postPath = join(OUTPUT_DIR, `post-${today}-restaurant-${slug}.json`);
      writeFileSync(postPath, JSON.stringify(post, null, 2) + "\n");

      logStep("🐦", `X (${copy.x.length} chars)`);
      logStep("🧵", `Threads (${copy.threads.length} chars)`);
      logStep("🦋", `Bluesky (${copy.bluesky.length} chars)`);

      posts.push({ path: postPath, post });
    } catch (err) {
      logError(`Copy gen failed for ${restaurant.name}: ${err.message}`);
    }

    // Rate limit between Claude calls
    if (fresh.indexOf(restaurant) < fresh.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  logSuccess(`Generated ${posts.length} restaurant opening post(s)`);

  for (const p of posts) {
    console.log(`POST_FILE=${p.path}`);
  }

  console.log(`\n**Restaurant Opening Posts Generated**`);
  console.log(`- Date: ${today}`);
  console.log(`- Openings: ${openings.length} total → ${withBlurbs.length} with blurbs → ${fresh.length} fresh`);
  console.log(`- Posts generated: ${posts.length}`);
  for (const p of posts) {
    console.log(`  • ${p.post.item.name} — ${p.post.item.cityName} → ${p.post.targetUrl}`);
  }

  // Commit + push short-urls.json immediately so the /go/ links referenced
  // in the newly-generated copy actually resolve on Vercel. Waiting for the
  // publisher's auto-commit caused broken links for hours (2026-04-11).
  if (posts.length > 0) {
    try {
      const { execSync } = await import("node:child_process");
      const cwd = ROOT;
      execSync("git add src/data/south-bay/short-urls.json", { cwd, stdio: "pipe" });
      const staged = execSync("git diff --cached --name-only", { cwd }).toString().trim();
      if (staged) {
        execSync(`git commit -m "data: short urls for ${posts.length} new restaurant opening(s)"`, { cwd, stdio: "pipe" });
        execSync("git pull --rebase", { cwd, stdio: "pipe" });
        execSync("git push", { cwd, stdio: "pipe" });
        console.log("✅ Committed + pushed short-urls.json");
      }
    } catch (e) {
      console.warn("⚠️  Failed to auto-commit short-urls.json:", e.message);
    }
  }
}

main().catch((err) => {
  logError(err.message);
  console.error(err);
  process.exit(1);
});
