export const prerender = false;

// ---------------------------------------------------------------------------
// South Bay Today — Quality-first pillar/meal planner
// ---------------------------------------------------------------------------
// POST /api/plan-day
// Input:  { city, kids, lockedCards, dismissedIds, planDate, ... }
// Output: { cards: [...], weather, ... }
//
// Each plan starts with the three best activities available across the full
// relevant pool: one morning, one afternoon, one evening. Only then does each
// pillar receive a quality restaurant pairing within five miles. Geography is
// never optimized across pillars.
//
// Regional scope is the homepage/newsletter default. City pages opt into a
// strict city scope, but use the same pillar-first method.
// ---------------------------------------------------------------------------

import type { APIRoute } from "astro";
import Anthropic from "@anthropic-ai/sdk";
import { errJson, okJson } from "../../lib/apiHelpers";
import { rateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { CLAUDE_OPUS, extractText, stripFences } from "../../lib/models";
import { CITY_MAP, getCityName } from "../../lib/south-bay/cities";
import { normalizeName } from "../../lib/south-bay/normalizeName";
import { logDecision } from "../../lib/south-bay/decisionLog.mjs";
import { hasOutOfAreaDestination, isVirtualEvent } from "../../lib/south-bay/eventFilters.mjs";
import { canonicalCategory } from "../../lib/south-bay/categories.mjs";
import { holidayOn, matchesHolidayTheme } from "../../lib/south-bay/holidays";
import { cleanDisplayCopy, cleanDisplayName } from "../../lib/south-bay/displayText.mjs";
import { fetchForecast, isRainyDay } from "../../lib/south-bay/weatherProvider.mjs";
import { chainBrandKey, chainInterestReasons, isNationalChain } from "../../lib/south-bay/chains.mjs";
import { isPlaceTemporarilyUnavailable } from "../../lib/south-bay/placeAvailability.mjs";
import { isEventPublishable } from "../../lib/south-bay/eventOccurrence.mjs";
import {
  mealOpenForService,
  mealVenueMatchesService,
} from "../../lib/south-bay/mealService.mjs";
import {
  audienceBreadthPenalty,
  isMarqueeEvent,
  REGIONAL_ROUTINE_PENALTY_CUTOFF,
  requiresChildToAttend,
  routineEventPenalty,
  titleQualityPenalty,
  UNPROMPTED_AUDIENCE_PENALTY_CUTOFF,
} from "../../lib/south-bay/editorialQuality.mjs";
import {
  type Bucket,
  BUCKET_LABELS,
  BUCKET_TIME_WINDOWS,
  bucketForEvent,
  bucketOrderIndex,
  isBucket,
} from "../../lib/south-bay/buckets";
import {
  DAY_PLAN_SELECTION_MODEL,
  PILLAR_BUCKETS,
  MEAL_BUCKET_BY_PILLAR,
  MEAL_PAIR_MAX_MILES,
  dayPlanPairingIssues,
  dominantPillarCity,
  isWithinQualityBand,
  mealBrandKey,
  rankNearbyMeals,
  type PillarBucket,
} from "../../lib/south-bay/dayPlanPairs";
import type { City } from "../../lib/south-bay/types";

import placesData from "../../data/south-bay/places.json";
import eventsData from "../../data/south-bay/upcoming-events.json";
import placeBlurbCache from "../../data/south-bay/place-blurb-cache.json";
import foodOpeningsData from "../../data/south-bay/scc-food-openings.json";

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
  /** Regional plans ignore city when selecting content. City pages opt into
   *  city scope explicitly so their local promise remains honest. */
  scope?: "regional" | "city";
  lockedIds?: string[];
  /** Richer lock info: pairs an id with the bucket the user locked it into.
   *  Takes precedence over lockedIds when both are sent. timeBlock kept for
   *  back-compat with older clients that haven't picked up the bucket schema. */
  lockedCards?: Array<{ id: string; bucket?: Bucket | null; timeBlock?: string | null }>;
  dismissedIds?: string[];
  /** Names persisted alongside dismissedIds, normalized server-side and used
   *  to filter candidates whose ID may have changed since the user dismissed
   *  them. Pairs with dismissedIds. */
  dismissedNames?: string[];
  /** Plan date in YYYY-MM-DD (PT). Default: today. */
  planDate?: string;
  /** Bypass the in-memory plan cache — SHUFFLE sets this so each click gets a
   *  freshly generated plan. */
  noCache?: boolean;
  preferences?: UserPreferences;
  /** Lowercase POI/event names to hard-exclude from this plan. */
  blockedNames?: string[];
  /** Recently-shown ids/names. Score penalty fades over a two-week window. */
  recentlyShown?: Array<string | { id?: string; name?: string; daysAgo?: number }>;
  /** Week-level context so Claude can diversify across a 10-day batch.
   *  Only populated by generate-schedule.mjs when batching. */
  weekContext?: {
    categorySaturation?: Record<string, number>;
  };
  /** LEGACY (unused by bucket pipeline). Older callers may still send
   *  these — accepted for backwards compat but not interpreted. */
  currentHour?: number;
  currentMinute?: number;
}

interface Candidate {
  id: string;
  name: string;
  category: string;
  city: string;
  address: string;
  description?: string;
  /** Ingest-time blurb (events only) — preferred source for the card's blurb. */
  blurb?: string | null;
  rating?: number | null;
  ratingCount?: number | null;
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
  primaryType?: string | null;
  types?: string[];
  lat: number;
  lng: number;
  locationPrecision: "exact" | "venue" | "city";
  curated?: boolean;
  isChain?: boolean;
  chainLocations?: number;
  interestingChain?: boolean;
  chainInterestReasons?: string[];
  bestSlots?: string[];
  newlyOpened?: boolean;
  foodDistinctiveness?: number;
  marquee?: boolean;
  routinePenalty?: number;
  audiencePenalty?: number;
  source: "event" | "place";
  eventDate?: string;
  eventTime?: string | null;
  eventEndTime?: string | null;
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
  /** Bucket slot for this card — the primary user-facing time signal. */
  bucket: Bucket;
  /** Real event time, only present when this card is an event with a fixed
   *  start (e.g. "7:30 PM"). Used as a small display hint; never required. */
  eventTime?: string | null;
  /** Real event end time when known. Drives render-time staleness filtering
   *  in the homepage view (a 6:30 AM event shouldn't linger till 1 PM). */
  eventEndTime?: string | null;
  /** Legacy display label kept for back-compat with old shared plans + the
   *  /plan/<id> renderer. New cards put the bucket label here ("Breakfast")
   *  so existing renderers that look for `timeBlock` still see something. */
  timeBlock: string;
  blurb: string;
  url?: string | null;
  mapsUrl?: string | null;
  cost?: string | null;
  costNote?: string | null;
  kidsCostNote?: string | null;
  photoRef?: string | null;
  image?: string | null;
  source: "event" | "place";
  locked: boolean;
  interestingChain?: boolean;
  chainInterestReasons?: string[];
  role: "pillar" | "paired-meal";
  pairedWithId: string;
  /** Present on meal cards; computed by the server, never supplied by Claude. */
  pairDistanceMiles?: number;
  /** Lowest-confidence location used for the pair distance. */
  pairLocationPrecision?: "exact" | "venue" | "city";
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// santa-cruz is in CITY_MAP for POI/event display but excluded from plan-day
// (case-by-case picks only, not enough POIs to fill a plan).
const VALID_CITIES = new Set(Object.keys(CITY_MAP).filter((c) => c !== "santa-cruz"));

const PERMANENT_NAME_BLOCKLIST = new Set<string>([
  normalizeName("3Below Theaters"), // San Jose — closed
].filter(Boolean));

const PILLAR_EVENT_OPTIONS_PER_BUCKET = 12;
const PILLAR_PLACE_OPTIONS_PER_BUCKET = 8;
const PILLAR_OPTIONS_PER_BUCKET = PILLAR_EVENT_OPTIONS_PER_BUCKET + PILLAR_PLACE_OPTIONS_PER_BUCKET;
const PILLAR_MODEL_MAX_SCORE_GAP = 10;
const MEAL_MODEL_MAX_PAIRING_GAP = 7;
const MEAL_OPTIONS_PER_PILLAR = 5;
const REGIONAL_WEATHER_CITY: City = "campbell";

// Four local records with one brand key count as a chain even when the brand
// is absent from the national list. Chain status is an editorial hurdle, not
// a ban: generic branches are filtered, interesting ones remain eligible.
const MULTI_LOCATION_THRESHOLD = 4;
const PLACE_BRAND_COUNTS: Map<string, number> = (() => {
  const map = new Map<string, number>();
  for (const p of (placesData as any).places ?? []) {
    const key = chainBrandKey(p.name);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
})();

function chainLocationCount(name: string | null | undefined): number {
  const key = chainBrandKey(name);
  return key ? (PLACE_BRAND_COUNTS.get(key) ?? 1) : 1;
}

interface PlaceLocation {
  lat: number;
  lng: number;
  city: string;
}

const normalizeLocationKey = (value: string | null | undefined): string =>
  String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(usa|united states|california)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function venueTokenMatch(left: string, right: string): boolean {
  const tokens = (value: string) => value
    .split(/\s+/)
    .filter((token) => token.length > 2 && !["the", "and", "for", "with"].includes(token));
  const a = tokens(left);
  const b = tokens(right);
  if (a.length < 2 || b.length < 2) return false;
  const bSet = new Set(b);
  const shared = a.filter((token) => bSet.has(token)).length;
  return shared >= 2 && shared / Math.min(a.length, b.length) >= 0.72;
}

const PLACE_LOCATIONS: Array<{ nameKey: string; addressKey: string; location: PlaceLocation }> = [];
const VENUE_LOCATION_LOOKUP = new Map<string, PlaceLocation>();
const ADDRESS_LOCATION_LOOKUP = new Map<string, PlaceLocation>();
for (const p of (placesData as any).places ?? []) {
  if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue;
  const location = { lat: p.lat, lng: p.lng, city: p.city };
  const nameKey = normalizeLocationKey(p.name);
  const addressKey = normalizeLocationKey(p.address);
  if (nameKey) VENUE_LOCATION_LOOKUP.set(nameKey, location);
  if (addressKey) ADDRESS_LOCATION_LOOKUP.set(addressKey, location);
  PLACE_LOCATIONS.push({ nameKey, addressKey, location });
}

function locationForEvent(event: any): PlaceLocation & { precision: "exact" | "venue" | "city" } {
  if (Number.isFinite(event?.lat) && Number.isFinite(event?.lng)) {
    return { lat: event.lat, lng: event.lng, city: event.city, precision: "exact" };
  }

  const venueKey = normalizeLocationKey(event?.venue);
  const exactVenue = venueKey ? VENUE_LOCATION_LOOKUP.get(venueKey) : null;
  if (exactVenue) return { ...exactVenue, precision: "venue" };

  const addressKey = normalizeLocationKey(event?.address);
  const exactAddress = addressKey ? ADDRESS_LOCATION_LOOKUP.get(addressKey) : null;
  if (exactAddress) return { ...exactAddress, precision: "venue" };

  // Venue feeds frequently omit the state/ZIP or append a room name. Accept a
  // conservative same-city containment match before falling back to a city
  // centroid. The fallback is labeled so diagnostics remain honest.
  const fuzzy = PLACE_LOCATIONS.find((entry) => {
    if (entry.location.city !== event?.city) return false;
    const nameMatch = venueKey.length >= 9 && entry.nameKey.length >= 9 &&
      (venueKey.includes(entry.nameKey) || entry.nameKey.includes(venueKey) || venueTokenMatch(venueKey, entry.nameKey));
    const addressMatch = addressKey.length >= 9 && entry.addressKey.length >= 9 &&
      (addressKey.includes(entry.addressKey) || entry.addressKey.includes(addressKey));
    return nameMatch || addressMatch;
  });
  if (fuzzy) return { ...fuzzy.location, precision: "venue" };

  const city = CITY_MAP[event?.city as City] || CITY_MAP[REGIONAL_WEATHER_CITY];
  return { lat: city.lat, lng: city.lon, city: event?.city || REGIONAL_WEATHER_CITY, precision: "city" };
}

const NEWLY_OPENED_FOOD_KEYS = new Set<string>(
  ((foodOpeningsData as any).opened ?? [])
    .map((opening: any) => {
      const name = normalizeName(opening?.name);
      const city = String(opening?.cityId || opening?.city || opening?.cityName || "")
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "-");
      return name && city ? `${name}|${city}` : null;
    })
    .filter(Boolean),
);

function isVerifiedNewOpening(name: string | null | undefined, city: string | null | undefined): boolean {
  const normalized = normalizeName(name);
  return !!normalized && !!city && NEWLY_OPENED_FOOD_KEYS.has(`${normalized}|${city}`);
}

const FOOD_TYPE_COUNTS = new Map<string, number>();
for (const p of (placesData as any).places ?? []) {
  if ((p?.category || "").toLowerCase() !== "food") continue;
  const key = normalizeLocationKey(p.displayType || p.primaryType);
  if (key) FOOD_TYPE_COUNTS.set(key, (FOOD_TYPE_COUNTS.get(key) || 0) + 1);
}

function foodDistinctiveness(displayType: string | null | undefined, primaryType?: string | null): number {
  const label = normalizeLocationKey(displayType || primaryType);
  if (!label || /^(restaurant|cafe|coffee shop|bakery|bar|food|breakfast restaurant|brunch restaurant|american restaurant|fast food restaurant|hamburger restaurant|pizza restaurant|sandwich shop)$/.test(label)) return 0;
  const count = FOOD_TYPE_COUNTS.get(label) || 0;
  if (count <= 3) return 12;
  if (count <= 8) return 9;
  if (count <= 20) return 6;
  if (count <= 50) return 3;
  return 0;
}

// Venue photo lookup — maps a normalized venue name to a photoRef from
// places.json so events inherit photos from their host venue.
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
  const exact = VENUE_PHOTO_LOOKUP.get(norm);
  if (exact) return exact;
  for (const [placeName, photoRef] of VENUE_PHOTO_LOOKUP) {
    if (placeName.length < 9) continue;
    if (norm.includes(placeName) || placeName.includes(norm)) return photoRef;
  }
  return null;
}

// Place blurb lookup — pre-generated venue-specific copy per place id.
// Mix of Google Places editorialSummary (verbatim where available) +
// data-driven templates (cuisine + city + street + price) for the rest.
// Built by scripts/generate-place-blurbs.mjs from places.json + the
// research cache. Empty placeholder during initial deploy; populated by
// the Mini.
const PLACE_BLURBS: Map<string, string> = (() => {
  const m = new Map<string, string>();
  const blurbs = ((placeBlurbCache as any).blurbs ?? {}) as Record<string, { blurb?: string }>;
  for (const [id, entry] of Object.entries(blurbs)) {
    if (entry?.blurb) m.set(id, entry.blurb);
  }
  return m;
})();

// In-memory plan cache: city:kids:date → { data, ts }
const planCache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

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
  "event.events": [
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
    const at = venue && venue !== name ? ` at ${venue}` : "";
    return `Quick stop${at}.`;
  }
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length];
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type DayKey = typeof DAY_KEYS[number];

function dayKeyForDate(targetDate: string | null | undefined): DayKey {
  const d = targetDate ? new Date(`${targetDate}T12:00:00`) : new Date();
  return d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short" })
    .toLowerCase()
    .slice(0, 3) as DayKey;
}

function isOpenOn(hours: Record<string, string> | null | undefined, dayKey: DayKey): boolean {
  if (!hours) return true;
  return dayKey in hours;
}

function openRangesOn(hours: Record<string, string> | null | undefined, dayKey: DayKey): Array<[number, number]> {
  if (!hours) return [];
  const range = hours[dayKey];
  if (!range) return [];
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

const TIME_SENSITIVE_TYPES = new Set([
  "restaurant", "cafe", "bakery", "bar", "meal_takeaway", "food", "meal_delivery",
  "museum", "art_gallery", "movie_theater", "performing_arts_theater",
  "shopping_mall", "spa", "gym", "bowling_alley", "amusement_park",
  "aquarium", "zoo", "library", "ice_cream_shop", "coffee_shop",
]);

const TIME_SENSITIVE_CATEGORIES = new Set(["food", "arts"]);

function isTimeSensitive(
  types: string[] | null | undefined,
  category?: string | null,
): boolean {
  if (types && types.some((t) => TIME_SENSITIVE_TYPES.has(t))) return true;
  if (category && TIME_SENSITIVE_CATEGORIES.has(category)) return true;
  return false;
}

/** True if the venue is open for at least 60 minutes within the bucket's
 *  time window. Time-sensitive venues with unknown hours fail (we don't
 *  guess); flexible venues (parks, trails) pass with a daylight default. */
function openDuringBucket(
  hours: Record<string, string> | null | undefined,
  dayKey: DayKey,
  bucket: Bucket,
  types?: string[] | null,
  category?: string | null,
): boolean {
  const [winStart, winEnd] = BUCKET_TIME_WINDOWS[bucket];
  if (!hours) {
    if (isTimeSensitive(types, category)) return false;
    // Outdoor/flexible: rough daylight band (6–21).
    return winStart >= 6 && winEnd <= 22;
  }
  const ranges = openRangesOn(hours, dayKey);
  if (ranges.length === 0) return false;
  for (const [o, c] of ranges) {
    const overlapStart = Math.max(o, winStart);
    const overlapEnd = Math.min(c, winEnd);
    if (overlapEnd - overlapStart >= 1) return true; // ≥1h overlap
  }
  return false;
}

export function parseHour(timeStr: string): number | null {
  const ampm = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    if (ampm[3].toUpperCase() === "PM" && h !== 12) h += 12;
    if (ampm[3].toUpperCase() === "AM" && h === 12) h = 0;
    return h;
  }
  const mil = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (mil) return parseInt(mil[1], 10);
  return null;
}

function parseClockToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = (m[3] || "").toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  if (!ampm && h < 8) h += 12;
  return h * 60 + min;
}

// ---------------------------------------------------------------------------
// Weather fetch (internal, same-origin)
// ---------------------------------------------------------------------------

async function fetchWeather(city: City, planDate?: string): Promise<{ weather: string | null; forecast: any[] | null }> {
  try {
    const cityConfig = CITY_MAP[city];
    if (!cityConfig) return { weather: null, forecast: null };

    // Canonical provider (NWS primary) — Open-Meteo ran 5-8°F hot here, which
    // skewed the isHot flag and had plans dodging "101°" days that were 93°.
    // See the decision record in src/lib/south-bay/weatherProvider.mjs.
    // Match the forecast day to the PLAN date: NWS drops "today" from the
    // paired list after ~6pm (night-only period), so forecast[0] can be
    // tomorrow. An evening shuffle for today must not inherit tomorrow's
    // heat/rain flags — no matching day means no weather signal.
    const { forecast } = await fetchForecast(cityConfig.lat, cityConfig.lon, { days: 3 });
    const wanted = planDate || todayStr();
    const today = forecast.find((d: any) => d.date === wanted);
    if (!today) return { weather: null, forecast: null };

    const { high, low, rainPct, desc } = today;
    const isRainy = isRainyDay(desc, rainPct);
    const isHot = high > 90;
    const isCold = high < 55;
    const isNice = !isRainy && !isHot && !isCold;

    return {
      weather: `${desc}, high ${high}°F${rainPct >= 5 ? `, ${rainPct}% chance of rain` : ""}`,
      forecast: [{ high, low, rainPct, isRainy, isHot, isCold, isNice, desc }],
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

function recentPenalty(daysAgo: number): number {
  if (daysAgo <= 0) return 50;
  if (daysAgo <= 2) return 30;
  if (daysAgo <= 7) return 18;
  if (daysAgo <= 14) return 8;
  return 0;
}

export function scoreCandidates(
  candidates: Candidate[],
  weather: WeatherContext | null,
  kids: boolean,
  prefs?: UserPreferences,
  recent?: RecentPenaltyInput,
  targetDate?: string,
): Candidate[] {
  // Holiday-themed event boost — when the plan date lands on a named
  // holiday (Mother's Day, Cinco de Mayo, July 4th, …), events whose
  // title/blurb/description/venue mention the holiday's theme keywords
  // get a +30 score so the planner is more likely to surface a Mother's
  // Day brunch on Mother's Day instead of a generic restaurant.
  const planIso = targetDate || todayStr();
  const holiday = holidayOn(planIso);
  const holidayHasKeywords = !!(holiday && holiday.themeKeywords?.length);

  for (const c of candidates) {
    let score = 0;

    if (c.source === "event") {
      // A dated occurrence is the strongest evidence that something is
      // exceptional *today*. Ongoing exhibitions remain eligible, but they do
      // not get to outrank a strong one-day event just for being an event.
      score += c.ongoing ? 16 : 24;
      if (c.eventDate === planIso) score += 20;
      if (c.eventTime) score += 4;
      if (c.marquee) score += 42;
      score -= titleQualityPenalty(c.name);
      score -= c.routinePenalty ?? routineEventPenalty(c);
      score -= c.audiencePenalty ?? audienceBreadthPenalty(c);
      if ((c.blurb || c.description || "").trim().length >= 70) score += 5;
      if (holidayHasKeywords && c.eventDate === planIso) {
        const haystack = `${c.name} ${c.blurb ?? ""} ${c.description ?? ""} ${c.venue ?? ""}`.toLowerCase();
        if (matchesHolidayTheme(holiday!, haystack)) score += 30;
      }
    }

    if (c.rating && c.rating >= 4.5) score += 10;
    else if (c.rating && c.rating >= 4.0) score += 3;
    if (c.ratingCount) score += Math.min(14, Math.log10(c.ratingCount + 1) * 4);
    else if ((c as any).curated && (!c.rating || c.rating === 0)) score += 7;

    if ((c as any).curated) score += 10;

    if (c.category === "food") {
      if (c.newlyOpened) score += 14;
      score += c.foodDistinctiveness || 0;
    }
    if (c.isChain) {
      score -= Math.min(12, 4 + Math.log2(Math.max(1, c.chainLocations || 1)) * 2);
    }

    if (kids && c.kidFriendly === true) score += 15;
    if (kids && c.kidFriendly === false) score -= 40;

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

    if (c.cost === "free") score += 5;

    if (kids) {
      const price = (c as any).priceLevel || c.costNote || "";
      if (price === "PRICE_LEVEL_VERY_EXPENSIVE" || price === "$$$$") score -= 50;
      if (price === "PRICE_LEVEL_EXPENSIVE" || price === "$$$") score -= 20;
    }

    if (c.category === "neighborhood") score -= 30;
    if (c.category === "wellness") score -= 60;

    if (prefs && prefs.totalInteractions >= 5) {
      const catScore = prefs.categoryScores[c.category];
      if (catScore !== undefined) score += catScore * 15;

      if (prefs.costBias !== 0) {
        const price = (c as any).priceLevel || c.costNote || "";
        const isExpensive = price === "PRICE_LEVEL_VERY_EXPENSIVE" || price === "$$$$" || price === "PRICE_LEVEL_EXPENSIVE" || price === "$$$";
        if (isExpensive) score += prefs.costBias * 10;
      }

      if (prefs.outdoorBias !== 0 && c.indoorOutdoor) {
        if (c.indoorOutdoor === "outdoor") score += prefs.outdoorBias * 10;
        else if (c.indoorOutdoor === "indoor") score -= prefs.outdoorBias * 10;
      }
    }

    if (recent) {
      const idPenalty = recent.byId.get(c.id) ?? 0;
      const nameKey = (c.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      const namePenalty = nameKey ? (recent.byName.get(nameKey) ?? 0) : 0;
      score -= Math.max(idPenalty, namePenalty);
    }

    // Reshuffles can move among excellent options, but randomness no longer
    // has enough weight to make a merely adequate candidate look exceptional.
    score += Math.random() * 2;

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
  targetDate?: string,
  blockedNames?: Set<string>,
  dismissedNames?: Set<string>,
  scope: "regional" | "city" = "regional",
): Candidate[] {
  const candidates: Candidate[] = [];
  const today = targetDate || todayStr();
  const planDayKey = dayKeyForDate(today);
  const isBlocked = (name: string | null | undefined) => {
    const n = normalizeName(name);
    if (!n) return false;
    if (PERMANENT_NAME_BLOCKLIST.has(n)) return true;
    if (!blockedNames || blockedNames.size === 0) return false;
    return blockedNames.has(n);
  };
  const isDismissedByName = (name: string | null | undefined) => {
    if (!dismissedNames || dismissedNames.size === 0) return false;
    const n = normalizeName(name);
    return n ? dismissedNames.has(n) : false;
  };

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
  for (const evt of events) {
    if (dismissedIds.has(`event:${evt.id}`)) continue;
    if (isDismissedByName(evt.title) || isDismissedByName(evt.venue)) continue;
    if (!isEventPublishable(evt)) continue;
    if (evt.virtual === true) continue;
    if (isVirtualEvent(evt)) continue;
    if (evt.title && PLAN_TITLE_BLOCKLIST.some((re) => re.test(evt.title))) continue;
    if (isBlocked(evt.title) || isBlocked(evt.venue)) continue;

    // City-run day trips ship on the Events tab under their departure city
    // (that exemption lives in generate-events.mjs and is deliberate), but the
    // destination is out of coverage and has no resolvable local venue, so
    // locationForEvent falls back to the departure city's centroid. A plan
    // built on that pairs an SF Zoo afternoon with a Sunnyvale lunch.
    if (hasOutOfAreaDestination(evt)) {
      logDecision({
        script: "plan-day",
        action: "dropped",
        target: `${evt.title} (event:${evt.id})`,
        reason: "destination is outside the coverage area",
        meta: { city, targetDate: today, address: evt.address, venue: evt.venue },
      });
      continue;
    }

    const isToday = evt.date === today;
    const isOngoingExhibition = evt.ongoing && !evt.date;
    const isOngoingPastStart = evt.ongoing && evt.date && evt.date <= today;
    if (!isToday && !isOngoingExhibition && !isOngoingPastStart) continue;

    if (isOngoingPastStart && !isToday) {
      const origDow = new Date(`${evt.date}T12:00:00Z`).getUTCDay();
      const todayDow = new Date(`${today}T12:00:00Z`).getUTCDay();
      if (origDow !== todayDow) continue;
    }

    const evtCity = evt.city as City;
    if (!VALID_CITIES.has(evtCity)) continue;
    if (scope === "city" && evtCity !== city) continue;

    // Hard skip: kids-mode events flagged kidFriendly:false.
    if (kids && evt.kidFriendly === false) continue;

    // Some source feeds label caregiver-and-child programming as "all ages."
    // An adult plan explicitly means no kids are present, so these are not
    // merely weak picks — the reader cannot meaningfully attend them.
    if (!kids && requiresChildToAttend(evt)) {
      logDecision({
        script: "plan-day",
        action: "dropped",
        target: `${evt.title} (event:${evt.id})`,
        reason: "requires a baby or young child in adult mode",
        meta: { city, targetDate: today },
      });
      continue;
    }

    if (kids && evt.title && /\b(parents?|caregivers?|adults?\s+only|seniors?|memoir|estate planning|tax\s+(prep|help)|investing|retirement|widow|grief|alzheimer|dementia|book club for adults|esl)\b/i.test(evt.title)) {
      logDecision({
        script: "plan-day",
        action: "dropped",
        target: `${evt.title} (event:${evt.id})`,
        reason: `title indicates adult-only programming, ignoring kidFriendly flag`,
        meta: { city, targetDate: today, kidFriendly: evt.kidFriendly },
      });
      continue;
    }

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

    const eventLocation = locationForEvent(evt);
    const routinePenalty = routineEventPenalty(evt);
    const audiencePenalty = audienceBreadthPenalty(evt);
    candidates.push({
      id: `event:${evt.id}`,
      name: cleanDisplayName(evt.title),
      category: canonicalCategory(evt.category || "events"),
      city: evt.city,
      address: evt.address || "",
      venue: cleanDisplayName(evt.venue) || null,
      description: cleanDisplayCopy(evt.description?.slice(0, 200)),
      blurb: cleanDisplayCopy((evt as any).blurb) || null,
      cost: evt.cost,
      costNote: (evt as any).costNote || null,
      kidFriendly: evt.kidFriendly ?? null,
      url: evt.url,
      photoRef: (evt as any).photoRef || lookupVenuePhoto(evt.venue),
      image: (evt as any).image || null,
      types: [],
      lat: eventLocation.lat,
      lng: eventLocation.lng,
      locationPrecision: eventLocation.precision,
      marquee: isMarqueeEvent(evt),
      routinePenalty,
      audiencePenalty,
      source: "event",
      eventDate: evt.date,
      eventTime: evt.time,
      eventEndTime: evt.endTime,
      ongoing: evt.ongoing ?? false,
      score: 0,
    });
  }

  // --- Places ---
  const VENUE_ONLY_TYPES = new Set([
    "performing_arts_theater", "concert_hall", "amphitheatre",
    "auditorium", "opera_house", "philharmonic_hall",
    "event_venue", "banquet_hall", "convention_center",
    "stadium", "arena", "live_music_venue", "comedy_club",
  ]);

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
    if (isPlaceTemporarilyUnavailable(p)) continue;

    const primaryType = p.primaryType || "";
    const types: string[] = p.types || [];
    if (VENUE_ONLY_TYPES.has(primaryType) || types.some((t: string) => VENUE_ONLY_TYPES.has(t))) continue;
    if (EXCLUDED_TYPES.has(primaryType) || types.some((t: string) => EXCLUDED_TYPES.has(t))) continue;
    if (!isOpenOn(p.hours, planDayKey)) continue;
    if ((p.category || "").toLowerCase() === "neighborhood") continue;
    if (/^(main\s+street|downtown|the\s+district|uptown)\s+\w+/i.test(p.name || "")) continue;
    if (kids && (p.category || "").toLowerCase() === "wellness") continue;

    if (!VALID_CITIES.has(p.city)) continue;
    if (scope === "city" && p.city !== city) continue;

    const category = canonicalCategory(p.category || "food");
    const blurb = cleanDisplayCopy(PLACE_BLURBS.get(p.id)) || null;
    const newlyOpened = category === "food" && isVerifiedNewOpening(p.name, p.city);
    const distinctiveness = category === "food" ? foodDistinctiveness(p.displayType, p.primaryType) : 0;
    const observedChainLocations = chainLocationCount(p.name);
    const nationalChain = isNationalChain(p.name);
    const isChain = nationalChain || observedChainLocations >= MULTI_LOCATION_THRESHOLD;
    const chainLocations = nationalChain ? Math.max(8, observedChainLocations) : observedChainLocations;
    const interestReasons = isChain
      ? chainInterestReasons({
          category,
          rating: p.rating,
          ratingCount: p.ratingCount,
          curated: !!p.curated,
          newlyOpened,
          foodDistinctiveness: distinctiveness,
          blurb,
          description: p.description,
        })
      : [];
    // Chain branches are allowed, but only when this specific recommendation
    // has an editorial reason to exist. This blocks commodity filler such as
    // Peet's while preserving a new, distinctive, or standout chain location.
    if (isChain && interestReasons.length === 0) continue;

    const placeCity = CITY_MAP[p.city as City] || CITY_MAP[city];
    const hasExactLocation = Number.isFinite(p.lat) && Number.isFinite(p.lng);

    candidates.push({
      id: `place:${p.id}`,
      name: cleanDisplayName(p.name),
      category,
      city: p.city,
      address: p.address || "",
      blurb,
      rating: p.rating,
      ratingCount: p.ratingCount,
      cost: p.cost || null,
      costNote: p.costNote || (p.priceLevel ? priceLevelLabel(p.priceLevel) : null),
      kidsCostNote: (p as any).kidsCostNote || null,
      kidFriendly: p.kidFriendly ?? null,
      indoorOutdoor: p.indoorOutdoor || null,
      url: p.url,
      mapsUrl: p.mapsUrl,
      photoRef: p.photoRef || lookupVenuePhoto(p.name) || null,
      hours: p.hours,
      displayType: cleanDisplayName(p.displayType) || null,
      primaryType: p.primaryType || null,
      types,
      lat: hasExactLocation ? p.lat : placeCity.lat,
      lng: hasExactLocation ? p.lng : placeCity.lon,
      locationPrecision: hasExactLocation ? "exact" : "city",
      curated: !!p.curated,
      isChain,
      chainLocations,
      interestingChain: isChain && interestReasons.length > 0,
      chainInterestReasons: interestReasons,
      bestSlots: p.bestSlots || [],
      newlyOpened,
      foodDistinctiveness: distinctiveness,
      source: "place",
      score: 0,
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
// Bucket sequencing — Claude picks one candidate per bucket
// ---------------------------------------------------------------------------

function describePreferences(prefs?: UserPreferences): string {
  if (!prefs || prefs.totalInteractions < 5) return "";
  const parts: string[] = [];
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

interface PillarPairPick {
  pillarBucket: PillarBucket;
  pillarId: string;
  pillarBlurb?: string;
  mealId: string;
  mealBlurb?: string;
}

interface PillarOption {
  bucket: PillarBucket;
  candidate: Candidate;
  meals: Array<{
    candidate: Candidate;
    distanceMiles: number;
    qualityScore: number;
    pairingScore: number;
  }>;
  bucketScore: number;
}

function isPillarBucket(value: unknown): value is PillarBucket {
  return typeof value === "string" && (PILLAR_BUCKETS as readonly string[]).includes(value);
}

function defaultBucketForLockedCandidate(candidate: Candidate): Bucket {
  if (candidate.source === "event" && candidate.eventTime) {
    // A food festival or farmers market is still an activity pillar. Only
    // restaurant places occupy meal buckets.
    const eventBucket = bucketForEvent(candidate.eventTime, "events");
    if (eventBucket) return eventBucket;
  }
  if (candidate.category === "food") return "lunch";
  return "afternoon";
}

function fitsPillarBucket(candidate: Candidate, bucket: PillarBucket, dayKey: DayKey, kids = false): boolean {
  if (candidate.source === "place" && candidate.category === "food") return false;
  if (candidate.source === "event") {
    if (candidate.eventTime) {
      if (bucketForEvent(candidate.eventTime, "events") !== bucket) return false;
      if (kids && bucket === "evening") {
        const start = parseClockToMinutes(candidate.eventTime);
        const end = parseClockToMinutes(candidate.eventEndTime);
        if (start !== null && start > 18 * 60 + 30) return false;
        if (end !== null && end > 20 * 60) return false;
      }
      return true;
    }
    return candidate.ongoing === true && bucket !== "evening";
  }
  return openDuringBucket(candidate.hours, dayKey, bucket, candidate.types, candidate.category);
}

export function isMealVenueCandidate(
  candidate: Pick<Candidate, "types" | "primaryType" | "displayType" | "curated" | "address" | "bestSlots">,
  bucket?: Bucket,
): boolean {
  if (!bucket || !["breakfast", "lunch", "dinner"].includes(bucket)) {
    return ["breakfast", "lunch", "dinner"].some((service) =>
      mealVenueMatchesService(candidate, service));
  }
  return mealVenueMatchesService(candidate, bucket);
}

function openForMealService(
  hours: Record<string, string> | null | undefined,
  dayKey: DayKey,
  bucket: Bucket,
): boolean {
  return mealOpenForService(hours, dayKey, bucket);
}

function fitsMealBucket(candidate: Candidate, bucket: Bucket, dayKey: DayKey): boolean {
  return candidate.source === "place" &&
    candidate.category === "food" &&
    candidate.locationPrecision !== "city" &&
    isMealVenueCandidate(candidate, bucket) &&
    openForMealService(candidate.hours, dayKey, bucket);
}

function pillarBucketScore(
  candidate: Candidate,
  bucket: PillarBucket,
  weekContext: PlanRequest["weekContext"],
): number {
  let score = candidate.score;
  if (candidate.source === "event") {
    score += candidate.eventTime ? 8 : 0;
    if (bucket === "evening") score += 10;
    if (candidate.marquee) score += 8;
  }
  if (candidate.source === "place" && candidate.bestSlots?.includes(bucket)) score += 10;
  const saturation = weekContext?.categorySaturation?.[candidate.category] || 0;
  score -= Math.min(18, Math.max(0, saturation - 1) * 2);
  return score;
}

function activityLine(candidate: Candidate, dayKey: DayKey): string {
  const parts = [`[${candidate.id}] ${candidate.name}`, `city: ${candidate.city}`, `category: ${candidate.category}`];
  if (candidate.displayType) parts.push(`type: ${candidate.displayType}`);
  if (candidate.source === "event") {
    parts.push(candidate.ongoing ? "signal: ongoing exhibition" : "signal: EVENT TODAY");
    if (candidate.marquee) parts.push("signal: MARQUEE");
    if ((candidate.routinePenalty || 0) >= 30) parts.push("signal: routine community programming");
    if ((candidate.audiencePenalty || 0) >= UNPROMPTED_AUDIENCE_PENALTY_CUTOFF) parts.push("signal: affiliation-limited audience");
    if (candidate.eventTime) {
      const time = candidate.eventEndTime
        ? `${candidate.eventTime}–${candidate.eventEndTime}`
        : candidate.eventTime;
      parts.push(`time: ${time}`);
    }
    if (candidate.venue) parts.push(`venue: ${candidate.venue}`);
  } else {
    if (candidate.rating) {
      parts.push(`reputation: ${candidate.rating}${candidate.ratingCount ? ` from ${candidate.ratingCount} ratings` : ""}`);
    }
    if (candidate.curated) parts.push("signal: editorially curated");
    const ranges = openRangesOn(candidate.hours, dayKey);
    if (ranges.length) {
      const fmt = (hour: number) => hour > 12 ? `${hour - 12} PM` : hour === 12 ? "12 PM" : `${hour} AM`;
      parts.push(`hours: ${ranges.map(([open, close]) => `${fmt(open)}–${fmt(close)}`).join(", ")}`);
    }
  }
  if (candidate.cost === "free") parts.push("cost: free");
  else if (candidate.costNote) parts.push(`price: ${candidate.costNote}`);
  if (candidate.indoorOutdoor) parts.push(`setting: ${candidate.indoorOutdoor}`);
  if (candidate.blurb || candidate.description) parts.push(`note: ${candidate.blurb || candidate.description}`);
  if (candidate.interestingChain && candidate.chainInterestReasons?.length) {
    parts.push(`chain interest: ${candidate.chainInterestReasons.join(", ")}`);
  }
  return parts.join(" | ");
}

function mealLine(ranked: PillarOption["meals"][number]): string {
  const meal = ranked.candidate;
  const parts = [
    `[${meal.id}] ${meal.name}`,
    `${ranked.distanceMiles.toFixed(1)} mi from activity`,
    `city: ${meal.city}`,
  ];
  if (meal.displayType) parts.push(`type: ${meal.displayType}`);
  if (meal.newlyOpened) parts.push("signal: newly opened");
  if (meal.curated) parts.push("signal: editorially curated");
  if ((meal.foodDistinctiveness || 0) >= 6) parts.push("signal: distinctive food type");
  if (meal.rating) {
    parts.push(`reputation: ${meal.rating}${meal.ratingCount ? ` from ${meal.ratingCount} ratings` : ""}`);
  }
  if (meal.costNote) parts.push(`price: ${meal.costNote}`);
  if (meal.blurb) parts.push(`note: ${meal.blurb}`);
  if (meal.interestingChain && meal.chainInterestReasons?.length) {
    parts.push(`chain interest: ${meal.chainInterestReasons.join(", ")}`);
  }
  return parts.join(" | ");
}

function buildPillarOptions(
  candidates: Candidate[],
  lockedCandidates: Array<{ candidate: Candidate; bucket: Bucket | null }>,
  dayKey: DayKey,
  weekContext: PlanRequest["weekContext"],
  kids: boolean,
  scope: "regional" | "city",
): Map<PillarBucket, PillarOption[]> {
  const mealsByBucket = new Map<Bucket, Candidate[]>();
  for (const pillarBucket of PILLAR_BUCKETS) {
    const mealBucket = MEAL_BUCKET_BY_PILLAR[pillarBucket];
    mealsByBucket.set(
      mealBucket,
      candidates.filter((candidate) => fitsMealBucket(candidate, mealBucket, dayKey)),
    );
  }

  const lockedByBucket = new Map<PillarBucket, Candidate>();
  for (const locked of lockedCandidates) {
    const resolved = locked.bucket || defaultBucketForLockedCandidate(locked.candidate);
    if (isPillarBucket(resolved) && fitsPillarBucket(locked.candidate, resolved, dayKey, kids)) {
      lockedByBucket.set(resolved, locked.candidate);
    }
  }

  const result = new Map<PillarBucket, PillarOption[]>();
  for (const bucket of PILLAR_BUCKETS) {
    const mealBucket = MEAL_BUCKET_BY_PILLAR[bucket];
    const locked = lockedByBucket.get(bucket);
    const eligible = candidates
      .filter((candidate) =>
        fitsPillarBucket(candidate, bucket, dayKey, kids) &&
        (
          scope === "city" ||
          candidate.source !== "event" ||
          (candidate.routinePenalty || 0) < REGIONAL_ROUTINE_PENALTY_CUTOFF ||
          candidate.id === locked?.id
        ) &&
        (
          candidate.source !== "event" ||
          (candidate.audiencePenalty || 0) < UNPROMPTED_AUDIENCE_PENALTY_CUTOFF ||
          candidate.id === locked?.id
        )
      )
      .map((candidate) => ({
        candidate,
        bucketScore: pillarBucketScore(candidate, bucket, weekContext),
      }))
      .sort((a, b) => b.bucketScore - a.bucketScore || a.candidate.id.localeCompare(b.candidate.id));

    const shortlist: Array<{ candidate: Candidate; bucketScore: number }> = [];
    const add = (entry: { candidate: Candidate; bucketScore: number }) => {
      if (shortlist.some((existing) => existing.candidate.id === entry.candidate.id)) return;
      shortlist.push(entry);
    };
    if (locked) {
      add({
        candidate: locked,
        bucketScore: pillarBucketScore(locked, bucket, weekContext) + 1000,
      });
    }
    // Dated events and excellent evergreen places are separate finalist lanes.
    // A busy calendar cannot crowd every place out before the editor compares
    // quality, and a large POI corpus cannot bury today's exceptional event.
    for (const entry of eligible.filter(({ candidate }) => candidate.source === "event").slice(0, PILLAR_EVENT_OPTIONS_PER_BUCKET)) add(entry);
    for (const entry of eligible.filter(({ candidate }) => candidate.source === "place").slice(0, PILLAR_PLACE_OPTIONS_PER_BUCKET)) add(entry);
    for (const entry of eligible) {
      if (shortlist.length >= PILLAR_OPTIONS_PER_BUCKET) break;
      add(entry);
    }
    shortlist.sort((a, b) => b.bucketScore - a.bucketScore || a.candidate.id.localeCompare(b.candidate.id));

    const options: PillarOption[] = [];
    const lockedMeal = preferredLockedMeal(lockedCandidates, mealBucket);
    for (const entry of shortlist) {
      // A city centroid is not evidence that two places are actually nearby.
      // Keep those candidates in the corpus, but never make a proximity claim
      // until ingestion can resolve the activity to a venue or exact point.
      if (entry.candidate.locationPrecision === "city") continue;
      const rankedMeals = rankNearbyMeals(
        entry.candidate,
        mealsByBucket.get(mealBucket) || [],
        MEAL_PAIR_MAX_MILES,
      );
      const lockedMealEntry = lockedMeal
        ? rankedMeals.find((meal) => meal.candidate.id === lockedMeal.id)
        : null;
      const meals = lockedMealEntry
        ? [lockedMealEntry, ...rankedMeals.filter((meal) => meal.candidate.id !== lockedMealEntry.candidate.id)].slice(0, MEAL_OPTIONS_PER_PILLAR)
        : rankedMeals.slice(0, MEAL_OPTIONS_PER_PILLAR);
      if (!meals.length) continue;
      options.push({ bucket, ...entry, meals });
    }
    result.set(bucket, options);
  }
  return result;
}

function preferredLockedMeal(
  lockedCandidates: Array<{ candidate: Candidate; bucket: Bucket | null }>,
  mealBucket: Bucket,
): Candidate | null {
  for (const locked of lockedCandidates) {
    if (locked.candidate.source !== "place" || locked.candidate.category !== "food") continue;
    const resolved = locked.bucket || defaultBucketForLockedCandidate(locked.candidate);
    if (resolved === mealBucket) return locked.candidate;
  }
  return null;
}

function candidateBlurb(candidate: Candidate, modelBlurb?: string): string {
  return cleanDisplayCopy(
    candidate.blurb ||
    candidate.description?.slice(0, 200) ||
    modelBlurb ||
    fallbackBlurb(candidate.source, candidate.category, candidate.name, candidate.venue),
  );
}

function toDayCard(
  candidate: Candidate,
  bucket: Bucket,
  role: DayCard["role"],
  pairedWithId: string,
  kids: boolean,
  blurb: string | undefined,
  rationale: string,
  pairDistanceMiles?: number,
  pairLocationPrecision?: DayCard["pairLocationPrecision"],
): DayCard {
  return {
    id: candidate.id,
    name: cleanDisplayName(candidate.name),
    category: candidate.category,
    city: candidate.city,
    address: candidate.address,
    bucket,
    eventTime: candidate.eventTime || null,
    eventEndTime: candidate.eventEndTime || null,
    timeBlock: BUCKET_LABELS[bucket],
    blurb: candidateBlurb(candidate, blurb),
    url: candidate.url,
    mapsUrl: candidate.mapsUrl,
    cost: candidate.cost,
    costNote: kids && candidate.kidsCostNote ? candidate.kidsCostNote : candidate.costNote,
    kidsCostNote: candidate.kidsCostNote,
    photoRef: candidate.photoRef || null,
    image: candidate.image || null,
    venue: cleanDisplayName(candidate.venue) || null,
    source: candidate.source,
    locked: rationale.includes("locked"),
    ...(candidate.interestingChain ? {
      interestingChain: true,
      chainInterestReasons: candidate.chainInterestReasons || [],
    } : {}),
    role,
    pairedWithId,
    ...(Number.isFinite(pairDistanceMiles) ? { pairDistanceMiles } : {}),
    ...(pairLocationPrecision ? { pairLocationPrecision } : {}),
    rationale,
  };
}

async function pickPillarPairsWithClaude(
  pool: Candidate[],
  lockedCandidates: Array<{ candidate: Candidate; bucket: Bucket | null }>,
  weather: string | null,
  city: City,
  scope: "regional" | "city",
  kids: boolean,
  prefs: UserPreferences | undefined,
  targetDate: string | undefined,
  weekContext: PlanRequest["weekContext"],
  dayKey: DayKey,
): Promise<DayCard[]> {
  const client = new Anthropic({ apiKey: import.meta.env.ANTHROPIC_API_KEY });
  const planDateObj = targetDate ? new Date(`${targetDate}T12:00:00`) : new Date();
  const todayLabel = planDateObj.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const allCandidates = [
    ...lockedCandidates.map(({ candidate }) => candidate),
    ...pool,
  ].filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index);

  const optionsByBucket = buildPillarOptions(allCandidates, lockedCandidates, dayKey, weekContext, kids, scope);
  for (const bucket of PILLAR_BUCKETS) {
    if (!(optionsByBucket.get(bucket)?.length)) {
      throw new Error(`No viable ${bucket} pillar with a meal within ${MEAL_PAIR_MAX_MILES} miles`);
    }
  }

  const lockedAssignmentCounts = new Map<Bucket, number>();
  for (const locked of lockedCandidates) {
    const resolved = locked.bucket || defaultBucketForLockedCandidate(locked.candidate);
    const isMeal = locked.candidate.source === "place" && locked.candidate.category === "food";
    if (isMeal && !["breakfast", "lunch", "dinner"].includes(resolved)) {
      throw new Error(`Locked restaurant ${locked.candidate.name} is assigned to activity bucket ${resolved}`);
    }
    if (!isMeal && !isPillarBucket(resolved)) {
      throw new Error(`Locked activity ${locked.candidate.name} is assigned to meal bucket ${resolved}`);
    }
    lockedAssignmentCounts.set(resolved, (lockedAssignmentCounts.get(resolved) || 0) + 1);
  }
  for (const [bucket, count] of lockedAssignmentCounts) {
    if (count > 1) throw new Error(`Multiple locked cards compete for ${bucket}`);
  }

  const requiredIds = new Set(lockedCandidates.map(({ candidate }) => candidate.id));
  const optionText = PILLAR_BUCKETS.map((bucket) => {
    const mealBucket = MEAL_BUCKET_BY_PILLAR[bucket];
    const options = optionsByBucket.get(bucket) || [];
    const lines = options.map((option, index) => {
      const required = requiredIds.has(option.candidate.id) ? " | REQUIRED BY USER" : "";
      const meals = option.meals
        .map((meal) => `    - ${mealLine(meal)}`)
        .join("\n");
      return `${index + 1}. ${activityLine(option.candidate, dayKey)}${required}\n  VERIFIED ${mealBucket.toUpperCase()} OPTIONS:\n${meals}`;
    });
    return `${bucket.toUpperCase()} PILLAR CANDIDATES\n${lines.join("\n")}`;
  }).join("\n\n");

  const saturation = Object.entries(weekContext?.categorySaturation || {})
    .filter(([, count]) => count >= 2)
    .map(([category, count]) => `${category} ×${count}`)
    .join(", ");

  const prompt = `You are the senior editor for South Bay Today. Build ${scope === "city" ? `a ${getCityName(city)} day plan` : "the best possible South Bay day plan"} for ${todayLabel}.

CORE METHOD — DO THESE IN ORDER:
1. Ignore the restaurants. Compare the activity candidates across the ENTIRE relevant pool and pick the one truly exceptional MORNING activity, the one truly exceptional AFTERNOON activity, and the one truly exceptional EVENING activity.
2. Only after the three pillars are chosen, pair each with one restaurant from that pillar's VERIFIED meal list: breakfast with morning, lunch with afternoon, dinner with evening.

PILLAR QUALITY COMES FIRST. Geography must never make a merely adequate activity beat an exceptional one. The three pillars may be in the same town or three different towns. Judge audience breadth, specificity, one-day relevance, editorial interest, rarity, marquee signals, and whether a reader would be annoyed to learn tomorrow that we buried it. A dated event often beats an evergreen place, but a weak routine listing or affiliation-limited offer does not beat a genuinely excellent activity.
MEAL QUALITY COMES NEXT. Every listed restaurant is already open in the right meal window and within ${MEAL_PAIR_MAX_MILES} miles of its pillar. Pick on "new, unique, great": verified new openings, distinctive local formats/cuisines, editorial curation, strong ratings with real review evidence, and specific source-backed notes. A chain is eligible only when its supplied chain-interest signal makes that branch worth recommending; never pick a familiar brand merely because it is convenient. Distance only breaks close quality ties.
${scope === "city" ? `CITY SCOPE: all six picks must stay in ${getCityName(city)}.` : "REGIONAL SCOPE: do not cluster the three pillars and do not optimize a six-stop driving route."}
${weather ? `Weather: ${weather}.` : ""}
${kids ? "FAMILY MODE: every activity and meal must work with kids. Avoid 21+ venues, adult-only programs, luxury dinner, and late activities that cannot wrap around 7:30 PM." : "ADULT MODE: no kids are in the group."}
${describePreferences(prefs)}
${saturation ? `Recent category saturation: ${saturation}. Use this only to break close pillar-quality ties.` : ""}

${optionText}

RULES:
- Return exactly three pair objects: morning+breakfast, afternoon+lunch, evening+dinner.
- Pick IDs only from the candidate and verified meal lists under the matching pillar.
- Never reuse an activity, restaurant, or restaurant brand. Different branches of the same brand count as a repeat.
- Any REQUIRED BY USER activity must be the pillar for its time bucket.
- Write one factual sentence per item using only its supplied note/type/setting/price data.
- Do not mention distance, travel time, proximity, star ratings, review counts, rankings, scoring, or the mechanics of pairing.
- Do not write cross-card transitions such as "after the museum" or "before the show."
- Never use filler like "hidden gem", "worth a stop", "solid local pick", "great place", "fun spot", "easy table", or "good food, no fuss."

OUTPUT — JSON array only:
[
  {
    "pillarBucket": "morning",
    "pillarId": "event-or-place-id",
    "pillarBlurb": "Specific factual sentence.",
    "mealId": "place-id from this pillar's breakfast list",
    "mealBlurb": "Specific factual sentence."
  },
  {
    "pillarBucket": "afternoon",
    "pillarId": "event-or-place-id",
    "pillarBlurb": "Specific factual sentence.",
    "mealId": "place-id from this pillar's lunch list",
    "mealBlurb": "Specific factual sentence."
  },
  {
    "pillarBucket": "evening",
    "pillarId": "event-or-place-id",
    "pillarBlurb": "Specific factual sentence.",
    "mealId": "place-id from this pillar's dinner list",
    "mealBlurb": "Specific factual sentence."
  }
]`;

  let modelPicks: PillarPairPick[] = [];
  try {
    const response = await client.messages.create({
      model: CLAUDE_OPUS,
      max_tokens: 1800,
      messages: [{ role: "user", content: prompt }],
    });
    const parsed = JSON.parse(stripFences(extractText(response.content)));
    if (Array.isArray(parsed)) modelPicks = parsed;
  } catch (error) {
    console.warn(`[plan-day] editorial selection failed; using ranked pairs: ${String((error as Error)?.message || error).slice(0, 180)}`);
  }

  const pickByBucket = new Map<PillarBucket, PillarPairPick>();
  for (const pick of modelPicks) {
    if (!isPillarBucket(pick?.pillarBucket)) continue;
    if (!pickByBucket.has(pick.pillarBucket)) pickByBucket.set(pick.pillarBucket, pick);
  }

  const cards: DayCard[] = [];
  const usedPillars = new Set<string>();
  const usedMeals = new Set<string>();
  const usedMealBrands = new Set<string>();
  const mealIsAvailable = (candidate: Candidate) =>
    !usedMeals.has(candidate.id) &&
    !usedMealBrands.has(mealBrandKey(candidate.name, candidate.id));

  for (const bucket of PILLAR_BUCKETS) {
    const mealBucket = MEAL_BUCKET_BY_PILLAR[bucket];
    const options = optionsByBucket.get(bucket) || [];
    const lockedPillar = lockedCandidates.find((locked) => {
      const resolved = locked.bucket || defaultBucketForLockedCandidate(locked.candidate);
      return resolved === bucket && fitsPillarBucket(locked.candidate, bucket, dayKey, kids);
    })?.candidate;
    const lockedMeal = preferredLockedMeal(lockedCandidates, mealBucket);
    const modelPick = pickByBucket.get(bucket);

    if (lockedMeal && !mealIsAvailable(lockedMeal)) {
      throw new Error(`Locked ${mealBucket} ${lockedMeal.name} duplicates a restaurant brand already used in this plan`);
    }

    const optionHasAvailableMeal = (entry: PillarOption) =>
      entry.meals.some((meal) => mealIsAvailable(meal.candidate));
    const bestAvailableOption = options.find((entry) =>
      !usedPillars.has(entry.candidate.id) && optionHasAvailableMeal(entry));
    const modelOption = options.find((entry) =>
      entry.candidate.id === modelPick?.pillarId && optionHasAvailableMeal(entry));
    let option = lockedPillar
      ? options.find((entry) => entry.candidate.id === lockedPillar.id)
      : modelOption && bestAvailableOption && isWithinQualityBand(
          modelOption.bucketScore,
          bestAvailableOption.bucketScore,
          PILLAR_MODEL_MAX_SCORE_GAP,
        )
        ? modelOption
        : undefined;
    if (lockedPillar && !option) {
      throw new Error(`Locked ${bucket} activity ${lockedPillar.name} has no valid ${mealBucket} within ${MEAL_PAIR_MAX_MILES} miles`);
    }
    if (lockedMeal && (!option || !option.meals.some((meal) => meal.candidate.id === lockedMeal.id))) {
      if (lockedPillar) {
        throw new Error(`Locked ${mealBucket} ${lockedMeal.name} is not within ${MEAL_PAIR_MAX_MILES} miles of locked ${bucket} activity`);
      }
      option = options.find((entry) =>
        !usedPillars.has(entry.candidate.id) &&
        entry.meals.some((meal) => meal.candidate.id === lockedMeal.id)
      );
      if (!option) {
        throw new Error(`Locked ${mealBucket} ${lockedMeal.name} has no compatible ${bucket} activity`);
      }
    }
    if (!option || usedPillars.has(option.candidate.id)) {
      if (lockedPillar || lockedMeal) throw new Error(`Locked choice for ${bucket}/${mealBucket} conflicts with another pair`);
      option = options.find((entry) =>
        !usedPillars.has(entry.candidate.id) && optionHasAvailableMeal(entry));
    }
    if (!option) throw new Error(`Could not choose a unique ${bucket} pillar`);

    const bestAvailableMeal = option.meals.find((entry) => mealIsAvailable(entry.candidate));
    const modelMeal = option.meals.find((entry) =>
      entry.candidate.id === modelPick?.mealId && mealIsAvailable(entry.candidate));
    let meal = lockedMeal
      ? option.meals.find((entry) => entry.candidate.id === lockedMeal.id)
      : modelMeal && bestAvailableMeal && isWithinQualityBand(
          modelMeal.pairingScore,
          bestAvailableMeal.pairingScore,
          MEAL_MODEL_MAX_PAIRING_GAP,
        )
        ? modelMeal
        : undefined;
    if (!meal || !mealIsAvailable(meal.candidate)) {
      if (lockedMeal) throw new Error(`Locked ${mealBucket} ${lockedMeal.name} conflicts with another pair`);
      meal = option.meals.find((entry) => mealIsAvailable(entry.candidate));
    }
    if (!meal) throw new Error(`Could not choose a unique ${mealBucket} pairing`);

    const pillarRationale = [
      lockedPillar?.id === option.candidate.id ? "locked-by-caller" : "quality-first-pillar",
      option.candidate.source === "event" ? (option.candidate.marquee ? "marquee-event-today" : "event-today") : "exceptional-place",
      `bucket-score=${option.bucketScore.toFixed(1)}`,
    ].join(" | ");
    const mealRationale = [
      lockedMeal?.id === meal.candidate.id ? "locked-by-caller" : "paired-meal",
      `quality=${meal.qualityScore.toFixed(1)}`,
      `distance=${meal.distanceMiles.toFixed(1)}mi`,
      ...(meal.candidate.interestingChain
        ? [`chain-interest=${meal.candidate.chainInterestReasons?.join(",") || "qualified"}`]
        : []),
    ].join(" | ");

    const pillarCard = toDayCard(
      option.candidate,
      bucket,
      "pillar",
      meal.candidate.id,
      kids,
      modelPick?.pillarBlurb,
      pillarRationale,
    );
    const mealCard = toDayCard(
      meal.candidate,
      mealBucket,
      "paired-meal",
      option.candidate.id,
      kids,
      modelPick?.mealBlurb,
      mealRationale,
      Math.round(meal.distanceMiles * 10) / 10,
      option.candidate.locationPrecision === "city" || meal.candidate.locationPrecision === "city"
        ? "city"
        : option.candidate.locationPrecision === "venue" || meal.candidate.locationPrecision === "venue"
          ? "venue"
          : "exact",
    );
    cards.push(mealCard, pillarCard);
    usedPillars.add(option.candidate.id);
    usedMeals.add(meal.candidate.id);
    usedMealBrands.add(mealBrandKey(meal.candidate.name, meal.candidate.id));

    for (const card of [pillarCard, mealCard]) {
      logDecision({
        script: "plan-day",
        action: "picked",
        target: `${card.name} (${card.id})`,
        reason: card.rationale || card.role,
        meta: {
          city,
          scope,
          targetDate,
          bucket: card.bucket,
          role: card.role,
          pairedWithId: card.pairedWithId,
          pairDistanceMiles: card.pairDistanceMiles,
          kids,
        },
      });
    }
  }

  cards.sort((a, b) => bucketOrderIndex(a.bucket) - bucketOrderIndex(b.bucket));
  const issues = dayPlanPairingIssues(cards);
  if (issues.length) throw new Error(`Invalid pillar-pairs plan: ${issues.join("; ")}`);
  return cards;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!rateLimit(clientAddress, 30)) return rateLimitResponse();

  let body: PlanRequest;
  try {
    body = await request.json();
  } catch {
    return errJson("Invalid JSON body", 400);
  }

  const {
    city,
    kids = false,
    scope = "regional",
    lockedIds = [],
    lockedCards = [],
    dismissedIds = [],
    dismissedNames = [],
    planDate,
    preferences,
    blockedNames = [],
    weekContext,
    recentlyShown = [],
    noCache = false,
  } = body;

  // Defensive input caps — these arrays come straight from the client and feed
  // normalization + the Claude prompt. Without bounds, a crafted request could
  // send megabyte arrays. Limits sit far above any legitimate session. Check
  // shape separately before iterating so a crafted scalar cannot slip through.
  const overCap = (a: unknown, max: number) => Array.isArray(a) && a.length > max;
  if (![lockedCards, lockedIds, dismissedIds, dismissedNames, blockedNames, recentlyShown].every(Array.isArray)) {
    return errJson("List fields must be arrays", 400);
  }
  if (
    overCap(lockedCards, 20) || overCap(lockedIds, 20) ||
    overCap(dismissedIds, 300) || overCap(dismissedNames, 300) ||
    overCap(blockedNames, 300) || overCap(recentlyShown, 100)
  ) {
    return errJson("Too many items in request", 413);
  }

  // Merge lockedCards into lockedIds + bucket map.
  const lockedBucketMap = new Map<string, Bucket | null>();
  for (const lc of lockedCards) {
    if (!lc?.id) continue;
    if (!lockedIds.includes(lc.id)) lockedIds.push(lc.id);
    if (isBucket(lc.bucket)) lockedBucketMap.set(lc.id, lc.bucket);
    else lockedBucketMap.set(lc.id, null);
  }
  const blockedSet = new Set(blockedNames.map((n) => normalizeName(n)).filter(Boolean));

  if (!city || !VALID_CITIES.has(city)) {
    return errJson(`Invalid city. Must be one of: ${[...VALID_CITIES].join(", ")}`, 400);
  }
  if (scope !== "regional" && scope !== "city") {
    return errJson('Invalid scope. Must be "regional" or "city"', 400);
  }

  if (!import.meta.env.ANTHROPIC_API_KEY) {
    return errJson("Server configuration error", 500);
  }

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

  const dayKey = dayKeyForDate(planDate);

  // Cache hit for default requests.
  const prefsHash = preferences
    ? Math.round((preferences.outdoorBias || 0) * 10 + (preferences.costBias || 0) * 10)
    : 0;
  const cacheRegion = scope === "city" ? city : "south-bay";
  const cacheKey = `${scope}:${cacheRegion}:${kids}:${prefsHash}:${planDate || ""}`;
  const isCacheableRequest = !noCache && !weekContext &&
    lockedIds.length === 0 && dismissedIds.length === 0 &&
    dismissedNameSet.size === 0 && blockedSet.size === 0 && recentlyShown.length === 0;
  if (isCacheableRequest) {
    const cached = planCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return okJson(cached.data, { "Cache-Control": "private, no-store" });
    }
  }

  try {
    const weatherCity = scope === "regional" ? REGIONAL_WEATHER_CITY : city;
    const weatherData = await fetchWeather(weatherCity, planDate);
    const weatherContext: WeatherContext | null = weatherData.forecast?.[0] ?? null;

    const allCandidates = buildCandidatePool(
      city,
      kids,
      dismissedSet,
      planDate,
      blockedSet,
      dismissedNameSet,
      scope,
    );

    // Score with graduated variety penalty.
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
    const scored = scoreCandidates(allCandidates, weatherContext, kids, preferences, recent, planDate);

    // Extract locked candidates (and report any locked ids that are stale).
    const lockedRaw = scored.filter((c) => lockedSet.has(c.id));
    const foundLockedIds = new Set(lockedRaw.map((c) => c.id));
    const invalidLockedIds = [...lockedSet].filter((id) => !foundLockedIds.has(id));
    if (invalidLockedIds.length > 0) {
      console.log(`[plan-day] ${invalidLockedIds.length} invalid lockedId(s): ${invalidLockedIds.join(", ")}`);
      for (const id of invalidLockedIds) {
        logDecision({
          script: "plan-day",
          action: "invalid-lock",
          target: id,
          reason: "locked id not present in candidate pool",
          meta: { city, targetDate: planDate },
        });
      }
    }
    const lockedWithBucket = lockedRaw.map((c) => ({
      candidate: c,
      bucket: lockedBucketMap.get(c.id) ?? null,
    }));
    const unlockedPool = scored.filter((c) => !lockedSet.has(c.id));

    // Dedupe same-venue/same-time event records without shrinking the regional
    // pool. The old planner sampled six events and eight restaurants before
    // Claude ever saw them; that pre-randomization is exactly what made strong
    // picks disappear.
    const eventGroups = new Map<string, Candidate>();
    const planningPool: Candidate[] = [];
    for (const candidate of unlockedPool) {
      if (candidate.source !== "event") {
        planningPool.push(candidate);
        continue;
      }
      const location = (candidate.venue || candidate.address || candidate.city || "").toLowerCase().trim();
      const time = (candidate.eventTime || "").toLowerCase().trim();
      const key = time ? `${location}|${time}` : candidate.id;
      const existing = eventGroups.get(key);
      if (!existing || candidate.score > existing.score) eventGroups.set(key, candidate);
    }
    planningPool.push(...eventGroups.values());

    const cards = await pickPillarPairsWithClaude(
      planningPool,
      lockedWithBucket,
      weatherData.weather,
      city,
      scope,
      kids,
      preferences,
      planDate,
      weekContext,
      dayKey,
    );

    const responseData = {
      cards,
      weather: weatherData.weather,
      city: scope === "city" ? city : dominantPillarCity(cards, REGIONAL_WEATHER_CITY),
      scope,
      selectionModel: DAY_PLAN_SELECTION_MODEL,
      mealPairMaxMiles: MEAL_PAIR_MAX_MILES,
      kids,
      generatedAt: new Date().toISOString(),
      poolSize: allCandidates.length,
      invalidLockedIds: invalidLockedIds.length > 0 ? invalidLockedIds : undefined,
    };

    if (isCacheableRequest) {
      planCache.set(cacheKey, { data: responseData, ts: Date.now() });
      if (planCache.size > 100) {
        const oldest = planCache.keys().next().value!;
        planCache.delete(oldest);
      }
    }

    return okJson(responseData, { "Cache-Control": "private, no-store" });
  } catch (err) {
    console.error("[plan-day] error:", err);
    return errJson(err instanceof Error ? err.message : "Plan generation failed", 500);
  }
};
