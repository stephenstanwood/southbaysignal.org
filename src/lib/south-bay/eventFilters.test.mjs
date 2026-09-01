import test from "node:test";
import assert from "node:assert/strict";
import {
  COVERED_LOCATION,
  LOCAL_DEPARTURE_TRIP,
  OUT_OF_AREA_LOCATION,
  hasOutOfAreaDestination,
  isRegistrationClosedForDay,
  isVirtualEvent,
  registrationFromBiblioCommons,
  registrationFromInstructions,
  registrationLabel,
  requiresAdvanceRegistration,
  resolveRegistrationClosesBy,
  resolveVirtualFlag,
  seriesStartedBeforeEvent,
  virtualFromSourceSignal,
} from "./eventFilters.mjs";

// The event that shipped as an in-person newsletter destination on
// 2026-08-05. events.sjsu.edu lists it VIRTUAL; nothing in its title or blurb
// says so, and SJSU's RSS defaults every event to the San Jose campus.
const CRC_MEETING = {
  title: "Collegiate Recovery Community (CRC) All Recovery Meeting",
  description:
    "Meet with students exploring recovery and substance-free living in a supportive group",
  venue: "San Jose State University",
  city: "san-jose",
};

// ── isVirtualEvent — text fallback ──

test("virtual title prefixes are caught", () => {
  assert.ok(isVirtualEvent({ title: "Online: Author Talk with Ann Patchett" }));
  assert.ok(isVirtualEvent({ title: "[Virtual] Estate Planning Basics" }));
  assert.ok(isVirtualEvent({ title: "Bay Area Climate Webinar" }));
});

test("a physical event with an incidental word is not virtual", () => {
  assert.ok(!isVirtualEvent({ title: "Live Music on the Plaza" }));
  assert.ok(!isVirtualEvent({ title: "Streamside Nature Walk" }));
});

test("the text fallback alone cannot see the CRC meeting — that is the bug", () => {
  // Documents WHY the source signal exists. If this ever starts returning
  // true from text alone, the regex got broader, not the source signal
  // redundant — keep reading the source field regardless.
  assert.ok(!isVirtualEvent({ title: CRC_MEETING.title, description: CRC_MEETING.description }));
});

// ── isVirtualEvent — explicit flag wins ──

test("an event flagged virtual by its source is virtual with no text marker", () => {
  assert.ok(isVirtualEvent({ ...CRC_MEETING, virtual: true }));
});

test("the flag does not override a text match in the other direction", () => {
  // virtual:false must not un-flag copy that plainly says webinar.
  assert.ok(isVirtualEvent({ title: "Bay Area Climate Webinar", virtual: false }));
});

// ── virtualFromSourceSignal ──

test("Localist experience values map correctly", () => {
  assert.equal(virtualFromSourceSignal("virtual"), true);
  assert.equal(virtualFromSourceSignal("inperson"), false);
  // Hybrid has a real room — it stays a destination.
  assert.equal(virtualFromSourceSignal("hybrid"), false);
});

test("LiveWhale online_type values map correctly", () => {
  assert.equal(virtualFromSourceSignal("Online only"), true);
  assert.equal(virtualFromSourceSignal("Hybrid"), false);
});

test("BiblioCommons booleans and unknowns map correctly", () => {
  assert.equal(virtualFromSourceSignal(true), true);
  assert.equal(virtualFromSourceSignal(false), false);
  // Silence is not an in-person guarantee — null keeps the text fallback.
  assert.equal(virtualFromSourceSignal(null), null);
  assert.equal(virtualFromSourceSignal(undefined), null);
  assert.equal(virtualFromSourceSignal(""), null);
  assert.equal(virtualFromSourceSignal("in-person and outdoors"), false);
  assert.equal(virtualFromSourceSignal("something else entirely"), null);
});

// ── resolveVirtualFlag — the ingest-time decision ──

test("the source's own field flags the CRC meeting the regex misses", () => {
  assert.equal(resolveVirtualFlag(CRC_MEETING, "virtual"), true);
});

test("the regex fallback still applies when the source says nothing", () => {
  assert.equal(resolveVirtualFlag({ title: "Online: Author Talk" }, null), true);
  assert.equal(resolveVirtualFlag({ title: "Online: Author Talk" }, undefined), true);
});

test("an in-person source signal leaves a physical event alone", () => {
  assert.equal(
    resolveVirtualFlag({ title: "Music in the Park", venue: "Plaza de César Chávez" }, "inperson"),
    false,
  );
  assert.equal(resolveVirtualFlag({ title: "Jazz on the Plazz" }, "hybrid"), false);
});

test("either signal is enough — an in-person label cannot override webinar copy", () => {
  // A false positive costs one skipped recommendation; a false negative ships
  // a factual error.
  assert.equal(resolveVirtualFlag({ title: "Bay Area Climate Webinar" }, "inperson"), true);
});

// ── hasOutOfAreaDestination ──

test("out-of-area venue is flagged even when the city slug is in-area", () => {
  // The live case: a Sunnyvale senior-center day trip whose destination is SF.
  assert.ok(
    hasOutOfAreaDestination({
      title: "August Day Trip to San Francisco Zoo & Gardens",
      city: "sunnyvale",
      venue: "San Francisco Zoo & Gardens",
      address: "San Francisco Zoo & Gardens",
    }),
  );
  assert.ok(
    hasOutOfAreaDestination({
      title: "Giants vs. Dodgers Day Trip",
      city: "sunnyvale",
      address: "Oracle Park, San Francisco, CA",
    }),
  );
});

test("in-area events are not flagged", () => {
  assert.ok(
    !hasOutOfAreaDestination({
      title: "Music in the Park",
      city: "san-jose",
      venue: "Plaza de César Chávez",
      address: "194 S Market St, San Jose, CA",
    }),
  );
  assert.ok(!hasOutOfAreaDestination({ address: "Stanford Memorial Church" }));
});

test("a remote satellite campus of an in-area school is flagged", () => {
  // Santa Clara University's calendar publishes its Jesuit School of Theology
  // programming, and that campus is in Berkeley. The event inherits SCU's
  // in-area city slug from the scraper, so the venue string is the only thing
  // that gives the real geography away. "JST-SCU" carries no covered token,
  // so the venue reads as out-of-area and the event is correctly dropped.
  assert.ok(
    hasOutOfAreaDestination({
      title: "Magnifica Humanitas: What is a Christian Approach to AI?",
      city: "santa-clara",
      venue: "JST-SCU, Berkeley Campus, Loyola Room",
      address: "",
    }),
  );
});

test("an address naming both cities resolves to in-area", () => {
  // Departure-and-destination strings ("leaves from Sunnyvale Community
  // Center") must not strand a genuinely local event.
  assert.ok(
    !hasOutOfAreaDestination({
      address: "Sunnyvale Community Center, 550 E Remington Dr, Sunnyvale, CA",
      venue: "San Francisco Bay Trail trailhead",
    }),
  );
});

test("descriptions are never read for geography", () => {
  // The Kepler's 4/24 regression: a sponsor or beneficiary named in the
  // description is not the event's location.
  assert.ok(
    !hasOutOfAreaDestination({
      title: "Benefit Concert",
      venue: "Montalvo Arts Center",
      address: "15400 Montalvo Rd, Saratoga, CA",
      description: "Proceeds support families in Oakland and Richmond.",
    }),
  );
});

test("empty and missing input is safe", () => {
  assert.ok(!hasOutOfAreaDestination(null));
  assert.ok(!hasOutOfAreaDestination(undefined));
  assert.ok(!hasOutOfAreaDestination({}));
  assert.ok(!hasOutOfAreaDestination(""));
});

// ── shared geography regexes ──

test("south county cities are out of area", () => {
  // Gilroy and Morgan Hill are Santa Clara County but outside coverage.
  assert.ok(OUT_OF_AREA_LOCATION.test("Gilroy Library"));
  assert.ok(OUT_OF_AREA_LOCATION.test("Morgan Hill Library"));
  assert.ok(!COVERED_LOCATION.test("Gilroy Library"));
});

test("day-trip exemption matches the titles ingest relies on", () => {
  // generate-events.mjs uses this to keep city-run outings in the feed.
  for (const title of [
    "August Day Trip to San Francisco Zoo & Gardens",
    "Senior Bus Trip: Monterey Bay Aquarium",
    "September Day Trip to SFMOMA",
  ]) {
    assert.ok(LOCAL_DEPARTURE_TRIP.test(title), title);
  }
  assert.ok(!LOCAL_DEPARTURE_TRIP.test("Maggie Stiefvater: The Dream Thieves"));
});

test("the trip exemption does not leak into the day-plan filter", () => {
  // Ingest keeps these; plan-day must still drop them. Same event, opposite
  // answers by design — this is the contract between the two stages.
  const trip = {
    title: "August Day Trip to San Francisco Zoo & Gardens",
    address: "San Francisco Zoo & Gardens",
  };
  assert.ok(LOCAL_DEPARTURE_TRIP.test(trip.title));
  assert.ok(hasOutOfAreaDestination(trip));
});

// ---------------------------------------------------------------------------
// Advance registration
// ---------------------------------------------------------------------------
// Every fixture below is a verbatim shape from the live BiblioCommons gateway
// (SJPL / SCCL / Palo Alto / Mountain View, sampled 2026-08-12).

/** Build a raw BiblioCommons event with the fields the normalizer reads. */
function biblioEvent({ provider = null, cap = null, maxSeats = null, instructions = null, isFull = false, registrationClosed = false, defIsFull = false } = {}) {
  return {
    id: "test-id",
    isFull,
    registrationClosed,
    definition: {
      title: "Test Event",
      registrationInfo: { provider, cap, maxSeats, instructions, isFull: defIsFull, enabledMethods: [] },
    },
  };
}

test("an ordinary drop-in library event needs no registration", () => {
  // 657 of 900 sampled events look exactly like this.
  assert.equal(registrationFromBiblioCommons(biblioEvent()), "none");
  assert.equal(requiresAdvanceRegistration({ registration: "none" }), false);
  assert.equal(registrationLabel({ registration: "none" }), "");
});

test("a room capacity alone does NOT mean registration", () => {
  // Palo Alto's Open Sewing Studio, Photography Meetup and Meditation with
  // Sara all carry cap/maxSeats with no provider and nobody registered —
  // that is a noted room capacity on a walk-in, not a booking. Gating on cap
  // would wrongly suppress ~40 genuine drop-in events.
  const openSewingStudio = biblioEvent({ cap: 15, maxSeats: 2 });
  assert.equal(registrationFromBiblioCommons(openSewingStudio), "none");
});

test("BIBLIO_EVENTS and EXTERNAL providers both require advance action", () => {
  assert.equal(registrationFromBiblioCommons(biblioEvent({ provider: "BIBLIO_EVENTS", cap: 30, maxSeats: 2 })), "required");
  assert.equal(
    registrationFromBiblioCommons(biblioEvent({
      provider: "EXTERNAL", cap: 30, maxSeats: 2,
      instructions: "Register in person at the Edenvale Branch Library, 101 Branham Lane East, San Jose.",
    })),
    "required",
  );
});

test("appointment language outranks generic register language", () => {
  // "call to set up a one-on-one counseling appointment" is both; the
  // appointment reading is the one the reader needs.
  assert.equal(
    registrationFromInstructions("Please call (408) 350-3239 on Monday-Friday between 8am-5pm to set up a free one-on-one counseling appointment."),
    "appointment-only",
  );
  assert.equal(registrationFromInstructions("Please call or email the branch to schedule an appointment."), "appointment-only");
  assert.equal(registrationFromInstructions("Email lpasternack@sccl.org to register."), "required");
  assert.equal(registrationFromInstructions("Bring your own yarn."), null);
  assert.equal(registrationFromInstructions(null), null);
});

test("Vintage Media Lab is appointment-only, and isFull does not suppress it", () => {
  // THE REGRESSION. Event 6a4bffddc52cdc3600ef3342 (2026-08-12T13:00) shipped
  // as the Aug 12 issue's afternoon field-guide pick: "1:00 PM · Mitchell Park
  // Library · Palo Alto · Free". It is appointment-only — one two-hour booking
  // per person per week — so a reader who walked up at 1:00 PM could not
  // get in.
  //
  // It reports isFull:true AND registrationClosed:true while the library's own
  // page advertises "August & September Appointments Still Available", so
  // isFull must NOT be read as sold-out here: provider is EXTERNAL with cap
  // and maxSeats both null, meaning BiblioCommons is doing no seat accounting
  // at all. Mapping it to "full" would silently drop a program that is running
  // and genuinely good; the right answer is to label it.
  const vintageMediaLab = biblioEvent({
    provider: "EXTERNAL",
    cap: null,
    maxSeats: null,
    isFull: true,
    registrationClosed: true,
    instructions: "<strong>Space is limited!</strong> Check the Vintage Media Lab page to see if appointments are still available for the month. If appointments are available, click the Book@Mitchell Park button near the top of the page.",
  });
  assert.equal(registrationFromBiblioCommons(vintageMediaLab), "appointment-only");
  assert.equal(requiresAdvanceRegistration({ registration: "appointment-only" }), true);
  assert.equal(registrationLabel({ registration: "appointment-only" }), "Appointment required");
});

test("isFull means full only when seats are actually being counted", () => {
  // Palo Alto's STEAM Lab Saturday: BiblioCommons is the registrar, so its
  // per-instance isFull is real.
  assert.equal(
    registrationFromBiblioCommons(biblioEvent({ provider: "BIBLIO_EVENTS", cap: 24, maxSeats: 4, isFull: true })),
    "full",
  );
  // Same flag, no seat accounting anywhere → not a sold-out signal.
  assert.equal(
    registrationFromBiblioCommons(biblioEvent({ provider: "EXTERNAL", isFull: true, instructions: "Please register: HERE" })),
    "required",
  );
});

test("the per-instance isFull wins over the series definition copy", () => {
  // definition.registrationInfo is shared by every instance of a recurring
  // series, so its isFull goes stale. Palo Alto's "Philosophy For Life" has an
  // instance whose own isFull is true while the definition still says false.
  const staleSeriesDefinition = biblioEvent({ provider: "BIBLIO_EVENTS", cap: 20, maxSeats: 2, isFull: true, defIsFull: false });
  assert.equal(registrationFromBiblioCommons(staleSeriesDefinition), "full");
});

test("explicit walk-up language beats a stray keyword when no provider is set", () => {
  // SJPL's "Indoor Family Storytime with Stay and Play": a door ticket handed
  // out 30 minutes before is a drop-in, not a booking. A naive
  // "limited"/"tickets" heuristic would have wrongly gated it.
  const storytime = biblioEvent({
    instructions: "Seating for Storytime is available on a first-come, first-served basis. A limited number of tickets will be distributed at the Information Desk 30 minutes prior to the start of Storytime.",
  });
  assert.equal(registrationFromBiblioCommons(storytime), "none");

  // But genuine reserve-ahead language with no provider still counts.
  const crochet = biblioEvent({ instructions: "Call, email, or go to the info desk to reserve a spot." });
  assert.equal(registrationFromBiblioCommons(crochet), "required");
});

test("a provider is authoritative — text cannot downgrade it to walk-up", () => {
  // Mirrors the virtual-flag rule: the source's structured field wins, text is
  // only a fallback for when the source said nothing.
  const contradictory = biblioEvent({
    provider: "BIBLIO_EVENTS",
    cap: 20,
    maxSeats: 2,
    instructions: "Drop-in welcome, no registration required.",
  });
  assert.notEqual(registrationFromBiblioCommons(contradictory), "none");
});

test("events with no registration field read as walk-up", () => {
  // Every non-library source. Absence must preserve existing behaviour.
  assert.equal(requiresAdvanceRegistration({ title: "Concert in the Park" }), false);
  assert.equal(requiresAdvanceRegistration(null), false);
  assert.equal(registrationLabel({ title: "Concert in the Park" }), "");
});

test("every gated state is excluded from walk-up slots and carries a label", () => {
  for (const state of ["required", "appointment-only", "full", "closed"]) {
    assert.equal(requiresAdvanceRegistration({ registration: state }), true, state);
    assert.notEqual(registrationLabel({ registration: state }), "", state);
  }
});

// ---------------------------------------------------------------------------
// Closed registration + registration windows
// ---------------------------------------------------------------------------
// The Sept 1 2026 defect: the issue listed SJPL's "Intro to Ukulele for
// Adults" (session 3 of a 3-part series) with a "Reserve ahead" tag while the
// event page said "Registration Closed" — the window had ended Aug 17, the
// day before the FIRST session. Fixtures below are the live shapes sampled
// that morning.

test("the registrationClosed flag maps to closed only with seat accounting", () => {
  // Same trap-1 discipline as isFull: the Vintage Media Lab instances report
  // registrationClosed:true with NO accounting while the library's page says
  // appointments are still available, so an unaccounted flag is noise. With
  // accounting the flag is real user-visible state.
  assert.equal(
    registrationFromBiblioCommons(biblioEvent({ provider: "BIBLIO_EVENTS", cap: 10, registrationClosed: true })),
    "closed",
  );
  assert.equal(
    registrationFromBiblioCommons(biblioEvent({ provider: "EXTERNAL", registrationClosed: true, instructions: "Please register." })),
    "required",
  );
  assert.equal(registrationLabel({ registration: "closed" }), "Registration closed");
});

test("a counted-full event stays full even when the flag also says closed", () => {
  // SCCL's "Beginning Guitar & Ukulele Class for Adults" (Sept 1) and SJPL's
  // ESL/EVC courses both report isFull:true AND registrationClosed:true with
  // accounting. `full` is the truer listing state — the waitlist path stays
  // visible (both pages render waitlist buttons) — and the newsletter's live
  // window check separately drops it if even the waitlist window has ENDED.
  assert.equal(
    registrationFromBiblioCommons(biblioEvent({ provider: "BIBLIO_EVENTS", cap: 10, isFull: true, registrationClosed: true })),
    "full",
  );
  assert.equal(
    registrationFromBiblioCommons(biblioEvent({ provider: "EXTERNAL", cap: 30, maxSeats: 2, isFull: true, registrationClosed: true })),
    "full",
  );
});

test("flag=false proves nothing — the ukulele instance said false while closed", () => {
  // Documents WHY resolveRegistrationClosesBy and the live re-check exist. If
  // this ever starts returning "closed", BiblioCommons fixed their flag — the
  // window logic stays regardless, since the flag lagged for two weeks here.
  assert.equal(
    registrationFromBiblioCommons(ukuleleRawInstance()),
    "required",
  );
});

/** The live gateway record for sjpl-6a7a2993b44674e2601d024d (2026-09-01). */
function ukuleleRawInstance() {
  return {
    id: "6a7a2993b44674e2601d024d",
    isFull: false,
    registrationClosed: false,
    numberRegistered: 8,
    definition: {
      title: "Intro to Ukulele for Adults",
      start: "2026-09-01T17:15",
      end: "2026-09-01T18:15",
      registrationInfo: {
        provider: "BIBLIO_EVENTS",
        cap: 10,
        maxSeats: 1,
        registrationEnd: { ordinal: 1, unit: "days", time: "T10:00", date: "2025-07-16", windowType: "RELATIVE" },
        registrationStart: { ordinal: 0, unit: "days", time: "T00:00", date: "2026-07-28", windowType: "STATIC" },
      },
    },
  };
}

test("a RELATIVE deadline resolves against the instance as an upper bound", () => {
  // 1 day before the Sept 1 5:15 PM start, at the 10:00 clock → Aug 31 10:00
  // PT. The TRUE deadline (anchored to the series' Aug 18 first session) was
  // even earlier; the stray date field (2025-07-16) must be ignored.
  const start = new Date("2026-09-01T17:15:00-07:00");
  const closes = resolveRegistrationClosesBy(ukuleleRawInstance(), start, new Date("2026-09-01T18:15:00-07:00"));
  assert.equal(closes.toISOString(), new Date("2026-08-31T10:00:00-07:00").toISOString());
});

/** A raw record whose registration window Biblio itself manages. */
function biblioWindowEvent(registrationEnd, provider = "BIBLIO_EVENTS") {
  return { definition: { registrationInfo: { provider, registrationEnd } } };
}

test("EVENT_START windows close relative to the start, hours units included", () => {
  const start = new Date("2026-09-02T16:00:00-07:00");
  const atStart = resolveRegistrationClosesBy(
    biblioWindowEvent({ ordinal: 0, unit: "days", windowType: "EVENT_START" }),
    start,
    null,
  );
  assert.equal(atStart.getTime(), start.getTime());
  // SJPL's Teens Reach meetings close 1 hour before start.
  const hourBefore = resolveRegistrationClosesBy(
    biblioWindowEvent({ ordinal: 1, unit: "hours", windowType: "EVENT_START" }),
    start,
    null,
  );
  assert.equal(hourBefore.getTime(), start.getTime() - 60 * 60 * 1000);
});

test("STATIC windows are absolute and a missing clock reads as end of day", () => {
  const withClock = resolveRegistrationClosesBy(
    biblioWindowEvent({ date: "2026-09-18", time: "T10:00", windowType: "STATIC" }),
    new Date("2026-09-19T10:00:00-07:00"),
    null,
  );
  assert.equal(withClock.toISOString(), new Date("2026-09-18T10:00:00-07:00").toISOString());
  const noClock = resolveRegistrationClosesBy(
    biblioWindowEvent({ date: "2026-09-18", windowType: "STATIC" }),
    new Date("2026-09-19T10:00:00-07:00"),
    null,
  );
  assert.equal(noClock.toISOString(), new Date("2026-09-18T23:59:00-07:00").toISOString());
});

test("an EXTERNAL provider's window rule is vestigial and derives nothing", () => {
  // SJPL's recurring "(Virtual) Math Club" carries a STATIC registrationEnd
  // of 2023-09-12 on its 2027 instances while the live registration_windows
  // endpoint reports ACTIVE with no window — off-platform registration means
  // the rule fields are stale config, exactly like EXTERNAL isFull. Honoring
  // it would have marked three open programs closed in the first 800 live
  // events sampled on 2026-09-01.
  assert.equal(
    resolveRegistrationClosesBy(
      biblioWindowEvent({ date: "2023-09-12", time: "T17:00", windowType: "STATIC" }, "EXTERNAL"),
      new Date("2027-01-20T17:00:00-08:00"),
      null,
    ),
    null,
  );
});

test("null-ish window rules resolve to nothing", () => {
  // The shape provider-less records carry: {ordinal: 0, unit: "days",
  // windowType: null} — no rule, no deadline.
  assert.equal(
    resolveRegistrationClosesBy(
      biblioWindowEvent({ ordinal: 0, unit: "days", time: null, date: null, windowType: null }),
      new Date(),
      null,
    ),
    null,
  );
  assert.equal(resolveRegistrationClosesBy({}, new Date(), null), null);
  assert.equal(resolveRegistrationClosesBy(null, new Date(), null), null);
});

test("the ukulele listing is closed for its own day — the shipped defect", () => {
  // Exactly the canonical feed record from the sent Sept 1 issue, plus the
  // registrationClosesBy the fixed ingest now derives (Aug 31 10:00 PT).
  const ukulele = {
    id: "sjpl-6a7a2993b44674e2601d024d",
    title: "Intro to Ukulele for Adults",
    date: "2026-09-01",
    registration: "required",
    registrationClosesBy: "2026-08-31T17:00:00.000Z",
  };
  assert.equal(isRegistrationClosedForDay(ukulele), true);
});

test("a deadline later in the day keeps the listing recommendable", () => {
  // "Reserve ahead" is honest when the reader can still act that morning: a
  // 10 AM cutoff or a closes-at-start rule is a reason to act, not to hide.
  assert.equal(
    isRegistrationClosedForDay({
      date: "2026-09-01",
      registration: "required",
      registrationClosesBy: "2026-09-01T17:00:00.000Z", // 10 AM PT that day
    }),
    false,
  );
});

test("closed state alone is closed for any day; full and walk-up never are", () => {
  assert.equal(isRegistrationClosedForDay({ date: "2026-09-01", registration: "closed" }), true);
  assert.equal(
    isRegistrationClosedForDay({ date: "2026-09-01", registration: "full", registrationClosesBy: "2026-08-01T00:00:00.000Z" }),
    false,
  );
  assert.equal(
    isRegistrationClosedForDay({ date: "2026-09-01", registrationClosesBy: "2026-08-01T00:00:00.000Z" }),
    false,
  );
  assert.equal(isRegistrationClosedForDay(null), false);
});

test("a deadline with no usable event date proves nothing", () => {
  assert.equal(
    isRegistrationClosedForDay({ registration: "required", registrationClosesBy: "2026-08-01T00:00:00.000Z" }),
    false,
  );
});

// ── Series-start markers ──

test("the ukulele's series marker reads as started-before-event", () => {
  assert.equal(
    seriesStartedBeforeEvent({
      title: "Intro to Ukulele for Adults",
      date: "2026-09-01",
      description:
        "[Rescheduled - Starting August 18] In this 3-part series, participants will learn the basics of playing the ukulele…",
    }),
    true,
  );
});

test("a future series start is an announcement, not a continuation", () => {
  assert.equal(
    seriesStartedBeforeEvent({
      title: "Beginning Watercolor (Starting September 15)",
      date: "2026-09-01",
      description: "A four-week course.",
    }),
    false,
  );
});

test("series language without a date never trips the marker", () => {
  assert.equal(
    seriesStartedBeforeEvent({
      title: "Intro to Ukulele for Adults",
      date: "2026-09-01",
      description: "In this 3-part series, participants will learn the basics.",
    }),
    false,
  );
});

test("a December start seen from January belongs to the previous year", () => {
  assert.equal(
    seriesStartedBeforeEvent({
      title: "Winter Writing Circle",
      date: "2026-01-12",
      description: "[Starting December 8] Weekly sessions through February.",
    }),
    true,
  );
});

test("a same-day start is session 1 and stays recommendable", () => {
  assert.equal(
    seriesStartedBeforeEvent({
      title: "Chess Basics",
      date: "2026-09-01",
      description: "Starting September 1, meet weekly for six weeks.",
    }),
    false,
  );
});
