import test from "node:test";
import assert from "node:assert/strict";
import {
  COVERED_LOCATION,
  LOCAL_DEPARTURE_TRIP,
  OUT_OF_AREA_LOCATION,
  hasOutOfAreaDestination,
  isVirtualEvent,
  registrationFromBiblioCommons,
  registrationFromInstructions,
  registrationLabel,
  requiresAdvanceRegistration,
  resolveVirtualFlag,
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
  for (const state of ["required", "appointment-only", "full"]) {
    assert.equal(requiresAdvanceRegistration({ registration: state }), true, state);
    assert.notEqual(registrationLabel({ registration: state }), "", state);
  }
});
