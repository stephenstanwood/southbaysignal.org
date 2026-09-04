// ---------------------------------------------------------------------------
// eventFuzzyDedup.mjs
// ---------------------------------------------------------------------------
// Fallback cross-source dedup that catches near-duplicate events the exact
// (title|date|venue) key in generate-events.mjs misses. Two sources often
// surface the same event with slightly different titles, organizer prefixes,
// or venue strings: "LGPNS Big Truck Day" / "Big Truck Day", "Curator-led
// Tours: …" / "Curator-led tours: …", "SJZ Break Room Jazz Jam Ft. X" /
// "Jazz Jam Ft. X". This pass groups by date+city and collapses pairs whose
// titles are subsets (or jaccard ≥ 0.85) AND share either start time
// (within 30 min) or venue tokens (jaccard ≥ 0.4).
//
// Token comparison tolerates a single-character typo on long words, and when
// two events already share a venue the venue's own name is stripped from both
// titles before matching — a ticketing feed stamps it on ("Hammer Presents
// `X`") where the institutional calendar doesn't. The survivor is chosen by
// occurrence evidence, then URL authority (a .edu/.gov event page beats a
// bare forms.gle RSVP link), then richness.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "by", "from",
  "and", "or", "vs", "versus", "presents", "present", "featuring", "ft", "feat",
  "amp", "s",
]);

function tokenize(s) {
  if (!s) return new Set();
  const out = new Set();
  for (const w of String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)) {
    if (!w || STOP_WORDS.has(w)) continue;
    // Keep all numeric tokens (age ranges, grade levels, years, edition numbers
    // distinguish otherwise-identical titles like "Chess Grades 1-5" vs "6-8").
    // Drop only short alpha-only tokens.
    if (w.length < 2 && !/\d/.test(w)) continue;
    out.add(w);
  }
  return out;
}

// Levenshtein distance, bailed out early once it exceeds `max`. Only ever
// called on short title tokens, so the full matrix is unnecessary.
function withinEditDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

// Two title tokens are "the same word" when they differ by a single typo.
// Deliberately narrow: both tokens alpha-only, ≥6 chars, sharing a 3-char
// prefix. That catches real scraper typos ("Texturscape" for "Texturescape",
// D194) without collapsing short distinct words ("tour"/"tours") or numeric
// tokens, which encode grade bands and age ranges that must stay distinct.
function sameWord(a, b) {
  if (a === b) return true;
  if (a.length < 6 || b.length < 6) return false;
  if (!/^[a-z]+$/.test(a) || !/^[a-z]+$/.test(b)) return false;
  if (a.slice(0, 3) !== b.slice(0, 3)) return false;
  return withinEditDistance(a, b, 1);
}

function hasWord(set, word) {
  if (set.has(word)) return true;
  for (const w of set) if (sameWord(w, word)) return true;
  return false;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  // One-to-one pairing: a token in `b` can only be claimed once, so two
  // near-identical tokens on one side can't both match it and push the
  // intersection above the smaller set's size.
  const claimed = new Set();
  let inter = 0;
  for (const w of a) {
    if (b.has(w) && !claimed.has(w)) { claimed.add(w); inter++; continue; }
    for (const c of b) {
      if (claimed.has(c) || !sameWord(c, w)) continue;
      claimed.add(c);
      inter++;
      break;
    }
  }
  return inter / (a.size + b.size - inter);
}

function isSubsetOf(a, b) {
  if (a.size === 0) return false;
  for (const w of a) if (!hasWord(b, w)) return false;
  return true;
}

// Drop venue words from a title's token set. A ticketing feed routinely
// stamps its own venue onto every title ("Hammer Presents `X`") while the
// institutional calendar doesn't ("Opening Reception - X"). Once we've
// already established both events are at the same venue, those tokens carry
// no distinguishing signal — they just drag jaccard below threshold.
function stripVenueTokens(titleTokens, venueTokens) {
  if (venueTokens.size === 0) return titleTokens;
  const out = new Set();
  for (const w of titleTokens) if (!hasWord(venueTokens, w)) out.add(w);
  return out;
}

function parseTimeMin(t) {
  if (!t) return null;
  const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + parseInt(m[2], 10);
}

// Case-insensitive, whitespace-trimmed exact title match — used for the
// certain-duplicate fast path below (distinct from the fuzzy subset/jaccard
// title match used elsewhere in this module).
function sameTitle(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function titleWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
}

function sharesTitleAnchor(a, b, length = 3) {
  const left = titleWords(a);
  const right = titleWords(b);
  if (left.length < length || right.length < length) return false;
  const rightPhrases = new Set();
  for (let i = 0; i <= right.length - length; i++) {
    rightPhrases.add(right.slice(i, i + length).join(" "));
  }
  for (let i = 0; i <= left.length - length; i++) {
    if (rightPhrases.has(left.slice(i, i + length).join(" "))) return true;
  }
  return false;
}

function firstPartyAuthorityScore(event) {
  const evidence = event?.occurrenceEvidence;
  if (
    String(evidence?.kind || "").startsWith("first-party")
    && evidence?.date === event?.date
    && /^https:\/\//i.test(String(evidence?.sourceUrl || ""))
  ) {
    return 100;
  }
  return 0;
}

// Link shorteners and bare form endpoints. These are RSVP/ticket handoffs,
// never a canonical event page — they carry no date, time, price, or
// description a reader (or a later fact-check pass) can verify against.
const NON_EVENT_PAGE_HOST = /(^|\.)(forms\.gle|bit\.ly|tinyurl\.com|t\.co|ow\.ly|lnkd\.in|rebrand\.ly|buff\.ly)$/i;
const FORM_PATH = /^\/forms\//i;

// Institutional publishers — a university or government calendar is the
// system of record for events held at its own venues.
const INSTITUTIONAL_HOST = /\.(edu|gov|mil)$/i;

/**
 * How authoritative this record's URL is as a description of the event.
 *   2 — institutional event page (.edu / .gov)
 *   1 — some other real event page
 *   0 — missing, a link shortener, or a bare form
 * Ranked above richness so a first-party calendar entry beats a ticketing
 * feed's longer blurb; ranked below occurrence evidence, which is stronger.
 */
function urlAuthorityScore(event) {
  const raw = String(event?.url || "").trim();
  if (!raw) return 0;
  let host;
  let path;
  try {
    const u = new URL(raw);
    host = u.hostname;
    path = u.pathname;
  } catch {
    return 0;
  }
  if (NON_EVENT_PAGE_HOST.test(host)) return 0;
  if (FORM_PATH.test(path)) return 0;
  return INSTITUTIONAL_HOST.test(host) ? 2 : 1;
}

// Lexicographic: occurrence evidence, then URL authority, then richness.
// Each tier only breaks a tie the tier above it left open.
function authorityTuple(event) {
  return [
    firstPartyAuthorityScore(event),
    urlAuthorityScore(event),
    richnessScore(event),
  ];
}

/**
 * Sort duplicate candidates strongest-first using the same evidence ladder as
 * fuzzy dedup. The generator's exact date+venue+time pass runs earlier and
 * must not silently choose a different source for the same occurrence.
 */
export function compareDuplicateAuthority(
  e1,
  e2,
  { occurrenceOnly = false, includeRichness = true } = {},
) {
  const a = authorityTuple(e1);
  const b = authorityTuple(e2);
  if (occurrenceOnly && a[0] === 0 && b[0] === 0) return 0;
  const length = includeRichness ? a.length : a.length - 1;
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return 0;
}

function chooseDuplicateToDrop(e1, e2) {
  const comparison = compareDuplicateAuthority(e1, e2);
  if (comparison < 0) return e2;
  if (comparison > 0) return e1;
  return e2;
}

function richnessScore(e) {
  let s = 0;
  if (e.description) s += Math.min(e.description.length / 100, 5);
  if (e.time) s += 2;
  if (e.endTime) s += 1;
  if (e.image || e.photoRef) s += 2;
  if (e.url) s += 3;
  if (e.cost) s += 0.5;
  return s;
}

/**
 * Apply fuzzy cross-source dedup. Returns { kept, droppedCount }.
 * Mutates nothing; produces a new array.
 */
export function fuzzyDedupEvents(events) {
  const groups = new Map();
  for (const e of events) {
    if (!e || !e.date || !e.city || !e.title) continue;
    const k = `${e.date}|${e.city}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  const dropIds = new Set();
  let droppedCount = 0;

  for (const evs of groups.values()) {
    if (evs.length < 2) continue;
    // Sports has its own date+venue dedup upstream; skip to avoid double-handling.
    const candidates = evs.filter((e) => e.category !== "sports");
    for (let i = 0; i < candidates.length; i++) {
      const e1 = candidates[i];
      if (dropIds.has(e1.id)) continue;
      const t1 = tokenize(e1.title);
      const tm1 = parseTimeMin(e1.time);
      const v1 = tokenize(e1.venue);
      for (let j = i + 1; j < candidates.length; j++) {
        const e2 = candidates[j];
        if (dropIds.has(e2.id)) continue;

        // Exact (title, url) match is a certain duplicate — two ingest paths
        // scraping the same organizer feed (e.g. SJMA's direct scraper +
        // the Playwright mirror) can disagree on id shape or time (one
        // resolves a detail-page time, the other defaults to noon), but
        // never disagree on canonical URL. Bypass the same-source time-diff
        // skip and venue-closeness check below — id shape and time proximity
        // don't matter here.
        if (e1.url && e2.url && e1.url === e2.url && sameTitle(e1.title, e2.title)) {
          const drop = chooseDuplicateToDrop(e1, e2);
          dropIds.add(drop.id);
          droppedCount++;
          continue;
        }

        const t2 = tokenize(e2.title);
        const v2 = tokenize(e2.venue);
        const venueClose = jaccard(v1, v2) >= 0.4;
        const hasFirstParty = firstPartyAuthorityScore(e1) > 0 || firstPartyAuthorityScore(e2) > 0;
        let titleMatch = isSubsetOf(t1, t2)
          || isSubsetOf(t2, t1)
          || jaccard(t1, t2) >= 0.85
          // First-party titles are often longer and more formal than an
          // aggregator's rewrite. A shared three-word anchor plus the same
          // date/city/venue is enough only when one record carries dated
          // first-party occurrence evidence.
          || (hasFirstParty && sharesTitleAnchor(e1.title, e2.title));

        // Same venue, same date, and the only thing keeping the titles apart
        // is the venue's own name bleeding into one of them. Retry the match
        // with venue words removed from both sides. Guarded on ≥2 residual
        // tokens each so a title that is *only* the venue name can't subset
        // its way into an unrelated event at the same address. D194:
        // "Hammer Presents `Texturscape` Hammer2 Gallery Opening Reception"
        // vs "Opening Reception - Hammer2 Gallery: Texturescape".
        if (!titleMatch && venueClose) {
          const s1 = stripVenueTokens(t1, v1);
          const s2 = stripVenueTokens(t2, v2);
          if (s1.size >= 2 && s2.size >= 2) {
            titleMatch = isSubsetOf(s1, s2) || isSubsetOf(s2, s1) || jaccard(s1, s2) >= 0.85;
          }
        }
        if (!titleMatch) continue;

        const tm2 = parseTimeMin(e2.time);
        if (e1.source && e1.source === e2.source && tm1 != null && tm2 != null && Math.abs(tm1 - tm2) > 30) {
          continue;
        }
        const timeClose = tm1 != null && tm2 != null && Math.abs(tm1 - tm2) <= 30;
        if (!timeClose && !venueClose) continue;

        const drop = chooseDuplicateToDrop(e1, e2);
        dropIds.add(drop.id);
        droppedCount++;
      }
    }
  }

  if (dropIds.size === 0) {
    return { kept: events.slice(), droppedCount: 0 };
  }
  return {
    kept: events.filter((e) => !e || !e.id || !dropIds.has(e.id)),
    droppedCount,
  };
}
