// Occurrence-specific corrections verified against first-party sources.
// Keep these upstream of blurb resolution so nightly refreshes cannot restore
// a sparse aggregator record or its previously invented cached copy.
// Evidence: docs/qa/2026-09-05-newsletter.md, 2026-09-06-newsletter.md, and
// 2026-09-08-newsletter.md.
import { REGISTRATION_APPOINTMENT } from "./eventFilters.mjs";

const DERBY_ATTENDANCE = "12 first-come, first-served tickets. The library’s pickup instructions conflict with its 2 PM start; confirm pickup timing with Berryessa Library before going.";
const CORRECTIONS = [
  {
    id: "sjpl-6a7bc1324cb69d003e203e28",
    date: "2026-09-06",
    url: "https://sjpl.bibliocommons.com/events/6a7bc1324cb69d003e203e28",
    facts: {
      time: "2:00 PM",
      endTime: "3:30 PM",
      sourceAudiences: ["Kids, ages 5-10"],
      audienceAge: "kids",
      kidFriendly: true,
      description: `Build and race two balloon-powered cars in Berryessa Library’s Community Room. Recommended for elementary students ages 5–10. ${DERBY_ATTENDANCE}`,
      blurb: "Build and race balloon-powered cars, recommended for ages 5–10.",
      attendanceNote: DERBY_ATTENDANCE,
      attendanceStatus: "needs-confirmation",
    },
  },
  {
    id: "cbdd438d7fbe",
    date: "2026-09-06",
    url: "https://losgatosca.libcal.com/event/17096186",
    facts: {
      sourceAudiences: ["Adults"],
      audienceAge: "adult",
      kidFriendly: false,
      description: "Training for adults in the Los Gatos Library Lobby, 4–5 PM, on recognizing an opioid overdose and using Narcan.",
      blurb: "Adults can learn to recognize an opioid overdose and use Narcan in the library lobby.",
    },
  },
  {
    id: "sanjosetheaters-eb92ddeb3f824327",
    date: "2026-09-05",
    title: /grupo duelo/i,
    venue: /san jose civic/i,
    facts: {
      description: "Óscar Iván Treviño and Grupo Duelo bring their norteño music to San Jose Civic on the Gravedad Tour 2026.",
      blurb: "Hear Óscar Iván Treviño and Grupo Duelo perform norteño music at San Jose Civic.",
    },
  },
  {
    id: "tm-Z7r9jZ1A7x78x",
    date: "2026-09-05",
    title: /lost 80['’]?s live/i,
    venue: /mountain winery/i,
    facts: {
      description: "Lost 80s Live features original vocalists or members, including Oingo Boingo Former Members, The Vapors, China Crisis, Big Country, B-Movie, Katrina, Icicle Works and Musical Youth. Show at 6 PM; doors at 4 PM.",
      blurb: "Hear Oingo Boingo Former Members, The Vapors, China Crisis and more at Lost 80s Live.",
      url: "https://lost80slive.com/event/mwc09052026/",
      time: "6:00 PM",
    },
  },
  {
    id: "sjpl-6a5280ebe564853d00fd6ea4",
    date: "2026-09-05",
    title: /pawsitive learning with town cats/i,
    venue: /vineland library/i,
    facts: {
      description: "Learn responsible cat care with Town Cats at Vineland Library, 2–3 PM. Recommended for ages 5+. Space is limited; tickets are available at the Information Desk starting at 1 PM.",
      blurb: "Learn cat care with Town Cats; pick up a ticket at Vineland Library’s Information Desk starting at 1 PM.",
      attendanceNote: "Recommended for ages 5+. Limited space; in-person ticket pickup at the Information Desk starts at 1 PM for the 2–3 PM program.",
    },
  },
  // 2026-09-08 issue QA. Broadway San Jose's own show page lists Family Night
  // on Broadway as Wednesday, September 9 only, with the free 6:00–7:15 PM
  // pre-show activities open to that performance's ticketholders. The inbound
  // City Newsletter record carried that sentence on the Sept 8 opening night,
  // so the blurb (and the issue's field guide) promised families a pre-show
  // that does not happen until the following evening.
  // Evidence: docs/qa/2026-09-08-newsletter.md
  {
    id: "inbound-b60351612d66d165",
    date: "2026-09-08",
    facts: {
      description: "Disney's first North American touring production of the beloved musical in over 25 years, featuring members of the original creative team. Broadway San Jose's run at the San Jose Center for the Performing Arts opens Tuesday, September 8 at 7:30 PM and plays through Sunday, September 13.",
      blurb: "See Disney's touring Beauty and the Beast open its San Jose run at the Center for the Performing Arts.",
    },
  },
  // The same fact belongs on the night it actually happens. Sept 9 is both the
  // closed-caption performance and Family Night on Broadway.
  {
    id: "tm-G5vYZ_1p2R16z",
    date: "2026-09-09",
    facts: {
      description: "Disney's touring Beauty and the Beast at the San Jose Center for the Performing Arts. This is Family Night on Broadway: all ticketholders for the 7:30 PM performance are invited to free pre-show activities from 6:00 PM to 7:15 PM. The performance is closed captioned.",
      blurb: "Catch Beauty and the Beast on Family Night, with free pre-show activities from 6 PM and closed captions during the show.",
    },
  },
  // Mountain View's Community Preservation Lab is an appointment service, not a
  // walk-in: the library's own page requires registration for a 90-minute
  // scanning slot and caps it at one per household per week. The libcal ingest
  // path set no registration state, so the record read as a walk-up and was
  // promoted to the Sept 8 afternoon plan card telling readers to just bring
  // their photos. "appointment-only" restores the existing advance-registration
  // gate, which keeps it in the listings with an "Appointment required" tag.
  //
  // registrationFromLibCal (eventFilters.mjs) now derives that state at ingest
  // for every LibCal event, so this `registration` is a floor rather than the
  // mechanism. The other two facts are NOT redundant: libraryEventDetails
  // builds attendanceNote only from ticket/first-come/limited-space phrasing,
  // which this description does not use, and the blurb is not derivable at all.
  {
    id: "d610aa488850",
    date: "2026-09-08",
    url: "https://mountainview.libcal.com/event/17319757",
    facts: {
      registration: REGISTRATION_APPOINTMENT,
      attendanceNote: "Registration is required. Sessions are 90 minutes and limited to one per household per week; September 8 slots are 1:00–2:30 PM and 3:00–4:30 PM in the History Center.",
      blurb: "Book a 90-minute appointment to digitize your own photos and documents with staff help at the History Center.",
    },
  },
  // Craft Tuesdays & Thursdays runs a different craft each session, and the
  // library lists the whole schedule on every occurrence. The cached blurb
  // summarised the series, so it advertised crafts that had already happened
  // (cactus characters Sept 1, beaded insects Sept 3) instead of the one a
  // reader would actually make that afternoon.
  {
    id: "sjpl-6a945a62be148200298b2cfb",
    date: "2026-09-08",
    facts: {
      blurb: "Make washi tape bookmarks at this week's drop-in craft session; supplies are limited, first come, first served.",
    },
  },
  {
    id: "sjpl-6a945a62be148200298b2cfc",
    date: "2026-09-10",
    facts: {
      blurb: "Make bug headbands at this week's drop-in craft session; supplies are limited, first come, first served.",
    },
  },
];

export function applyVerifiedEventFacts(event) {
  const correction = CORRECTIONS.find((c) => event?.date === c.date && (
    event.id === c.id || (c.url && event.url === c.url)
      || (c.title?.test(event.title || "") && c.venue?.test(event.venue || ""))
  ));
  return correction ? { ...event, ...correction.facts } : event;
}

// ---------------------------------------------------------------------------
// Reference matching: is this copy talking about this event at all?
// ---------------------------------------------------------------------------

function comparable(value) {
  return String(value || "").toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Words that name a KIND of place rather than a specific one. Trimming them
// off the end leaves the part a reader actually says out loud: "Seven Trees
// Library" -> "seven trees". Kept to a suffix trim so the proper-name phrase
// stays contiguous ("San Jose Civic" is not a generic anything).
const GENERIC_VENUE_WORDS = new Set([
  "library", "branch", "center", "centre", "hall", "room", "rooms", "theater",
  "theatre", "museum", "school", "church", "gallery", "lounge", "campus",
  "auditorium", "public", "community", "regional", "main", "the",
]);

function venueCore(venue) {
  const tokens = comparable(venue).split(" ").filter(Boolean);
  while (tokens.length > 1 && GENERIC_VENUE_WORDS.has(tokens.at(-1))) tokens.pop();
  return tokens.join(" ");
}

const TITLE_STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "our", "their", "this", "that", "free",
  "annual", "weekly", "monthly", "special", "join", "come",
]);

function singular(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

// The one word a reader would keep if they dropped the registration title:
// "Playdates for Children and Their Caregivers" -> "playdate".
function titleHeadNoun(rawTitle) {
  const body = rawTitle.match(/^[^:]{1,32}:\s+(.+)$/)?.[1] ?? rawTitle;
  for (const token of comparable(body).split(" ")) {
    if (token.length >= 5 && !TITLE_STOPWORDS.has(token)) return singular(token);
  }
  return "";
}

export function copyMentionsEvent(text, event) {
  const rawTitle = String(event?.rawTitle || event?.title || "").split(/\s[–—-]\s/)[0];
  const title = comparable(rawTitle);
  const copy = comparable(text);
  if (title.length >= 5 && copy.includes(title)) return true;
  // Intros often omit a category prefix: "the balloon car derby" still
  // refers to "STEM: Balloon Car Derby" and needs the same attendance guard.
  const withoutPrefix = comparable(rawTitle.match(/^[^:]{1,32}:\s+(.+)$/)?.[1]);
  if (withoutPrefix.length >= 10 && withoutPrefix.includes(" ") && copy.includes(withoutPrefix)) return true;

  // A reader-facing reference names the place and the kind of thing rather
  // than the registration title: the 2026-09-09 "Also on the calendar" intro
  // said "the Seven Trees playdate" for "Playdates for Children and Their
  // Caregivers", so no title path matched and the whole unsupported() guard
  // skipped the event. Require BOTH halves — a venue alone sweeps in every
  // event at that address, a head noun alone every playdate in the county.
  const core = venueCore(event?.venue);
  const head = titleHeadNoun(rawTitle);
  if (core.length < 6 || head.length < 5 || !copy.includes(core)) return false;
  return copy.split(" ").some((token) => singular(token) === head);
}

// ---------------------------------------------------------------------------
// Source-grounded fact checks
// ---------------------------------------------------------------------------

// Everything the SOURCE says, never the model's earlier blurb. An empty or
// truncated description is not permission to invent an age gate or an act.
function sourceText(event) {
  return [
    event?.rawTitle,
    event?.title,
    event?.description,
    event?.attendanceNote,
    ...(Array.isArray(event?.sourceAudiences) ? event.sourceAudiences : []),
  ].filter(Boolean).join(" ");
}

function splitSentences(text) {
  const parts = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?]+(?:\s+|$)/g)) {
    parts.push({ start, end: m.index + m[0].length });
    start = m.index + m[0].length;
  }
  if (start < text.length) parts.push({ start, end: text.length });
  return parts;
}

// Attribute a claim to this event only when the sentence carrying it refers to
// the event. The 2026-09-09 intro packed three events into one sentence, so
// validating every claim in a string against every event it mentions would
// blank copy that was right about a different one. Single-sentence copy (a
// card blurb) is about its own event by construction.
function claimAppliesToEvent(copy, index, event) {
  const sentences = splitSentences(copy);
  if (sentences.length < 2) return true;
  const sentence = sentences.find((s) => index >= s.start && index < s.end);
  return !sentence || copyMentionsEvent(copy.slice(sentence.start, sentence.end), event);
}

const AGE_CLAIM_PATTERNS = [
  { re: /\bages?\s+(\d{1,2})\s*(?:[-–—]|to|through|thru)\s*(\d{1,2})\b/gi, open: false },
  { re: /\bages?\s+(\d{1,2})\s*\+/gi, open: true },
  { re: /\bages?\s+(\d{1,2})\s+(?:and|&)\s+(?:up|older|over)\b/gi, open: true },
];

function ageClaims(text) {
  const claims = [];
  for (const { re, open } of AGE_CLAIM_PATTERNS) {
    for (const m of String(text || "").matchAll(re)) {
      claims.push({ lo: Number(m[1]), hi: open ? null : Number(m[2]), index: m.index });
    }
  }
  return claims;
}

// The widest span the source itself vouches for. SJPL publishes several at
// once — a BiblioCommons audience tag ("Young Children, ages 0-5"), a
// recommended span ("ages 2 – 6"), and per-session gates ("(ages 3-8)") — and
// any of them can be the one a sentence is quoting, so they are unioned rather
// than required to agree.
function ageBounds(claims) {
  if (!claims.length) return null;
  return {
    lo: Math.min(...claims.map((c) => c.lo)),
    hi: claims.some((c) => c.hi === null) ? null : Math.max(...claims.map((c) => c.hi)),
  };
}

function ageClaimSupported(claim, bounds) {
  if (!bounds || claim.lo < bounds.lo) return false;
  if (bounds.hi === null) return true;
  return claim.hi !== null && claim.hi <= bounds.hi;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ORDINALS = { "1st": 1, first: 1, "2nd": 2, second: 2, "3rd": 3, third: 3, "4th": 4, fourth: 4, "5th": 5, fifth: 5 };

// A series that runs a different activity each session publishes its WHOLE
// schedule on every occurrence, in one of two shapes:
//   "2nd Wednesday: Superhero Obstacle Course (ages 3-8)"   (ordinal weekday)
//   "Thursday, September 10: Bug headbands"                 (calendar date)
// Both mean a reader on one date must be told that date's activity and no
// other. The Craft Tuesdays & Thursdays corrections above exist because a
// cached blurb advertised the previous session's craft; this parser makes that
// failure detectable from the source instead of by hand-entry.
const ROTATION_MARKER = new RegExp(
  String.raw`\b(?:(1st|2nd|3rd|4th|5th|first|second|third|fourth|fifth)\s+(${WEEKDAYS.join("|")})`
    + String.raw`|(?:(?:${WEEKDAYS.join("|")}),?\s+)?(${MONTHS.join("|")})\s+(\d{1,2}))\s*:\s+`,
  "gi",
);
// Where a schedule stops and the program's standing notes begin.
const ROTATION_TRAILER = /\b(?:free|recommended|registration|please|supplies|space is|all ages|this program|no registration)\b/i;

function parseSessionRotation(source) {
  const text = String(source || "");
  const markers = [...text.matchAll(ROTATION_MARKER)];
  // One marker is a date mentioned in passing; a rotation is a list.
  if (markers.length < 2) return [];
  return markers.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    let activity = text.slice(start, end);
    const trailer = activity.search(ROTATION_TRAILER);
    if (trailer >= 0) activity = activity.slice(0, trailer);
    return {
      ordinal: m[1] ? ORDINALS[m[1].toLowerCase()] : null,
      weekday: m[2] ? WEEKDAYS.indexOf(m[2].toLowerCase()) : null,
      month: m[3] ? MONTHS.indexOf(m[3].toLowerCase()) + 1 : null,
      day: m[4] ? Number(m[4]) : null,
      // Parentheticals carry the per-session age gate, which is checked as an
      // age claim in its own right, not as part of the activity's name.
      activity: activity.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim(),
    };
  }).filter((entry) => entry.activity);
}

/**
 * The scheduled activity for this event's OWN date, or "" when the source
 * publishes no rotation (or publishes one keyed to a different weekday than
 * the occurrence, which is a mismatch we decline to guess at).
 *
 * September 2026's Wednesdays are 2/9/16/23/30, so Sept 9 is the 2nd
 * Wednesday: "Superhero Obstacle Course".
 */
export function rotationActivityForOccurrence(event) {
  return rotationEntryForOccurrence(event)?.activity || "";
}

function rotationEntryForOccurrence(event) {
  const rotation = parseSessionRotation(sourceText(event));
  if (!rotation.length) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(event?.date || ""));
  if (!parts) return null;
  const [year, month, day] = parts.slice(1).map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const ordinal = Math.ceil(day / 7);
  return rotation.find((entry) => (entry.ordinal !== null
    ? entry.ordinal === ordinal && entry.weekday === weekday
    : entry.month === month && entry.day === day)) || null;
}

// "this week's playdate is the superhero obstacle course for ages 3 to 8" —
// subject captured separately so the claim can be tied to the event's own head
// noun. "this week's plan is a great one" is editorial voice, not a fact.
const SESSION_ACTIVITY_RE = /\bthis\s+(?:week|month)['’]?s\s+([\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,2}?)\s+(?:is|will\s+be)\s+(?:the\s+|an?\s+)?([^.;,()]{3,60})/giu;
const ACTIVITY_TAIL = /\s+\b(?:for|at|on|in|with|from|starting|beginning)\b.*$/i;

/**
 * Validate source claims, not the model's earlier blurb. Empty/truncated
 * descriptions are not permission to invent whether an act is a cover band,
 * who a program is for, or which week's activity a reader will find.
 */
export function eventCopyFactConflict(text, event) {
  const copy = String(text || "");
  const source = sourceText(event);
  if (/\b(?:cover|tribute)[\s-]+(?:bands?|acts?|groups?|artists?)\b/i.test(copy)
      && !/\b(?:cover|tribute)\b/i.test(source)) return "unsupported cover/tribute identity";
  if (/\b(?:original|founding)\s+(?:members?|vocalists?|singers?|lineup)\b/i.test(copy)
      && !/\b(?:original|founding)\s+(?:members?|vocalists?|singers?|lineup)\b/i.test(source)) {
    return "unsupported original-member identity";
  }
  if (/\bbanda\b/i.test(copy) && !/\bbanda\b/i.test(source)) return "unsupported banda genre";

  const bounds = ageBounds(ageClaims(source));
  for (const claim of ageClaims(copy)) {
    if (!claimAppliesToEvent(copy, claim.index, event)) continue;
    if (!ageClaimSupported(claim, bounds)) return "unsupported age range";
  }

  const head = titleHeadNoun(String(event?.rawTitle || event?.title || "").split(/\s[–—-]\s/)[0]);
  const scheduled = comparable(rotationActivityForOccurrence(event));
  const normalizedCopy = comparable(copy);
  const normalizedSource = comparable(source);
  for (const m of copy.matchAll(SESSION_ACTIVITY_RE)) {
    if (!claimAppliesToEvent(copy, m.index, event)) continue;
    // The claim has to be ABOUT this event: "this week's playdate is …" for a
    // playdate, not "this week's lineup is …" borrowed from a neighbouring
    // sentence.
    if (!head || !comparable(m[1]).split(" ").some((token) => singular(token) === head)) continue;
    const named = comparable(m[2].replace(ACTIVITY_TAIL, ""));
    if (named.length < 6 || !named.includes(" ")) continue;
    if (!normalizedSource.includes(named)) return "unsupported session activity";
    if (scheduled && !scheduled.includes(named) && !named.includes(scheduled)) {
      return "another session's rotation activity";
    }
  }

  // The same wrong-week claim without the "this week's X is Y" frame: naming a
  // rotation entry that belongs to a different session, and only that one.
  if (scheduled) {
    const strays = parseSessionRotation(source)
      .map((entry) => comparable(entry.activity))
      .filter((activity) => activity.length >= 6 && activity.includes(" ")
        && !scheduled.includes(activity) && normalizedCopy.includes(activity));
    if (strays.length && !normalizedCopy.includes(scheduled)) return "another session's rotation activity";
  }
  return null;
}
