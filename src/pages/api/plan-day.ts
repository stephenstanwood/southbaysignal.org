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
import { CLAUDE_SONNET, extractText, stripFences } from "../../lib/models";
import { CITY_MAP, getCityName } from "../../lib/south-bay/cities";
import type { City } from "../../lib/south-bay/types";

import placesData from "../../data/south-bay/places.json";
import eventsData from "../../data/south-bay/upcoming-events.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserPreferences {
  categoryScores: Record<string, number>;
  costBias: number;
  outdoorBias: number;
  totalInteractions: number;
}

interface PlanRequest {
  city: City;
  kids: boolean;
  lockedIds?: string[];
  dismissedIds?: string[];
  currentHour?: number; // 0-23, defaults to now
  planDate?: string;    // YYYY-MM-DD — plan for a specific date (default: today)
  preferences?: UserPreferences;
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
  kidsCostNote?: string | null;
  kidFriendly?: boolean | null;
  indoorOutdoor?: string | null;
  url?: string | null;
  mapsUrl?: string | null;
  hours?: Record<string, string> | null;
  venue?: string | null;
  photoRef?: string | null;
  source: "event" | "place";
  eventDate?: string;
  eventTime?: string | null;
  ongoing?: boolean;
  score: number;
}

interface DayCard {
  id: string;
  name: string;
  category: string;
  city: string;
  address: string;
  venue?: string | null;
  timeBlock: string;
  blurb: string;
  why: string;
  url?: string | null;
  mapsUrl?: string | null;
  cost?: string | null;
  costNote?: string | null;
  kidsCostNote?: string | null;
  photoRef?: string | null;
  source: "event" | "place";
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CITIES = new Set(Object.keys(CITY_MAP));
const MAX_CARDS = 6;
const CANDIDATE_POOL_SIZE = 25; // fewer = faster Haiku response

// Distance threshold in km for "nearby" places
const NEARBY_KM = 8; // ~5 miles — reasonable driving distance

// In-memory plan cache: city:kids:hour → { data, ts }
const planCache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Check if a place is open today based on its hours data. null hours = assume open. */
function isOpenToday(hours: Record<string, string> | null): boolean {
  if (!hours) return true; // no hours data = assume open
  const dayIdx = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).toLowerCase().slice(0, 3);
  return dayIdx in hours;
}

/** Get today's closing hour for a place, or null if unknown. */
function closingHourToday(hours: Record<string, string> | null | undefined): number | null {
  if (!hours) return null;
  const dayIdx = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).toLowerCase().slice(0, 3);
  const range = hours[dayIdx];
  if (!range) return null;
  // Take the LAST segment for split ranges like "11:00-14:00,17:00-22:00"
  const lastSeg = range.split(",").pop() || range;
  const close = lastSeg.split("-")[1];
  if (!close) return null;
  return parseHour(close);
}

/** Get today's opening hour for a place, or null if unknown. */
function openingHourToday(hours: Record<string, string> | null | undefined): number | null {
  if (!hours) return null;
  const dayIdx = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).toLowerCase().slice(0, 3);
  const range = hours[dayIdx];
  if (!range) return null;
  // Take the FIRST segment for split ranges (e.g. lunch start for "11:00-14:00,17:00-22:00")
  const firstSeg = range.split(",")[0] || range;
  const open = firstSeg.split("-")[0];
  if (!open) return null;
  return parseHour(open);
}

/**
 * Return the full list of (open, close) pairs for today, in 24h hours.
 * Handles single and split ranges like "11:00-14:00,17:00-22:00".
 * Returns [] if closed today or hours unknown.
 */
function openRangesToday(hours: Record<string, string> | null | undefined): Array<[number, number]> {
  if (!hours) return [];
  const dayIdx = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).toLowerCase().slice(0, 3);
  const range = hours[dayIdx];
  if (!range) return []; // closed today
  const out: Array<[number, number]> = [];
  for (const seg of range.split(",")) {
    const [openStr, closeStr] = seg.split("-");
    if (!openStr || !closeStr) continue;
    const o = parseHour(openStr);
    const c = parseHour(closeStr);
    if (o !== null && c !== null) out.push([o, c]);
  }
  return out;
}

/**
 * Check whether the given [startH, endH] block fits entirely within any of
 * the venue's open ranges today. Unknown hours = default 9 AM–8 PM window.
 */
function fitsInOpenRange(hours: Record<string, string> | null | undefined, startH: number, endH: number): boolean {
  if (!hours) return startH >= 9 && endH <= 20; // default 9 AM–8 PM for unknown hours
  const ranges = openRangesToday(hours);
  if (ranges.length === 0) return false; // closed today
  for (const [o, c] of ranges) {
    if (startH >= o && endH <= c) return true;
  }
  return false;
}

function currentPTHour(): number {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hour12: false,
  }) as unknown as number;
}

/** Parse a time string like "9:00 PM" or "21:00" into 24h hour. Returns null if unparseable. */
function parseHour(timeStr: string): number | null {
  // Try "H:MM AM/PM" format
  const ampm = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    if (ampm[3].toUpperCase() === "PM" && h !== 12) h += 12;
    if (ampm[3].toUpperCase() === "AM" && h === 12) h = 0;
    return h;
  }
  // Try 24h "HH:MM"
  const mil = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (mil) return parseInt(mil[1], 10);
  return null;
}

const KIDS_CURFEW_HOUR = 20; // 8 PM — nothing starting at or after this

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
  prefs?: UserPreferences,
): Candidate[] {
  for (const c of candidates) {
    let score = 0;

    // --- Source priority ---
    // Events get a moderate boost, not a dominant one
    if (c.source === "event") {
      score += 25;
      if (c.eventDate === todayStr()) score += 15;
    }

    // --- Rating boost ---
    if (c.rating && c.rating >= 4.5) score += 15;
    else if (c.rating && c.rating >= 4.0) score += 5;

    // --- Curated places are premium ---
    if ((c as any).curated) score += 25;

    // --- Food places get a meal-slot boost ---
    if (c.category === "food") score += 10;

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

    // --- In kids mode, heavily penalize expensive restaurants ---
    if (kids) {
      const price = (c as any).priceLevel || c.costNote || "";
      if (price === "PRICE_LEVEL_VERY_EXPENSIVE" || price === "$$$$") score -= 50;
      if (price === "PRICE_LEVEL_EXPENSIVE" || price === "$$$") score -= 20;
    }

    // --- Penalize generic neighborhood entries — specific places are always better ---
    if (c.category === "neighborhood") score -= 30;

    // --- User preference adjustments (only when enough signal) ---
    if (prefs && prefs.totalInteractions >= 5) {
      // Category affinity: ±15 based on learned preference
      const catScore = prefs.categoryScores[c.category];
      if (catScore !== undefined) score += catScore * 15;

      // Cost bias: penalize/boost expensive items
      if (prefs.costBias !== 0) {
        const price = (c as any).priceLevel || c.costNote || "";
        const isExpensive = price === "PRICE_LEVEL_VERY_EXPENSIVE" || price === "$$$$" || price === "PRICE_LEVEL_EXPENSIVE" || price === "$$$";
        if (isExpensive) score += prefs.costBias * 10; // negative bias → penalty
      }

      // Outdoor bias
      if (prefs.outdoorBias !== 0 && c.indoorOutdoor) {
        if (c.indoorOutdoor === "outdoor") score += prefs.outdoorBias * 10;
        else if (c.indoorOutdoor === "indoor") score -= prefs.outdoorBias * 10;
      }
    }

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
  targetDate?: string,
): Candidate[] {
  const candidates: Candidate[] = [];
  const cityConfig = CITY_MAP[city];
  const today = targetDate || todayStr();

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

    // In kids mode, skip events that start at or after curfew
    if (kids && evt.time) {
      const startH = parseHour(evt.time.split(/\s*-\s*/)[0]);
      if (startH !== null && startH >= KIDS_CURFEW_HOUR) continue;
    }

    candidates.push({
      id: `event:${evt.id}`,
      name: evt.title,
      category: evt.category || "events",
      city: evt.city,
      address: evt.address || "",
      venue: evt.venue || null,
      description: evt.description?.slice(0, 200),
      cost: evt.cost,
      costNote: (evt as any).costNote || null,
      kidFriendly: evt.kidFriendly ?? null,
      url: evt.url,
      source: "event",
      eventDate: evt.date,
      eventTime: evt.time,
      ongoing: evt.ongoing ?? false,
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

  // Places that should never appear in day plans
  const EXCLUDED_TYPES = new Set([
    "preschool", "child_care_agency", "day_care_center",
    "school", "primary_school", "secondary_school", "middle_school",
    "hospital", "doctor", "dentist", "pharmacy", "veterinary_care",
    "insurance_agency", "lawyer", "accounting", "real_estate_agency",
    "car_dealer", "car_repair", "car_wash", "gas_station",
    "funeral_home", "cemetery", "storage", "self_storage",
    "post_office", "bank", "atm", "laundry", "dry_cleaner",
    "locksmith", "plumber", "electrician", "roofing_contractor",
    "moving_company", "travel_agency",
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

    // Skip places that don't belong in day plans (schools, services, etc.)
    if (EXCLUDED_TYPES.has(primaryType) || types.some((t: string) => EXCLUDED_TYPES.has(t))) {
      continue;
    }

    // Skip places that are closed today
    if (!isOpenToday(p.hours)) continue;

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
      kidsCostNote: (p as any).kidsCostNote || null,
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
    case "PRICE_LEVEL_INEXPENSIVE": return "Under $15/person";
    case "PRICE_LEVEL_MODERATE": return "$15–30/person";
    case "PRICE_LEVEL_EXPENSIVE": return "$30–60/person";
    case "PRICE_LEVEL_VERY_EXPENSIVE": return "$60+/person";
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Claude Haiku sequencing
// ---------------------------------------------------------------------------

/** Build a short natural-language summary of user preferences for the prompt */
function describePreferences(prefs?: UserPreferences): string {
  if (!prefs || prefs.totalInteractions < 5) return "";
  const parts: string[] = [];

  // Top liked/disliked categories
  const sorted = Object.entries(prefs.categoryScores).sort((a, b) => b[1] - a[1]);
  const liked = sorted.filter(([, v]) => v > 0.2).slice(0, 2).map(([k]) => k);
  const disliked = sorted.filter(([, v]) => v < -0.2).slice(0, 2).map(([k]) => k);
  if (liked.length) parts.push(`enjoys ${liked.join(" and ")}`);
  if (disliked.length) parts.push(`tends to skip ${disliked.join(" and ")}`);

  if (prefs.outdoorBias > 0.3) parts.push("prefers outdoor activities");
  else if (prefs.outdoorBias < -0.3) parts.push("prefers indoor activities");

  if (prefs.costBias < -0.3) parts.push("budget-conscious");
  else if (prefs.costBias > 0.3) parts.push("happy to splurge");

  return parts.length ? `USER PREFERENCES: This person ${parts.join(", ")}.` : "";
}

async function sequenceWithClaude(
  pool: Candidate[],
  lockedCandidates: Candidate[],
  weather: string | null,
  city: City,
  kids: boolean,
  hour: number,
  prefs?: UserPreferences,
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

  // Format locked items. Avoid the word "LOCKED" in the section header
  // because the model has echoed it back as a literal timeBlock value.
  const lockedSection = lockedCandidates.length > 0
    ? `\n\nMUST-INCLUDE ITEMS (plan around these — always include every one):\n${lockedCandidates.map((c) => `- ${c.name} (${c.category}, ${c.city})${c.eventTime ? ` at ${c.eventTime}` : ""}`).join("\n")}`
    : "";

  // Format candidate pool (top items by score)
  const topPool = pool.slice(0, CANDIDATE_POOL_SIZE);
  const poolText = topPool
    .map((c, i) => {
      const parts = [`${i + 1}. [${c.id}] ${c.name}`];
      parts.push(`category: ${c.category}`);
      parts.push(`city: ${c.city}`);
      if (c.address) parts.push(`address: ${c.address}`);
      if (c.source === "event" && !c.ongoing) parts.push(`EVENT TODAY`);
      if (c.source === "event" && c.ongoing) parts.push(`ongoing exhibition (daytime hours only — must end by 5 PM)`);
      if (c.eventTime) parts.push(`time: ${c.eventTime}`);
      if (c.rating) parts.push(`rating: ${c.rating}`);
      if (c.cost) parts.push(`cost: ${c.cost}`);
      if (c.costNote) parts.push(`price: ${c.costNote}`);
      if (c.kidFriendly === true) parts.push(`kid-friendly`);
      if (c.why) parts.push(`note: ${c.why}`);
      if (c.indoorOutdoor) parts.push(`setting: ${c.indoorOutdoor}`);
      // Only include places that are actually open. If hours data is present
      // and there's no entry for today, skip entirely (closed today).
      const hoursObj = (c as any).hours as Record<string, string> | null | undefined;
      const fmt = (h: number) => (h > 12 ? `${h - 12} PM` : h === 12 ? "12 PM" : h === 0 ? "12 AM" : `${h} AM`);
      if (hoursObj) {
        const ranges = openRangesToday(hoursObj);
        if (ranges.length === 0) return null; // closed today — omit from prompt
        parts.push(`hours: ${ranges.map(([o, c2]) => `${fmt(o)}–${fmt(c2)}`).join(", ")}`);
      } else {
        // No hours data — apply sensible default so Claude doesn't schedule
        // a bakery at 7 PM or a bar at 8 AM
        parts.push(`hours: ${fmt(9)}–${fmt(20)} (estimated)`);
      }
      return parts.join(" | ");
    })
    .filter((line): line is string => line !== null)
    .join("\n");

  const prompt = `You are the day-planning engine for South Bay Today, a local guide for ${cityName}, California.

It's ${today}, ${timeSlot} (${hour}:00). ${weather ? `Weather: ${weather}.` : ""}
${kids ? "This plan is for a family WITH KIDS. Prioritize kid-friendly activities." : "This plan is for adults WITHOUT KIDS."}
${describePreferences(prefs)}
${lockedSection}

CANDIDATE POOL:
${poolText}

TASK: Pick 5-7 items from the pool (including all locked items) and sequence them into a full day plan that fills the remaining hours with no big gaps. Return a JSON array. Every 1-2 hour block from NOW until bedtime should have something. Err on the side of MORE suggestions — a packed day is better than a sparse one. Do NOT suggest things for "tomorrow."

CRITICAL RULES FOR BALANCE:
- Items marked "EVENT TODAY" are specific things happening today. Include 1-2 if any exist in the pool, but NEVER make the entire plan just events. A good day is activities + food + maybe an event.
- MEALS ARE REQUIRED: A full day plan MUST include food stops. If the plan starts before noon, include a breakfast/brunch/coffee spot. Always include lunch (noon-2pm). If the plan goes past 6pm, include dinner. Pick actual restaurants or cafes from the pool — not just "grab food somewhere."
- The ideal plan is: activity → food → activity → food → activity. Alternate between doing things and eating.

RULES:
- For a full day plan, START AT 9:00 AM with breakfast or coffee — a breakfast burrito spot, a fun cafe, a bakery. Every good day starts with food. If the current time is past 9, start from NOW (${hour}:00) instead.
- Don't schedule things in the past
- Events with listed times are anchors — schedule around them
- If an event has no listed time, pick a reasonable slot for it
- NEVER put two items of the same category back-to-back. No two parks in a row, no two restaurants in a row (unless lunch + dinner). Alternate categories: outdoor → food → museum → entertainment → food, etc.
- Max 2 of any single category in the entire plan. A day with 3 parks is a bad day plan.
- Geographic clustering — don't zigzag across the region
- Time blocks should be realistic (meals: 1-1.5hr, museums: 2hr, parks: 1-2hr, events: per schedule)
- Match places to appropriate time slots: cafes/coffee for morning, restaurants for lunch/dinner, parks for daytime, bars for evening
- NEVER suggest a sit-down restaurant for "morning coffee" — use actual cafes or coffee shops instead
- NEVER pick a "neighborhood" or "downtown area" as a card — always pick a SPECIFIC restaurant, cafe, park, museum, or venue instead. "Grab lunch at Luna Mexican Kitchen" is great; "Go to Downtown Campbell" is useless to a local.
- NEVER schedule a place after its closing time. If a place says "closes: 4 PM", your time block must END by 4 PM at the latest. A museum that closes at 4:30 PM cannot be a 9 PM activity.
- Only suggest a venue (theater, amphitheater, stadium) if it appears as an EVENT in the pool with a specific show/game today
${kids ? "- Kid-friendly is essential. Skip anything adults-only.\n- BUDGET: Kids mode = casual and affordable. Never suggest $$$$ restaurants. Prefer $ and $$ spots.\n- CURFEW: Last activity must END by 9:00 PM. Kids need to be home by 9. Never schedule anything starting after 8:00 PM." : ""}
- READ THE PRICE DATA: if a place is listed as $$$$ it is NOT "casual." Match your description to the actual price level.

TONE: Write like a friend texting a plan, not a travel brochure or AI assistant.
- "blurb": what to actually DO at THAT SPECIFIC PLACE (order the tri-tip sandwich, hike the upper loop, sit on the patio). The blurb MUST describe the place named by that ID — never describe a different place in the blurb. If you don't know what the place offers, keep the blurb generic for that type (e.g. "Try the local favorite dishes" for a restaurant you don't know).
- "why": one casual sentence. "Perfect weather for it" or "you won't find better ramen" — NOT "this is a one-time event that makes today unforgettable"
- NEVER say: "real game", "real event", "anchor event", "one-time", "only today", "happens only today", "unforgettable", "energy burn", "change of scenery", "right now"
- NEVER mention star ratings, review scores, or rating numbers. No "4.7 stars", "rated 4.5", "highly rated". It's tacky. Just recommend confidently.
- NEVER mention distance, travel time, or proximity. No "near", "nearby", "close to", "minutes from", "zero travel time", "short drive", "easy drive". The user doesn't need you to justify logistics.
- NEVER fabricate details not in the data — don't assume drop-in availability, class schedules, or specific menu items unless the data says so
- NEVER describe a place as being "in" a city it's not in — check the city field
- NEVER hedge or qualify — just recommend it confidently
- Vary your sentence structure. Do NOT use an em dash (—) in every blurb. Mix periods, commas, and short sentences. If you catch yourself reaching for "—", use a period instead.

OUTPUT FORMAT (JSON array, no markdown fences):
[
  {
    "id": "place:google-id-or-event:event-id",
    "timeBlock": "11:30 AM - 1:00 PM",
    "blurb": "One sentence about what to do here today.",
    "why": "One sentence about why this is a great pick."
  }
]

timeBlock MUST be a literal time range like "7:00 PM - 8:30 PM". Never write "LOCKED", "TBD", "all day", or any placeholder word — always a real clock range with AM/PM.

Return ONLY the JSON array. No explanation.`;

  const response = await client.messages.create({
    model: CLAUDE_SONNET,
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

  // Validate a timeBlock string matches the expected format. Guards against
  // the model echoing back "LOCKED", "TBD", or other placeholder strings
  // instead of an actual time range.
  const isValidTimeBlock = (tb: string | null | undefined): boolean => {
    if (!tb) return false;
    return /\d{1,2}:\d{2}\s*(?:AM|PM)/i.test(tb);
  };

  // Compute a reasonable "HH:MM AM/PM - HH:MM AM/PM" block from an eventTime
  // string, or a fallback slot if eventTime is missing/unparseable.
  const timeBlockFromEventTime = (eventTime: string | null | undefined, fallback = "7:00 PM - 8:30 PM"): string => {
    if (!eventTime) return fallback;
    const startMatch = eventTime.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    if (!startMatch) return fallback;
    const startH = parseHour(startMatch[1]);
    if (startH === null) return startMatch[1];
    const endH = startH + 1;
    const endMin = 30;
    const endAmPm = endH >= 12 ? "PM" : "AM";
    const endHour12 = endH > 12 ? endH - 12 : endH === 0 ? 12 : endH;
    return `${startMatch[1]} - ${endHour12}:${String(endMin).padStart(2, "0")} ${endAmPm}`;
  };

  const cards: DayCard[] = [];
  for (const pick of picks) {
    const candidate = candidateMap.get(pick.id);
    if (!candidate) continue;

    // Sanitize: if the model returned a bogus timeBlock (e.g. "LOCKED", "TBD",
    // empty), derive one from the candidate's eventTime instead.
    const timeBlock = isValidTimeBlock(pick.timeBlock)
      ? pick.timeBlock
      : timeBlockFromEventTime(candidate.eventTime);

    cards.push({
      id: candidate.id,
      name: candidate.name,
      category: candidate.category,
      city: candidate.city,
      address: candidate.address,
      timeBlock,
      blurb: pick.blurb,
      why: pick.why,
      url: candidate.url,
      mapsUrl: candidate.mapsUrl,
      cost: candidate.cost,
      costNote: kids && candidate.kidsCostNote ? candidate.kidsCostNote : candidate.costNote,
      kidsCostNote: candidate.kidsCostNote,
      photoRef: (candidate as any).photoRef || null,
      venue: candidate.venue || null,
      source: candidate.source,
      locked: lockedCandidates.some((l) => l.id === candidate.id),
    });
  }

  // Post-process: force locked items into the plan if Claude forgot them
  for (const locked of lockedCandidates) {
    if (!cards.some((c) => c.id === locked.id)) {
      console.log(`[plan-day] forcing locked item: ${locked.name}`);
      const timeBlock = timeBlockFromEventTime(locked.eventTime);
      cards.push({
        id: locked.id,
        name: locked.name,
        category: locked.category,
        city: locked.city,
        address: locked.address,
        timeBlock,
        blurb: locked.description?.slice(0, 200) || `Head to ${locked.name} and see what's going on.`,
        why: locked.why || "This is the one the day is built around.",
        url: locked.url,
        mapsUrl: locked.mapsUrl,
        cost: locked.cost,
        costNote: kids && locked.kidsCostNote ? locked.kidsCostNote : locked.costNote,
        kidsCostNote: locked.kidsCostNote,
        photoRef: (locked as any).photoRef || null,
        venue: locked.venue || null,
        source: locked.source,
        locked: true,
      });
    }
  }

  // Re-sort chronologically after forcing locked items
  cards.sort((a, b) => {
    const aH = parseHour(a.timeBlock.split(/\s*-\s*/)[0]) ?? 99;
    const bH = parseHour(b.timeBlock.split(/\s*-\s*/)[0]) ?? 99;
    return aH - bH;
  });

  // Post-process: enforce kids curfew — drop any card starting at or after 8 PM
  if (kids) {
    const before = cards.length;
    for (let i = cards.length - 1; i >= 0; i--) {
      const startTime = cards[i].timeBlock.split(/\s*-\s*/)[0];
      const h = parseHour(startTime);
      if (h !== null && h >= KIDS_CURFEW_HOUR && !cards[i].locked) {
        cards.splice(i, 1);
      }
    }
    if (cards.length < before) {
      console.log(`[plan-day] kids curfew: dropped ${before - cards.length} card(s) starting after ${KIDS_CURFEW_HOUR}:00`);
    }
  }

  // Post-process: detect blurb↔card mismatches. Sometimes Claude returns a
  // pick with id of one place but a blurb describing a different place in
  // the pool. The merge step uses the id to look up the candidate but keeps
  // the wrong blurb verbatim, producing cards like:
  //   "The Tech Interactive" + "Spend hours at the Rosicrucian Egyptian Museum"
  // Detection: check if the blurb contains ANY significant word from the
  // place name OR mentions the place name as a substring. If zero overlap,
  // the blurb was probably written for a different candidate — drop it.
  {
    const before = cards.length;
    const stopwords = new Set([
      "the", "and", "for", "with", "from", "into", "onto", "this", "that",
      "your", "their", "at", "in", "on", "of", "to", "a", "an", "is", "it",
      "its", "by", "as", "or", "but", "be", "you", "are", "san", "jose",
      "san-jose", "los", "gatos", "palo", "alto", "santa", "clara", "mountain",
      "view", "cupertino", "sunnyvale", "milpitas", "campbell", "saratoga",
    ]);
    for (let i = cards.length - 1; i >= 0; i--) {
      if (cards[i].locked) continue;
      const name = (cards[i].name || "").toLowerCase();
      const blurb = (cards[i].blurb || "").toLowerCase();
      if (!name || !blurb) continue;
      // Quick win: if full name is substring of blurb, accept
      if (blurb.includes(name)) continue;
      // Otherwise: look for any significant word overlap
      const nameWords = name
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3 && !stopwords.has(w));
      if (nameWords.length === 0) continue; // name too generic to validate
      const hasOverlap = nameWords.some((w) => blurb.includes(w));
      if (!hasOverlap) {
        console.log(`[plan-day] dropped blurb mismatch: card="${cards[i].name}" blurb="${cards[i].blurb?.slice(0, 80)}..."`);
        cards.splice(i, 1);
      }
    }
    if (cards.length < before) {
      console.log(`[plan-day] blurb validator: dropped ${before - cards.length} mismatched card(s)`);
    }
  }

  // Post-process: drop places whose scheduled time block doesn't fit within
  // the venue's actual open hours today. Catches three bugs:
  //   1. Scheduled past closing (e.g. museum at 9 PM that closes 5 PM)
  //   2. Scheduled before opening (e.g. dinner-only restaurant at 2 PM)
  //   3. Scheduled on a closed day (no hours entry for today)
  {
    const before = cards.length;
    for (let i = cards.length - 1; i >= 0; i--) {
      if (cards[i].locked) continue;
      const candidate = candidateMap.get(cards[i].id);
      if (!candidate) continue;
      const hoursObj = (candidate as any).hours as Record<string, string> | null | undefined;
      if (!hoursObj) continue; // unknown hours — keep it
      const [startStr, endStr] = cards[i].timeBlock.split(/\s*-\s*/);
      const startH = parseHour(startStr || "");
      const endH = parseHour(endStr || "") ?? (startH !== null ? startH + 1 : null);
      if (startH === null || endH === null) continue;
      if (!fitsInOpenRange(hoursObj, startH, endH)) {
        console.log(`[plan-day] dropped ${cards[i].name} — ${cards[i].timeBlock} doesn't fit venue hours`);
        cards.splice(i, 1);
      }
    }
    if (cards.length < before) {
      console.log(`[plan-day] hours check: dropped ${before - cards.length} card(s) outside venue hours`);
    }
  }

  // Post-process: fix same-category back-to-back by swapping with nearest non-adjacent different-category card
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].category === cards[i - 1].category && !cards[i].locked && !cards[i - 1].locked) {
      // Find the nearest later card with a different category to swap with
      let swapIdx = -1;
      for (let j = i + 1; j < cards.length; j++) {
        if (cards[j].category !== cards[i - 1].category && !cards[j].locked) {
          swapIdx = j;
          break;
        }
      }
      if (swapIdx !== -1) {
        [cards[i], cards[swapIdx]] = [cards[swapIdx], cards[i]];
      }
    }
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

  const { city, kids = false, lockedIds = [], dismissedIds = [], currentHour, planDate, preferences } = body;

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

  // Cache hit for default requests (no locks/dismissals/preferences)
  const prefsHash = preferences ? Math.round((preferences.outdoorBias || 0) * 10 + (preferences.costBias || 0) * 10) : 0;
  const cacheKey = `${city}:${kids}:${hour}:${prefsHash}`;
  if (lockedIds.length === 0 && dismissedIds.length === 0) {
    const cached = planCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return okJson(cached.data, { "Cache-Control": "private, no-store" });
    }
  }

  try {
    // 1. Fetch weather
    const weatherData = await fetchWeather(city);
    const weatherContext: WeatherContext | null = weatherData.forecast?.[0] ?? null;

    // 2. Build candidate pool
    const allCandidates = buildCandidatePool(city, kids, dismissedSet, lockedSet, planDate);

    // 3. Score candidates
    const scored = scoreCandidates(allCandidates, weatherContext, hour, kids, preferences);

    // 4. Separate locked items
    const lockedCandidates = scored.filter((c) => lockedSet.has(c.id));
    const unlockedPool = scored.filter((c) => !lockedSet.has(c.id));

    // 5. Build diverse pool — balance events, food, and activities

    // 5a. Dedupe events: collapse near-duplicates at the same physical spot
    //     (same venue/address AND overlapping time). The user can only attend
    //     one thing at a time, so showing two competing events at 6:30 PM at
    //     the same library just confuses the plan. Keep the highest-scored one.
    const rawEventCandidates = unlockedPool.filter((c) => c.source === "event");
    const dedupedEvents: Candidate[] = [];
    const eventGroupSeen = new Map<string, Candidate>();
    for (const c of rawEventCandidates) {
      // Group key: venue+eventTime, or address+eventTime, or city+eventTime
      const loc = (c.venue || c.address || c.city || "").toLowerCase().trim();
      const time = (c.eventTime || "").toLowerCase().trim();
      const groupKey = time ? `${loc}|${time}` : null;
      // Also collapse exact id duplicates (shouldn't happen but defensive)
      if (eventGroupSeen.has(c.id)) continue;
      eventGroupSeen.set(c.id, c);
      if (!groupKey) {
        dedupedEvents.push(c);
        continue;
      }
      const existing = dedupedEvents.find((e) => {
        const eLoc = (e.venue || e.address || e.city || "").toLowerCase().trim();
        const eTime = (e.eventTime || "").toLowerCase().trim();
        return `${eLoc}|${eTime}` === groupKey;
      });
      if (!existing) {
        dedupedEvents.push(c);
      } else if ((c.score || 0) > (existing.score || 0)) {
        // Replace lower-scored duplicate
        const idx = dedupedEvents.indexOf(existing);
        dedupedEvents[idx] = c;
      }
      // else: drop c, keep existing
    }
    const dropped = rawEventCandidates.length - dedupedEvents.length;
    if (dropped > 0) {
      console.log(`[plan-day] deduped ${dropped} overlapping events at same venue/time`);
    }
    const eventCandidates = dedupedEvents;
    const foodCandidates = unlockedPool.filter((c) => c.source === "place" && c.category === "food");
    const otherPlaces = unlockedPool.filter((c) => c.source === "place" && c.category !== "food");

    const diversePool: Candidate[] = [];

    // Events: include top 3-4 (not ALL — leave room for places)
    const MAX_EVENTS = 4;
    for (const c of eventCandidates.slice(0, MAX_EVENTS)) {
      diversePool.push(c);
    }

    // Food: guarantee at least 4 food options so Claude can pick meals
    const MIN_FOOD = 4;
    for (const c of foodCandidates.slice(0, Math.max(MIN_FOOD, 5))) {
      diversePool.push(c);
    }

    // Fill remaining slots with diverse non-food places
    const catCounts: Record<string, number> = {};
    const CAT_CAPS: Record<string, number> = { outdoor: 3, museum: 2, entertainment: 3, wellness: 2, shopping: 2 };
    for (const c of otherPlaces) {
      const count = catCounts[c.category] || 0;
      const maxForCat = CAT_CAPS[c.category] ?? 3;
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
      preferences,
    );

    const responseData = {
      cards,
      weather: weatherData.weather,
      city,
      kids,
      generatedAt: new Date().toISOString(),
      poolSize: allCandidates.length,
    };

    // Cache default requests for 5 min
    if (lockedIds.length === 0 && dismissedIds.length === 0) {
      planCache.set(cacheKey, { data: responseData, ts: Date.now() });
      // Evict old entries
      if (planCache.size > 100) {
        const oldest = planCache.keys().next().value!;
        planCache.delete(oldest);
      }
    }

    return okJson(responseData, { "Cache-Control": "private, no-store" });
  } catch (err) {
    console.error("plan-day error:", err);
    return errJson(`Planning failed: ${toErrMsg(err)}`, 500);
  }
};
