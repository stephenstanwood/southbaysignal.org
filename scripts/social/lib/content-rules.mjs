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

// 11 cities in the South Bay Today coverage map → canonical address tokens.
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
];
