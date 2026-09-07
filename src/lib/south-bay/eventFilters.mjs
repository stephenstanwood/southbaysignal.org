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
/**
 * Registration was required and the window has ended — there is nothing a
 * reader can do anymore, not even join a waitlist. Distinct from `full`
 * (waitlist may still be open) because it removes the event from every
 * recommendation slot instead of merely demoting it.
 *
 * Shipped 2026-09-01 after that morning's issue listed SJPL's "Intro to
 * Ukulele for Adults" with a "Reserve ahead" tag. The event was session 3 of
 * a 3-part series whose registration closed the day before the FIRST session
 * (Aug 17) — the newsletter pointed readers at a dead signup for a mid-series
 * class.
 */
export const REGISTRATION_CLOSED = "closed";

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

  // The top-level per-instance `registrationClosed` needs the SAME seat-
  // accounting discipline as isFull (trap 1): the Vintage Media Lab instances
  // report registrationClosed:true alongside their spurious isFull:true while
  // the library's page advertises appointments still available. With
  // accounting, a true flag is real user-visible state (SJPL's ESL/EVC course
  // instances render a full/waitlist banner from it). And in the other
  // direction the flag proves NOTHING: the Sept 1 2026 ukulele instance
  // reported false while its own page showed "Registration Closed", because
  // the badge comes from the registration WINDOW, which the flag lags — that
  // is what resolveRegistrationClosesBy below and the newsletter's live
  // window re-check are for.
  if (ev.registrationClosed === true && hasSeatAccounting) return REGISTRATION_CLOSED;

  if (provider === "EXTERNAL") {
    // Off-platform registration always needs advance action; the instructions
    // only decide whether it is an appointment or a seat.
    return fromInstructions || REGISTRATION_REQUIRED;
  }

  // BIBLIO_EVENTS: registration runs on the library's own site.
  return fromInstructions || REGISTRATION_REQUIRED;
}

/** Normalize a GraphQL enum value to an upper-case string, or null. */
function enumValue(value) {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

/**
 * Normalize one raw Meetup GraphQL event node into a registration state.
 *
 * Reads the shape api.meetup.com/gql-ext actually returns (verified against
 * the live eventSearch feed, 49 South Bay events, 2026-09-07):
 *
 *   node.rsvpState                 <- RsvpState enum, the reader-facing CTA
 *   node.maxTickets                <- Int; 0 means "no limit"
 *   node.rsvpSettings.rsvpsClosed  <- Boolean
 *   node.rsvps.yesCount            <- seats actually taken
 *   node.group.joinMode            <- GroupJoinMode: OPEN | APPROVAL | CLOSED
 *   node.group.isPrivate           <- Boolean
 *
 * `rsvpState` is the load-bearing field, the way `provider` is for
 * BiblioCommons. It is exactly what Meetup renders in the listing's sticky
 * CTA bar, so it is the same string the reader will see:
 *   JOIN_OPEN           "Attend"          -> anyone can RSVP, walk-up stands
 *   JOIN_APPROVAL       "Request to join" -> an organizer must approve first
 *   JOIN_DUES_APPROVAL  approval + dues
 *   FULL / WAITLIST     out of seats
 *   CLOSED              RSVPs shut
 *
 * Shipped 2026-09-07 after that morning's issue opened by calling a Hacker
 * Dojo BBQ and PASCA's "Monday Pizza Social in the Garden" "both
 * no-registration walk-ups", and said so again in Tonight's Pick. The pizza
 * social is JOIN_APPROVAL with maxTickets 31 — its CTA reads "Request to
 * join", so a reader who took the newsletter at its word could be turned
 * away at an approval gate. Every Meetup event reached the planner with no
 * `registration` field at all, indistinguishable from a park concert.
 *
 * THREE TRAPS, all observed in that same 49-event sample:
 *
 * 1. `rsvpState` is the CURRENT MEMBER's state, so it can describe our OAuth
 *    identity rather than the reader's. A group we have already joined
 *    reports RSVP/YES/NO instead of a JOIN_* value, which says nothing about
 *    what a stranger faces. Those states therefore fall through to
 *    `group.joinMode`, which is member-independent. (All 49 sampled events
 *    returned JOIN_* — we belong to none of these groups — so this is a
 *    guard against the day someone signs the service account into one.)
 *
 * 2. `isPrivate` does NOT gate admission. It hides a group's content from
 *    non-members; the join mode is a separate setting. South Bay Adventure's
 *    "Willow Glens Goombah's Car Show" is isPrivate:true with joinMode OPEN
 *    and rsvpState JOIN_OPEN — a genuine open RSVP. Gating on isPrivate
 *    would have suppressed 6 of 49 events, several of them walk-ups.
 *
 * 3. `maxTickets` alone does NOT imply registration — the same discipline the
 *    BiblioCommons classifier documents as its trap 2. 16 of 49 events carry
 *    a positive maxTickets, most of them open-RSVP. A cap only matters once
 *    the seats are actually gone, and unlike BiblioCommons' advisory `cap`,
 *    Meetup enforces this one, so an exhausted cap IS real seat accounting.
 *
 * The converse of trap 1 also bites: `joinMode` alone is not enough either.
 * Desi Social & Network Group runs joinMode OPEN with rsvpState
 * JOIN_DUES_APPROVAL — dues plus approval on an "open" group. Both signals
 * are needed, with the CTA state first.
 */
export function registrationFromMeetup(node) {
  if (!node) return REGISTRATION_NONE;

  const state = enumValue(node.rsvpState);
  const joinMode = enumValue(node.group?.joinMode);
  const maxTickets = Number.isFinite(node.maxTickets) && node.maxTickets > 0 ? node.maxTickets : null;
  const yesCount = Number.isFinite(node.rsvps?.yesCount) ? node.rsvps.yesCount : null;

  // Nothing a reader can do anymore.
  if (state === "CLOSED" || node.rsvpSettings?.rsvpsClosed === true) return REGISTRATION_CLOSED;

  // Out of seats. The waitlist may still be open, so this is `full`, not
  // `closed`. Seat arithmetic only runs against an enforced limit (trap 3).
  if (state === "FULL" || state === "WAITLIST") return REGISTRATION_FULL;
  if (maxTickets !== null && yesCount !== null && yesCount >= maxTickets) return REGISTRATION_FULL;

  // An organizer or a payment stands between the reader and the door.
  if (state === "JOIN_APPROVAL" || state === "JOIN_DUES_APPROVAL" || state === "DUES") {
    return REGISTRATION_REQUIRED;
  }
  // REQUESTED means our own account is already waiting on an approval, which
  // still proves the gate exists. NOT_OPEN_YET means RSVPs have not opened,
  // so there is no walk-up to promise either.
  if (state === "REQUESTED" || state === "NOT_OPEN_YET") return REGISTRATION_REQUIRED;

  // Member-independent backstop for trap 1, and the only signal when the
  // feed omits rsvpState entirely.
  if (joinMode === "APPROVAL" || joinMode === "CLOSED") return REGISTRATION_REQUIRED;

  // JOIN_OPEN / RSVP / YES / NO / NONE / absent: the RSVP is open to anyone.
  return REGISTRATION_NONE;
}

/**
 * True when a reader cannot simply turn up at the listed time. The gate for
 * every walk-up recommendation slot: day-plan pillars and Tonight's Pick.
 *
 * Events with no `registration` field read as walk-up, preserving existing
 * behaviour. Libraries (registrationFromBiblioCommons) and Meetup
 * (registrationFromMeetup) both populate it at ingest.
 */
export function requiresAdvanceRegistration(event) {
  if (!event) return false;
  const state = typeof event === "string" ? event : event.registration;
  return (
    state === REGISTRATION_REQUIRED ||
    state === REGISTRATION_APPOINTMENT ||
    state === REGISTRATION_FULL ||
    state === REGISTRATION_CLOSED
  );
}

// A conflicting attendance instruction is not a registration requirement.
// Keep the listing and its confirmation note, but do not recommend going.
export function requiresAttendanceConfirmation(event) {
  return event?.attendanceStatus === "needs-confirmation";
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
  if (state === REGISTRATION_CLOSED) return "Registration closed";
  return "";
}

/**
 * Prose that promises a reader they can turn up without booking: "no
 * registration required", "walk-up", "drop in", "just show up", "open to all
 * comers".
 *
 * Written for the 2026-09-07 issue, whose lede called two 6 PM Meetup events
 * "both no-registration walk-ups" and whose Tonight's Pick repeated "no
 * registration required". One of them was approval-gated. The claim reached
 * three separate strings in one email, so the guard belongs on the CLAIM, not
 * on any single blurb.
 *
 * This is deliberately asymmetric with the classifier above. We can prove an
 * event is GATED — a source publishes an approval gate or a closed window —
 * but almost no source affirmatively publishes "you may walk up". A missing
 * registration field is an absence of evidence, and `registration: "none"`
 * only means the source disclosed no gate; on Meetup even an open event still
 * renders an RSVP button. So a walk-up promise needs support from the event's
 * own words (walkUpSupportedByEventText), never from silence.
 */
const WALK_UP_CLAIM_PATTERNS = [
  /\bno\s+(?:advance\s+|prior\s+|pre[-\s]?)?(?:registration|reservations?|sign[-\s]?ups?|rsvps?|tickets?|booking)\b/i,
  /\b(?:registration|reservations?|sign[-\s]?up|rsvp|booking|tickets?)\s+(?:is\s+|are\s+)?not\s+(?:required|needed|necessary)\b/i,
  /\bwithout\s+(?:a\s+)?(?:registration|reservation|sign[-\s]?up|rsvp|booking|ticket)\b/i,
  /\bwalk[-\s]?ups?\b/i,
  /\bwalk\s+right\s+in\b/i,
  /\bdrop[-\s]?in\b/i,
  /\bjust\s+(?:show\s+up|turn\s+up|walk\s+in)\b/i,
  /\bshow\s+up\s+and\b/i,
  /\bopen\s+(?:to\s+)?(?:all\s+comers|the\s+public\s+with\s+no)\b/i,
];

/** True when copy promises walk-up access. */
export function assertsWalkUp(text) {
  const copy = String(text || "");
  if (!copy) return false;
  return WALK_UP_CLAIM_PATTERNS.some((re) => re.test(copy));
}

/**
 * True when the event's OWN source text earns a walk-up promise — the
 * Berryessa balloon-derby case, whose library copy really does say
 * "first-come, first-served". Reuses DROP_IN_PATTERNS so the two directions
 * of this decision cannot drift apart.
 *
 * A gated event can never support the claim, whatever its copy says.
 */
export function walkUpSupportedByEventText(event) {
  if (!event) return false;
  if (requiresAdvanceRegistration(event)) return false;
  const source = [event.rawTitle, event.title, event.description, event.attendanceNote]
    .filter(Boolean)
    .join(" ");
  if (!source) return false;
  return DROP_IN_PATTERNS.some((re) => re.test(source));
}

// ---------------------------------------------------------------------------
// Registration windows
// ---------------------------------------------------------------------------
// BiblioCommons closes registration on a schedule the feed only publishes as a
// RULE (definition.registrationInfo.registrationEnd), not as a state: the Sept
// 1 2026 ukulele instance kept isFull:false / registrationClosed:false while
// its page rendered "Registration Closed", because the badge comes from the
// resolved window (the per-event registration_windows endpoint returned
// status:"ENDED", window_end Aug 17 — the day before the series began).
// resolveRegistrationClosesBy turns the rule into a comparable deadline so
// ingest and the newsletter can reason about closedness offline; the
// newsletter additionally re-checks the live endpoint for whatever it selects
// (scripts/newsletter/registration-recheck.mjs).
// ---------------------------------------------------------------------------

/** PT offset by month — same heuristic as scripts/lib/dates.mjs parseDatePT
 * (PDT Mar–Nov, PST Dec–Feb). Off by an hour for a few DST-transition hours a
 * year, which is harmless at the day granularity these deadlines are used at. */
function ptOffsetForMonth(month) {
  return month >= 3 && month <= 11 ? "-07:00" : "-08:00";
}

/** The event's calendar date in Pacific Time, as YYYY-MM-DD. */
function ptCalendarDate(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** Parse "YYYY-MM-DD" (+ optional "T10:00"/"10:00" clock) as a PT instant. */
function parsePtDateTime(isoDate, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) return null;
  const hhmm = String(time || "").replace(/^T/, "");
  const clock = /^\d{2}:\d{2}(:\d{2})?$/.test(hhmm) ? hhmm : null;
  const month = parseInt(isoDate.slice(5, 7), 10);
  const parsed = new Date(
    `${isoDate}T${clock || "23:59:00"}${clock && clock.length === 5 ? ":00" : ""}${ptOffsetForMonth(month)}`,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Resolve a raw BiblioCommons event's registration deadline to an absolute
 * Date, or null when the source publishes no usable window.
 *
 * Window shapes observed live (SJPL/SCCL, 2026-09-01):
 *   STATIC       absolute { date, time } — used verbatim (no time → end of
 *                that PT day, the latest reading).
 *   EVENT_START  closes `ordinal` × `unit` before the instance starts
 *                (ordinal 0 = at start; SJPL teen meetings use hours).
 *   EVENT_END    same, anchored to the instance end.
 *   RELATIVE     `ordinal` × `unit` before the start, at the `time` clock —
 *                BiblioCommons resolves this against the SERIES' first
 *                session, which the instance record doesn't carry, so this
 *                computes against the INSTANCE start instead. That makes the
 *                result an UPPER BOUND: a mid-series instance's true deadline
 *                (first session − ordinal) is never later than this. "Past the
 *                upper bound" therefore proves closed; "before it" proves
 *                nothing, which is what the newsletter's live re-check is for.
 *                (A stray `date` rides along on RELATIVE rules — e.g. the
 *                ukulele's said 2025-07-16 — and is ignored.)
 *
 * BIBLIO_EVENTS ONLY. When registration runs off-platform (provider
 * "EXTERNAL"), the rule fields are vestigial config BiblioCommons itself
 * ignores: SJPL's recurring "(Virtual) Math Club" carries a STATIC end of
 * 2023-09-12 on 2027 instances while the live registration_windows endpoint
 * reports ACTIVE with no window at all (verified 2026-09-01). Deriving a
 * deadline from those would have closed three open programs in the first
 * 800 live events sampled. Same discipline as isFull/registrationClosed:
 * EXTERNAL per-field state is noise.
 *
 * Returns the LATEST plausible close. Callers treat `now > result` as closed.
 */
export function resolveRegistrationClosesBy(ev, start, end) {
  const info = ev?.definition?.registrationInfo || {};
  const provider = typeof info.provider === "string" ? info.provider.toUpperCase() : null;
  if (provider !== "BIBLIO_EVENTS") return null;
  const rule = info.registrationEnd;
  if (!rule || typeof rule !== "object") return null;
  const windowType = typeof rule.windowType === "string" ? rule.windowType.toUpperCase() : null;

  if (windowType === "STATIC") return parsePtDateTime(rule.date, rule.time);

  const anchor = windowType === "EVENT_END" ? end || start : start;
  if (!(anchor instanceof Date) || Number.isNaN(anchor.getTime())) return null;
  if (windowType !== "EVENT_START" && windowType !== "EVENT_END" && windowType !== "RELATIVE") return null;

  const ordinal = Number.isFinite(rule.ordinal) ? rule.ordinal : 0;
  const unitMs = String(rule.unit || "days").toLowerCase().startsWith("hour")
    ? 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;
  const shifted = new Date(anchor.getTime() - ordinal * unitMs);
  const clock = String(rule.time || "").replace(/^T/, "");
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(clock)) {
    const atClock = parsePtDateTime(ptCalendarDate(shifted), clock);
    if (atClock) return atClock;
  }
  return shifted;
}

/**
 * True when a reader opening the newsletter on `isoDate` can no longer
 * register: the state already says closed, or a required/appointment event's
 * published deadline fell before that day even began. A deadline DURING the
 * day (a 10 AM cutoff, a closes-at-start rule) keeps the event honest to
 * recommend — "Reserve ahead" then means "reserve this morning".
 *
 * `full` is deliberately not closed-for-day: a full event stays listed with
 * its "Registration full" label because the waitlist may still be open.
 */
export function isRegistrationClosedForDay(event, isoDate = null) {
  if (!event) return false;
  if (event.registration === REGISTRATION_CLOSED) return true;
  if (
    event.registration !== REGISTRATION_REQUIRED &&
    event.registration !== REGISTRATION_APPOINTMENT
  ) return false;
  const closes = Date.parse(event.registrationClosesBy || "");
  if (!Number.isFinite(closes)) return false;
  const day = isoDate || event.date;
  const dayStart = day ? parsePtDateTime(day, "00:00") : null;
  if (!dayStart) return false;
  return closes < dayStart.getTime();
}

/**
 * True when the event's own copy says it belongs to a series that began
 * before this date — the "[Rescheduled - Starting August 18]" marker on the
 * Sept 1 ukulele session. Session N>1 of a register-ahead series is never a
 * fresh recommendation: the reader could not join even when the registration
 * data looks open (an EXTERNAL provider publishes no window to check).
 *
 * Text-only and deliberately narrow: it needs an explicit "Starting <Month>
 * <Day>" phrase that resolves EARLIER than the event's own date. A future
 * "Starting …" (announcing session 1) or bare series language ("3-part
 * series") without a date never trips it. Callers should combine it with a
 * registration gate — a drop-in series is fine to join midway.
 */
const SERIES_START_MARKER =
  /\bstart(?:ing|s)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
const MONTH_INDEX = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function seriesStartedBeforeEvent(event) {
  if (!event || !/^\d{4}-\d{2}-\d{2}$/.test(String(event.date || ""))) return false;
  const hay = [event.title, event.description].filter(Boolean).join(" ");
  const m = SERIES_START_MARKER.exec(hay);
  if (!m) return false;
  const month = MONTH_INDEX[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  if (!month || !day || day > 31) return false;
  const eventYear = parseInt(event.date.slice(0, 4), 10);
  const pad = (n) => String(n).padStart(2, "0");
  let candidate = `${eventYear}-${pad(month)}-${pad(day)}`;
  // Year is never printed in the marker. A "start" more than ~6 months after
  // the event is a December/January wrap — it belongs to the previous year.
  if (candidate > event.date) {
    const monthsAhead = (month - parseInt(event.date.slice(5, 7), 10) + 12) % 12;
    if (monthsAhead > 6) candidate = `${eventYear - 1}-${pad(month)}-${pad(day)}`;
  }
  return candidate < event.date;
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
