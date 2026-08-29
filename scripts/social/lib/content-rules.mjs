// ---------------------------------------------------------------------------
// content-rules.mjs — single source of truth for geography + virtual + acronym
// patterns shared across the content pipeline.
//
// Importers:
//   - scripts/audit-places.mjs
//   - scripts/validate-places.mjs
//   - scripts/audit-events.mjs
//   - scripts/social/lib/post-gen-review.mjs
//   - scripts/generate-events.mjs (for the normalization step at the tail)
//
// TypeScript counterparts (src/pages/api/plan-day.ts, src/lib/south-bay/*)
// keep their own inline copies for now — update both when adding a rule.
// ---------------------------------------------------------------------------

// 11 in-area cities + curated out-of-area slugs used for hand-picked POIs and
// regional events (santa-cruz day-trip landmarks, santa-clara-county events).
// A place/event slug matches when ANY of the slug's tokens appears in the
// address (case-insensitively).
export const SLUG_TO_CITY_TOKENS = {
  campbell: ["campbell"],
  cupertino: ["cupertino"],
  "los-altos": ["los altos", "los altos hills"],
  "los-gatos": ["los gatos", "monte sereno"],
  milpitas: ["milpitas"],
  "mountain-view": ["mountain view"],
  "palo-alto": ["palo alto", "stanford"],
  "san-jose": ["san jose", "san josé"],
  "santa-clara": ["santa clara"],
  saratoga: ["saratoga"],
  sunnyvale: ["sunnyvale"],
  // Curated out-of-area slugs — allowed for hand-picked landmarks/events only.
  "santa-cruz": ["santa cruz", "felton", "capitola"],
  "santa-clara-county": ["santa clara county"],
};

// Human-readable names for the 11 cities (lowercase tokens).
export const IN_AREA_CITIES = new Set([
  "san jose", "santa clara", "sunnyvale", "mountain view", "palo alto",
  "los altos", "cupertino", "campbell", "los gatos", "saratoga", "milpitas",
]);

// Bay Area + neighboring cities that shouldn't anchor an in-area event.
// Used by post-gen-review and audit-events to hard-block leakage.
export const OUT_OF_AREA_CITIES = [
  "santa cruz", "oakland", "berkeley", "san francisco", "hayward",
  "fremont", "union city", "daly city", "san mateo", "redwood city",
  "menlo park", "walnut creek", "concord", "monterey", "capitola",
  "half moon bay", "gilroy", "morgan hill", "watsonville",
];

// Venues on the border of the coverage area that we allow to ship as in-area
// even though their address falls in an OUT_OF_AREA_CITIES city. These pass
// the editorial bar (cultural quality, Stephen-approved) and functionally
// serve the coverage area.
// Matched case-insensitively against venue/title/name strings.
export const BORDER_VENUE_ALLOWLIST = [
  "kepler's books", // 1010 El Camino Real, Menlo Park → slugged palo-alto
  "keplers books",  // apostrophe-dropped variant
];

export function isBorderAllowedVenue(slot) {
  const fields = [
    slot?.item?.venue,
    slot?.item?.title,
    slot?.item?.name,
    slot?.venue,
    slot?.title,
    slot?.name,
  ].filter(Boolean).map((s) => String(s).toLowerCase()).join(" | ");
  if (!fields) return false;
  return BORDER_VENUE_ALLOWLIST.some((needle) => fields.includes(needle));
}

// Non-CA US state codes — appearing in an address is always a contamination
// signal for a place tagged as in-area.
export const NON_CA_STATES = new Set([
  "AK","AL","AR","AZ","CO","CT","DC","DE","FL","GA","HI","IA","ID","IL","IN",
  "KS","KY","LA","MA","MD","ME","MI","MN","MO","MS","MT","NC","ND","NE","NH",
  "NJ","NM","NV","NY","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VA",
  "VT","WA","WI","WV","WY",
]);

// Non-US country tokens that might show up at the end of an address.
export const NON_US_COUNTRIES = [
  "Canada", "Mexico", "United Kingdom", "UK", "Australia", "India", "Japan",
  "China", "France", "Germany", "Italy", "Spain", "Brazil",
];

// Strong virtual signals — if any fires on a title or a structured address,
// the event is treated as virtual-only (never a day-plan stop, never a
// tonight-pick).
export const VIRTUAL_TITLE_SIGNALS = [
  /^online[:\s-]/i,
  /^virtual[:\s-]/i,
  /^\[online\]/i,
  /^\[virtual\]/i,
  /\bwebinar\b/i,
  /\blivestream\b/i,
];

export const VIRTUAL_ADDRESS_SIGNALS = [
  /^\s*(online|virtual|zoom|webex|teams)\b/i,
  /\bzoom link\b/i,
];

// Post-hoc text checks (used by post-gen-review when the flag wasn't set
// upstream). Broader than the title/address scans above — looks at the whole
// slot text.
export const VIRTUAL_SIGNALS = [
  /\bvirtual(ly)?\b/i,
  /\bonline\b/i,
  /\bzoom\b/i,
  /\blivestream/i,
  /\bwebinar\b/i,
  /\bdial[- ]?in\b/i,
  /\bremote\b/i,
];

// Title patterns that mean the event is a meeting/gov hearing, not a public
// activity. Used by generate-events.mjs + plan-day.ts + audit-events.mjs to
// filter out commission/committee meetings that leak into event feeds.
export const MEETING_TITLE_PATTERNS = [
  /\bcommission\s+meeting\b/i,
  /\bregular\s+meeting\b/i,
  /\bspecial\s+meeting\b/i,
  /\bsubcommittee\b/i,
  /\bstudy\s+session\b/i,
  /\bcity\s+council\s+meeting\b/i,
  /\bplanning\s+commission\b/i,
  /\btown\s+council\b/i,
  /\bbudget\s+hearing\b/i,
  /\bboard of supervisors\b/i,
];

// Acronyms we want enforced in titles/blurbs regardless of source casing.
// Applied at generate-events tail and whenever downstream text flows through
// applyTerminologyFixes.
export const ACRONYM_FIXES = [
  ["AIDS", /\b(Aids|aids)\b/g],
  ["HIV", /\b(Hiv|hiv)\b/g],
  ["COVID", /\b(Covid|covid)\b/g],
  ["DMV", /\b(Dmv|dmv)\b/g],
  ["CPR", /\b(Cpr|cpr)\b/g],
  ["DIY", /\b(Diy|diy)\b/g],
  ["LGBTQ", /\b(Lgbtq|lgbtq)\b/g],
  ["NASA", /\b(Nasa|nasa)\b/g],
  ["CCC", /\b(Ccc|ccc)\b/g],
  ["KCAT", /\b(Kcat|kcat)\b/g],
];

// ---------------------------------------------------------------------------
// Editorial voice — downbeat day language
// ---------------------------------------------------------------------------
// CLAUDE.md: "never describe a day or part of a day as quiet, slow, thin,
// light, sparse, sleepy, soft, or weak. South Bay Today should skew optimistic
// about its data: there is always something useful to do."
//
// The newsletter had the only implementation of this rule, private to
// scripts/newsletter/lib.mjs, and its day vocabulary omitted "weekend" and
// "week" — so a weekend claim sailed past it. That hole is why the Palo Alto
// city briefing shipped "Palo Alto's weekend leans quiet and communal."
// Shared here so every generator checks the same rule against the same words.
export const DAY_CONTEXT_WORDS = [
  "today", "tonight", "day", "calendar", "lineup", "morning", "daytime", "afternoon", "evening",
  "weekend", "week",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];
export const DAY_CONTEXT = `(?:this\\s+)?(?:the\\s+)?(?:${DAY_CONTEXT_WORDS.join("|")})`;
export const DOWNBEAT_DAY_LANGUAGE =
  "(?:quiet|quieter|quietest|slow|slower|slowest|thin|thinner|thinnest|light|lighter|lightest|sparse|sparser|sparsest|sleepy|soft|weak)";

/**
 * True when text describes a day (or week/weekend) as downbeat — either
 * "<day> ... <term>" within a clause, or "<term> <day>" directly.
 */
export function hasDownbeatDayLanguage(value) {
  const text = String(value || "");
  const dayThenTerm = new RegExp(`\\b${DAY_CONTEXT}\\b[^.!?]{0,80}\\b${DOWNBEAT_DAY_LANGUAGE}\\b`, "i");
  const termThenDay = new RegExp(`\\b${DOWNBEAT_DAY_LANGUAGE}\\s+${DAY_CONTEXT}\\b`, "i");
  return dayThenTerm.test(text) || termThenDay.test(text);
}

/**
 * Relative day references ("today", "tonight", "tomorrow") in copy that is
 * cached and re-read for days after it was written.
 *
 * The city briefings are generated on one clock and served until the next run,
 * so a baked-in "today" silently retargets when the date rolls: the 2026-08-29
 * file described Friday's Herbal Tea Party at Gamble Garden as happening
 * "today" and Friday's Montalvo play as "tonight", both written the previous
 * evening. The Saratoga sentence even said "tonight" and "on Friday" about the
 * same night. The day names are already in the source data, so naming the day
 * costs nothing and survives the rollover.
 *
 * Deliberately NOT applied to the newsletter: that is sent once, read the
 * morning it lands, and "Tonight's Pick" is one of its named sections.
 */
export function hasRelativeDayReference(value) {
  return /\b(today|tonight|tomorrow|yesterday|this\s+(?:morning|afternoon|evening))\b/i.test(
    String(value || ""),
  );
}
