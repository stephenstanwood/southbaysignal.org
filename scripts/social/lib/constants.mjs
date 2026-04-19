// ---------------------------------------------------------------------------
// South Bay Today — Social Posting Configuration
// ---------------------------------------------------------------------------

export const CONFIG = {
  DRY_RUN: false,
  PLATFORMS: { x: true, threads: true, bluesky: true, facebook: true, mastodon: true, instagram: true },
  // Content slot types for the 3-post-per-day strategy
  SLOT_TYPES: { "day-plan": true, "tonight-pick": true, "wildcard": true },
  // Legacy format flags (kept for backward compat during transition)
  FORMATS: { daily_pulse: true, tonight: true, weekend: true, civic: true },
  THRESHOLDS: { daily_pulse: 40, tonight: 35, weekend: 60, civic: 50 },
  SCHEDULE_FILE: "src/data/south-bay/social-schedule.json",
  BLACKLIST_FILE: "src/data/south-bay/social-blacklist.json",
  HISTORY_FILE: "src/data/south-bay/social-post-history.json",
  HISTORY_RETENTION_DAYS: 30,
  CARD_OUTPUT_DIR: "/tmp/sbs-social-cards",
  SBS_BASE_URL: "https://southbaytoday.org",
};

// Haiku for cheap bulk work: classifier, fact-check, editorial filter, reply triage.
export const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

// Sonnet for user-facing copy generation (day-plan social posts, tonight picks,
// wildcards, restaurant opening blurbs). Haiku produced noticeably blander copy
// on these and they're the thing Stephen is reviewing — worth the extra cost.
export const CLAUDE_COPY_MODEL = "claude-sonnet-4-6";

// Scoring weights
export const SCORE_WEIGHTS = {
  localRelevance: { max: 5 },
  timeliness: { max: 5 },
  usefulness: { max: 5 },
  novelty: { max: 4 },
  specificity: { max: 3 },
  publicAppeal: { max: 3 },
  sourceConfidence: { max: 3 },
};

// Scoring penalties
export const SCORE_PENALTIES = {
  recentDuplicate: -8,
  sameVenueThisWeek: -4,
  sameCategorySaturation: -3,
  staleItem: -5,
  adminNoise: -10,
  weakSummary: -3,
};

// Diversity constraints
export const DIVERSITY = {
  maxSameCity: 2,
  maxSameCategory: 2,
  minUniqueCities: 2,
};

// Category mapping for normalization
export const CATEGORY_MAP = {
  arts: "arts",
  music: "arts",
  community: "community",
  market: "community",
  family: "community",
  sports: "sports",
  outdoor: "outdoor",
  education: "education",
  food: "food",
  civic: "civic",
  council: "civic",
  permit: "civic",
  development: "development",
  transit: "transit",
};

// City display names
export const CITY_NAMES = {
  "san-jose": "San Jose",
  campbell: "Campbell",
  "los-gatos": "Los Gatos",
  saratoga: "Saratoga",
  cupertino: "Cupertino",
  sunnyvale: "Sunnyvale",
  "mountain-view": "Mountain View",
  "palo-alto": "Palo Alto",
  "santa-clara": "Santa Clara",
  "los-altos": "Los Altos",
  milpitas: "Milpitas",
};

// Admin noise keywords (items containing these get penalized)
export const ADMIN_NOISE = [
  "minutes approved",
  "roll call",
  "adjournment",
  "consent calendar",
  "proclamation",
  "closed session",
  "ceremonial",
  "flag salute",
];

// Polarizing/political keywords — hard block from social posting
export const POLITICAL_BLOCK = [
  "ice raid",
  "immigration enforcement",
  "federal budget cut",
  "deportation",
  "partisan",
  "recall election",
  "impeach",
  "political rally",
  "protest march",
  "defund",
];

// Internal/non-public event signals — heavy penalty
export const INTERNAL_EVENT_SIGNALS = [
  "youth commission",
  "student government",
  "faculty meeting",
  "staff meeting",
  "pay day",
  "payroll",
  "employee",
  "internal",
  "off-campus living",
  "wellness center",
  "residence hall",
  "resident advisor",
  "dining hall",
  "meal plan",
  "orientation",
  "office hours",
  "campus ministry",
  "campus-ministry",
  "student mass",
  "daily mass",
  "sunday mass",
  "eucharist",
  "liturgy",
  "mission santa clara",
  "student org",
  "sorority",
  "fraternity",
  "rush week",
  "alumni reception",
  "presidential reception",
  "alumni for others",
  "admitted students",
  "prospective students",
  "commencement rehearsal",
  "living with ocd",
  "support group",
  "counseling",
  "therapy group",
];

// SBS tab URLs for CTAs (hash-based routing with full tab IDs)
export const TAB_URLS = {
  today: "/",
  plan: "/#plan",
  events: "/#events",
  camps: "/#camps",
  government: "/#government",
  technology: "/#technology",
  development: "/#development",
  food: "/#food",
  transit: "/#transit",
  weather: "/#weather",
  sports: "/#sports",
};
