export const prerender = false;

// ---------------------------------------------------------------------------
// South Bay Today — Day-Planning Engine
// ---------------------------------------------------------------------------
// POST /api/plan-day
// Input:  { city, kids, lockedIds, dismissedIds, currentHour }
// Output: { cards: [...], weather }
//
// 1. Load places + today's events + weather
// 2. Score & filter a candidate pool (~25 items)
// 3. Call Claude Haiku to sequence into a 5-6 card day plan
// ---------------------------------------------------------------------------

import type { APIRoute } from "astro";
import Anthropic from "@anthropic-ai/sdk";
import { errJson, okJson, toErrMsg } from "../../lib/apiHelpers";
import { rateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { CLAUDE_HAIKU, extractText, stripFences } from "../../lib/models";
import { CITY_MAP, getCityName } from "../../lib/south-bay/cities";
import type { City } from "../../lib/south-bay/types";

import placesData from "../../data/south-bay/places.json";
import eventsData from "../../data/south-bay/upcoming-events.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlanRequest {
  city: City;
  kids: boolean;
  lockedIds?: string[];
  dismissedIds?: string[];
  currentHour?: number; // 0-23, defaults to now
}

interface Candidate {
  id: string;
  name: string;
  category: string;
  city: string;
  address: string;
  description?: string;
  why?: string;
  rating?: number | null;
  cost?: string | null;
  costNote?: string | null;
  kidFriendly?: boolean | null;
  indoorOutdoor?: string | null;
  url?: string | null;
  mapsUrl?: string | null;
  hours?: Record<string, string> | null;
  source: "event" | "place";
  eventDate?: string;
  eventTime?: string | null;
  score: number;
}

interface DayCard {
  id: string;
  name: string;
  category: string;
  city: string;
  address: string;
  timeBlock: string;
  blurb: string;
  why: string;
  url?: string | null;
  mapsUrl?: string | null;
  cost?: string | null;
  costNote?: string | null;
  photoRef?: string | null;
  source: "event" | "place";
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CITIES = new Set(Object.keys(CITY_MAP));
const MAX_CARDS = 6;
const CANDIDATE_POOL_SIZE = 30;

// Distance threshold in km for "nearby" places
const NEARBY_KM = 15;

// Category diversity: max items of same category in final plan
// const MAX_SAME_CATEGORY = 2; // reserved for future client-side enforcement

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function currentPTHour(): number {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hour12: false,
  }) as unknown as number;
}

// ---------------------------------------------------------------------------
// Weather fetch (internal, same-origin)
// ---------------------------------------------------------------------------

async function fetchWeather(city: City): Promise<{ weather: string | null; forecast: any[] | null }> {
  try {
    // In serverless, we can't call ourselves — read from Open-Meteo directly
    const cityConfig = CITY_MAP[city];
    if (!cityConfig) return { weather: null, forecast: null };

    const url = [
      `https://api.open-meteo.com/v1/forecast`,
      `?latitude=${cityConfig.lat}&longitude=${cityConfig.lon}`,
      `&current=temperature_2m,weather_code`,
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
      `&temperature_unit=fahrenheit`,
      `&timezone=America%2FLos_Angeles`,
      `&forecast_days=1`,
    ].join("");

    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { weather: null, forecast: null };
    const data = await res.json();

    const temp = Math.round(data.current.temperature_2m);
    const high = Math.round(data.daily.temperature_2m_max[0]);
    const low = Math.round(data.daily.temperature_2m_min[0]);
    const rainPct = data.daily.precipitation_probability_max[0] ?? 0;
    const weatherCode = data.current.weather_code as number;

    // Simplified weather classification for scoring
    const isRainy = rainPct > 50 || [61, 63, 65, 71, 73, 75, 80, 81, 82, 95, 96, 99].includes(weatherCode);
    const isHot = high > 90;
    const isCold = high < 55;
    const isNice = !isRainy && !isHot && !isCold;

    return {
      weather: `${temp}°F, high ${high}°F${rainPct >= 5 ? `, ${rainPct}% rain chance` : ""}`,
      forecast: [{ high, low, rainPct, isRainy, isHot, isCold, isNice, weatherCode }],
    };
  } catch {
    return { weather: null, forecast: null };
  }
}

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

interface WeatherContext {
  isRainy: boolean;
  isHot: boolean;
  isCold: boolean;
  isNice: boolean;
}

function scoreCandidates(
  candidates: Candidate[],
  weather: WeatherContext | null,
  hour: number,
  kids: boolean,
): Candidate[] {
  for (const c of candidates) {
    let score = 0;

    // --- Source priority ---
    // Today-only events are the most valuable
    if (c.source === "event") {
      score += 50;
      // Events happening today get extra boost
      if (c.eventDate === todayStr()) score += 30;
    }

    // --- Rating boost ---
    if (c.rating && c.rating >= 4.5) score += 15;
    else if (c.rating && c.rating >= 4.0) score += 5;

    // --- Curated places are premium ---
    if ((c as any).curated) score += 20;

    // --- Kid-friendliness ---
    if (kids && c.kidFriendly === true) score += 15;
    if (kids && c.kidFriendly === false) score -= 40; // strong penalty

    // --- Weather appropriateness ---
    if (weather) {
      if (weather.isRainy && c.indoorOutdoor === "outdoor") score -= 25;
      if (weather.isRainy && c.indoorOutdoor === "indoor") score += 15;
      if (weather.isNice && c.indoorOutdoor === "outdoor") score += 15;
      if (weather.isHot && c.indoorOutdoor === "indoor") score += 10;
    }

    // --- Time slot relevance ---
    const bestSlots = (c as any).bestSlots as string[] | undefined;
    if (bestSlots?.length) {
      const currentSlot = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
      if (bestSlots.includes(currentSlot)) score += 10;
    }

    // --- Cost preference (free/low preferred) ---
    if (c.cost === "free") score += 5;

    // --- Penalize generic neighborhood entries — specific places are always better ---
    if (c.category === "neighborhood") score -= 30;

    // --- Small random jitter for variety ---
    score += Math.random() * 10;

    c.score = score;
  }

  return candidates.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Build candidate pool
// ---------------------------------------------------------------------------

function buildCandidatePool(
  city: City,
  kids: boolean,
  dismissedIds: Set<string>,
  lockedIds: Set<string>,
): Candidate[] {
  const candidates: Candidate[] = [];
  const cityConfig = CITY_MAP[city];
  const today = todayStr();

  // --- Events happening today or soon, in/near the city ---
  const events = (eventsData as any).events ?? [];
  for (const evt of events) {
    if (dismissedIds.has(`event:${evt.id}`)) continue;

    // Only today's events — ongoing exhibitions ok, but skip future single-day events
    const isToday = evt.date === today;
    const isOngoingExhibition = evt.ongoing && !evt.date; // no specific date = true ongoing
    const isOngoingPastStart = evt.ongoing && evt.date && evt.date <= today;
    if (!isToday && !isOngoingExhibition && !isOngoingPastStart) continue;

    // Must be in our city or a nearby city
    const evtCity = evt.city as City;
    if (evtCity !== city) {
      // Check distance if both have coords
      const evtCityConfig = CITY_MAP[evtCity];
      if (!evtCityConfig || !cityConfig) continue;
      const dist = haversineKm(cityConfig.lat, cityConfig.lon, evtCityConfig.lat, evtCityConfig.lon);
      if (dist > NEARBY_KM) continue;
    }

    candidates.push({
      id: `event:${evt.id}`,
      name: evt.title,
      category: evt.category || "events",
      city: evt.city,
      address: evt.address || evt.venue || "",
      description: evt.description?.slice(0, 200),
      cost: evt.cost,
      kidFriendly: evt.kidFriendly ?? null,
      url: evt.url,
      source: "event",
      eventDate: evt.date,
      eventTime: evt.time,
      score: 0,
    });
  }

  // --- Places from the pool ---
  // Venue-only types: only useful if there's an actual event today
  const VENUE_ONLY_TYPES = new Set([
    "performing_arts_theater", "concert_hall", "amphitheatre",
    "event_venue", "convention_center", "stadium", "arena",
    "live_music_venue", "comedy_club",
  ]);

  const places = (placesData as any).places ?? [];
  for (const p of places) {
    if (dismissedIds.has(`place:${p.id}`)) continue;

    // Skip venue-only places — these need a specific event to be useful
    const primaryType = p.primaryType || "";
    const types: string[] = p.types || [];
    if (VENUE_ONLY_TYPES.has(primaryType) || types.some((t: string) => VENUE_ONLY_TYPES.has(t))) {
      continue;
    }

    // Filter to city or nearby
    if (p.city !== city) {
      if (!p.lat || !p.lng || !cityConfig) continue;
      const dist = haversineKm(cityConfig.lat, cityConfig.lon, p.lat, p.lng);
      if (dist > NEARBY_KM) continue;
    }

    candidates.push({
      id: `place:${p.id}`,
      name: p.name,
      category: p.category || "food",
      city: p.city,
      address: p.address || "",
      description: p.curated ? undefined : undefined, // places don't have descriptions
      why: p.why || undefined,
      rating: p.rating,
      cost: p.cost || null,
      costNote: p.costNote || (p.priceLevel ? priceLevelLabel(p.priceLevel) : null),
      kidFriendly: p.kidFriendly ?? null,
      indoorOutdoor: p.indoorOutdoor || null,
      url: p.url,
      mapsUrl: p.mapsUrl,
      photoRef: p.photoRef || null,
      hours: p.hours,
      source: "place",
      score: 0,
      ...(p.curated ? { curated: true, bestSlots: p.bestSlots } : {}),
    });
  }

  return candidates;
}

function priceLevelLabel(level: string): string | null {
  switch (level) {
    case "PRICE_LEVEL_FREE": return "Free";
    case "PRICE_LEVEL_INEXPENSIVE": return "$";
    case "PRICE_LEVEL_MODERATE": return "$$";
    case "PRICE_LEVEL_EXPENSIVE": return "$$$";
    case "PRICE_LEVEL_VERY_EXPENSIVE": return "$$$$";
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Claude Haiku sequencing
// ---------------------------------------------------------------------------

async function sequenceWithClaude(
  pool: Candidate[],
  lockedCandidates: Candidate[],
  weather: string | null,
  city: City,
  kids: boolean,
  hour: number,
): Promise<DayCard[]> {
  const client = new Anthropic({ apiKey: import.meta.env.ANTHROPIC_API_KEY });
  const cityName = getCityName(city);
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const timeSlot = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  // Format locked items
  const lockedSection = lockedCandidates.length > 0
    ? `\n\nLOCKED ITEMS (must include, plan around these):\n${lockedCandidates.map((c) => `- ${c.name} (${c.category}, ${c.city})${c.eventTime ? ` at ${c.eventTime}` : ""}`).join("\n")}`
    : "";

  // Format candidate pool (top items by score)
  const topPool = pool.slice(0, CANDIDATE_POOL_SIZE);
  const poolText = topPool
    .map((c, i) => {
      const parts = [`${i + 1}. [${c.id}] ${c.name}`];
      parts.push(`category: ${c.category}`);
      parts.push(`city: ${c.city}`);
      if (c.address) parts.push(`address: ${c.address}`);
      if (c.source === "event") parts.push(`EVENT TODAY`);
      if (c.eventTime) parts.push(`time: ${c.eventTime}`);
      if (c.rating) parts.push(`rating: ${c.rating}`);
      if (c.cost) parts.push(`cost: ${c.cost}`);
      if (c.costNote) parts.push(`price: ${c.costNote}`);
      if (c.kidFriendly === true) parts.push(`kid-friendly`);
      if (c.why) parts.push(`note: ${c.why}`);
      if (c.indoorOutdoor) parts.push(`setting: ${c.indoorOutdoor}`);
      return parts.join(" | ");
    })
    .join("\n");

  const prompt = `You are the day-planning engine for South Bay Today, a local guide for ${cityName}, California.

It's ${today}, ${timeSlot} (${hour}:00). ${weather ? `Weather: ${weather}.` : ""}
${kids ? "This plan is for a family WITH KIDS. Prioritize kid-friendly activities." : "This plan is for adults WITHOUT KIDS."}
${lockedSection}

CANDIDATE POOL:
${poolText}

TASK: Pick the best items from the pool (including all locked items) and sequence them into a great day plan. Return a JSON array. Only include items that fit in the remaining hours of the day. If it's late and only 1-2 activities fit, return 1-2 cards. Do NOT pad with "tomorrow" or "backup" suggestions. Quality over quantity.

CRITICAL: Items marked "EVENT TODAY" are real, one-time happenings — include at least 1-2 of these if any exist in the pool. They're what makes today different from any other day.

RULES:
- Start from NOW (${hour}:00) — don't schedule things in the past
- Events with listed times are anchors — schedule around them
- If an event has no listed time, pick a reasonable slot for it
- No two restaurants/food spots back-to-back unless lunch + dinner
- Mix categories for variety (outdoor, food, museum, entertainment)
- Geographic clustering — don't zigzag across the region
- Time blocks should be realistic (meals: 1-1.5hr, museums: 2hr, parks: 1-2hr, events: per schedule)
- Match places to appropriate time slots: cafes/coffee for morning, restaurants for lunch/dinner, parks for daytime, bars for evening
- NEVER suggest a sit-down restaurant for "morning coffee" — use actual cafes or coffee shops instead
- NEVER pick a "neighborhood" or "downtown area" as a card — always pick a SPECIFIC restaurant, cafe, park, museum, or venue instead. "Grab lunch at Luna Mexican Kitchen" is great; "Go to Downtown Campbell" is useless to a local.
- Only suggest a venue (theater, amphitheater, stadium) if it appears as an EVENT in the pool with a specific show/game today
${kids ? "- Kid-friendly is essential. Skip anything adults-only." : ""}

TONE: Each card's "blurb" should describe the EXPERIENCE (what to do, eat, see there) — NOT restate the name, opponent, or facts already in the title. For sports events, talk about the ballpark experience, not the matchup. The "why" should be one short punchy sentence about why it fits today. NEVER hedge, apologize, or say "scratch this." NEVER fabricate details not in the data — if you don't know the opponent, don't guess.

OUTPUT FORMAT (JSON array, no markdown fences):
[
  {
    "id": "place:google-id-or-event:event-id",
    "timeBlock": "11:30 AM - 1:00 PM",
    "blurb": "One sentence about what to do here today.",
    "why": "One sentence about why this is a great pick."
  }
]

Return ONLY the JSON array. No explanation.`;

  const response = await client.messages.create({
    model: CLAUDE_HAIKU,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = extractText(response.content);
  const cleaned = stripFences(text);

  let picks: Array<{ id: string; timeBlock: string; blurb: string; why: string }>;
  try {
    picks = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse Claude response: ${cleaned.slice(0, 200)}`);
  }

  // Merge picks with candidate data
  const allCandidates = [...lockedCandidates, ...topPool];
  const candidateMap = new Map(allCandidates.map((c) => [c.id, c]));

  const cards: DayCard[] = [];
  for (const pick of picks) {
    const candidate = candidateMap.get(pick.id);
    if (!candidate) continue;

    cards.push({
      id: candidate.id,
      name: candidate.name,
      category: candidate.category,
      city: candidate.city,
      address: candidate.address,
      timeBlock: pick.timeBlock,
      blurb: pick.blurb,
      why: pick.why,
      url: candidate.url,
      mapsUrl: candidate.mapsUrl,
      cost: candidate.cost,
      costNote: candidate.costNote,
      photoRef: (candidate as any).photoRef || null,
      source: candidate.source,
      locked: lockedCandidates.some((l) => l.id === candidate.id),
    });
  }

  return cards;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // Rate limit: 10 plans per minute per IP
  if (!rateLimit(clientAddress, 30)) return rateLimitResponse();

  let body: PlanRequest;
  try {
    body = await request.json();
  } catch {
    return errJson("Invalid JSON body", 400);
  }

  const { city, kids = false, lockedIds = [], dismissedIds = [], currentHour } = body;

  // Validate city
  if (!city || !VALID_CITIES.has(city)) {
    return errJson(`Invalid city. Must be one of: ${[...VALID_CITIES].join(", ")}`, 400);
  }

  // Validate API key
  if (!import.meta.env.ANTHROPIC_API_KEY) {
    return errJson("Server configuration error", 500);
  }

  const hour = typeof currentHour === "number" ? currentHour : Number(currentPTHour());
  const dismissedSet = new Set(dismissedIds);
  const lockedSet = new Set(lockedIds);

  try {
    // 1. Fetch weather
    const weatherData = await fetchWeather(city);
    const weatherContext: WeatherContext | null = weatherData.forecast?.[0] ?? null;

    // 2. Build candidate pool
    const allCandidates = buildCandidatePool(city, kids, dismissedSet, lockedSet);

    // 3. Score candidates
    const scored = scoreCandidates(allCandidates, weatherContext, hour, kids);

    // 4. Separate locked items
    const lockedCandidates = scored.filter((c) => lockedSet.has(c.id));
    const unlockedPool = scored.filter((c) => !lockedSet.has(c.id));

    // 5. Events always get priority slots, then fill with diverse places
    const eventCandidates = unlockedPool.filter((c) => c.source === "event");
    const placeCandidates = unlockedPool.filter((c) => c.source === "place");

    // Start with ALL today's events (they're rare and valuable)
    const diversePool: Candidate[] = [...eventCandidates];

    // Fill remaining slots with diverse places
    const catCounts: Record<string, number> = {};
    for (const c of placeCandidates) {
      const count = catCounts[c.category] || 0;
      const maxForCat = c.category === "food" ? 10 : 6;
      if (count < maxForCat) {
        diversePool.push(c);
        catCounts[c.category] = count + 1;
      }
      if (diversePool.length >= CANDIDATE_POOL_SIZE) break;
    }

    // 6. Claude sequences the plan
    const cards = await sequenceWithClaude(
      diversePool,
      lockedCandidates,
      weatherData.weather,
      city,
      kids,
      hour,
    );

    return okJson(
      {
        cards,
        weather: weatherData.weather,
        city,
        kids,
        generatedAt: new Date().toISOString(),
        poolSize: allCandidates.length,
      },
      { "Cache-Control": "private, no-store" },
    );
  } catch (err) {
    console.error("plan-day error:", err);
    return errJson(`Planning failed: ${toErrMsg(err)}`, 500);
  }
};
