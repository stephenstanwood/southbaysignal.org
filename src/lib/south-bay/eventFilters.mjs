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
//
// Text patterns are a FALLBACK, not the primary signal. Most calendar
// platforms publish their own location-type field (Localist `experience`,
// LiveWhale `online_type`, BiblioCommons `isVirtual`) and the ingest reads it
// via virtualFromSourceSignal() below. Regex alone shipped a factual error on
// 2026-08-05: SJSU's "Collegiate Recovery Community (CRC) All Recovery
// Meeting" is VIRTUAL on events.sjsu.edu, but neither its title nor its
// description says so, so it went out as an in-person newsletter destination
// paired with a lunch recommendation.
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
 * Returns true if the event is virtual. An explicit `virtual: true` flag —
 * set at ingest from the source's own location-type field — wins; otherwise
 * falls back to matching title + description text.
 * Accepts either a string or an event-like object with .title/.description.
 */
export function isVirtualEvent(eventOrText) {
  if (!eventOrText) return false;
  if (typeof eventOrText === "string") {
    return VIRTUAL_EVENT_PATTERNS.some((re) => re.test(eventOrText));
  }
  if (eventOrText.virtual === true) return true;
  const hay = [eventOrText.title, eventOrText.description]
    .filter(Boolean)
    .join(" ");
  if (!hay) return false;
  return VIRTUAL_EVENT_PATTERNS.some((re) => re.test(hay));
}

/**
 * Source-published location type → true (online-only) | false (physically
 * attendable) | null (source said nothing usable).
 *
 * Understands the shapes the feeds actually emit:
 *   - Localist (SJSU, Stanford):  experience = "virtual" | "inperson" | "hybrid"
 *   - LiveWhale (SCU):            online_type = "Online only" | "Hybrid", is_online = 1
 *   - BiblioCommons (libraries):  isVirtual = true | false
 *
 * HYBRID RETURNS false ON PURPOSE. A hybrid event has a real room someone can
 * walk into, so it stays eligible as a destination; only online-only events
 * are disqualified. `null` means "unknown" — the caller keeps the text
 * fallback rather than treating silence as an in-person guarantee.
 */
export function virtualFromSourceSignal(signal) {
  if (signal === true) return true;
  if (signal === false) return false;
  if (signal === null || signal === undefined) return null;
  if (typeof signal === "number") return signal === 1 ? true : signal === 0 ? false : null;
  if (typeof signal !== "string") return null;
  const s = signal.trim().toLowerCase();
  if (!s) return null;
  // Check hybrid/in-person first — "online only" and "hybrid" both contain
  // location words, and a hybrid event must not be read as online-only.
  if (/\b(hybrid|mixed|in[-\s]?person|inperson|offline|onsite|on[-\s]site)\b/.test(s)) return false;
  if (/\b(virtual|online|remote|webinar|livestream|live[-\s]?stream|zoom|webex|teams)\b/.test(s)) return true;
  return null;
}

/**
 * The canonical ingest-time decision. Either the source or the text saying
 * "virtual" is enough: a false positive costs one skipped recommendation out
 * of ~1,800 events, while a false negative ships a factual error to readers.
 */
export function resolveVirtualFlag(event, sourceSignal) {
  return virtualFromSourceSignal(sourceSignal) === true || isVirtualEvent(event);
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
