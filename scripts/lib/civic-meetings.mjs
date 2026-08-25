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

// ---------------------------------------------------------------------------
// Posted start times that belong to a closed session
//
// isClosedSessionMeeting above answers "is this whole sitting closed?". A
// second, narrower failure has its own shape: a public meeting whose *first
// block* is closed, posted as one calendar entry under a plain name.
//
// Sunnyvale is the standing case. Legistar carries one row named "City
// Council" whose EventTime is 4:30 PM and whose EventComment holds the real
// running order:
//
//   "Special Meeting: Closed Session - 4:30 PM |
//    Special Meeting: Presentation - 6 PM | Regular Meeting - 7 PM"
//
// So 4:30 PM is the hour the doors are shut. The 2026-08-25 issue printed
// "Sunnyvale at 4:30" and called it the afternoon to scratch a civic itch —
// sending readers to a locked room. Nine 2026 entries carry this shape, so the
// closed-session vocabulary in generate-upcoming-meetings.mjs can never catch
// it: that vocabulary is keyed on the meeting *name*, and the name here says
// nothing.
// ---------------------------------------------------------------------------

// One "Label - 7 PM" block. The separator must be preceded by a non-digit so a
// bare clock can never be read as one: San José posts "Closed Session at 9:30
// a.m." as a note about a *separate* earlier meeting, and splitting it at the
// colon inside "9:30" would invent a block that isn't there.
const SESSION_BLOCK = /^(.*?)(?<=\D)\s*[-–—:]\s*(\d{1,2}(?::[0-5]\d)?\s*[ap]\.?\s*m\.?)\b/i;

/**
 * Read a posted running order out of a provider's free-text comment.
 *
 * @param {string} text EventComment / eventDescription / Description
 * @returns {{label: string, startTime: string, closed: boolean}[]} in posted order
 */
export function parseSessionSchedule(text) {
  return stripUrls(String(text ?? "").replace(/\r?\n/g, " | "))
    .split("|")
    .map((chunk) => {
      const match = chunk.trim().match(SESSION_BLOCK);
      if (!match) return null;
      const label = match[1].trim();
      const startTime = normalizeMeetingTime(match[2]);
      if (!label || !startTime) return null;
      // Reuse the one closed-session vocabulary. Providers punctuate these
      // labels with a colon ("Special Meeting: Closed Session"); the
      // designation pattern reads them as ordinary meeting-type qualifiers.
      return { label, startTime, closed: isClosedSessionMeeting({ bodyName: label.replace(/:/g, " ") }) };
    })
    .filter(Boolean);
}

/**
 * Move a posted start off a closed session and onto the first block a reader
 * can actually attend.
 *
 * Returns the posted start untouched unless the schedule says, in the city's
 * own words, that (a) every block convening at the posted hour is closed and
 * (b) a public block follows. Anything less certain — no schedule, one lone
 * block, a closed session noted at some other hour — is left alone, because
 * quietly restating a start time we can't source is the worse error.
 *
 * @returns {{startTime: string|null, closedSessionStart: string|null}}
 */
export function resolvePublicStart({ startTime = null, comment, description } = {}) {
  const posted = CLOCK.test(String(startTime ?? "")) ? String(startTime) : null;
  const unchanged = { startTime: startTime ?? null, closedSessionStart: null };
  if (!posted) return unchanged;
  const postedMinutes = meetingClockMinutes(posted);

  for (const text of [comment, description]) {
    const blocks = parseSessionSchedule(text);
    // A single block is just a restatement of the posted time; it says nothing
    // about a public alternative.
    if (blocks.length < 2) continue;

    const atPosted = blocks.filter((block) => block.startTime === posted);
    if (atPosted.length === 0 || !atPosted.every((block) => block.closed)) continue;

    const [open] = blocks
      .filter((block) => !block.closed && meetingClockMinutes(block.startTime) > postedMinutes)
      .sort((a, b) => meetingClockMinutes(a.startTime) - meetingClockMinutes(b.startTime));
    if (!open) continue;

    return { startTime: open.startTime, closedSessionStart: posted };
  }
  return unchanged;
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

/**
 * Per-meeting agenda link for a PrimeGov-hosted body.
 *
 * A digest's sourceUrl otherwise falls back to the city's configured
 * agendaUrl, which points at the *City Council* agenda page. When the digest
 * is relabeled to another body — Palo Alto's Architectural Review Board, say —
 * that link attributes the item to a body that never heard it. PrimeGov
 * publishes one HTML agenda per meeting (compileOutputType 3); link to that
 * instead so the cited source is the agenda actually summarized.
 *
 * @param {string} domain PrimeGov host, e.g. "cityofpaloalto.primegov.com"
 * @param {object} meeting a ListArchivedMeetings record
 * @returns {string|null} the agenda URL, or null when no HTML agenda is published
 */
export function primeGovAgendaUrl(domain, meeting) {
  const host = String(domain || "").toLowerCase();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.primegov\.com$/.test(host)) return null;
  const docs = Array.isArray(meeting?.documentList) ? meeting.documentList : [];
  const agenda = docs.find(
    (d) => d?.compileOutputType === 3 && d?.publishStatus === 1 && Number.isInteger(d?.id),
  );
  if (!agenda) return null;
  return `https://${host}/Portal/Meeting?compiledMeetingDocumentFileId=${agenda.id}`;
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

// ---------------------------------------------------------------------------
// Body verification — shared by generate-digests and generate-around-town.
//
// Stoa's ingest labels every record `meetingType: "City Council"`, including
// meetings that were nothing of the sort. That mislabel has now shipped twice:
// once as a digest (San Jose 2026-08-05, Palo Alto 2026-08-06) and once as an
// around-town item (Palo Alto 2026-08-06, published as "Council to weigh rules
// for cell equipment" when the Architectural Review Board heard it). Both
// generators must ask the city's own portal what actually convened.
// ---------------------------------------------------------------------------
const LEGISTAR_UA = "SouthBaySignal/1.0 (stanwood.dev; civic data aggregator)";
// Words that appear in nearly every body name and so carry no signal for
// telling two same-day bodies apart.
const BODY_NAME_STOPWORDS = new Set([
  "board", "committee", "commission", "council", "city", "town", "the", "of",
  "and", "for", "regular", "special", "joint", "meeting", "session", "adjourned",
  "study", "closed", "annual",
]);

function distinctiveTokens(bodyName) {
  return [...new Set(
    String(bodyName).toLowerCase().match(/[a-z]{3,}/g) ?? [],
  )].filter((w) => !BODY_NAME_STOPWORDS.has(w));
}

// Choose which same-day body actually produced the record we summarized.
//
// Both verifiers used to take the first plausible board/committee/commission on
// the date. That is only safe when exactly one convened. On 2026-08-20 Palo Alto
// held the Architectural Review Board at 8:30am and the Public Art Commission at
// 7pm; the digest summarized the Public Art Commission agenda (3150 El Camino
// Real public art, Code:ART 2027 funding) but shipped it under the ARB's name
// and the ARB's agenda link — an agenda that contains none of it.
//
// So when more than one candidate exists, score each body's distinctive words
// against the record's own text and require a single clear winner. If nothing
// matches, or two bodies tie, return null: leaving the label unresolved is a
// smaller error than attributing an item to a body that never heard it.
//
// `candidates` is [{ body, sourceUrl }]; recordText is the record's title +
// excerpt (empty string is fine — a single candidate is still returned).
export function pickBodyForRecord(candidates, recordText = "") {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const haystack = String(recordText).toLowerCase();
  const scored = candidates.map((c) => {
    const tokens = distinctiveTokens(c.body);
    const hits = tokens.filter((t) => new RegExp(`\\b${t}\\b`).test(haystack)).length;
    return { ...c, score: hits };
  });
  scored.sort((a, b) => b.score - a.score);
  if (scored[0].score === 0) return null;
  if (scored[0].score === scored[1].score) return null;
  return scored[0];
}

// Upstream records carry a `meetingType` we display verbatim, and it defaults to
// "City Council" when absent. On 2026-08-05 San José's record was labeled City
// Council but the only meeting that day was the Joint Rules and Open Government
// Committee / Committee of the Whole — so the digest told residents the Council
// met when it had not. Ask Legistar what actually convened on that date: if no
// City Council event exists, return the real body name so the digest is honest.
// Returns null on any error or when the label already checks out, leaving the
// existing behavior untouched.
export async function verifyLegistarBodyOnDate(client, dateIso, recordText = "") {
  try {
    const url =
      `https://webapi.legistar.com/v1/${client}/Events` +
      `?$filter=EventDate ge datetime'${dateIso}T00:00:00'` +
      ` and EventDate lt datetime'${dateIso}T23:59:59'`;
    const res = await fetch(url, {
      headers: { "User-Agent": LEGISTAR_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const events = await res.json();
    if (!Array.isArray(events) || events.length === 0) return null;

    const bodies = events.map((e) => String(e.EventBodyName || "").trim()).filter(Boolean);
    if (bodies.some((b) => /^city council\b/i.test(b))) return null; // label is correct

    // Prefer bodies whose names read like deliberative ones (committee /
    // commission / council-of-the-whole) over incidental same-day staff hearings.
    const deliberative = bodies.filter((b) => /\b(committee|commission)\b/i.test(b));
    const candidates = (deliberative.length > 0 ? deliberative : bodies)
      // Strip meeting-type boilerplate Legistar prepends to some body names
      // ("Joint Meeting for the Rules and Open Government Committee…"). It's not
      // part of the body's name and it makes the card heading unreadable.
      .map((b) => b.replace(/^(?:joint|special|regular)\s+meeting\s+(?:for|of)\s+the\s+/i, "").trim())
      .filter(Boolean)
      // Legistar's calendar link is already filtered to the meeting date, so the
      // existing legistarMeetingUrl fallback stays correct for this body.
      .map((body) => ({ body, sourceUrl: null }));
    return pickBodyForRecord(candidates, recordText);
  } catch {
    return null;
  }
}

// Same honesty check as above, for cities on PrimeGov instead of Legistar.
// Palo Alto's Legistar instance is decommissioned (paloalto.legistar.com answers
// every request with "Invalid parameters!"), so the Legistar verifier could
// never run for it and upstream mislabels sailed through. On 2026-08-17 the
// Aug 6 digest was published as "Palo Alto City Council" when PrimeGov shows
// the only Aug 6 meeting was the Architectural Review Board — the Council's
// Aug 3 sitting was canceled and its next one was Aug 10.
export async function verifyPrimeGovBodyOnDate(domain, dateIso, recordText = "") {
  try {
    const year = dateIso.slice(0, 4);
    const url = `https://${domain}/api/v2/PublicPortal/ListArchivedMeetings?year=${year}`;
    const res = await fetch(url, {
      headers: { "User-Agent": LEGISTAR_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const meetings = await res.json();
    if (!Array.isArray(meetings)) return null;

    // PrimeGov dateTime is a naive local wall clock, so the Pacific calendar
    // date is the literal prefix — never re-read it as UTC.
    const sameDay = meetings.filter((m) => String(m.dateTime || "").slice(0, 10) === dateIso);
    if (sameDay.length === 0) return null;

    // PrimeGov marks cancellations in the title. A canceled council sitting must
    // not count as confirmation that the council met.
    const live = sameDay.filter((m) => !/cancel(?:led|ed)|postponed/i.test(m.title || ""));
    if (live.length === 0) return null;

    // Keep the meeting record, not just its title — the agenda link we cite as
    // the digest's source hangs off the same record.
    const named = live.filter((m) => String(m.title || "").trim());
    if (named.some((m) => /^city council\b/i.test(String(m.title).trim()))) return null; // label is correct

    const deliberative = named.filter((m) => /\b(board|committee|commission)\b/i.test(String(m.title)));
    const candidates = (deliberative.length > 0 ? deliberative : named)
      .map((m) => ({
        // Drop the "Regular Meeting" / "Special Meeting" suffix PrimeGov appends —
        // it is meeting type, not the body's name.
        body: String(m.title).replace(/\s+(?:regular|special|joint)\s+meeting\b.*$/i, "").trim(),
        sourceUrl: primeGovAgendaUrl(domain, m),
      }))
      .filter((c) => c.body);
    return pickBodyForRecord(candidates, recordText);
  } catch {
    return null;
  }
}
