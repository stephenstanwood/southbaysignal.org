// ---------------------------------------------------------------------------
// swap-candidates — finds alternative stops for a day-plan card being swapped.
//
// Filters:
//   - Same category (food → food, outdoor → outdoor, etc.)
//   - Near the anchor city (within ~20km haversine)
//   - Open during the original timeBlock (when hours data is present)
//   - Not already in the plan (excludes current ids)
// Returns the top N by rating * log(ratingCount), enough variety for Stephen
// to pick from.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLACES_FILE = join(__dirname, "..", "..", "..", "src", "data", "south-bay", "places.json");
const EVENTS_FILE = join(__dirname, "..", "..", "..", "src", "data", "south-bay", "upcoming-events.json");

// City coordinates (lat/lon) — duplicated from src/lib/south-bay/cities.ts so
// this helper has no Astro dependency. Keep in sync when adding new cities.
const CITY_COORDS = {
  campbell:        { lat: 37.2872, lon: -121.9500, name: "Campbell" },
  cupertino:       { lat: 37.3230, lon: -122.0322, name: "Cupertino" },
  "los-gatos":     { lat: 37.2261, lon: -121.9822, name: "Los Gatos" },
  "mountain-view": { lat: 37.3861, lon: -122.0839, name: "Mountain View" },
  saratoga:        { lat: 37.2638, lon: -122.0230, name: "Saratoga" },
  sunnyvale:       { lat: 37.3688, lon: -122.0363, name: "Sunnyvale" },
  "palo-alto":     { lat: 37.4419, lon: -122.1430, name: "Palo Alto" },
  "san-jose":      { lat: 37.3382, lon: -121.8863, name: "San Jose" },
  "santa-clara":   { lat: 37.3541, lon: -121.9552, name: "Santa Clara" },
  "los-altos":     { lat: 37.3852, lon: -122.1141, name: "Los Altos" },
  milpitas:        { lat: 37.4323, lon: -121.8996, name: "Milpitas" },
};

const NEARBY_KM = 20;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Parse a timeBlock like "11:30 AM - 1:00 PM" into { startH, endH } where
// hours are 0-23 (decimal minutes dropped — coarse enough for open-hours check).
function parseTimeBlock(tb) {
  if (!tb || typeof tb !== "string") return null;
  const parts = tb.split(/\s*-\s*/);
  if (parts.length < 2) return null;
  const parseOne = (s) => {
    const m = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
    if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
    return h;
  };
  const startH = parseOne(parts[0]);
  const endH = parseOne(parts[1]);
  if (startH === null || endH === null) return null;
  return { startH, endH };
}

// Check if a place's hours entry covers [startH, endH] on the plan's date.
// hours example: { mon: "09:00-17:00", tue: "09:00-17:00", ... }
function isOpenDuring(hours, dateStr, startH, endH) {
  if (!hours || typeof hours !== "object") return true; // unknown → don't filter
  const d = new Date(dateStr + "T12:00:00");
  const dow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()];
  const range = hours[dow];
  if (!range) return false; // closed that day
  const m = range.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
  if (!m) return true;
  const openH = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  const closeH = parseInt(m[3], 10) + parseInt(m[4], 10) / 60;
  return startH >= openH && endH <= closeH;
}

let placesCache = null;
function loadPlaces() {
  if (placesCache) return placesCache;
  try {
    const raw = JSON.parse(readFileSync(PLACES_FILE, "utf8"));
    placesCache = Array.isArray(raw) ? raw : (raw.places || []);
  } catch {
    placesCache = [];
  }
  return placesCache;
}

let eventsCache = null;
function loadEvents() {
  if (eventsCache) return eventsCache;
  try {
    const raw = JSON.parse(readFileSync(EVENTS_FILE, "utf8"));
    eventsCache = Array.isArray(raw) ? raw : (raw.events || []);
  } catch {
    eventsCache = [];
  }
  return eventsCache;
}

/**
 * Find swap candidates for a card in a day-plan.
 *
 * @param {object} opts
 * @param {string} opts.anchorCity — plan's anchor city slug
 * @param {string} opts.category — category of the card being swapped
 * @param {string} opts.timeBlock — original card's timeBlock
 * @param {string} opts.planDate — plan date (YYYY-MM-DD)
 * @param {string[]} opts.excludeIds — card ids already in the plan
 * @param {number} [opts.limit=8]
 * @returns {Array<object>} candidate cards
 */
export function findSwapCandidates(opts) {
  const { anchorCity, category, timeBlock, planDate, excludeIds = [], limit = 8 } = opts;
  const exclude = new Set(excludeIds);

  const anchor = CITY_COORDS[anchorCity];
  if (!anchor) return [];

  const tb = parseTimeBlock(timeBlock);

  // Places: filter by category + near anchor + open during timeBlock
  const places = loadPlaces();
  const placeCandidates = [];
  for (const p of places) {
    if (!p || exclude.has(p.id) || !p.city || !p.name) continue;
    if (p.category !== category) continue;
    if (!p.rating || p.rating < 4.0) continue;
    if (!p.ratingCount || p.ratingCount < 25) continue;
    const cityCoords = CITY_COORDS[p.city];
    if (!cityCoords) continue;
    const distKm = haversineKm(anchor.lat, anchor.lon, cityCoords.lat, cityCoords.lon);
    if (distKm > NEARBY_KM) continue;
    if (tb && !isOpenDuring(p.hours, planDate, tb.startH, tb.endH)) continue;

    placeCandidates.push({
      id: p.id,
      name: p.name,
      category: p.category,
      city: p.city,
      address: p.address,
      rating: p.rating,
      ratingCount: p.ratingCount,
      costNote: p.costNote || null,
      photoRef: p.photoRef || null,
      url: p.url || null,
      mapsUrl: p.mapsUrl || null,
      source: "place",
      _score: (p.rating || 0) * Math.log(p.ratingCount + 1),
      _distKm: Math.round(distKm * 10) / 10,
    });
  }

  // Events: if category is "events" or "entertainment", also include events
  // happening on the plan's date in nearby cities.
  const eventCandidates = [];
  if (category === "events" || category === "entertainment") {
    const events = loadEvents();
    for (const e of events) {
      if (!e || exclude.has(e.id) || !e.city || !e.title) continue;
      if (e.virtual === true) continue;
      // Date match: event's start date must equal planDate, OR event is ongoing.
      const eventDate = (e.startDate || e.date || "").slice(0, 10);
      const isOngoing = e.ongoing === true;
      if (eventDate !== planDate && !isOngoing) continue;
      const cityCoords = CITY_COORDS[e.city];
      if (!cityCoords) continue;
      const distKm = haversineKm(anchor.lat, anchor.lon, cityCoords.lat, cityCoords.lon);
      if (distKm > NEARBY_KM) continue;

      eventCandidates.push({
        id: e.id,
        name: e.title,
        category: category,
        city: e.city,
        address: e.address || e.venue || "",
        costNote: e.costNote || null,
        photoRef: null,
        url: e.url || null,
        mapsUrl: null,
        venue: e.venue || null,
        source: "event",
        eventTime: e.eventTime || null,
        _score: 100, // events always ranked first
        _distKm: Math.round(distKm * 10) / 10,
      });
    }
  }

  const combined = [...eventCandidates, ...placeCandidates]
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);

  return combined;
}
