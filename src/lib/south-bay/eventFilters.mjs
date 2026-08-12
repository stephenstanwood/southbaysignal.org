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
// Advance registration
// ---------------------------------------------------------------------------
// Single source of truth for "can a reader who saw this in the newsletter just
// show up?" Same split as the virtual flag above: the source's own structured
// field is the primary signal and free text is only a fallback.
//
// Shipped 2026-08-12 after the Aug 12 issue ran Palo Alto's "Vintage Media
// Lab" as its afternoon field-guide pick — "spend the afternoon digitizing
// family cassettes and photos", 1:00 PM, Mitchell Park Library, Free. The
// program is appointment-only (one two-hour booking per person per week), so
// a reader who followed the newsletter and walked up at 1:00 PM could not get
// in. The BiblioCommons ingest was reading definition.title/start/end and
// dropping definition.registrationInfo entirely, so every registration-gated
// library event across SJPL, SCCL, Palo Alto and Mountain View reached the
// planner indistinguishable from a drop-in storytime.
// ---------------------------------------------------------------------------

/** No advance action needed — walk up at the listed time. */
export const REGISTRATION_NONE = "none";
/** Must register/reserve ahead, but seats are open. */
export const REGISTRATION_REQUIRED = "required";
/** Must book an individual appointment slot; there is no general admission. */
export const REGISTRATION_APPOINTMENT = "appointment-only";
/** Registration is tracked and the event is out of seats. */
export const REGISTRATION_FULL = "full";

/** Instructions describing an individually booked slot rather than a seat. */
const APPOINTMENT_PATTERNS = [
  /\bappointments?\b/i,
  /\bbook\s*@/i,
  /\bbook\s+(an?|your)\s+(appointment|slot|time|session|visit)\b/i,
  /\bschedule\s+(an?|your)\s+(appointment|slot|time|session|visit|consultation)\b/i,
  /\bone[-\s]?on[-\s]?one\b/i,
  /\b1\s*[-:]\s*1\b/,
];

/** Instructions describing advance registration for a seat. */
const REGISTER_PATTERNS = [
  /\bregist(er|ration|ering)\b/i,
  /\breserv(e|ation|ations)\b/i,
  /\bsign[-\s]?up\b/i,
  /\bsign\s+up\b/i,
  /\brsvp\b/i,
  /\benroll(ment)?\b/i,
];

/**
 * Text that explicitly promises walk-up access. Only consulted when the source
 * published no registration provider — a provider is authoritative and text
 * must never downgrade it.
 *
 * Earns its keep on SJPL's "Indoor Family Storytime with Stay and Play", whose
 * instructions read "Seating ... is available on a first-come, first-served
 * basis. A limited number of tickets will be distributed at the Information
 * Desk 30 minutes prior." That is a drop-in with a door ticket, not a booking,
 * and a bare "limited"/"tickets" heuristic would have wrongly gated it.
 */
const DROP_IN_PATTERNS = [
  /\bfirst[-\s]come\b/i,
  /\bdrop[-\s]?in\b/i,
  /\bwalk[-\s]?ins?\b/i,
  /\bno\s+(advance\s+)?(registration|reservation|sign[-\s]?up|rsvp)\b/i,
  /\bregistration\s+(is\s+)?not\s+(required|needed|necessary)\b/i,
];

function stripInstructionMarkup(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify free-text registration instructions.
 * Returns an appointment/required state, or null when the text says nothing
 * actionable. Appointment language wins over generic register language: "call
 * to set up a one-on-one counseling appointment" is both, and the appointment
 * reading is the one a reader needs.
 */
export function registrationFromInstructions(instructions) {
  const text = stripInstructionMarkup(instructions);
  if (!text) return null;
  if (APPOINTMENT_PATTERNS.some((re) => re.test(text))) return REGISTRATION_APPOINTMENT;
  if (REGISTER_PATTERNS.some((re) => re.test(text))) return REGISTRATION_REQUIRED;
  return null;
}

/**
 * Normalize one raw BiblioCommons event into a registration state.
 *
 * Reads the shape the gateway actually returns (verified against SJPL, SCCL,
 * Palo Alto and Mountain View, 900 events, 2026-08-12):
 *
 *   ev.definition.registrationInfo = { provider, cap, maxSeats, isFull,
 *                                      instructions, enabledMethods, ... }
 *   ev.isFull / ev.registrationClosed          <- per-instance, top level
 *
 * `provider` is the load-bearing field:
 *   null            no registration (657/900) — the ordinary storytime case
 *   "BIBLIO_EVENTS" registration runs inside BiblioCommons, always capped
 *   "EXTERNAL"      registration happens off-platform; instructions say how
 *
 * TWO TRAPS, both of which produced the Vintage Media Lab bug if ignored:
 *
 * 1. `isFull` is NOT a reliable sold-out signal. When provider is "EXTERNAL"
 *    with cap and maxSeats both null, BiblioCommons has no seat accounting at
 *    all, so `isFull` carries no information — 4 of the 40 Vintage Media Lab
 *    instances in the live feed report isFull:true while the library's own
 *    page advertises "August & September Appointments Still Available". So
 *    `full` requires actual seat accounting; without it an EXTERNAL event
 *    stays appointment-only/required and gets labelled rather than suppressed.
 *
 * 2. A non-null `cap` does NOT imply registration. Palo Alto's "Open Sewing
 *    Studio", "Photography Meetup" and "Meditation with Sara" all carry
 *    cap/maxSeats with provider null, no instructions, and numberRegistered
 *    null — room capacity noted on a drop-in, nothing to book. Gating on cap
 *    would have wrongly suppressed ~40 genuine walk-up events.
 *
 * `definition.registrationInfo.isFull` is deliberately ignored in favour of
 * the top-level `ev.isFull`: the definition is shared across every instance of
 * a recurring series, so its copy goes stale (Palo Alto's "STEAM Lab Saturday"
 * reports definition isFull:false on an instance whose own isFull is true).
 */
export function registrationFromBiblioCommons(ev) {
  if (!ev) return REGISTRATION_NONE;
  const info = ev.definition?.registrationInfo || {};
  const provider = typeof info.provider === "string" ? info.provider.toUpperCase() : null;
  const cap = Number.isFinite(info.cap) ? info.cap : null;
  const maxSeats = Number.isFinite(info.maxSeats) ? info.maxSeats : null;
  const fromInstructions = registrationFromInstructions(info.instructions);

  // Seats are only really being counted when a cap exists or BiblioCommons is
  // itself the registrar. See trap 1 above.
  const hasSeatAccounting =
    provider === "BIBLIO_EVENTS" || cap !== null || maxSeats !== null;

  if (!provider) {
    // No registrar. Trust explicit walk-up language over a stray "reserve", and
    // treat silence as a drop-in — that is the overwhelming majority case.
    const text = stripInstructionMarkup(info.instructions);
    if (text && DROP_IN_PATTERNS.some((re) => re.test(text))) return REGISTRATION_NONE;
    return fromInstructions || REGISTRATION_NONE;
  }

  if (ev.isFull === true && hasSeatAccounting) return REGISTRATION_FULL;

  if (provider === "EXTERNAL") {
    // Off-platform registration always needs advance action; the instructions
    // only decide whether it is an appointment or a seat.
    return fromInstructions || REGISTRATION_REQUIRED;
  }

  // BIBLIO_EVENTS: registration runs on the library's own site.
  return fromInstructions || REGISTRATION_REQUIRED;
}

/**
 * True when a reader cannot simply turn up at the listed time. The gate for
 * every walk-up recommendation slot: day-plan pillars and Tonight's Pick.
 *
 * Events with no `registration` field — every non-library source — read as
 * walk-up, preserving existing behaviour.
 */
export function requiresAdvanceRegistration(event) {
  if (!event) return false;
  const state = typeof event === "string" ? event : event.registration;
  return (
    state === REGISTRATION_REQUIRED ||
    state === REGISTRATION_APPOINTMENT ||
    state === REGISTRATION_FULL
  );
}

/**
 * Short reader-facing label, or "" when nothing needs saying. Used by listing
 * surfaces that still show the event (the Events tab, "Also on the calendar")
 * so a gated event is labelled rather than silently dropped.
 */
export function registrationLabel(event) {
  const state = typeof event === "string" ? event : event?.registration;
  if (state === REGISTRATION_APPOINTMENT) return "Appointment required";
  if (state === REGISTRATION_REQUIRED) return "Reserve ahead";
  if (state === REGISTRATION_FULL) return "Registration full";
  return "";
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
