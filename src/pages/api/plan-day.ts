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
// 3. Call Claude Sonnet to sequence into a 5-6 card day plan
// ---------------------------------------------------------------------------

import type { APIRoute } from "astro";
import Anthropic from "@anthropic-ai/sdk";
import { errJson, okJson, toErrMsg } from "../../lib/apiHelpers";
import { rateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { CLAUDE_SONNET, extractText, stripFences } from "../../lib/models";
import { CITY_MAP, getCityName } from "../../lib/south-bay/cities";
import { normalizeName } from "../../lib/south-bay/normalizeName";
import { logDecision } from "../../lib/south-bay/decisionLog.mjs";
import { isVirtualEvent } from "../../lib/south-bay/eventFilters.mjs";
import { canonicalCategory } from "../../lib/south-bay/categories.mjs";
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
  /** Richer lock info: pairs an id with the current timeBlock so Claude can
   *  anchor the plan around it (and the force-insert fallback uses the same
   *  timeBlock instead of defaulting to 7 PM for places). Takes precedence
   *  over lockedIds when both are sent. */
  lockedCards?: Array<{ id: string; timeBlock?: string | null }>;
  dismissedIds?: string[];
  /** Names persisted alongside dismissedIds, normalized server-side and used
   *  to filter candidates whose ID may have changed since the user dismissed
   *  them (curated → Google Places re-keying, etc.). Pairs with dismissedIds. */
  dismissedNames?: string[];
  currentHour?: number; // 0-23, defaults to now
  currentMinute?: number; // 0-59, used with currentHour to round start time to next :00/:30
  planDate?: string;    // YYYY-MM-DD — plan for a specific date (default: today)
  /** Bypass the 5-min in-memory plan cache — SHUFFLE sets this so each
   *  click gets a freshly generated plan instead of a recent hit. */
  noCache?: boolean;
  preferences?: UserPreferences;
  /** Lowercase POI/event names to hard-exclude from this plan. Used by the
   *  schedule generator to prevent the same venue anchoring multiple days in
   *  the same week. */
  blockedNames?: string[];
  /** Recently-shown ids/names the client has served. The scorer applies a
   *  graduated penalty so the same venue doesn't anchor every day: today
   *  is hardest, last-week fades to a nudge. Strings are treated as today's
   *  picks; objects carry name + daysAgo so by-name matches (same venue,
   *  different id record) get penalized too. Managed client-side by the
   *  homepage ledger (localStorage, ~120 entries, 7-day window). */
  recentlyShown?: Array<string | { id?: string; name?: string; daysAgo?: number }>;
  /** City anchors used on recent shuffles — same shape/purpose as
   *  recentlyShown but for anchor selection diversity. Currently informational
   *  (client picks the anchor); kept here for future server-side use. */
  recentAnchors?: string[];
  /** Week-level context so Claude can diversify across the batch. Optional —
   *  only populated by generate-schedule.mjs when building a 10-day run. */
  weekContext?: {
    /** Anchor cities already used this week (human names, e.g. "Palo Alto"). */
    anchorCities?: string[];
    /** Per-category saturation counts across the batch so far. */
    categorySaturation?: Record<string, number>;
  };
}

interface Candidate {
  id: string;
  name: string;
  category: string;
  city: string;
  address: string;
  description?: string;
  /** Ingest-time blurb from eventBlurbs.mjs (events only). Preferred source
   *  for the card's visible blurb — stable across shuffles, Haiku-written
   *  once per event. Falls through to description → fallbackBlurb() pool. */
  blurb?: string | null;
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
  image?: string | null;
  displayType?: string | null;
  source: "event" | "place";
  eventDate?: string;
  eventTime?: string | null;
  eventEndTime?: string | null;
  /** Event duration in minutes. Derived from eventTime/eventEndTime when both
   *  are parseable. null = unknown (e.g. ongoing exhibits, missing endTime). */
  eventDurationMin?: number | null;
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
  image?: string | null;
  source: "event" | "place";
  locked: boolean;
  /** Breadcrumb for debugging — describes why this card ended up in the plan.
   *  e.g. "claude:pool-rank-12 | score=15.4 | EVENT TODAY"
   *  Surfaced via /plan/<id>?debug=1 and structured decision log. */
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// santa-cruz is in CITY_MAP for POI/event display but excluded from plan-day
// (case-by-case picks only, not full coverage with enough POIs to fill a plan)
const VALID_CITIES = new Set(Object.keys(CITY_MAP).filter((c) => c !== "santa-cruz"));

// Permanently-closed / never-recommend places + venues. Keyed by normalizeName()
// so the match survives apostrophe/quote/ampersand variants. Add an entry here
// (not in blockedNames) when a place is gone for good — this applies to every
// plan, not just one shuffle.
const PERMANENT_NAME_BLOCKLIST = new Set<string>([
  normalizeName("3Below Theaters"), // San Jose — closed
].filter(Boolean));
const MAX_CARDS = 7;
const CANDIDATE_POOL_SIZE = 35; // expanded region = bigger pool, more variety

// Distance threshold in km for "nearby" places. The anchor city provides
// flavor/centering, but stops can span neighboring cities — the whole south
// bay reads as one region. 20km covers SJ ↔ Sunnyvale, Mountain View, Los
// Altos, Cupertino — all reasonable driving distance. The prompt still
// enforces geographic clustering so plans don't zigzag.
const NEARBY_KM = 20;

// Venue photo lookup — maps a normalized venue name to a photoRef from
// places.json so events inherit photos from their host venue. Computed
// once at module load (places.json is committed + imported statically).
// Expect ~40% hit rate on event venues; campus building names (Stanford,
// SCU sub-buildings) miss and fall through to the Unsplash category
// fallback in the UI.
const VENUE_PHOTO_LOOKUP: Map<string, string> = (() => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const map = new Map<string, string>();
  const places = (placesData as any).places ?? [];
  for (const p of places) {
    if (!p?.photoRef || !p?.name) continue;
    map.set(norm(p.name), p.photoRef);
  }
  return map;
})();

function lookupVenuePhoto(venue: string | null | undefined): string | null {
  if (!venue) return null;
  const norm = venue.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!norm) return null;
  // Exact normalized match.
  const exact = VENUE_PHOTO_LOOKUP.get(norm);
  if (exact) return exact;
  // Substring match — either the venue contains a place name or vice versa.
  // Only consider place names ≥9 chars to avoid spurious hits on short words.
  for (const [placeName, photoRef] of VENUE_PHOTO_LOOKUP) {
    if (placeName.length < 9) continue;
    if (norm.includes(placeName) || placeName.includes(norm)) return photoRef;
  }
  return null;
}

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

// Category-aware fallback blurbs used when an event/place has no description
// and we're force-inserting or replacing without a Claude-generated blurb.
// Keep these varied + specific so cards never collapse to "Swing by X and
// see what's going on" (which reads as filler, not recommendation).
const FALLBACK_BLURB_POOL: Record<string, string[]> = {
  "event.food": [
    "Food event — grab something to eat and post up.",
    "Local food happening — bring an appetite.",
    "Food pop-up worth stopping in for.",
  ],
  "event.arts": [
    "Art happening — step in and see the work.",
    "Gallery event — quick browse, easy stop.",
    "Arts event, low-key drop-in vibe.",
  ],
  "event.music": [
    "Live music — catch a set.",
    "Music night at this spot.",
    "Concert-style evening — stay for a song or two.",
  ],
  "event.entertainment": [
    "Live entertainment — worth a stop.",
    "Show on tonight — walk in and see what's playing.",
    "Performance slot — settle in and enjoy.",
  ],
  "event.sports": [
    "Game-time — good excuse to cheer.",
    "Sports event — quick stop for the action.",
  ],
  "event.outdoor": [
    "Outdoor event — get some fresh air.",
    "Outdoors thing — stretch the legs and poke around.",
  ],
  "event.shopping": [
    "Market/pop-up — browse the stalls.",
    "Shopping event — pick up something local.",
  ],
  "event.museum": [
    "Museum event — small-scale, easy visit.",
    "Exhibit-adjacent event — plan an hour.",
  ],
  "event.wellness": [
    "Low-key wellness drop-in.",
    "Wellness event — easy hour.",
  ],
  "event.events": [ // community/family/education catchall
    "Community event — free to drop in.",
    "Local gathering — everyone welcome.",
    "Free event, casual drop-in vibe.",
    "Neighborhood thing — stop by for a bit.",
  ],
  "place.food": [
    "Solid local pick for a meal.",
    "Go-to spot nearby — easy table.",
    "Good food, no fuss.",
  ],
  "place.outdoor": [
    "Good place to walk and clear your head.",
    "Nice spot to get some air.",
    "Easy outdoor stretch.",
  ],
  "place.arts": [
    "Worth a quick gallery browse.",
    "Low-key arts stop.",
  ],
  "place.museum": [
    "Short museum stop — worth an hour.",
    "Easy browse, rotating exhibits.",
  ],
  "place.shopping": [
    "Fun to poke around.",
    "Good browse — pick something up or don't.",
  ],
  "place.entertainment": [
    "Nice spot to unwind for an hour or two.",
  ],
  "place.wellness": [
    "Wind-down stop.",
  ],
  "place.sports": [
    "Good slot to stay active.",
  ],
};

export function fallbackBlurb(
  source: "event" | "place",
  category: string | null | undefined,
  name: string,
  venue: string | null | undefined,
): string {
  const cat = (category || "").toLowerCase();
  const key = `${source}.${cat}`;
  const pool = FALLBACK_BLURB_POOL[key] || FALLBACK_BLURB_POOL[`${source}.events`] || [];
  if (pool.length === 0) {
    // Last-ditch generic — still better than "swing by X".
    const at = venue && venue !== name ? ` at ${venue}` : "";
    return `Quick stop${at}.`;
  }
  // Deterministic-but-varied: hash name so the same card gets the same
  // blurb every render (no flicker on re-fetch) but different cards pick
  // different templates.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length];
}

// Build a "HH:MM AM/PM - HH:MM AM/PM" timeBlock from an event's start time.
// Prefers a given endTime; otherwise defaults to start + 90 minutes. Sports
// events return just the start time — you don't show up halfway through a
// baseball game.
export function timeBlockFromEventTime(
  eventTime: string | null | undefined,
  eventEndTime?: string | null,
  fallback = "7:00 PM - 8:30 PM",
  category?: string | null,
): string {
  if (!eventTime) return fallback;
  const startMatch = eventTime.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (!startMatch) return fallback;
  const startH = parseHour(startMatch[1]);
  if (startH === null) return startMatch[1];

  // If we have an explicit endTime, use it verbatim.
  if (eventEndTime) {
    const endMatch = eventEndTime.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    if (endMatch) return `${startMatch[1]} - ${endMatch[1]}`;
  }

  // Sports: just the start time. Games run 2-3+ hours and you arrive at
  // first pitch / kickoff, not in the middle.
  if ((category || "").toLowerCase() === "sports") {
    return startMatch[1];
  }

  // Else default to +90 min.
  const startMin = parseInt(eventTime.match(/\d{1,2}:(\d{2})/)?.[1] || "0", 10);
  const totalEndMin = startH * 60 + startMin + 90;
  const endH = Math.floor(totalEndMin / 60) % 24;
  const endMin = totalEndMin % 60;
  const endAmPm = endH >= 12 ? "PM" : "AM";
  const endHour12 = endH > 12 ? endH - 12 : endH === 0 ? 12 : endH;
  return `${startMatch[1]} - ${endHour12}:${String(endMin).padStart(2, "0")} ${endAmPm}`;
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
export function parseHour(timeStr: string): number | null {
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

/** Convert "9:30 PM" / "21:30" / "9:30" into minutes-since-midnight. */
function parseClockToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = (m[3] || "").toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  if (!ampm && h < 8) h += 12; // heuristic: 7:30 without AM/PM in evening events → 19:30
  return h * 60 + min;
}

/** Duration in minutes between start and end clock strings, or null if unparseable. */
function computeDurationMin(start: string | null | undefined, end: string | null | undefined): number | null {
  const a = parseClockToMinutes(start);
  const b = parseClockToMinutes(end);
  if (a === null || b === null) return null;
  const d = b - a;
  return d > 0 ? d : null;
}

/**
 * Round the plan's START time to the next :00 or :30 so users get a clean
 * clock-aligned start with a small buffer. If the current minute is already
 * on :00 or :30, add another 30 minutes. Examples:
 *   10:00 → 10:30  |  10:15 → 10:30  |  10:30 → 11:00  |  10:45 → 11:00
 *   15:53 → 16:00
 * Returns { startHour (0-23), startMinute (0 or 30), formatted (e.g. "4:00 PM") }.
 */
function computeStartTime(hour: number, minute: number): { startHour: number; startMinute: number; formatted: string } {
  const total = hour * 60 + minute;
  let rounded = Math.ceil(total / 30) * 30;
  if (total % 30 === 0) rounded += 30;
  const startHour = Math.floor(rounded / 60) % 24;
  const startMinute = rounded % 60;
  const ampm = startHour >= 12 ? "PM" : "AM";
  const h12 = startHour === 0 ? 12 : startHour > 12 ? startHour - 12 : startHour;
  const formatted = `${h12}:${String(startMinute).padStart(2, "0")} ${ampm}`;
  return { startHour, startMinute, formatted };
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

    // Simplified weather classification for scoring. Threshold lowered from
    // 50% → 40% so a forecast like "40% chance of rain" also tips us toward
    // indoor picks. Rain + cold is a noticeable quality lever for day plans.
    const isRainy = rainPct >= 40 || [61, 63, 65, 71, 73, 75, 80, 81, 82, 95, 96, 99].includes(weatherCode);
    const isHot = high > 90;
    const isCold = high < 55;
    const isNice = !isRainy && !isHot && !isCold;

    return {
      weather: `${temp}°F, high ${high}°F${rainPct >= 5 ? `, ${rainPct}% chance of rain` : ""}`,
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

interface RecentPenaltyInput {
  byId: Map<string, number>;
  byName: Map<string, number>;
}

/** Score penalty for a card we've already shown the user. Today's picks
 *  are punished hard enough to push them out of the top-35 pool entirely
 *  (base scores for a curated 4.7 kid-friendly outdoor park top out near
 *  ~85, so -45 drops them below most in-pool competitors even with max
 *  jitter). The penalty fades over a week so the pool eventually forgets. */
function recentPenalty(daysAgo: number): number {
  if (daysAgo <= 0) return 45;
  if (daysAgo <= 2) return 25;
  if (daysAgo <= 7) return 10;
  return 0;
}

function scoreCandidates(
  candidates: Candidate[],
  weather: WeatherContext | null,
  hour: number,
  kids: boolean,
  prefs?: UserPreferences,
  recent?: RecentPenaltyInput,
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
    // Softened from +15/+5 → +10/+3. Curated places without a numeric
    // rating (Rose Garden, Hakone, Shoreline, etc.) used to fall ~15
    // points behind rated curated picks and systematically lost; they
    // now get a parity baseline so the rotation actually rotates.
    if (c.rating && c.rating >= 4.5) score += 10;
    else if (c.rating && c.rating >= 4.0) score += 3;
    else if ((c as any).curated && (!c.rating || c.rating === 0)) score += 7;

    // --- Curated places are premium ---
    if ((c as any).curated) score += 25;

    // --- Food places get a meal-slot boost ---
    if (c.category === "food") score += 10;

    // --- Kid-friendliness ---
    if (kids && c.kidFriendly === true) score += 15;
    if (kids && c.kidFriendly === false) score -= 40; // strong penalty

    // --- Weather appropriateness ---
    // Rain + cold are two of the biggest "wish they'd planned better" vectors.
    // Hard-penalize outdoor picks when it's raining or cold, and give indoor
    // picks a modest boost in categories that actually work when the weather
    // is lousy (museums, entertainment, food, shopping).
    const INDOOR_RESCUE_CATS = new Set(["museum", "entertainment", "food", "shopping", "arts"]);
    if (weather) {
      if (weather.isRainy && c.indoorOutdoor === "outdoor") score -= 30;
      if (weather.isRainy && c.indoorOutdoor === "indoor") score += 15;
      if (weather.isRainy && !c.indoorOutdoor && INDOOR_RESCUE_CATS.has(c.category)) score += 10;
      if (weather.isCold && c.indoorOutdoor === "outdoor") score -= 15;
      if (weather.isCold && !c.indoorOutdoor && INDOOR_RESCUE_CATS.has(c.category)) score += 5;
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

    // --- Dial down wellness/spa hard — they crowd out more interesting picks.
    //     -20 wasn't enough; wellness kept winning evening slots. -60 makes it
    //     a last-resort option only.
    if (c.category === "wellness") score -= 60;

    // --- Duration-aware penalty: a 6-hour festival starting at 4 PM leaves
    //     only room for ~1 more stop. Demote very long events when we're
    //     already late in the day so they don't hog the plan. ---
    if (c.source === "event" && c.eventDurationMin && c.eventDurationMin > 240) {
      if (hour >= 15) score -= 15; // after 3 PM, long events crowd the plan
    }

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

    // --- Recently-shown penalty (graduated). A 7-day ledger persists on
    //     the client, so the same venue can't anchor every day. Today's
    //     picks get -25 (hard enough to displace a dominant candidate),
    //     last-2-days -15, last-week -7. Also matches by normalized
    //     name so multi-record places (e.g. 6 "Los Gatos Creek Trail"
    //     entries across cities) all get penalized together. ---
    if (recent) {
      const idPenalty = recent.byId.get(c.id) ?? 0;
      const nameKey = (c.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      const namePenalty = nameKey ? (recent.byName.get(nameKey) ?? 0) : 0;
      score -= Math.max(idPenalty, namePenalty);
    }

    // --- Random jitter for variety. Widened from ±10 to ±25 so close
    //     top-of-pool candidates actually reshuffle between loads. ---
    score += Math.random() * 25;

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
  blockedNames?: Set<string>,
  startTimeContext?: { startHour: number; startMinute: number; formatted: string },
  dismissedNames?: Set<string>,
): Candidate[] {
  const candidates: Candidate[] = [];
  const cityConfig = CITY_MAP[city];
  const today = targetDate || todayStr();
  const isBlocked = (name: string | null | undefined) => {
    const n = normalizeName(name);
    if (!n) return false;
    if (PERMANENT_NAME_BLOCKLIST.has(n)) return true;
    if (!blockedNames || blockedNames.size === 0) return false;
    return blockedNames.has(n);
  };
  // Per-user "Never" hides: filter by normalized name so a hide survives an
  // ID change between sessions (curated → Google Places re-keying, etc.).
  const isDismissedByName = (name: string | null | undefined) => {
    if (!dismissedNames || dismissedNames.size === 0) return false;
    const n = normalizeName(name);
    return n ? dismissedNames.has(n) : false;
  };

  // --- Events happening today or soon, in/near the city ---
  // Defensive title blocklist — upstream generate-events.mjs should catch these,
  // but enforce again here so any slip-through never lands in a day plan.
  const PLAN_TITLE_BLOCKLIST = [
    /\bpractice\b/i,
    /\brehearsal\b/i,
    /\bboard meeting\b/i,
    /\bstaff meeting\b/i,
    /\bcommittee meeting\b/i,
    /\bcommission\b.*\bmeeting\b/i,
    /\bregular meeting\b/i,
    /\bspecial meeting\b/i,
    /\bsubcommittee\b/i,
    /\bstudy session\b/i,
    /\bstorytime\b/i,
  ];
  const events = (eventsData as any).events ?? [];
  // Virtual events are never valid day-plan stops. We rely on the upstream
  // generator to set evt.virtual, but fall back to title/description sniffing
  // via the SHARED filter module so the plan pool is never contaminated even
  // if generation missed a pattern.
  for (const evt of events) {
    if (dismissedIds.has(`event:${evt.id}`)) continue;
    if (isDismissedByName(evt.title) || isDismissedByName(evt.venue)) continue;
    if (evt.virtual === true) continue;
    if (isVirtualEvent(evt)) continue;
    if (evt.title && PLAN_TITLE_BLOCKLIST.some((re) => re.test(evt.title))) continue;
    if (isBlocked(evt.title) || isBlocked(evt.venue)) continue;

    // Only today's events — ongoing exhibitions ok, but skip future single-day events
    const isToday = evt.date === today;
    const isOngoingExhibition = evt.ongoing && !evt.date; // no specific date = true ongoing
    const isOngoingPastStart = evt.ongoing && evt.date && evt.date <= today;
    if (!isToday && !isOngoingExhibition && !isOngoingPastStart) continue;

    // Weekly-recurring guard: if an ongoing event has a past start date, it's a
    // weekly-recurring slot (farmers markets, weekly meetups, etc.) — only
    // include if today is the same day-of-week. Without this, a Sunday farmers
    // market shows up in a Wednesday plan. (noon UTC avoids TZ edge cases.)
    if (isOngoingPastStart && !isToday) {
      const origDow = new Date(`${evt.date}T12:00:00Z`).getUTCDay();
      const todayDow = new Date(`${today}T12:00:00Z`).getUTCDay();
      if (origDow !== todayDow) continue;
    }

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

    // Audience-age filter — events tagged at ingest as kids-only should
    // never appear in adult plans, and 21+/drag/tasting events should never
    // appear in kids plans. "all" (default for most events) passes both.
    // Missing tag also passes — we never had it tagged before 2026-04-22.
    const aa = (evt as any).audienceAge as string | undefined;
    if (aa === "kids" && !kids) {
      logDecision({
        script: "plan-day",
        action: "dropped",
        target: `${evt.title} (event:${evt.id})`,
        reason: `kids-only event in adult plan`,
        meta: { city, targetDate: today, audienceAge: aa },
      });
      continue;
    }
    if (aa === "adult" && kids) {
      logDecision({
        script: "plan-day",
        action: "dropped",
        target: `${evt.title} (event:${evt.id})`,
        reason: `adult-only event in kids plan`,
        meta: { city, targetDate: today, audienceAge: aa },
      });
      continue;
    }

    // Past-today filter: drop today's timed events whose end is before the
    // plan's start. e.g. at 5 PM, don't surface a 3 PM library class —
    // it's already over. Ongoing exhibits (no time, or already passed
    // start-date) are handled above.
    if (isToday && evt.time && startTimeContext) {
      const startH = parseHour(evt.time.split(/\s*-\s*/)[0]);
      if (startH !== null) {
        const startM = (evt.time.match(/\d{1,2}:(\d{2})/)?.[1]) || "00";
        const evtStartMin = startH * 60 + parseInt(startM, 10);
        const evtDurationMin = computeDurationMin(evt.time, evt.endTime) || 90;
        const evtEndMin = evtStartMin + evtDurationMin;
        const planStartMin = startTimeContext.startHour * 60 + startTimeContext.startMinute;
        if (evtEndMin <= planStartMin) {
          logDecision({
            script: "plan-day",
            action: "dropped",
            target: `${evt.title} (event:${evt.id})`,
            reason: `event ended before plan start (evt ${evt.time} +${evtDurationMin}m, plan starts ${startTimeContext.formatted})`,
            meta: { city, targetDate: today },
          });
          continue;
        }
      }
    }

    candidates.push({
      id: `event:${evt.id}`,
      name: evt.title,
      category: canonicalCategory(evt.category || "events"),
      city: evt.city,
      address: evt.address || "",
      venue: evt.venue || null,
      description: evt.description?.slice(0, 200),
      blurb: (evt as any).blurb || null,
      cost: evt.cost,
      costNote: (evt as any).costNote || null,
      kidFriendly: evt.kidFriendly ?? null,
      url: evt.url,
      // Prefer ingest-time image (OG scrape or Recraft) over venue-match photoRef.
      // Falls back to live venue lookup for any event that predates the ingest pass.
      photoRef: (evt as any).photoRef || lookupVenuePhoto(evt.venue),
      image: (evt as any).image || null,
      source: "event",
      eventDate: evt.date,
      eventTime: evt.time,
      eventEndTime: evt.endTime,
      eventDurationMin: computeDurationMin(evt.time, evt.endTime),
      ongoing: evt.ongoing ?? false,
      score: 0,
    });
  }

  // --- Places from the pool ---
  // Venue-only types: only useful if there's an actual event today
  const VENUE_ONLY_TYPES = new Set([
    "performing_arts_theater", "concert_hall", "amphitheatre",
    "auditorium", "opera_house", "philharmonic_hall",
    "event_venue", "banquet_hall", "convention_center",
    "stadium", "arena", "live_music_venue", "comedy_club",
  ]);

  // Places that should never appear in day plans
  const EXCLUDED_TYPES = new Set([
    "preschool", "child_care_agency", "day_care_center",
    "school", "primary_school", "secondary_school", "middle_school",
    "hospital", "doctor", "dentist", "pharmacy", "veterinary_care",
    "dental_clinic", "medical_lab", "urgent_care_clinic",
    "chiropractor", "physiotherapist", "psychologist",
    "insurance_agency", "lawyer", "accounting", "real_estate_agency",
    "car_dealer", "car_repair", "car_wash", "gas_station",
    "electric_vehicle_charging_station", "auto_parts_store",
    "funeral_home", "cemetery", "storage", "self_storage",
    "post_office", "bank", "atm", "laundry", "dry_cleaner",
    "locksmith", "plumber", "electrician", "roofing_contractor",
    "moving_company", "travel_agency",
  ]);

  const places = (placesData as any).places ?? [];
  for (const p of places) {
    if (dismissedIds.has(`place:${p.id}`)) continue;
    if (isDismissedByName(p.name)) continue;
    if (isBlocked(p.name)) continue;

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

    // Skip generic "Downtown X" / neighborhood tiles — Stephen has asked for
    // specific restaurants/shops as plan cards, not vague neighborhood names.
    // Score penalty alone wasn't enough because the curated boost (+25) offset it.
    if ((p.category || "").toLowerCase() === "neighborhood") continue;

    // Filter to city or nearby
    if (p.city !== city) {
      if (!p.lat || !p.lng || !cityConfig) continue;
      const dist = haversineKm(cityConfig.lat, cityConfig.lon, p.lat, p.lng);
      if (dist > NEARBY_KM) continue;
    }

    candidates.push({
      id: `place:${p.id}`,
      name: p.name,
      category: canonicalCategory(p.category || "food"),
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
      // Fall back to venue-match lookup — places.json has ~38 entries and
      // occasional dupes where one row is missing photoRef. The lookup
      // table picks any matching row's photoRef, so "DishDash" (null)
      // inherits from "Dishdash Middle Eastern Cuisine" (populated).
      photoRef: p.photoRef || lookupVenuePhoto(p.name) || null,
      hours: p.hours,
      displayType: p.displayType || null,
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
  targetDate?: string,
  weekContext?: { anchorCities?: string[]; categorySaturation?: Record<string, number> },
  startTime?: { startHour: number; startMinute: number; formatted: string },
  lockedTimeMap?: Map<string, string>,
): Promise<DayCard[]> {
  const client = new Anthropic({ apiKey: import.meta.env.ANTHROPIC_API_KEY });
  const cityName = getCityName(city);
  // The DOW/date we put in the prompt MUST be the plan's date, not generation
  // time. Otherwise the model writes blurbs referencing the wrong day of week
  // (e.g. "a great Sunday afternoon" on a Monday plan).
  const planDateObj = targetDate ? new Date(`${targetDate}T12:00:00`) : new Date();
  const today = planDateObj.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const timeSlot = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  // Fallback: if caller didn't pass a computed start time, round the hour
  // ourselves so the prompt never says "15:00" when it's actually 3:53 PM.
  const start = startTime ?? computeStartTime(hour, 0);
  const startH = start.startHour;

  // Format locked items. Avoid the word "LOCKED" in the section header
  // because the model has echoed it back as a literal timeBlock value.
  // If the caller supplied a timeBlock for a locked card (e.g. the user
  // locked it at a specific slot), pass it to Claude so the plan is
  // anchored to that time rather than Claude re-guessing.
  const lockedSection = lockedCandidates.length > 0
    ? `\n\nMUST-INCLUDE ITEMS (plan around these — always include every one):\n${lockedCandidates.map((c) => {
        const pinnedTime = lockedTimeMap?.get(c.id);
        const timeHint = pinnedTime
          ? ` — keep at ${pinnedTime}`
          : c.eventTime ? ` at ${c.eventTime}` : "";
        return `- ${c.name} (${c.category}, ${c.city})${timeHint}`;
      }).join("\n")}`
    : "";

  // Format candidate pool (top items by score)
  const topPool = pool.slice(0, CANDIDATE_POOL_SIZE);
  const poolText = topPool
    .map((c, i) => {
      const parts = [`${i + 1}. [${c.id}] ${c.name}`];
      parts.push(`category: ${c.category}`);
      if (c.displayType) parts.push(`type: ${c.displayType}`);
      parts.push(`city: ${c.city}`);
      if (c.address) parts.push(`address: ${c.address}`);
      if (c.source === "event" && !c.ongoing) parts.push(`EVENT TODAY`);
      if (c.source === "event" && c.ongoing) parts.push(`ongoing exhibition (daytime hours only — must end by 5 PM)`);
      if (c.eventTime) {
        // Include both start and end (or explicit duration) so Claude can
        // size the timeBlock realistically. Without this, a 6-hour festival
        // gets planned like a 1-hour talk and overlaps later cards.
        const timeStr = c.eventEndTime
          ? `${c.eventTime}–${c.eventEndTime}`
          : c.eventTime;
        parts.push(`time: ${timeStr}`);
        if (c.eventDurationMin) {
          const hrs = Math.round(c.eventDurationMin / 60 * 10) / 10;
          parts.push(`duration: ${hrs}h`);
        }
      }
      if (c.rating) parts.push(`rating: ${c.rating}`);
      if (c.cost) parts.push(`cost: ${c.cost}`);
      if (c.costNote) parts.push(`price: ${c.costNote}`);
      if (c.kidFriendly === true) parts.push(`kid-friendly`);
      if (c.why) parts.push(`note: ${c.why}`);
      if (c.indoorOutdoor) parts.push(`setting: ${c.indoorOutdoor}`);
      // Pre-written blurb from ingest pass — if this candidate is picked,
      // we'll overwrite Claude's blurb with this one anyway. Including it
      // lets Claude know what the event actually is instead of inventing.
      if (c.blurb) parts.push(`blurb: ${c.blurb}`);
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

  // Week-level context — when the caller (generate-schedule.mjs) is batching
  // multiple days, give Claude visibility into what's already in the batch so
  // it can diversify rather than stacking the same venues/categories.
  let weekContextSection = "";
  if (weekContext) {
    const parts: string[] = [];
    const anchors = (weekContext.anchorCities || []).filter(Boolean);
    if (anchors.length) {
      const counts: Record<string, number> = {};
      for (const a of anchors) counts[a] = (counts[a] || 0) + 1;
      const summary = Object.entries(counts)
        .map(([c, n]) => (n > 1 ? `${c} (${n}×)` : c))
        .join(", ");
      parts.push(`Anchor cities already picked this week: ${summary}. Prefer neighborhoods that complement, not duplicate — but don't force a far-away city just to be different.`);
    }
    const cats = weekContext.categorySaturation || {};
    const saturated = Object.entries(cats).filter(([, n]) => n >= 2);
    if (saturated.length) {
      parts.push(`Category saturation so far this week: ${saturated.map(([c, n]) => `${c} ×${n}`).join(", ")}. Lean AWAY from these categories when there's an equally good alternative.`);
    }
    if (parts.length) weekContextSection = `\n\nTHIS-WEEK CONTEXT (use to diversify):\n${parts.join("\n")}`;
  }

  const prompt = `You are the day-planning engine for South Bay Today, a local guide for the South Bay region of California. Today's plan is anchored around ${cityName}, but the candidate pool pulls from the whole South Bay — stops in adjacent cities (Santa Clara, Campbell, Sunnyvale, Mountain View, Cupertino, Los Gatos, etc.) are totally fine when they cluster geographically.

It's ${today}, ${timeSlot}. The user is reading this at roughly ${start.formatted} — that's when the plan should START. ${weather ? `Weather: ${weather}.` : ""}
${kids ? "This plan is for a family WITH KIDS. Prioritize kid-friendly activities." : "This plan is for adults WITHOUT KIDS."}
${describePreferences(prefs)}
${lockedSection}${weekContextSection}

CANDIDATE POOL:
${poolText}

TASK: Build a plan that starts at ${start.formatted} and fills the rest of the day until ~10 PM. The FIRST card's timeBlock MUST start at ${start.formatted} or later — nothing earlier. The user is reading this right now and cannot time-travel. Return a JSON array.

DO NOT suggest things for "tomorrow."

GEOGRAPHIC CLUSTERING (critical):
- Anchor the plan around ${cityName}, but feel free to include stops in adjacent South Bay cities if they fit geographically.
- Don't zigzag across the whole region. If you start in San Jose, don't send someone to Mountain View for lunch and back to SJ for dinner. Pick a cluster and stay in it — one or two neighboring cities max.
- A tight 15-minute-drive radius is ideal. People can drive a little, but chaos plans that cross 30 miles between stops are broken.

SHAPE — scale the plan to the remaining day, starting at ${start.formatted}:
${startH < 10 ? `Full day ahead — target 6–7 cards:
1. Breakfast/coffee (${start.formatted}–10 AM)
2. Morning activity (10 AM–12 PM)
3. Lunch (12–2 PM)
4. Afternoon activity (2–5 PM)
5. Happy hour / snack (5–6 PM, optional)
6. Dinner (6–8 PM)
7. Evening activity (8–10 PM)` : startH < 13 ? `Late morning start — target 5–6 cards. Skip breakfast:
1. Brunch or early lunch at ${start.formatted}
2. Afternoon activity (2–5 PM)
3. Happy hour / snack (5–6 PM, optional)
4. Dinner (6–8 PM)
5. Evening activity (8–10 PM)` : startH < 16 ? `Afternoon start — target 4–5 cards. No breakfast, no brunch:
1. First stop at ${start.formatted} — afternoon activity, late lunch, or café
2. Another activity or happy hour (5–6 PM)
3. Dinner (6–8 PM)
4. Evening activity (8–10 PM)` : startH < 19 ? `Early evening start — target 3–4 cards:
1. First stop at ${start.formatted} — happy hour, pre-dinner activity, or dinner itself
2. Dinner (6–8 PM) if not already the first slot
3. Evening activity (8–10 PM)` : `Evening start — target 2–3 cards:
1. First stop at ${start.formatted} — dinner, drinks, or an event tonight
2. Late activity (9–10 PM) — dessert, late bar, show`}

The plan MUST honor the target card count for the time window. Don't force 6+ cards when only a few hours of day remain — a short realistic plan beats a fake full-day plan.

CRITICAL RULES FOR BALANCE:
- Items marked "EVENT TODAY" are specific things happening today. Include 1-2 if any exist in the pool, but NEVER make the entire plan just events. A good day is activities + food + maybe an event.
- MEALS ARE REQUIRED: A full day plan MUST include food stops. If the plan starts before noon, include a breakfast/brunch/coffee spot. Always include lunch (noon-2pm). If the plan goes past 6pm, include dinner. Pick actual restaurants or cafes from the pool — not just "grab food somewhere."
- The ideal plan is: activity → food → activity → food → activity. Alternate between doing things and eating.

RULES:
- The FIRST card's timeBlock MUST start at ${start.formatted} or later. Never schedule anything before ${start.formatted}.
- Don't schedule things in the past
- Events with listed times are anchors — schedule around them
- If an event has no listed time, pick a reasonable slot for it
- NEVER put two items of the same category back-to-back. No two parks in a row, no two food stops in a row. The only food-after-food that's OK is lunch + dinner with at least 3 hours between them — eating a sit-down meal and then immediately going to another restaurant is a nonsense plan ("have lunch, then go eat crab" is the kind of thing you must never ship).
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
    max_tokens: 2500,
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

  // Map id → pool rank (1-based) for the rationale breadcrumb.
  const poolRank = new Map(topPool.map((c, i) => [c.id, i + 1]));

  const cards: DayCard[] = [];
  for (const pick of picks) {
    const candidate = candidateMap.get(pick.id);
    if (!candidate) continue;

    // Force event cards to use the event's actual start time — Claude has
    // shown a habit of parking events in convenient slots ("Kids Knitting
    // 8:30 PM" for an event that was really at 3 PM). Events have a known
    // real-world time; Claude doesn't get to rewrite it. Only places (no
    // eventTime) get Claude's chosen timeBlock.
    let timeBlock: string;
    if (candidate.source === "event" && candidate.eventTime) {
      const forced = timeBlockFromEventTime(candidate.eventTime, candidate.eventEndTime, undefined, candidate.category);
      if (pick.timeBlock && pick.timeBlock !== forced) {
        logDecision({
          script: "plan-day",
          action: "autofixed",
          target: `${candidate.name} (${candidate.id})`,
          reason: `forced event timeBlock: claude said "${pick.timeBlock}", actual is "${forced}"`,
          meta: { city, targetDate, eventTime: candidate.eventTime },
        });
      }
      timeBlock = forced;
    } else {
      timeBlock = isValidTimeBlock(pick.timeBlock)
        ? pick.timeBlock
        : timeBlockFromEventTime(candidate.eventTime, undefined, undefined, candidate.category);
    }

    const isLocked = lockedCandidates.some((l) => l.id === candidate.id);
    const rank = poolRank.get(candidate.id);
    const rationaleParts: string[] = [];
    if (isLocked) rationaleParts.push("locked-by-caller");
    else if (rank) rationaleParts.push(`claude:pool-rank-${rank}/${topPool.length}`);
    else rationaleParts.push("claude:pick");
    if (candidate.source === "event") rationaleParts.push(candidate.ongoing ? "ongoing-exhibit" : "event-today");
    if (candidate.rating) rationaleParts.push(`rating=${candidate.rating}`);
    if (candidate.category) rationaleParts.push(`cat=${candidate.category}`);
    const rationale = rationaleParts.join(" | ");

    // Blurb precedence for cards: ingest-time blurb (stable across shuffles,
    // Haiku-written with the real description for context) > Claude's per-run
    // improvisation > cached description prose > category fallback pool.
    // Events with ingest blurbs never drift into "Swing by X and see what's
    // going on" territory.
    const cardBlurb =
      candidate.blurb ||
      pick.blurb ||
      candidate.description?.slice(0, 200) ||
      fallbackBlurb(candidate.source, candidate.category, candidate.name, candidate.venue);

    cards.push({
      id: candidate.id,
      name: candidate.name,
      category: candidate.category,
      city: candidate.city,
      address: candidate.address,
      timeBlock,
      blurb: cardBlurb,
      why: pick.why,
      url: candidate.url,
      mapsUrl: candidate.mapsUrl,
      cost: candidate.cost,
      costNote: kids && candidate.kidsCostNote ? candidate.kidsCostNote : candidate.costNote,
      kidsCostNote: candidate.kidsCostNote,
      photoRef: (candidate as any).photoRef || null,
      image: (candidate as any).image || null,
      venue: candidate.venue || null,
      source: candidate.source,
      locked: isLocked,
      rationale,
    });

    logDecision({
      script: "plan-day",
      action: "picked",
      target: `${candidate.name} (${candidate.id})`,
      reason: rationale,
      meta: { city, targetDate, timeBlock, kids },
    });
  }

  // Post-process: force locked items into the plan if Claude forgot them.
  // Time precedence: caller-pinned timeBlock > event's scheduled time >
  // fallback slot. This keeps a place locked at 10:30 AM from drifting
  // to a default 7 PM slot.
  for (const locked of lockedCandidates) {
    if (!cards.some((c) => c.id === locked.id)) {
      console.log(`[plan-day] forcing locked item: ${locked.name}`);
      const pinnedTime = lockedTimeMap?.get(locked.id);
      const timeBlock = pinnedTime || timeBlockFromEventTime(locked.eventTime, undefined, undefined, locked.category);
      cards.push({
        id: locked.id,
        name: locked.name,
        category: locked.category,
        city: locked.city,
        address: locked.address,
        timeBlock,
        blurb: locked.blurb || locked.description?.slice(0, 200) || fallbackBlurb(locked.source, locked.category, locked.name, locked.venue),
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
        rationale: "locked-force-insert | claude-omitted",
      });
      logDecision({
        script: "plan-day",
        action: "force-inserted",
        target: `${locked.name} (${locked.id})`,
        reason: "locked item missing from Claude output",
        meta: { city, targetDate },
      });
    }
  }

  // Re-sort chronologically after forcing locked items
  cards.sort((a, b) => {
    const aH = parseHour(a.timeBlock.split(/\s*-\s*/)[0]) ?? 99;
    const bH = parseHour(b.timeBlock.split(/\s*-\s*/)[0]) ?? 99;
    return aH - bH;
  });

  // Post-process: strip any card whose timeBlock starts before the plan's
  // computed start time. Claude occasionally disregards the prompt and tries
  // to fill a "full day" shape even when we asked for current-time-through-EOD.
  if (startTime) {
    const before = cards.length;
    const startTotalMin = startTime.startHour * 60 + startTime.startMinute;
    for (let i = cards.length - 1; i >= 0; i--) {
      if (cards[i].locked) continue;
      const tb = cards[i].timeBlock.split(/\s*-\s*/)[0];
      // Reuse parseHour, but we need minutes too — parse manually
      const m = tb.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!m) continue;
      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const pm = m[3].toUpperCase() === "PM";
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      if (h * 60 + min < startTotalMin) {
        logDecision({
          script: "plan-day",
          action: "dropped",
          target: `${cards[i].name} (${cards[i].id})`,
          reason: `starts at ${tb} — before plan start time ${startTime.formatted}`,
          meta: { city, targetDate, startHour: startTime.startHour },
        });
        cards.splice(i, 1);
      }
    }
    if (cards.length < before) {
      console.log(`[plan-day] past-start filter: dropped ${before - cards.length} card(s) starting before ${startTime.formatted}`);
    }
  }

  // Post-process: enforce kids curfew — drop any card starting at or after 8 PM
  if (kids) {
    const before = cards.length;
    for (let i = cards.length - 1; i >= 0; i--) {
      if (cards[i].locked) continue;
      const startTime = cards[i].timeBlock.split(/\s*-\s*/)[0];
      const h = parseHour(startTime);
      // Malformed timeBlock is treated as a drop-worthy failure in kids mode:
      // we can't prove it's before curfew, and shipping an unparseable time
      // to a kids plan is worse than dropping one card.
      if (h === null) {
        console.warn(`[plan-day] kids curfew: unparseable timeBlock "${cards[i].timeBlock}" for ${cards[i].name} — dropping`);
        logDecision({
          script: "plan-day",
          action: "dropped",
          target: `${cards[i].name} (${cards[i].id})`,
          reason: `kids curfew — unparseable timeBlock "${cards[i].timeBlock}"`,
          meta: { city, targetDate, kids: true },
        });
        cards.splice(i, 1);
        continue;
      }
      if (h >= KIDS_CURFEW_HOUR) {
        logDecision({
          script: "plan-day",
          action: "dropped",
          target: `${cards[i].name} (${cards[i].id})`,
          reason: `kids curfew — starts at ${startTime}, cutoff ${KIDS_CURFEW_HOUR}:00`,
          meta: { city, targetDate, kids: true },
        });
        cards.splice(i, 1);
      }
    }
    if (cards.length < before) {
      console.log(`[plan-day] kids curfew: dropped ${before - cards.length} card(s) (past curfew or malformed time)`);
    }
  }

  // Post-process: detect blurb↔card mismatches. Sometimes Claude returns a
  // pick with id of one place but a blurb describing a different place in
  // the pool. The merge step uses the id to look up the candidate but keeps
  // the wrong blurb verbatim, producing cards like:
  //   "The Tech Interactive" + "Spend hours at the Rosicrucian Egyptian Museum"
  //
  // New rule: only drop if the blurb clearly describes a DIFFERENT pool
  // candidate (contains that candidate's distinctive name). Otherwise keep
  // it — generic-sounding blurbs for locally-vague venues like "Main Street
  // Cupertino" no longer get yanked because the name had no long unique word.
  {
    const before = cards.length;
    // Pre-compute "distinctive tokens" per pool candidate: long words (>=5
    // chars) from the venue name that aren't city names or generic fillers.
    const CITY_TOKENS = new Set([
      "san", "jose", "san-jose", "los", "gatos", "palo", "alto", "santa",
      "clara", "mountain", "view", "cupertino", "sunnyvale", "milpitas",
      "campbell", "saratoga", "south", "north", "east", "west", "downtown",
    ]);
    const GENERIC_TOKENS = new Set([
      "market", "museum", "center", "street", "avenue", "park", "plaza",
      "restaurant", "cafe", "bar", "library", "community",
    ]);
    const distinctive = (name: string): string[] => {
      return (name || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 5 && !CITY_TOKENS.has(w) && !GENERIC_TOKENS.has(w));
    };
    const poolDistinct = new Map<string, string[]>();
    for (const c of pool) poolDistinct.set(c.id, distinctive(c.name));

    for (let i = cards.length - 1; i >= 0; i--) {
      if (cards[i].locked) continue;
      const cardId = cards[i].id;
      const name = (cards[i].name || "").toLowerCase();
      const blurb = (cards[i].blurb || "").toLowerCase();
      if (!name || !blurb) continue;

      // Accept immediately if full name is substring of blurb.
      if (blurb.includes(name)) continue;

      // Accept if the blurb contains a distinctive token from THIS card's name.
      const ownDistinct = poolDistinct.get(cardId) || distinctive(name);
      if (ownDistinct.some((w) => blurb.includes(w))) continue;

      // Otherwise: check if the blurb clearly describes a DIFFERENT candidate.
      // Look for a distinctive token from any other pool candidate.
      let mismatchedTo: string | null = null;
      for (const [otherId, tokens] of poolDistinct.entries()) {
        if (otherId === cardId) continue;
        if (tokens.some((w) => blurb.includes(w))) {
          mismatchedTo = otherId;
          break;
        }
      }

      if (mismatchedTo) {
        console.log(`[plan-day] dropped blurb mismatch: card="${cards[i].name}" describes ${mismatchedTo} blurb="${cards[i].blurb?.slice(0, 80)}..."`);
        logDecision({
          script: "plan-day",
          action: "dropped",
          target: `${cards[i].name} (${cards[i].id})`,
          reason: `blurb describes different pool candidate (${mismatchedTo})`,
          meta: { city, targetDate, blurb: cards[i].blurb?.slice(0, 80) },
        });
        cards.splice(i, 1);
      }
      // Else: blurb is generic (no distinctive tokens from any candidate).
      // Keep it — Claude likely wrote a vague but on-topic description.
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

  // Post-process: eliminate same-category back-to-back runs.
  //
  // Food+food within 3 hours is the nightmare case ("have lunch, then go eat
  // crab"). For any same-category back-to-back pair, try to replace the second
  // card with a different-category candidate from the pool that fits the time
  // slot. Special rule for food: lunch + dinner is fine (gap >= 3 hours);
  // anything tighter is a planning failure and must be replaced.
  {
    const usedIds = new Set(cards.map((c) => c.id));
    const poolById = new Map(topPool.map((c) => [c.id, c]));

    for (let i = 1; i < cards.length; i++) {
      const prev = cards[i - 1];
      const cur = cards[i];
      if (cur.locked || prev.locked) continue;
      if (cur.category !== prev.category) continue;

      // For food, allow if the two meals are at least 3 hours apart
      // (lunch + dinner), otherwise treat as same-category back-to-back.
      if (cur.category === "food") {
        const prevStart = parseHour(prev.timeBlock.split(/\s*-\s*/)[0] || "") ?? -1;
        const curStart = parseHour(cur.timeBlock.split(/\s*-\s*/)[0] || "") ?? -1;
        if (prevStart >= 0 && curStart >= 0 && curStart - prevStart >= 3) continue;
      }

      // Find a replacement candidate: different from prev's category, not
      // already in the plan, and (if hours known) open during cur's slot.
      const [startStr, endStr] = cur.timeBlock.split(/\s*-\s*/);
      const slotStart = parseHour(startStr || "");
      const slotEnd = parseHour(endStr || "") ?? (slotStart !== null ? slotStart + 1 : null);

      let replacement: Candidate | null = null;
      for (const cand of topPool) {
        if (usedIds.has(cand.id)) continue;
        if (cand.category === prev.category) continue;
        if (cand.category === "neighborhood") continue;
        const hoursObj = (cand as any).hours as Record<string, string> | null | undefined;
        if (hoursObj && slotStart !== null && slotEnd !== null) {
          if (!fitsInOpenRange(hoursObj, slotStart, slotEnd)) continue;
        }
        // Events with a fixed start/end window must actually be happening
        // during the slot. A 9 AM–1 PM farmers market doesn't fit a 1:30 PM
        // gap, even if its category is right.
        if (cand.source === "event" && cand.eventTime && slotStart !== null && slotEnd !== null) {
          const evStart = parseHour(cand.eventTime.split(/\s*-\s*/)[0]);
          if (evStart !== null) {
            const evEnd = cand.eventEndTime ? parseHour(cand.eventEndTime) : evStart + 1.5;
            if (evEnd !== null && (evEnd <= slotStart || evStart >= slotEnd)) continue;
          }
        }
        replacement = cand;
        break;
      }

      if (!replacement) {
        // Couldn't find a pool replacement — drop the offending card rather
        // than ship "lunch then crab". A shorter plan > a dumb plan.
        console.log(`[plan-day] dropping back-to-back ${cur.category}: ${cur.name} after ${prev.name}`);
        cards.splice(i, 1);
        i--;
        continue;
      }

      console.log(`[plan-day] replacing back-to-back ${cur.category}: ${cur.name} → ${replacement.name}`);
      usedIds.delete(cur.id);
      usedIds.add(replacement.id);
      // Replacement events keep their real-world time; only places inherit
      // the original slot. Final sort below restores chronology.
      const replacementTimeBlock =
        replacement.source === "event" && replacement.eventTime
          ? timeBlockFromEventTime(replacement.eventTime, replacement.eventEndTime, undefined, replacement.category)
          : cur.timeBlock;
      cards[i] = {
        id: replacement.id,
        name: replacement.name,
        category: replacement.category,
        city: replacement.city,
        address: replacement.address,
        timeBlock: replacementTimeBlock,
        blurb: replacement.blurb || replacement.description?.slice(0, 160) || fallbackBlurb(replacement.source, replacement.category, replacement.name, replacement.venue),
        why: replacement.why || "A solid pick to break up the day.",
        url: replacement.url ?? null,
        mapsUrl: replacement.mapsUrl ?? null,
        cost: replacement.cost ?? null,
        costNote: kids && replacement.kidsCostNote ? replacement.kidsCostNote : (replacement.costNote ?? null),
        kidsCostNote: replacement.kidsCostNote ?? null,
        photoRef: (replacement as any).photoRef || null,
        venue: replacement.venue || null,
        source: replacement.source,
        locked: false,
      };
      void poolById; // reserved for future lookups
    }
  }

  // Defensive: any event card whose timeBlock drifted from the real event
  // window gets snapped back. The main sequencer + padder force this, but
  // back-to-back replacement and other paths historically copied a slot
  // verbatim and orphaned the eventTime. This catches every path.
  for (const card of cards) {
    if (card.source !== "event") continue;
    const candidate = candidateMap.get(card.id);
    const evTime = (candidate as any)?.eventTime;
    if (!evTime) continue;
    const forced = timeBlockFromEventTime(evTime, (candidate as any)?.eventEndTime, undefined, (candidate as any)?.category);
    if (card.timeBlock !== forced) {
      logDecision({
        script: "plan-day",
        action: "autofixed",
        target: `${card.name} (${card.id})`,
        reason: `event timeBlock drifted: "${card.timeBlock}" → "${forced}"`,
        meta: { city, targetDate, eventTime: evTime },
      });
      card.timeBlock = forced;
    }
  }

  // Final safety sort — guarantees chronological order regardless of what
  // post-processing steps above did.
  cards.sort((a, b) => {
    const aH = parseHour(a.timeBlock.split(/\s*-\s*/)[0]) ?? 99;
    const bH = parseHour(b.timeBlock.split(/\s*-\s*/)[0]) ?? 99;
    return aH - bH;
  });

  // Post-process: time-overlap validator. Claude sometimes hands back two
  // cards whose blocks intersect (e.g. card[i] 2-4 PM, card[i+1] 3-5 PM).
  // Keep the earlier one, drop the later one. Never drop a locked card —
  // those stay regardless.
  {
    const before = cards.length;
    const parseRange = (tb: string): [number, number] | null => {
      const m = tb.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!m) return null;
      const toMin = (h: string, min: string, ap: string) => {
        let hn = parseInt(h, 10);
        const mn = parseInt(min, 10);
        const pm = ap.toUpperCase() === "PM";
        if (pm && hn !== 12) hn += 12;
        if (!pm && hn === 12) hn = 0;
        return hn * 60 + mn;
      };
      return [toMin(m[1], m[2], m[3]), toMin(m[4], m[5], m[6])];
    };

    for (let i = cards.length - 1; i >= 1; i--) {
      if (cards[i].locked) continue;
      const prev = parseRange(cards[i - 1].timeBlock);
      const cur = parseRange(cards[i].timeBlock);
      if (!prev || !cur) continue;
      // prev.end > cur.start means overlap. Allow touching (prev.end == cur.start).
      if (prev[1] > cur[0]) {
        logDecision({
          script: "plan-day",
          action: "dropped",
          target: `${cards[i].name} (${cards[i].id})`,
          reason: `time overlap with ${cards[i - 1].name} (${cards[i - 1].timeBlock} vs ${cards[i].timeBlock})`,
          meta: { city, targetDate, prevEnd: prev[1], curStart: cur[0] },
        });
        cards.splice(i, 1);
      }
    }
    if (cards.length < before) {
      console.log(`[plan-day] overlap validator: dropped ${before - cards.length} overlapping card(s)`);
    }
  }

  return cards;
}

// ---------------------------------------------------------------------------
// padWithClaude — second Claude call that fills in missing stops for a
// thin plan. Used when sequenceWithClaude returns <6 cards. Context-aware:
// shows Claude the existing cards and asks it to fill the gaps with picks
// that fit the plan's geographic cluster and timeline.
// ---------------------------------------------------------------------------

async function padWithClaude(args: {
  partial: DayCard[];
  pool: Candidate[];
  targetTotal: number;
  city: City;
  kids: boolean;
  weather: string | null;
  targetDate?: string;
  startHour?: number;
  startFormatted?: string;
}): Promise<DayCard[]> {
  const { partial, pool, targetTotal, city, kids, weather, targetDate, startHour = 0, startFormatted } = args;
  const needed = targetTotal - partial.length;
  if (needed <= 0 || pool.length === 0) return [];

  const client = new Anthropic({ apiKey: import.meta.env.ANTHROPIC_API_KEY });
  const cityName = getCityName(city);

  const planDateObj = targetDate ? new Date(`${targetDate}T12:00:00`) : new Date();
  const today = planDateObj.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Describe the plan so far — cards the pad must fit around.
  const existingText = partial
    .map((c) => `  • ${c.timeBlock} — ${c.name} (${c.category}, ${c.city})`)
    .join("\n");

  // Identify the time gaps — but only for slots that are still in the future
  // relative to the plan's startHour. Don't ask for breakfast when it's 4 PM.
  const startHours = partial
    .map((c) => parseHour(c.timeBlock.split(/\s*-\s*/)[0]))
    .filter((h): h is number => h !== null);
  const earliest = startHours.length ? Math.min(...startHours) : 99;
  const latest = startHours.length ? Math.max(...startHours) : 0;
  const gapHints: string[] = [];
  if (startHour < 10 && earliest > 10) gapHints.push("Plan is missing a breakfast/morning-coffee stop (before 10 AM).");
  if (startHour < 13 && latest < 13) gapHints.push("Plan is missing lunch (12–2 PM).");
  if (startHour < 18 && latest < 18 && !kids) gapHints.push("Plan is missing dinner / evening activity (6–9 PM).");
  if (startHour < 19 && !partial.some((c) => c.category === "food")) gapHints.push("Plan has no food stops at all — add at least one meal that's still in the future.");
  if (gapHints.length === 0) gapHints.push(`Plan has ${partial.length} stops; extend the timeline forward from the last existing stop, never backward.`);

  // Pool text with ids so the model returns real candidates.
  const topPool = pool.slice(0, CANDIDATE_POOL_SIZE);
  const poolText = topPool
    .map((c, i) => {
      const parts = [`${i + 1}. [${c.id}] ${c.name}`, `category: ${c.category}`, `city: ${c.city}`];
      if (c.address) parts.push(`address: ${c.address}`);
      if (c.eventTime) parts.push(`time: ${c.eventTime}`);
      if (c.rating) parts.push(`rating: ${c.rating}`);
      if (c.costNote) parts.push(`price: ${c.costNote}`);
      if (c.blurb) parts.push(`blurb: ${c.blurb}`);
      return parts.join(" | ");
    })
    .join("\n");

  const prompt = `You are padding an incomplete day plan for South Bay Today. The partial plan already has ${partial.length} stops — your job is to ADD ${needed} more stops that fill the gaps. DO NOT change or repeat the existing stops.

It's ${today}.${startFormatted ? ` The user is reading this at roughly ${startFormatted} — NOTHING can be scheduled before ${startFormatted}.` : ""} Anchor: ${cityName}. ${weather ? `Weather: ${weather}.` : ""}

EXISTING STOPS (already locked in — do not return these):
${existingText}

GAPS TO FILL:
${gapHints.map((g) => `- ${g}`).join("\n")}

CANDIDATE POOL (pick ${needed} from here):
${poolText}

RULES:
- Return exactly ${needed} new stops, no more.
- Use ids from the pool. Do not invent ids.
${startFormatted ? `- Every new stop's timeBlock MUST start at ${startFormatted} or later. Never schedule anything before ${startFormatted}, even if the existing stops leave a "gap" earlier in the day — that gap is the past and cannot be filled.` : ""}
- Each new stop needs a timeBlock that fits between/around the existing stops without overlapping them.
- Cluster geographically with the existing cards; don't send the user across the region for a single stop.
- NEVER pick the same category as an adjacent existing stop.
- Blurbs: what to do at that specific place. Why: one casual sentence. No "real event", "only today", "unforgettable". No distance/travel mentions. No star ratings.

OUTPUT FORMAT (JSON array, no markdown fences, exactly ${needed} entries):
[{ "id": "...", "timeBlock": "HH:MM AM/PM - HH:MM AM/PM", "blurb": "...", "why": "..." }]

Return ONLY the JSON array.`;

  const response = await client.messages.create({
    model: CLAUDE_SONNET,
    max_tokens: 1200,
    messages: [{ role: "user", content: prompt }],
  });

  const text = extractText(response.content);
  const cleaned = stripFences(text);

  let picks: Array<{ id: string; timeBlock: string; blurb: string; why: string }>;
  try {
    picks = JSON.parse(cleaned);
  } catch {
    console.warn(`[plan-day] padWithClaude: failed to parse response: ${cleaned.slice(0, 200)}`);
    return [];
  }

  const candidateMap = new Map(topPool.map((c) => [c.id, c]));
  const padded: DayCard[] = [];
  const isValidTimeBlock = (tb: string | null | undefined): boolean => {
    if (!tb) return false;
    return /\d{1,2}:\d{2}\s*(?:AM|PM)/i.test(tb);
  };

  for (const pick of picks) {
    const candidate = candidateMap.get(pick.id);
    if (!candidate) continue;
    // Same force-fix as main planner: event cards MUST use the event's real
    // start time. Padder Claude runs a less careful prompt and is even more
    // likely to park events in convenient slots.
    let timeBlock: string;
    if (candidate.source === "event" && (candidate as any).eventTime) {
      timeBlock = timeBlockFromEventTime((candidate as any).eventTime, (candidate as any).eventEndTime, undefined, (candidate as any).category);
    } else {
      timeBlock = isValidTimeBlock(pick.timeBlock) ? pick.timeBlock : "12:00 PM - 1:00 PM";
    }
    const padBlurb =
      candidate.blurb ||
      pick.blurb ||
      candidate.description?.slice(0, 200) ||
      fallbackBlurb(candidate.source, candidate.category, candidate.name, candidate.venue);
    padded.push({
      id: candidate.id,
      name: candidate.name,
      category: candidate.category,
      city: candidate.city,
      address: candidate.address,
      timeBlock,
      blurb: padBlurb,
      why: pick.why,
      url: candidate.url,
      mapsUrl: candidate.mapsUrl,
      cost: candidate.cost,
      costNote: kids && candidate.kidsCostNote ? candidate.kidsCostNote : candidate.costNote,
      kidsCostNote: candidate.kidsCostNote,
      photoRef: (candidate as any).photoRef || null,
      image: (candidate as any).image || null,
      venue: candidate.venue || null,
      source: candidate.source,
      locked: false,
      rationale: `claude:pad | gap-fill | partial-had-${partial.length}`,
    });
    logDecision({
      script: "plan-day",
      action: "padded",
      target: `${candidate.name} (${candidate.id})`,
      reason: `context-aware pad to reach ${targetTotal} stops`,
      meta: { city, targetDate, partialCount: partial.length, timeBlock },
    });
  }

  return padded;
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

  const { city, kids = false, lockedIds = [], lockedCards = [], dismissedIds = [], dismissedNames = [], currentHour, currentMinute, planDate, preferences, blockedNames = [], weekContext, recentlyShown = [], noCache = false } = body;

  // Merge lockedCards into lockedIds + a time map. lockedCards is the richer
  // format; we accept lockedIds separately for backwards compat with older
  // callers (scripts, pre-rebuild clients).
  const lockedTimeMap = new Map<string, string>();
  for (const lc of lockedCards) {
    if (lc?.id && !lockedIds.includes(lc.id)) lockedIds.push(lc.id);
    if (lc?.id && lc.timeBlock) lockedTimeMap.set(lc.id, lc.timeBlock);
  }
  const blockedSet = new Set(blockedNames.map((n) => normalizeName(n)).filter(Boolean));

  // Validate city
  if (!city || !VALID_CITIES.has(city)) {
    return errJson(`Invalid city. Must be one of: ${[...VALID_CITIES].join(", ")}`, 400);
  }

  // Validate API key
  if (!import.meta.env.ANTHROPIC_API_KEY) {
    return errJson("Server configuration error", 500);
  }

  const hour = typeof currentHour === "number" ? currentHour : Number(currentPTHour());
  const minute = typeof currentMinute === "number" ? currentMinute : 0;
  const startTime = computeStartTime(hour, minute);
  // Normalize legacy `pad:X` prefixes (from old surgery scripts) to the
  // canonical `place:X` form so they still match candidate-pool IDs.
  const canonicalDismissed = (dismissedIds as string[]).flatMap((id) =>
    id.startsWith("pad:") ? [id, "place:" + id.slice(4)] : [id],
  );
  const dismissedSet = new Set(canonicalDismissed);
  const dismissedNameSet = new Set(
    (Array.isArray(dismissedNames) ? dismissedNames : [])
      .map((n: string) => normalizeName(n))
      .filter(Boolean) as string[],
  );
  const lockedSet = new Set(lockedIds);

  // Cache hit for default requests (no locks/dismissals/preferences/blocks).
  // noCache=true forces a fresh plan — used by the SHUFFLE button so the
  // user always sees a new plan even if they happen to hit the same anchor.
  const prefsHash = preferences ? Math.round((preferences.outdoorBias || 0) * 10 + (preferences.costBias || 0) * 10) : 0;
  const cacheKey = `${city}:${kids}:${hour}:${prefsHash}:${planDate || ""}`;
  // recentlyShown bypasses the cache too — a repeated request with the same
  // ledger would serve identical cards; the whole point of the ledger is
  // variety, so we always replan when it's present.
  if (!noCache && lockedIds.length === 0 && dismissedIds.length === 0 && dismissedNameSet.size === 0 && blockedSet.size === 0 && recentlyShown.length === 0) {
    const cached = planCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return okJson(cached.data, { "Cache-Control": "private, no-store" });
    }
  }

  try {
    // 1. Fetch weather
    const weatherData = await fetchWeather(city);
    const weatherContext: WeatherContext | null = weatherData.forecast?.[0] ?? null;

    // 2. Build candidate pool — pass startTime so past-today events get dropped
    const allCandidates = buildCandidatePool(city, kids, dismissedSet, lockedSet, planDate, blockedSet, startTime, dismissedNameSet);

    // 3. Score candidates. Graduated variety penalty: each entry in the
    // ledger comes with daysAgo so today's picks bite hardest and last
    // week's fade to a nudge. Backward-compatible with legacy string[].
    const recentById = new Map<string, number>();
    const recentByName = new Map<string, number>();
    for (const entry of recentlyShown) {
      if (typeof entry === "string") {
        recentById.set(entry, Math.max(recentById.get(entry) ?? 0, recentPenalty(0)));
        continue;
      }
      if (!entry) continue;
      const days = typeof entry.daysAgo === "number" ? entry.daysAgo : 0;
      const penalty = recentPenalty(days);
      if (penalty <= 0) continue;
      if (entry.id) recentById.set(entry.id, Math.max(recentById.get(entry.id) ?? 0, penalty));
      if (entry.name) {
        const key = entry.name.toLowerCase().replace(/\s+/g, " ").trim();
        if (key) recentByName.set(key, Math.max(recentByName.get(key) ?? 0, penalty));
      }
    }
    const recent: RecentPenaltyInput = { byId: recentById, byName: recentByName };
    const scored = scoreCandidates(allCandidates, weatherContext, hour, kids, preferences, recent);

    // 4. Separate locked items. Any id the client sent that's NOT in the
    // current pool is stale (event cancelled, place archived) — return
    // them to the client so it can purge state.locked instead of silently
    // shipping fewer cards every shuffle.
    const lockedCandidates = scored.filter((c) => lockedSet.has(c.id));
    const foundLockedIds = new Set(lockedCandidates.map((c) => c.id));
    const invalidLockedIds = [...lockedSet].filter((id) => !foundLockedIds.has(id));
    if (invalidLockedIds.length > 0) {
      console.log(`[plan-day] ${invalidLockedIds.length} invalid lockedId(s) (not in pool): ${invalidLockedIds.join(", ")}`);
      for (const id of invalidLockedIds) {
        logDecision({
          script: "plan-day",
          action: "invalid-lock",
          target: id,
          reason: "locked id not present in candidate pool (cancelled/archived)",
          meta: { city, targetDate: planDate },
        });
      }
    }
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
    // Caps use CANONICAL categories (see src/lib/south-bay/categories.mjs).
    // Any event-specific label like "music" gets mapped to "entertainment"
    // before the pool is built, so a single cap applies consistently.
    const CAT_CAPS: Record<string, number> = {
      outdoor: 3,
      museum: 2,
      entertainment: 3,
      wellness: 1,
      shopping: 2,
      arts: 3,
      sports: 2,
      events: 3,
    };
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
    let cards = await sequenceWithClaude(
      diversePool,
      lockedCandidates,
      weatherData.weather,
      city,
      kids,
      hour,
      preferences,
      planDate,
      weekContext,
      startTime,
      lockedTimeMap,
    );

    // 6b. Context-aware padding (Tier 2.1): if sequenceWithClaude returned a
    // thin plan, call Claude again with the partial + remaining pool to fill
    // the gaps with proper blurbs instead of generic padding picks.
    // Target scales with the remaining day — at 5 PM we don't want 7 cards.
    const MIN_STOPS =
      startTime.startHour < 10 ? 6 :
      startTime.startHour < 13 ? 5 :
      startTime.startHour < 16 ? 4 :
      startTime.startHour < 19 ? 3 :
      2;
    if (cards.length < MIN_STOPS) {
      const usedIds = new Set(cards.map((c) => c.id));
      const remainingPool = diversePool.filter((c) => !usedIds.has(c.id));
      if (remainingPool.length > 0) {
        console.log(`[plan-day] thin plan (${cards.length}/${MIN_STOPS}) — calling padWithClaude for ${MIN_STOPS - cards.length} more stops`);
        try {
          const padded = await padWithClaude({
            partial: cards,
            pool: remainingPool,
            targetTotal: MIN_STOPS,
            city,
            kids,
            weather: weatherData.weather,
            targetDate: planDate,
            startHour: startTime.startHour,
            startFormatted: startTime.formatted,
          });
          if (padded.length > 0) {
            cards = [...cards, ...padded].sort((a, b) => {
              const aH = parseHour(a.timeBlock.split(/\s*-\s*/)[0]) ?? 99;
              const bH = parseHour(b.timeBlock.split(/\s*-\s*/)[0]) ?? 99;
              return aH - bH;
            });
            console.log(`[plan-day] padded ${padded.length} card(s) → ${cards.length} total`);
          }
        } catch (err) {
          console.warn(`[plan-day] padWithClaude failed: ${(err as Error).message}`);
        }
      }
    }

    // 6c. Final hours sweep — applies to BOTH sequenced and padded cards.
    // sequenceWithClaude has its own check, but padded cards bypass it. Without
    // this sweep a padder pick like "Triton Museum at 7:30 AM" (museum opens 11)
    // slips through into the user-visible plan.
    {
      const candidateById = new Map(diversePool.map((c) => [c.id, c]));
      const before = cards.length;
      for (let i = cards.length - 1; i >= 0; i--) {
        if (cards[i].locked) continue;
        if (cards[i].source === "event") continue; // events keep their announced time
        const candidate = candidateById.get(cards[i].id);
        if (!candidate) continue;
        const hoursObj = (candidate as any).hours as Record<string, string> | null | undefined;
        if (!hoursObj) continue;
        const [startStr, endStr] = cards[i].timeBlock.split(/\s*-\s*/);
        const startH = parseHour(startStr || "");
        const endH = parseHour(endStr || "") ?? (startH !== null ? startH + 1 : null);
        if (startH === null || endH === null) continue;
        if (!fitsInOpenRange(hoursObj, startH, endH)) {
          console.log(`[plan-day] final hours sweep dropped ${cards[i].name} — ${cards[i].timeBlock} doesn't fit venue hours`);
          cards.splice(i, 1);
        }
      }
      if (cards.length < before) {
        console.log(`[plan-day] final hours sweep: dropped ${before - cards.length} card(s)`);
      }
    }

    const responseData = {
      cards,
      weather: weatherData.weather,
      city,
      kids,
      generatedAt: new Date().toISOString(),
      poolSize: allCandidates.length,
      // IDs the client sent in lockedIds/lockedCards that aren't in the
      // current pool. Client should purge these from its state so they
      // stop haunting future shuffles.
      invalidLockedIds: invalidLockedIds.length > 0 ? invalidLockedIds : undefined,
    };

    // Cache default requests for 5 min
    if (lockedIds.length === 0 && dismissedIds.length === 0 && dismissedNameSet.size === 0 && blockedSet.size === 0) {
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
