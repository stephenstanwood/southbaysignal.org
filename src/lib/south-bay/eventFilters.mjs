// ---------------------------------------------------------------------------
// Shared event filters
// ---------------------------------------------------------------------------
// Single source of truth for "this event should never appear in a day plan."
// Imported by:
//   - scripts/generate-events.mjs — filters at scrape time so bad events
//     never land in upcoming-events.json
//   - src/pages/api/plan-day.ts — runtime safety net in case generation
//     missed something or the data is stale
//
// Any pattern added here applies in BOTH places. Keep them in sync or you
// get the "caught at one stage, not the other" divergence bug that let
// tUrn events leak into plans even after generation patterns were added.
// ---------------------------------------------------------------------------

/**
 * Patterns that match virtual/online/livestream events by title or
 * description. Matched case-insensitively. A positive match means the event
 * is NOT a valid physical stop and should be dropped from both pools.
 */
export const VIRTUAL_EVENT_PATTERNS = [
  // Title prefixes
  /^online[:\s-]/i,
  /^virtual[:\s-]/i,
  /^\[online\]/i,
  /^\[virtual\]/i,
  /^(virtual|online):\s+/i,

  // SCU tUrn climate lectures — academic-only, no fixed address
  /\btUrn\b/i,

  // Online-prefixed activity types
  /\bonline\s+(author\s+talk|book\s+club|discussion|talk|lecture|q&a|class|workshop|group|conversation)\b/i,
  /\bonline\s+conversation\s+group\b/i,

  // Generic virtual/online/livestream markers
  /\b(webinar|livestream|live[-\s]?stream|virtual\s+(event|talk|class|meeting|tour|gathering|reading))\b/i,
  /\bzoom\s+(meeting|call|session|event|webinar|link)\b/i,
];

/**
 * Returns true if the event looks virtual/online based on title + description.
 * Accepts either a string or an event-like object with .title and .description.
 */
export function isVirtualEvent(eventOrText) {
  if (!eventOrText) return false;
  if (typeof eventOrText === "string") {
    return VIRTUAL_EVENT_PATTERNS.some((re) => re.test(eventOrText));
  }
  const hay = [eventOrText.title, eventOrText.description]
    .filter(Boolean)
    .join(" ");
  if (!hay) return false;
  return VIRTUAL_EVENT_PATTERNS.some((re) => re.test(hay));
}

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

/**
 * Bay Area (and wider California) cities outside the coverage area. A hit on
 * an event's address/venue means the event physically happens somewhere we
 * don't cover, regardless of what its city slug says.
 */
export const OUT_OF_AREA_LOCATION =
  /\b(san francisco|oakland|berkeley|alameda|fremont|hayward|walnut creek|san mateo|redwood city|daly city|san leandro|richmond|concord|vallejo|sacramento|los angeles|san rafael|novato|petaluma|napa|emeryville|burlingame|san bruno|pacifica|half moon bay|morgan hill|gilroy|marin)\b/i;

/** Cities inside the coverage area, plus the two campus tokens that carry no city name. */
export const COVERED_LOCATION =
  /\b(san jos[eé]|santa clara|sunnyvale|cupertino|campbell|milpitas|saratoga|los gatos|los altos|palo alto|mountain view|monte sereno|stanford|moffett)\b/i;

/**
 * Organized outings that depart from a covered city even though the
 * destination is elsewhere — "August Day Trip to San Francisco Zoo & Gardens"
 * is a Sunnyvale senior-center trip, not an SF event. These stay in the
 * events feed (see `hasOutOfAreaDestination` for why they still can't be
 * day-plan stops).
 */
export const LOCAL_DEPARTURE_TRIP =
  /\b(day\s+trip|bus\s+trip|field\s+trip|excursion|trip\s+to|tour\s+to)\b/i;

/**
 * Returns true if the event's own address/venue names an out-of-area city and
 * names no covered city — i.e. the thing physically happens outside coverage.
 *
 * Reads address/venue ONLY, never the description: descriptions name sponsors,
 * beneficiaries and "supports families in <city>" asides that are not the
 * event's location (the Kepler's 4/24 regression).
 *
 * Note the asymmetry with the ingest filter in generate-events.mjs. There, a
 * `LOCAL_DEPARTURE_TRIP` title is an exemption — city-run day trips are real
 * local programming and belong on the Events tab under their departure city.
 * Here there is no exemption, because a day plan is a geography contract: a
 * pillar gets paired with a meal within five miles of its coordinates, and an
 * SF Zoo trip resolves to no known venue and falls back to its departure
 * city's centroid. Left in the pool, it produces a plan that sends a reader to
 * San Francisco for the afternoon and books lunch in Sunnyvale.
 */
export function hasOutOfAreaDestination(event) {
  if (!event) return false;
  const hay =
    typeof event === "string"
      ? event
      : [event.address, event.location, event.venue].filter(Boolean).join(" | ");
  if (!hay) return false;
  return OUT_OF_AREA_LOCATION.test(hay) && !COVERED_LOCATION.test(hay);
}
