/**
 * First-party 2026 Palo Alto State of the City.
 *
 * PrimeGov lists this as "City Council Special Meeting - State of the City 2026"
 * at 5:30 PM in "Council Chamber". The city's public event page is the reader
 * source of truth: Mayor's State of the City at Paly PAC, doors 5:30 p.m.,
 * program 6:00–8:00 p.m.
 *
 * https://www.paloalto.gov/stateofthecity
 * Verified 2026-08-19 against that page and the PrimeGov HTML agenda
 * (compiledMeetingDocumentFileId=21266), which also names Paly PAC.
 */

export const PALO_ALTO_STATE_OF_THE_CITY_URL =
  "https://www.paloalto.gov/stateofthecity";

export const PALO_ALTO_STATE_OF_THE_CITY_2026 = Object.freeze({
  date: "2026-08-19",
  bodyName: "Mayor's State of the City",
  title: "Mayor's State of the City",
  startTime: "18:00",
  time: "6:00 PM",
  endTime: "8:00 PM",
  doorsTime: "5:30 PM",
  location: "Paly PAC · doors 5:30 PM",
  venue: "Paly PAC",
  address: "50 Embarcadero Rd, Palo Alto, CA 94301",
  url: PALO_ALTO_STATE_OF_THE_CITY_URL,
});

export function isStateOfTheCityTitle(value) {
  return /\bstate of the city\b/i.test(String(value || ""));
}

export function overlayPaloAltoStateOfTheCity(meeting, primeGovEvent = {}) {
  if (!meeting || meeting.date !== PALO_ALTO_STATE_OF_THE_CITY_2026.date) {
    return meeting;
  }
  const title = `${meeting.bodyName || ""} ${primeGovEvent.title || ""}`;
  if (!isStateOfTheCityTitle(title)) return meeting;

  return {
    ...meeting,
    bodyName: PALO_ALTO_STATE_OF_THE_CITY_2026.bodyName,
    startTime: PALO_ALTO_STATE_OF_THE_CITY_2026.startTime,
    location: PALO_ALTO_STATE_OF_THE_CITY_2026.location,
    url: PALO_ALTO_STATE_OF_THE_CITY_2026.url,
    closedSession: false,
  };
}

export function getPaloAltoStateOfTheCityEvent({ fromDate = "0000-01-01" } = {}) {
  const spec = PALO_ALTO_STATE_OF_THE_CITY_2026;
  if (spec.date < fromDate) return null;

  return {
    id: `palo-alto-state-of-the-city-${spec.date}`,
    title: spec.title,
    date: spec.date,
    displayDate: "Wed, Aug 19",
    time: spec.time,
    endTime: spec.endTime,
    venue: spec.venue,
    address: spec.address,
    city: "palo-alto",
    category: "community",
    cost: "free",
    description:
      "Join the Mayor of Palo Alto for the 2026 State of the City at the Palo Alto High School Performing Arts Center. Doors open at 5:30 p.m. and the program begins at 6:00 p.m.",
    url: spec.url,
    source: "City of Palo Alto",
    kidFriendly: true,
    audienceAge: "all",
    blurb:
      "Hear the Mayor's State of the City address at Paly PAC. Doors open at 5:30 p.m.; the program starts at 6:00.",
    occurrenceEvidence: {
      kind: "first-party-occurrence-page",
      date: spec.date,
      sourceUrl: spec.url,
      checkedAt: "2026-08-19T13:10:00.000Z",
    },
  };
}

function isSameStateOfTheCityRow(event) {
  if (!event || typeof event !== "object") return false;
  if (event.id === `palo-alto-state-of-the-city-${PALO_ALTO_STATE_OF_THE_CITY_2026.date}`) {
    return true;
  }
  if (String(event.date || "").slice(0, 10) !== PALO_ALTO_STATE_OF_THE_CITY_2026.date) {
    return false;
  }
  const haystack = [event.title, event.bodyName, event.url]
    .filter(Boolean)
    .join(" ");
  if (!isStateOfTheCityTitle(haystack) && !/stateofthecity/i.test(String(event.url || ""))) {
    return false;
  }
  const place = [event.city, event.venue, event.location].filter(Boolean).join(" ");
  return /palo[\s-]?alto|paly/i.test(place) || /paloalto\.gov/i.test(String(event.url || ""));
}

export function mergePaloAltoStateOfTheCity(events, { fromDate = "0000-01-01" } = {}) {
  const rest = (Array.isArray(events) ? events : []).filter(
    (event) => !isSameStateOfTheCityRow(event),
  );
  const canonical = getPaloAltoStateOfTheCityEvent({ fromDate });
  if (!canonical) return { events: rest, addedCount: 0, replacedCount: events.length - rest.length };

  return {
    events: [...rest, canonical],
    addedCount: 1,
    replacedCount: events.length - rest.length,
  };
}
