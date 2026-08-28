import { looksLikeReadableAgenda, parseAgendaOutline } from "./agenda-outline.mjs";

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
    // No council meeting exists on this date, so the "City Council" label is
    // disproven even when pickBodyForRecord can't say which body it was. A bare
    // null can't express that — the caller reads it as "nothing to change" and
    // publishes the label anyway. San José's 2026-08-26 digest shipped as a
    // City Council meeting when Legistar shows only the Joint Rules and Open
    // Government Committee / Committee of the Whole and the Planning
    // Commission sat that day. Hand back councilMet:false so the caller can
    // tell "the label checks out" from "the label is wrong and I can't fix it".
    return pickBodyForRecord(candidates, recordText)
      ?? { body: null, sourceUrl: null, councilMet: false };
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
    // Same contract as the Legistar verifier above: an ambiguous body still
    // disproves the "City Council" label, and the caller has to be able to see
    // that rather than reading a bare null as "nothing to change".
    return pickBodyForRecord(candidates, recordText)
      ?? { body: null, sourceUrl: null, councilMet: false };
  } catch {
    return null;
  }
}

// ── eScribe archive (Campbell) ──────────────────────────────────────────────
//
// eScribe exposes two calendar endpoints and they are NOT interchangeable:
//
//   MeetingsCalendarView.aspx/GetCalendarMeetings
//     Forward-looking, one *rendered month* per call. Asking it for a month
//     that has already passed returns [] — which reads exactly like "the
//     council did not meet". generate-upcoming-meetings uses this one, and
//     correctly, because it only ever wants the next sitting.
//
//   MeetingsCalendarView.aspx/PastMeetings?Year=YYYY
//     The archive, paged per meeting type. This is the only endpoint that can
//     answer "what did the council last take up", so it is the one a digest
//     fallback needs.
//
// Confusing the two is how Campbell looked dormant while it was meeting: on
// 2026-08-27 GetCalendarMeetings returned nothing for July through December
// while PastMeetings listed regular sessions on August 3 and August 18.

// How many agenda items reach the summarizer.
//
// Consent-calendar items come first and there can be fifteen of them, so a low
// cap spends the whole excerpt on check registers and final map approvals and
// truncates away the item a resident actually needs — Saratoga's Aug 19 agenda
// lost a 25-lot subdivision appeal and a five-year Sheriff's contract at 12.
// Every South Bay council agenda seen so far fits inside 20.
const MAX_AGENDA_ITEMS = 20;

const ESCRIBE_UA = "SouthBaySignal/1.0 (stanwood.dev; civic data aggregator)";

/**
 * One eScribe request, returned as text.
 *
 * Some Node builds reject escribemeetings.com's chain with
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY (the root resolves from Node's bundled CA
 * store, not the OS keychain). System curl trusts it, so fall back to curl on a
 * TLS failure instead of dropping the city. Don't collapse this to a plain
 * fetch without testing on the Mini.
 */
async function escribeRequest(url, { body = null, ua = ESCRIBE_UA, timeout = 20_000 } = {}) {
  const isPost = body !== null;
  try {
    const res = await fetch(url, {
      method: isPost ? "POST" : "GET",
      headers: {
        "User-Agent": ua,
        ...(isPost ? { "Content-Type": "application/json", Accept: "application/json" } : {}),
      },
      ...(isPost ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    const cause = err?.cause?.code || "";
    if (!/CERT|TLS|SSL/i.test(`${cause} ${err.message}`)) throw err;
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const args = ["-sL", "--max-time", String(Math.ceil(timeout / 1000) + 5), "-A", ua];
    if (isPost) args.push("-X", "POST", "-H", "Content-Type: application/json", "-d", JSON.stringify(body));
    args.push(url);
    const { stdout } = await promisify(execFile)("curl", args, { maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  }
}

/** POST an eScribe ASP.NET AJAX endpoint and parse its JSON envelope. */
export async function escribePost(url, body, opts = {}) {
  return JSON.parse(await escribeRequest(url, { ...opts, body: body ?? {} }));
}

/** Reader-facing agenda page for one eScribe meeting id. */
export function escribeAgendaUrl(host, meetingId) {
  return `https://${host}/Meeting.aspx?Id=${encodeURIComponent(meetingId)}&Agenda=Agenda&lang=English`;
}

/**
 * eScribe serializes archive rows' `Start` as ASP.NET `/Date(<epoch ms>)/`.
 * The epoch is real UTC (unlike the naive local `StartDate` on calendar rows),
 * so the city's calendar date is the Pacific rendering of it.
 */
export function escribeRowDateISO(row) {
  const match = String(row?.Start ?? "").match(/\/Date\((-?\d+)/);
  if (!match) return null;
  const ms = Number(match[1]);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

const ESCRIBE_AGENDA_TITLE = /<div class="AgendaItemTitle"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/g;
const ESCRIBE_AGENDA_MOTION = /<div class="MotionText[\s\S]*?<\/li>/;

/** Longest recommended action worth carrying into a summarization prompt. */
const MOTION_CHARS = 240;

function decodeAgendaText(fragment) {
  return String(fragment ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160|#xa0);/gi, " ")
    .replace(/&(?:rsquo|lsquo|#8216|#8217|#39|#x27);/gi, "'")
    .replace(/&(?:ldquo|rdquo|quot|#34);/gi, '"')
    .replace(/&(?:ndash|#8211);/gi, "–")
    .replace(/&(?:mdash|#8212);/gi, "—")
    .replace(/&amp;/gi, "&")
    // eScribe titles carry stray zero-width characters from staff paste-ins
    // (Campbell's "Measure O" item ends in U+200B), which otherwise survive
    // into headings and key topics.
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Agenda items, in order, from a rendered eScribe agenda page — each title
 * paired with its "Recommended Action" where the page publishes one.
 *
 * The action is what disambiguates the title. Campbell's August 18 2026 item
 * reads "Acceptance of Campbell Police Foundation Donations", which a summarizer
 * given titles alone rendered as donations *to* the foundation; the recommended
 * action says the city is accepting $41,911.62 *from* it. Same words, opposite
 * direction of money.
 */
export function extractEscribeAgendaItems(html) {
  const source = String(html ?? "");
  const titles = [...source.matchAll(ESCRIBE_AGENDA_TITLE)];
  return titles.map((match, i) => {
    // An item's motion sits between its own title and the next one.
    const from = match.index + match[0].length;
    const to = titles[i + 1]?.index ?? source.length;
    const motion = source.slice(from, to).match(ESCRIBE_AGENDA_MOTION);
    const action = motion
      ? decodeAgendaText(motion[0]).replace(/^Recommended Action\s*/i, "")
      : "";
    return { title: decodeAgendaText(match[1]), action: truncateAtWord(action, MOTION_CHARS) };
  });
}

function truncateAtWord(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return `${cut.slice(0, cut.lastIndexOf(" ")).trimEnd()}…`;
}

/** Agenda item titles alone, in order. */
export function extractEscribeAgendaTitles(html) {
  return extractEscribeAgendaItems(html).map((item) => item.title);
}

/**
 * Keep only the agenda lines a resident would recognize as city business.
 *
 * Drops procedural scaffolding (all-caps section banners, roll call, recess),
 * lines too short to carry a topic, and anything long enough to be a legal
 * notice rather than an item. Shared by the Legistar and eScribe past-meeting
 * fallbacks so the two can't drift into summarizing different things.
 */
export function isSubstantiveAgendaTitle(value) {
  const title = String(value ?? "").split(/\r?\n/)[0].trim();
  if (title.length <= 25 || title.length >= 300) return false;
  if (/^(roll call|call to order|pledge of allegiance|adjournment|closed session|public comment|consent calendar|recess)/i.test(title)) return false;
  return title !== title.toUpperCase();
}

export function substantiveAgendaTitles(titles) {
  return (titles ?? [])
    .map((t) => String(t ?? "").split(/\r?\n/)[0].trim())
    .filter(isSubstantiveAgendaTitle);
}

/**
 * Most recent *past* council meeting published on a city's eScribe portal,
 * shaped like the upstream records the digest pipeline already handles.
 *
 * Returns null when the portal has no past meeting with a usable agenda, so a
 * caller can fall through to whatever it was going to do anyway.
 */
export async function fetchEscribePastMeeting({
  host,
  meetingTypes = [],
  today = ptDateISO(),
  maxCandidates = 3,
  ua = ESCRIBE_UA,
} = {}) {
  const year = Number(today.slice(0, 4));
  // Current year first, then the one before — a January run has no past meeting
  // in the new year yet.
  for (const archiveYear of [year, year - 1]) {
    const rows = [];
    for (const type of meetingTypes) {
      let payload;
      try {
        payload = await escribePost(
          `https://${host}/MeetingsCalendarView.aspx/PastMeetings?Year=${archiveYear}`,
          { type, pageNumber: 1 },
          { ua },
        );
      } catch {
        continue; // one dead meeting type must not sink the others
      }
      const meetings = payload?.d?.Meetings;
      if (Array.isArray(meetings)) rows.push(...meetings);
    }

    const candidates = rows
      .filter((row) => row?.Id && row?.HasAgenda && !row?.Cancelled)
      .map((row) => ({ row, date: escribeRowDateISO(row) }))
      .filter(({ date }) => date && date <= today)
      .sort((a, b) => b.date.localeCompare(a.date));

    for (const { row, date } of candidates.slice(0, maxCandidates)) {
      const agendaUrl = escribeAgendaUrl(host, row.Id);
      let html;
      try {
        html = await escribeRequest(agendaUrl, { ua, timeout: 30_000 });
      } catch {
        continue;
      }
      const items = extractEscribeAgendaItems(html)
        .filter((item) => isSubstantiveAgendaTitle(item.title));
      // One line is a procedural stub, not an agenda worth summarizing — same
      // floor the Legistar past-meeting fallback uses.
      if (items.length < 2) continue;

      return {
        id: `escribe-${host}-${row.Id}`,
        city: null,
        date,
        meetingType: "City Council",
        title: `City Council — ${date}`,
        excerpt: items
          .slice(0, MAX_AGENDA_ITEMS)
          .map((item) => (item.action ? `${item.title} — ${item.action}` : item.title))
          .join("\n"),
        keywords: items.slice(0, 5).map((item) => item.title),
        source: "escribe-direct",
        sourceUrl: agendaUrl,
      };
    }
  }
  return null;
}

// ── Plain-text agenda portals (Los Altos, Saratoga) ─────────────────────────
//
// Neither city exposes agenda items as records. Los Altos (CivicClerk) will
// hand back the agenda PDF already converted to text; Saratoga (CivicEngage)
// serves a PDF and nothing else. Both come out the far side as a numbered
// outline, which lib/agenda-outline.mjs knows how to read.

const AGENDA_UA = "SouthBaySignal/1.0 (stanwood.dev; civic data aggregator)";
// CivicEngage answers a bare bot UA with an interstitial rather than the file.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Rebuild a PDF's visual lines from glyph positions.
 *
 * pdf.js emits positioned runs, not lines, so `extractText` loses the outline
 * structure the parser keys on. Group runs by baseline, order by x, and insert
 * a space wherever the horizontal gap says the city's typesetting had one —
 * concatenating blind produced Saratoga's
 * "ApproveacontractwithSpecifiedPlayEquipmentCo.".
 */
export async function pdfTextLines(buffer) {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const lines = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const rows = new Map();
    for (const item of content.items) {
      if (typeof item.str !== "string" || !item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: item.transform[4], width: item.width ?? 0, str: item.str });
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const runs = rows.get(y).sort((a, b) => a.x - b.x);
      let line = "";
      let cursor = null;
      for (const run of runs) {
        const gap = cursor === null ? 0 : run.x - cursor;
        if (line && gap > 1 && !/\s$/.test(line) && !/^\s/.test(run.str)) line += " ";
        line += run.str;
        cursor = run.x + run.width;
      }
      lines.push(line);
    }
  }
  return lines.join("\n");
}

/** Shape an agenda outline into the upstream record the digest pipeline reads. */
function agendaRecord({ id, date, items, sourceUrl, source }) {
  const usable = items.filter((item) => isSubstantiveAgendaTitle(item.title));
  // One line is a procedural stub, not an agenda worth summarizing — the same
  // floor every other past-meeting fallback uses.
  if (usable.length < 2) return null;
  return {
    id,
    city: null,
    date,
    meetingType: "City Council",
    title: `City Council — ${date}`,
    excerpt: usable
      .slice(0, MAX_AGENDA_ITEMS)
      .map((item) => (item.detail ? `${item.title} — ${item.detail}` : item.title))
      .join("\n"),
    keywords: usable.slice(0, 5).map((item) => item.title),
    source,
    sourceUrl,
  };
}

/**
 * Most recent past council meeting published on a CivicClerk portal.
 *
 * CivicClerk stores the agenda as a PDF but will convert it on request:
 * `GetMeetingFileStream(fileId=N,plainText=true)` returns the text directly, so
 * this path never has to parse a PDF.
 */
export async function fetchCivicClerkPastMeeting({
  apiHost,
  category = "City Council",
  today = ptDateISO(),
  maxCandidates = 3,
} = {}) {
  const url = new URL(`https://${apiHost}/v1/Events`);
  url.searchParams.set("$filter", `categoryName eq '${category}' and eventDate lt ${today}T23:59:59Z`);
  url.searchParams.set("$orderby", "eventDate desc");
  url.searchParams.set("$top", "20");

  const res = await fetch(url, {
    headers: { "User-Agent": AGENDA_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`CivicClerk HTTP ${res.status}`);
  const events = (await res.json())?.value ?? [];

  const candidates = events
    .filter((event) => event?.hasAgenda && !event?.isDeleted)
    // A closed session is not public business a resident can read about.
    .filter((event) => !isClosedSessionMeeting({ bodyName: event.eventName, description: event.eventDescription }))
    .map((event) => ({ event, date: String(event.eventDate ?? "").slice(0, 10) }))
    .filter(({ date }) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today);

  for (const { event, date } of candidates.slice(0, maxCandidates)) {
    const agenda = (event.publishedFiles ?? []).find((f) => f?.type === "Agenda" && f?.fileId);
    if (!agenda) continue;
    const fileUrl = `https://${apiHost}/v1/Meetings/GetMeetingFileStream(fileId=${agenda.fileId},plainText=true)`;
    let text;
    try {
      const fileRes = await fetch(fileUrl, {
        headers: { "User-Agent": AGENDA_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!fileRes.ok) continue;
      text = await fileRes.text();
    } catch {
      continue;
    }
    if (!looksLikeReadableAgenda(text)) continue;

    const record = agendaRecord({
      id: `civicclerk-${apiHost}-${event.id}`,
      date,
      items: parseAgendaOutline(text),
      source: "civicclerk-direct",
      sourceUrl: `https://${apiHost.replace(/\.api\./, ".portal.")}/event/${event.id}/files`,
    });
    if (record) return record;
  }
  return null;
}

// A CivicEngage agenda link: /AgendaCenter/ViewFile/Agenda/_MMDDYYYY-1465
const CIVICENGAGE_AGENDA_LINK =
  /<a[^>]+href="([^"]*\/AgendaCenter\/ViewFile\/Agenda\/_(\d{2})(\d{2})(\d{4})-\d+)"[^>]*>([\s\S]*?)<\/a>/gi;

// Cities post machine-translated agendas beside the English one. Their text
// layer is a font subset that decodes to mojibake, so they are unreadable to a
// summarizer even when they parse — Saratoga's Chinese agenda comes out as
// `!"#$%&%'(')*+,-./`. looksLikeReadableAgenda is the backstop; this is the
// cheaper first pass, since it avoids downloading them at all.
const TRANSLATED_AGENDA =
  /\b(chinese|spanish|vietnamese|korean|tagalog|japanese|russian|arabic|farsi|hindi|punjabi|espa[nñ]ol)\b/i;

/**
 * Past agenda documents linked from a CivicEngage agenda center, newest first.
 *
 * Exported for its own sake: the translation filter is the only thing standing
 * between the digest and an unreadable PDF, and it is worth testing without a
 * network round trip.
 */
export function parseCivicEngageAgendaLinks(html, { baseUrl, today = ptDateISO() } = {}) {
  const seen = new Set();
  const candidates = [];
  for (const match of String(html ?? "").matchAll(CIVICENGAGE_AGENDA_LINK)) {
    const [, href, month, day, year, rawLabel] = match;
    const date = `${year}-${month}-${day}`;
    if (date > today) continue;
    const label = rawLabel.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (TRANSLATED_AGENDA.test(label)) continue;
    const url = href.startsWith("http") ? href : `${baseUrl}${href}`;
    if (seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, date, label });
  }
  return candidates.sort((a, b) => b.date.localeCompare(a.date));
}

/** Most recent past council meeting published on a CivicEngage agenda center. */
export async function fetchCivicEngagePastMeeting({
  baseUrl,
  calendarId,
  today = ptDateISO(),
  maxCandidates = 3,
} = {}) {
  const indexUrl = `${baseUrl}/AgendaCenter/${calendarId}`;
  const res = await fetch(indexUrl, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`CivicEngage HTTP ${res.status}`);
  const candidates = parseCivicEngageAgendaLinks(await res.text(), { baseUrl, today });

  for (const { url, date } of candidates.slice(0, maxCandidates)) {
    let text;
    try {
      const fileRes = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(45_000),
      });
      if (!fileRes.ok) continue;
      text = await pdfTextLines(await fileRes.arrayBuffer());
    } catch {
      continue;
    }
    if (!looksLikeReadableAgenda(text)) continue;

    const record = agendaRecord({
      id: `civicengage-${calendarId}-${date}`,
      date,
      items: parseAgendaOutline(text),
      source: "civicengage-direct",
      sourceUrl: url,
    });
    if (record) return record;
  }
  return null;
}
