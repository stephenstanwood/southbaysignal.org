const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export function ptDateISO(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/**
 * Normalize a provider's meeting start into 24-hour "HH:MM" local wall clock.
 *
 * Each portal states it differently, and one of them lies about the zone:
 *   Legistar    EventTime  "5:00 PM"
 *   PrimeGov    dateTime   "2026-08-17T17:30:00"     (naive local)
 *   eScribe     StartDate  "2026/08/11 19:00:00"     (naive local)
 *   CivicClerk  eventDate  "2026-08-11T16:00:00Z"    (local, mislabeled Z)
 *
 * CivicClerk's trailing Z is not UTC. Its own publishedAgendaTimeStamp
 * ("Agenda Posted on August 7, 2026 1:21 PM") matches the publishOn stamp
 * "2026-08-07T13:21:26.623Z" hour for hour, so the wall clock is already the
 * city's. Reading it as UTC would move Milpitas's 4:00 PM sitting to 9:00 AM.
 * Every branch here takes the wall clock as written and discards the offset.
 */
export function normalizeMeetingTime(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const meridiem = raw.match(/^(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\.?$/i);
  if (meridiem) {
    let hour = Number(meridiem[1]);
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem[3].toLowerCase() === "p") hour += 12;
    return clockString(hour, Number(meridiem[2] ?? 0));
  }

  const wall = raw.match(/(?:^|[T\s])(\d{1,2}):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/i);
  if (!wall) return null;
  const hour = Number(wall[1]);
  if (hour > 23) return null;
  return clockString(hour, Number(wall[2]));
}

function clockString(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Minutes past local midnight for a normalized "HH:MM", or null if unknown. */
export function meetingClockMinutes(startTime) {
  const value = String(startTime ?? "");
  if (!CLOCK.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** Reader-facing label for a normalized "HH:MM" ("17:30" → "5:30 PM"). */
export function formatMeetingTime(startTime) {
  const minutes = meetingClockMinutes(startTime);
  if (minutes === null) return null;
  const hour24 = Math.floor(minutes / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minutes % 60).padStart(2, "0")} ${hour24 < 12 ? "AM" : "PM"}`;
}

// A meeting whose posted description IS a closed-session designation. Anchored
// on purpose: San José publishes a public 1:30 PM council meeting whose comment
// reads "https://sanjoseca.zoom.us/j/… Closed Session at 9:30 a.m.", which is a
// note about a *separate* earlier session, not a label for this meeting. Only a
// description that says nothing but "closed session" (with the usual meeting-
// type qualifiers around it) closes the whole sitting.
const CLOSED_SESSION_DESIGNATION =
  /^(?:non-?televised\s+|special\s+|regular\s+|adjourned\s+|joint\s+|city\s+council\s+|council\s+|meeting\s+)*(?:closed|executive)\s+session(?:\s+meeting)?$/i;

/**
 * True when readers can neither attend nor watch — a closed session posted as a
 * meeting in its own right. Cupertino's 2026-08-11 sitting is the case this
 * exists for: EventComment "Non-Televised Special Meeting Closed Session",
 * which the 2026-08-11 issue listed as a plain council meeting in a conference
 * room. EventVideoStatus is no help; Cupertino reported "Public" for it.
 */
export function isClosedSessionMeeting({ bodyName, comment, description } = {}) {
  const fields = [bodyName, comment, description].map((value) => String(value ?? "").trim());
  if (fields.some((field) => /\bnon-?televised\b/i.test(field))) return true;
  return fields.some((field) => CLOSED_SESSION_DESIGNATION.test(stripUrls(field)));
}

function stripUrls(value) {
  return value.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Use the meeting URL supplied by Legistar itself. EventId/EventGuid belong to
 * the Web API and cannot be rebuilt as public-site ID/GUID parameters. If the
 * provider URL is missing or crosses hosts, fall back to the official calendar
 * filtered to the exact meeting date.
 */
export function legistarMeetingUrl(site, date, eventInSiteUrl = null) {
  if (!/^[a-z0-9-]+$/i.test(String(site || ""))) throw new Error("invalid Legistar site");
  if (!ISO_DATE.test(String(date || ""))) throw new Error("invalid meeting date");
  const expectedHost = `${site.toLowerCase()}.legistar.com`;
  const providerUrl = safeHttpUrl(eventInSiteUrl);
  if (
    providerUrl?.protocol === "https:"
    && providerUrl.hostname.toLowerCase() === expectedHost
    && /\/MeetingDetail\.aspx$/i.test(providerUrl.pathname)
    && (providerUrl.searchParams.has("LEGID") || providerUrl.searchParams.has("ID"))
  ) {
    return providerUrl.href;
  }

  const [year, month, day] = date.split("-").map(Number);
  const displayDate = `${month}/${day}/${year}`;
  const calendar = new URL(`https://${expectedHost}/Calendar.aspx`);
  calendar.searchParams.set("From", displayDate);
  calendar.searchParams.set("To", displayDate);
  return calendar.href;
}

/** Attach the exact first-party observation that makes a meeting publishable. */
export function confirmMeeting(meeting, { provider, sourceUrl, observedDate = meeting?.date } = {}) {
  if (!meeting || !ISO_DATE.test(String(meeting.date || ""))) return null;
  if (observedDate !== meeting.date || !String(provider || "").trim()) return null;
  const source = safeHttpUrl(sourceUrl);
  if (!source) return null;
  return {
    ...meeting,
    confirmation: {
      status: "confirmed",
      provider: String(provider),
      observedDate,
      sourceUrl: source.href,
    },
  };
}

export function isConfirmedMeeting(meeting) {
  const confirmation = meeting?.confirmation;
  if (!meeting || !ISO_DATE.test(String(meeting.date || ""))) return false;
  if (confirmation?.status !== "confirmed" || confirmation.observedDate !== meeting.date) return false;
  return Boolean(String(confirmation.provider || "").trim() && safeHttpUrl(confirmation.sourceUrl));
}

/** Final fail-closed publication gate. Recurrence projections have no exact
 * first-party observation and therefore cannot enter the committed artifact. */
export function onlyConfirmedMeetings(meetings) {
  return Object.fromEntries(
    Object.entries(meetings || {}).filter(([, meeting]) => isConfirmedMeeting(meeting)),
  );
}

/** Select the next concrete CivicClerk event in a bounded window. */
export function pickCivicClerkMeeting(events, today, { maxDays = 60 } = {}) {
  if (!ISO_DATE.test(String(today || ""))) return null;
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + maxDays);
  const endDate = end.toISOString().slice(0, 10);

  return (Array.isArray(events) ? events : [])
    .filter((event) => event?.categoryName === "City Council")
    .filter((event) => !/cancel(?:led|ed)|postponed/i.test(String(event.eventName || "")))
    .filter((event) => {
      const date = String(event?.eventDate || "").slice(0, 10);
      return ISO_DATE.test(date) && date >= today && date <= endDate;
    })
    .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)))[0] || null;
}
