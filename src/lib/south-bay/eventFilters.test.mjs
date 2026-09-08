import test from "node:test";
import assert from "node:assert/strict";
import {
  COVERED_LOCATION,
  LOCAL_DEPARTURE_TRIP,
  OUT_OF_AREA_LOCATION,
  assertsWalkUp,
  hasOutOfAreaDestination,
  isRegistrationClosedForDay,
  isVirtualEvent,
  registrationFromBiblioCommons,
  registrationFromInstructions,
  registrationFromLibCal,
  registrationFromMeetup,
  registrationLabel,
  requiresAdvanceRegistration,
  resolveRegistrationClosesBy,
  resolveVirtualFlag,
  seriesStartedBeforeEvent,
  virtualFromSourceSignal,
  walkUpSupportedByEventText,
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
// Meetup registration
// ---------------------------------------------------------------------------
// The Sept 7 2026 defect: the issue opened by calling a Hacker Dojo BBQ and
// PASCA's pizza social "both no-registration walk-ups", and repeated it in
// Tonight's Pick. The pizza social's CTA reads "Request to join". Both
// fixtures below are the live api.meetup.com/gql-ext nodes for those two
// events, captured 2026-09-07.

// https://www.meetup.com/hackerdojo/events/316453161/ — CTA "Free / Attend".
const MEETUP_BBQ = {
  id: "316453161",
  title: "Community BBQ - Labor Day",
  rsvpState: "JOIN_OPEN",
  maxTickets: 0,
  rsvpSettings: { rsvpsClosed: false, rsvpOpenTime: null, rsvpCloseTime: null },
  rsvps: { totalCount: 11, yesCount: 11 },
  group: { urlname: "hackerdojo", isPrivate: false, joinMode: "OPEN" },
};

// https://www.meetup.com/pasca-volunteers/events/316176113/ — CTA
// "Free / 24 spots left / Request to join". 31 tickets, 7 taken.
const MEETUP_PIZZA = {
  id: "316176113",
  title: "Monday Pizza Social in the Garden",
  rsvpState: "JOIN_APPROVAL",
  maxTickets: 31,
  rsvpSettings: { rsvpsClosed: false, rsvpOpenTime: null, rsvpCloseTime: null },
  rsvps: { totalCount: 7, yesCount: 7 },
  group: { urlname: "pasca-volunteers", isPrivate: false, joinMode: "APPROVAL" },
};

test("an open-RSVP Meetup event stays a walk-up", () => {
  assert.equal(registrationFromMeetup(MEETUP_BBQ), "none");
  assert.equal(requiresAdvanceRegistration({ registration: registrationFromMeetup(MEETUP_BBQ) }), false);
});

test("an approval-gated Meetup event requires advance registration", () => {
  // The whole point of the fix: this is what shipped as a "walk-up".
  assert.equal(registrationFromMeetup(MEETUP_PIZZA), "required");
  assert.equal(requiresAdvanceRegistration({ registration: "required" }), true);
  assert.equal(registrationLabel({ registration: registrationFromMeetup(MEETUP_PIZZA) }), "Reserve ahead");
});

test("a Meetup ticket cap alone does NOT mean registration", () => {
  // Same discipline as the BiblioCommons cap trap. 16 of 49 sampled South Bay
  // events carry a positive maxTickets and most are open RSVPs; a cap only
  // matters once the seats are actually gone.
  const capped = { ...MEETUP_BBQ, maxTickets: 20, rsvps: { totalCount: 3, yesCount: 3 } };
  assert.equal(registrationFromMeetup(capped), "none");
});

test("a private Meetup group does not gate an open RSVP", () => {
  // South Bay Adventure's "Willow Glens Goombah's Car Show": isPrivate true,
  // joinMode OPEN, rsvpState JOIN_OPEN. isPrivate hides content, it does not
  // gate admission — gating on it would suppress 6 of 49 sampled events.
  const privateOpen = {
    ...MEETUP_BBQ,
    maxTickets: 20,
    group: { urlname: "southbayadventure", isPrivate: true, joinMode: "OPEN" },
  };
  assert.equal(registrationFromMeetup(privateOpen), "none");
});

test("a dues gate on an OPEN group is still a gate", () => {
  // Desi Social & Network Group runs joinMode OPEN with rsvpState
  // JOIN_DUES_APPROVAL, so joinMode alone would miss it.
  const dues = {
    ...MEETUP_BBQ,
    rsvpState: "JOIN_DUES_APPROVAL",
    group: { urlname: "desisocialandnetworkgroup", isPrivate: true, joinMode: "OPEN" },
  };
  assert.equal(registrationFromMeetup(dues), "required");
});

test("joinMode backstops an rsvpState that describes our own membership", () => {
  // rsvpState is the CURRENT MEMBER's state. If the service account ever joins
  // a group, the JOIN_* value disappears and says nothing about a stranger.
  for (const rsvpState of ["RSVP", "YES", "NO", "NONE", null]) {
    assert.equal(
      registrationFromMeetup({ ...MEETUP_PIZZA, rsvpState }),
      "required",
      String(rsvpState),
    );
    assert.equal(registrationFromMeetup({ ...MEETUP_BBQ, rsvpState }), "none", String(rsvpState));
  }
});

test("exhausted seats and shut RSVPs map to full and closed", () => {
  assert.equal(registrationFromMeetup({ ...MEETUP_BBQ, rsvpState: "FULL" }), "full");
  assert.equal(registrationFromMeetup({ ...MEETUP_BBQ, rsvpState: "WAITLIST" }), "full");
  // An enforced cap with every seat taken is real accounting.
  assert.equal(
    registrationFromMeetup({ ...MEETUP_PIZZA, maxTickets: 31, rsvps: { totalCount: 31, yesCount: 31 } }),
    "full",
  );
  assert.equal(registrationFromMeetup({ ...MEETUP_BBQ, rsvpState: "CLOSED" }), "closed");
  assert.equal(
    registrationFromMeetup({ ...MEETUP_BBQ, rsvpSettings: { rsvpsClosed: true } }),
    "closed",
  );
});

test("a missing or empty Meetup node is safe", () => {
  assert.equal(registrationFromMeetup(null), "none");
  assert.equal(registrationFromMeetup({}), "none");
});

// ---------------------------------------------------------------------------
// LibCal registration
// ---------------------------------------------------------------------------
// The Sept 8 2026 defect: the issue made Mountain View's "Community
// Preservation Lab Scanning Service" its afternoon plan card and told readers
// to bring a shoebox of family photos and let staff digitize them. The service
// is appointment-only. The LibCal ingest set no `registration` field at all,
// so requiresAdvanceRegistration() read every LibCal event as a walk-up.
//
// Every fixture below is the live /ajax/calendar/list row for a real event,
// captured 2026-09-08 from mountainview.libcal.com and losgatosca.libcal.com.

// https://mountainview.libcal.com/event/17319757 — the September 8 occurrence.
// registration_enabled is FALSE: the two 90-minute slots are booked through
// links in the body copy, not through a LibCal form on this row.
const LIBCAL_SCANNING = {
  id: 17319757,
  title: "Community Preservation Lab Scanning Service",
  registration_enabled: false,
  online_registration: false,
  in_person_registration: false,
  description: "<p>The Community Preservation Lab is a service provided at the Mountain View History Center. It allows library users to digitize their personal photos and documents with the assistance of library staff. Registration is required to use this service. Please read <a href=\"https://www.mountainview.gov/home/showdocument?id=13174\">this document</a> to learn more about the scanning service before making an appointment. <strong>Appointments are limited to one per household per week.</strong></p>\n<p>Register below for a 90-minute session for scanning services in the History Center.</p>\n<p style=\"text-align: center;\"><a href=\"https://mountainview.libcal.com/event/17319724\">Click Here to Register for 1:00pm to 2:30pm</a></p>\n<p style=\"text-align: center;\"><style type=\"text/css\">#s_lc_event_16714527 {\n  background: #228B22;\n  font: 16px Arial, Helvetica, Verdana;\n}</style></p>",
  more_info: "",
};

// https://mountainview.libcal.com/event/14959849 — an ordinary capped class.
const LIBCAL_LANDSCAPE = {
  id: 14959849,
  title: "Landscape Design for Beginners",
  registration_enabled: true,
  online_registration: false,
  in_person_registration: true,
  description: "<p>Registration is required. Seats and materials are limited. Please only register if you plan on attending.</p><p>Discover the fundamentals of landscape design in this beginner-friendly class.</p>",
  more_info: "",
};

// https://mountainview.libcal.com/event/17028027 — trap 2. The library
// attached a signup form AND told readers they can turn up anyway.
const LIBCAL_UKULELE = {
  id: 17028027,
  title: "Ukulele Jam Sing and Play Along",
  registration_enabled: true,
  online_registration: false,
  in_person_registration: true,
  description: "<p>Registration is recommended. Seating is limited. Walk-ins&nbsp;are also welcome.&nbsp;</p><p>Would you like to learn some fun songs on the ukulele?</p>",
  more_info: "",
};

// https://losgatosca.libcal.com/event/16035527 — says "appointment" in the
// course of promising the opposite.
const LIBCAL_TECH_HELP = {
  id: 16035527,
  title: "Drop-In Tech Help",
  registration_enabled: false,
  description: "<p>Do you have questions about your laptop, smartphone, or tablet? Join us for Drop-in Tech help. No appointment is needed, we help patrons on a first come first served basis. We meet in the 2nd floor Tech Lab and a clipboard for singing-up is at the 2nd floor reference desk starting at 2:30PM.</p>",
  more_info: "",
};

// https://losgatosca.libcal.com/event/17376577 — a drop-in book club whose
// only registration-shaped words are two mailing-list plugs.
const LIBCAL_COOKBOOK_CLUB = {
  id: 17376577,
  title: "Cookbook Club",
  registration_enabled: false,
  description: "<p>September&#39;s theme is &quot;in a bun&quot;! Come to our meeting ready to talk all about what you made and the book you used. Don&#39;t forget to sign up for our Cookbook Club newsletter to get all the latest updates and cookbook suggestions! You can sign up for any of our newsletters&nbsp;here.</p>",
  more_info: "",
};

test("an appointment-only LibCal service is gated even though its flag says false", () => {
  // The September 8 plan-card defect. registration_enabled is false because the
  // booking links live in the body copy, so the flag alone would have shipped
  // the same walk-up promise a second time.
  assert.equal(registrationFromLibCal(LIBCAL_SCANNING), "appointment-only");
  assert.equal(requiresAdvanceRegistration({ registration: "appointment-only" }), true);
  assert.equal(registrationLabel(registrationFromLibCal(LIBCAL_SCANNING)), "Appointment required");
});

test("a plain capped LibCal class is required, not appointment-only", () => {
  assert.equal(registrationFromLibCal(LIBCAL_LANDSCAPE), "required");
  assert.equal(registrationLabel(registrationFromLibCal(LIBCAL_LANDSCAPE)), "Reserve ahead");
});

test("a LibCal walk-up promise beats the registration flag", () => {
  // Trap 2, and the direction that differs from BiblioCommons: LibCal's flag
  // only says a form is attached, so five real Mountain View walk-up programs
  // would have been suppressed if it won. LibCal's own form widget prints a
  // stock "Registration is required" banner on this page; the library's
  // sentence is the one that describes the door.
  assert.equal(registrationFromLibCal(LIBCAL_UKULELE), "none");
  assert.equal(requiresAdvanceRegistration({ registration: registrationFromLibCal(LIBCAL_UKULELE) }), false);
  assert.equal(walkUpSupportedByEventText({ description: "Registration is recommended. Walk-ins are also welcome." }), true);
});

test("drop-in copy outranks the word 'appointment' inside it", () => {
  // "No appointment is needed" matches APPOINTMENT_PATTERNS on the very word
  // that says it is not one — 17 Los Gatos occurrences. Same discipline as the
  // "Open Lab Hours" qualifier on the admin-hours rule in generate-events.mjs:
  // a false positive here silently removes a good event from the plan.
  assert.equal(registrationFromLibCal(LIBCAL_TECH_HELP), "none");
});

test("a mailing-list plug is not event registration", () => {
  // Three Los Gatos book clubs invite readers to sign up for a newsletter and
  // nothing else. Monday Morning Book Club adds "new members are welcome at
  // any time" — gating them would have been the opposite failure.
  assert.equal(registrationFromLibCal(LIBCAL_COOKBOOK_CLUB), "none");
  assert.equal(
    registrationFromLibCal({
      registration_enabled: false,
      description: "New members are welcome at any time. Sign up for our newsletter here.",
    }),
    "none",
  );

  // Surgical, not a bail-out: a description carrying BOTH a plug and a real
  // instruction still gates on the instruction.
  assert.equal(
    registrationFromLibCal({
      registration_enabled: false,
      description: "Email signup@gwc-losgatos.org to register. Sign up for our newsletter here.",
    }),
    "required",
  );
});

test("the LibCal flag speaks only when the library's own words did not", () => {
  // Trap 1 in both directions. A bare true is a gate; a bare false is silence,
  // not a walk-up guarantee — Pages and Paws reports true on its October date
  // and false on November and December because the flag tracks whether
  // registration has OPENED, not whether it is needed.
  const bare = { title: "Board Game Night", description: "<p>Bring a friend and play.</p>" };
  assert.equal(registrationFromLibCal({ ...bare, registration_enabled: true }), "required");
  assert.equal(registrationFromLibCal({ ...bare, registration_enabled: false }), "none");
  assert.equal(registrationFromLibCal({ ...bare }), "none");
});

test("a missing or empty LibCal row is safe", () => {
  assert.equal(registrationFromLibCal(null), "none");
  assert.equal(registrationFromLibCal({}), "none");
});

test("inline style blocks never reach the registration text", () => {
  // LibCal wraps each "Click Here to Register" button in an inline <style>.
  // The stripper drops the block's CONTENT, so CSS cannot be matched as prose.
  assert.equal(
    registrationFromLibCal({
      registration_enabled: false,
      description: "<p>Come and play.</p><style type=\"text/css\">#s_lc_event_1 { background: #228B22; }</style>",
    }),
    "none",
  );
});

// ---------------------------------------------------------------------------
// Walk-up claims in copy
// ---------------------------------------------------------------------------

test("walk-up promises are recognized in every phrasing the issue used", () => {
  for (const copy of [
    "both no-registration walk-ups",
    "Hacker Dojo is hosting one through Meetup with no registration required",
    "One more open gathering tonight, no RSVP needed",
    "registration is not required",
    "you can just show up",
    "a drop-in session",
    "walk in without a reservation",
  ]) {
    assert.equal(assertsWalkUp(copy), true, copy);
  }
  for (const copy of [
    "A cookout is the right note for Labor Day.",
    "Reserve ahead for this one.",
    "The garden opens at six.",
    "",
  ]) {
    assert.equal(assertsWalkUp(copy), false, copy);
  }
});

test("only the event's own words can support a walk-up promise", () => {
  // The Berryessa balloon derby really does say first-come, first-served.
  const derby = {
    title: "STEM: Balloon Car Derby",
    attendanceNote: "12 first-come, first-served tickets.",
  };
  assert.equal(walkUpSupportedByEventText(derby), true);

  // A Meetup record says only who is hosting. Nothing supports the promise.
  assert.equal(walkUpSupportedByEventText({
    title: "Monday Pizza Social in the Garden",
    description: "Meetup event by Plant & Soul California (PASCA) Volunteers.",
  }), false);

  // And a gated event can never support it, whatever its copy says.
  assert.equal(walkUpSupportedByEventText({ ...derby, registration: "required" }), false);
  assert.equal(walkUpSupportedByEventText(null), false);
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
