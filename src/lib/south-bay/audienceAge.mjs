// ---------------------------------------------------------------------------
// audienceAge — classify events as "kids" | "adult" | "all" from title+desc.
//
// Tag applied at ingest time (generate-events.mjs). Plan-day reads the tag
// at candidate-pool time to exclude kids-only events from adult plans and
// adults-only events from kids plans. "all" is the default and hits both.
//
// Bias is CONSERVATIVE — only strong, unambiguous signals trigger "kids" or
// "adult". Everything else stays "all". The goal is to kill obvious
// mismatches ("Kids Knitting" in an adult plan, "Wine Tasting" in a kids
// plan) without dropping mixed events that genuinely work for both.
//
// Note: brewpubs, bars, and breweries are NOT adult-only by default — many
// serve food and welcome families. Only the EVENT itself being 21+/drag/etc.
// flips the tag to "adult". Same for "kids" — a community event that says
// "kids welcome" is still "all", not "kids".
// ---------------------------------------------------------------------------

// Strong kids-only signals: explicit age ranges, preschool/toddler, story
// time, puppet shows, "kids [activity]" patterns. Note: "kids" alone is NOT
// enough — "Family Day: Kids Welcome" should stay "all".
//
// Age digits are bounded by three ranges, each pinning a different leakage class:
//   - KIDS_AGE (0-17): kid territory. Used for the bare "ages 5" and the lower
//     bound of "ages X-Y" — anything ≥18 is not a kid.
//   - KIDS_AGE_RANGE_UPPER (0-18): allows the upper bound of "ages 13-18" to
//     match (HS senior caps at 18). Tighter than 17 would untag legitimate teen
//     programs whose range stops at 18; wider would let "ages 5-25" leak in.
//   - KIDS_AGE_OPEN (0-12): the open-ended forms "ages X+" and "ages X and up"
//     have no upper bound, so "ages 13+" / "ages 13 and up" are ambiguous — an
//     open mic that says "all levels and ages 13+" welcomes adults. Capping at
//     12 confines the open form to true kid-program copy ("ages 5+ welcome").
//
// Before these bounds, "ages 50+" (senior events) and "ages 18-65" (adult
// forums) silently triggered kids; "ages 13+" on an open mic falsely tagged it
// kids; and "ages 12 to 25" (young-adult book clubs) matched on the lower bound
// alone because the upper escaped the range pattern.
const KIDS_AGE = "(?:\\d|1[0-7])";
const KIDS_AGE_RANGE_UPPER = "(?:\\d|1[0-8])";
const KIDS_AGE_OPEN = "(?:\\d|1[0-2])";
const KIDS_SIGNALS = [
  /\btoddlers?\b/i,
  /\bpreschool(?:er)?s?\b/i,
  /\bstory ?times?\b/i,
  /\bbedtime stor(?:y|ies)\b/i,
  /\bpuppet\s+shows?\b/i,
  new RegExp(`\\bages?\\s+${KIDS_AGE}\\s*[-–]\\s*${KIDS_AGE_RANGE_UPPER}\\b`, "i"),       // "ages 2-5", "ages 13-18"
  new RegExp(`\\bages?\\s+${KIDS_AGE}\\s+to\\s+${KIDS_AGE_RANGE_UPPER}\\b`, "i"),         // "ages 12 to 17"
  new RegExp(`\\bages?\\s+${KIDS_AGE_OPEN}\\s*(?:and|&)\\s*(?:up|under|older)\\b`, "i"), // "ages 5 and up" (≤12)
  new RegExp(`\\bages?\\s+${KIDS_AGE_OPEN}\\+`, "i"),                                    // "ages 5+" (≤12)
  // Bare "ages 5" — only fires when not part of a range or open-ended form
  // already handled above; otherwise it would match the lower bound of
  // "ages 12 to 25" and tag young-adult book clubs as kids.
  new RegExp(`\\bages?\\s+${KIDS_AGE}\\b(?!\\s*[-–]|\\s+to\\s+\\d|\\s*\\+|\\s*(?:and|&)\\s*(?:up|under|older))`, "i"),
  /\bkid'?s?\s+(?:knitting|craft|art|yoga|cooking|science|club|camp|hour|music|dance|story|story time|book club)\b/i,
  /\bkids'?\s+only\b/i,
  /\bchildren's\s+(?:story|hour|craft|music|book club|program)\b/i,
  /\bkindergart(?:en|ner)s?\b/i,
  /\bgrades?\s+(?:k|pre-k|\d)\b/i,
  /\belementary(?:-school| school)?\b/i,
  /\b(?:teen|tween)s?\s+(?:night|club|hangout|meetup|program|lounge)\b/i,
  /\btots?\b(?:\s+(?:club|hour|story|storytime|time))/i,  // "tots" alone could be false positive
];

// Strong adult-only signals: explicit age gates, adult-theme events.
// Bar/brewery venue alone does NOT trigger this.
const ADULT_SIGNALS = [
  // No trailing \b after \+ — "+" is non-word and is always followed by non-word
  // (space/punct/EOL) in real copy, so \b\+\b would silently miss every "21+".
  /\b21\s*\+/,
  /\b18\s*\+/,
  /\b21\s*(?:and|&)\s*over\b/i,
  /\b18\s*(?:and|&)\s*over\b/i,
  /\badults?\s+only\b/i,
  /\bno\s+minors\b/i,
  /\bspeakeas(?:y|ies)\b/i,
  /\bburlesque\b/i,
  /\bdrag\s+(?:show|brunch|queen|bingo|night)\b/i,
  /\bwine\s+(?:tasting|pairing|dinner|walk|stroll|flight)\b/i,
  /\bcocktail\s+(?:class|hour|making|tasting|pairing)\b/i,
  /\bspirits?\s+tasting\b/i,
  /\bwhisk(?:e)?y\s+(?:tasting|pairing|flight|dinner)\b/i,
  /\bbeer\s+(?:tasting|pairing|dinner)\b/i,
  /\bsake\s+tasting\b/i,
  /\bcannabis\b/i,
  /\bhookah\b/i,
  /\bsingles\s+(?:mixer|night|event)\b/i,
  /\bspeed\s+dating\b/i,
];

/**
 * Classify an event's audience age.
 *   - "kids"  — kids-only (story time, age-specific, etc.)
 *   - "adult" — adults-only (21+, drag, wine tasting)
 *   - "all"   — mixed / family-friendly / no strong signal (default)
 */
// Phrases that mention kid ages but describe a service for the parents'
// kids, NOT the event audience — e.g. adult community forums advertise
// "childcare available for ages 4+". Stripped before kids classification so
// they don't trigger the "ages X+" signal.
const NON_AUDIENCE_AGE_PHRASES = [
  /\bchildcare\s+(?:available|provided|offered|on[-\s]site)?\s*for\s+ages?\s+\d{1,2}\+?/gi,
  /\bbabysit(?:ting|ter)\s+(?:available|provided)?\s*for\s+ages?\s+\d{1,2}\+?/gi,
];

// Title-only kid signals — "X for Kids/Children" pattern where the title
// ENDS with the kid audience tag. Title-restricted because descriptions
// commonly say "great for kids and adults" or "programs for kids in need"
// which shouldn't flip a mixed-audience event to kids-only.
const KIDS_TITLE_SIGNALS = [
  /\bfor\s+(?:school[-\s]age\s+)?(?:kids?|children|toddlers|preschoolers)\b\s*(?:[!.\)]+\s*)?$/i,
];

export function classifyAudienceAge(event) {
  // Structured library audience labels are the program's intended audience.
  // Prose may discuss families or childcare without inviting those audiences.
  const labels = (event.sourceAudiences || []).map((label) => String(label));
  const sourceKids = labels.some((label) => /\b(?:kids?|children|teens?|tweens?|babies|toddlers?|preschool|elementary)\b/i.test(label)
    || KIDS_SIGNALS.some((pattern) => pattern.test(label)));
  const sourceAdults = labels.some((label) => /\b(?:adults?|seniors?)\b/i.test(label));
  const sourceAll = labels.some((label) => /\b(?:all ages|everyone|famil(?:y|ies))\b/i.test(label));
  if (sourceAll || (sourceKids && sourceAdults)) return "all";
  if (sourceKids) return "kids";
  if (sourceAdults) return "adult";

  const title = String(event.title || "");
  const desc = String(event.description || "").slice(0, 400);
  let hay = `${title}\n${desc}`;
  for (const r of NON_AUDIENCE_AGE_PHRASES) hay = hay.replace(r, "");

  const isKids =
    KIDS_SIGNALS.some((r) => r.test(hay)) ||
    KIDS_TITLE_SIGNALS.some((r) => r.test(title));
  const isAdult = ADULT_SIGNALS.some((r) => r.test(hay));

  // If both patterns hit (rare — e.g. "family wine walk" or "kids welcome at
  // the drag brunch"), prefer "all" — too ambiguous to hard-exclude.
  if (isKids && isAdult) return "all";
  if (isKids) return "kids";
  if (isAdult) return "adult";
  return "all";
}
