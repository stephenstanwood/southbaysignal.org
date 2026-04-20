// ---------------------------------------------------------------------------
// South Bay Today — Post-Generation Quality Review
//
// Runs at the tail of batch schedule generation. Catches the kinds of issues
// Stephen surfaced manually during review:
//   - Venue repeats across the week (four Ritz theme nights in 3 weeks)
//   - Same venue on consecutive days (SJSU Music Building Mon + Tue)
//   - Day-of-week in title contradicts slot date ("Monday Night Revels" on Wed)
//   - Day plans with fewer than 5 stops or starting after noon
//   - Broken venue strings ("457" — truncation from Legistar summaries)
//   - Terminology/capitalization typos (aids → AIDS, pandemic → epidemic)
//   - Day-plan cards out of chronological order (defense-in-depth w/ plan-day)
//
// Deterministic fixes are applied in place. Harder issues get their slot
// status reset to "draft" so the caller can re-run the generator for one
// more pass.
// ---------------------------------------------------------------------------

import {
  IN_AREA_CITIES,
  OUT_OF_AREA_CITIES,
  VIRTUAL_SIGNALS,
  isBorderAllowedVenue,
} from "./content-rules.mjs";

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_ALIASES = {
  Sunday: ["sunday", "sun "],
  Monday: ["monday", "mon "],
  Tuesday: ["tuesday", "tue ", "tues"],
  Wednesday: ["wednesday", "wed "],
  Thursday: ["thursday", "thu ", "thurs"],
  Friday: ["friday", "fri "],
  Saturday: ["saturday", "sat "],
};

const TERMINOLOGY_FIXES = [
  // AIDS is always all-caps
  { pattern: /\bAids\b/g, replacement: "AIDS" },
  { pattern: /\baids\b(?!\w)/g, replacement: "AIDS" },
  // "AIDS pandemic" is wrong; correct medical term is "epidemic"
  { pattern: /AIDS pandemic/g, replacement: "AIDS epidemic" },
  // "pandemic history" used loosely for AIDS exhibit context — it's an epidemic
  { pattern: /\bpandemic history\b/gi, replacement: "epidemic history" },
  { pattern: /\bthe pandemic\b(?=[^.]{0,80}\b(AIDS|HIV)\b)/gi, replacement: "the epidemic" },
];

// IN_AREA_CITIES, OUT_OF_AREA_CITIES, VIRTUAL_SIGNALS are imported from
// content-rules.mjs above — shared with audit-events and validate-places.

// Category keywords for saturation checks (spa/massage is noisy right now).
const CATEGORY_KEYWORDS = {
  spa: [/\bspa\b/i, /\bmassage\b/i, /\bsauna\b/i, /\bfacial\b/i, /\bthai massage\b/i],
};

// Tonight-pick titles that often contain these keywords shouldn't be shipped
// — they're not evening-entertainment fare for the tonight slot.
const WEAK_TONIGHT_PATTERNS = [
  /\bwildfire workshop\b/i,
  /\bfire safety\b/i,
  /\breading buddies\b/i,
  /\bstory ?time\b/i,
  /\bkids? craft\b/i,
  /\btoddler\b/i,
  /\bpreschool\b/i,
  /\bhomework help\b/i,
  /\bsupport group\b/i,
  /\bproperty assessment\b/i,
  /\bworkshop\b.*\b(tax|assessment|benefit)\b/i,
  /\b(knit|crochet)\b.*\bcircle\b/i,
  /\b(crystal|singing) bowls?\b/i,
  /\btown council\b/i,
];

// Day-plan card-level bad patterns. Cards matching any of these get SURGICALLY
// REMOVED from the plan (not flagged at plan level). This keeps the good parts
// of a plan and just drops the junk.
const BAD_CARD_TITLE_PATTERNS = [
  /\b(thai )?massage\b/i,
  /\b(day )?spa\b/i,
  /\bacupuncture\b/i,
  /\bsauna\b/i,
  /\bfacial\b/i,
  // niche meetups / practices
  /\bsig\b/i,
  /\bbook club\b/i,
  /\b(knit|crochet) circle\b/i,
  /\bband jam\b/i,
  /\b(dance|music)\s+(practice|rehearsal)\b/i,
  /\brehearsal\b/i,
  /\bsupport group\b/i,
  /\bhomework (help|club)\b/i,
  /\btoddler\b/i,
  /\bpreschool\b/i,
  /\bjunior musical\b/i,
  /\bkindergart?en (play|music)\b/i,
  /\bstory ?time\b/i,
  /\bwednesday meditation\b/i,
  /\bthursday .* meditation\b/i,
  /\bmeditation and mindfulness\b/i,
  // internal commemorations / gov meetings
  /\bcommemoration\b/i,
  /\bregular meeting\b/i,
  /\bcommission meeting\b/i,
  /\bcommittee meeting\b/i,
  /\bstudy session\b/i,
  /\bclass of \d{4} reunion\b/i,
];

const BAD_CARD_VENUE_PATTERNS = [
  /^\d+$/, // truncated number
  /^[a-z]{1,2}$/i, // 1-2 char stub
];

// Evidence that a venue field is truncated / broken data
function venueLooksBroken(venue) {
  if (!venue) return false;
  const s = String(venue).trim();
  if (!s) return false;
  // Pure number (e.g. "457" is the end of an address)
  if (/^\d+$/.test(s)) return true;
  // Very short alphabetic strings
  if (s.length <= 2) return true;
  return false;
}

function parseHour(timeStr) {
  if (!timeStr) return null;
  const lower = String(timeStr).toLowerCase().trim();
  if (lower.includes("noon")) return 12;
  if (lower.includes("midnight")) return 0;
  const ampm = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const isPM = ampm[3] === "pm";
    if (isPM && h !== 12) h += 12;
    if (!isPM && h === 12) h = 0;
    return h;
  }
  const mil = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (mil) return parseInt(mil[1]);
  return null;
}

import { normalizeName } from "./normalizeName.mjs";

// Canonical form for dedup: handles "&" vs "and", curly quotes, and
// punctuation drift so venue-repeat detection and title-repeat detection
// catch Hakone Estate & Gardens vs Hakone Estate and Gardens.
function normalize(s) {
  return normalizeName(s);
}

function allCopyStrings(slot) {
  const copy = slot?.copy;
  if (!copy) return [];
  const out = [];
  for (const [k, v] of Object.entries(copy)) {
    // Handle both flat strings and platform-keyed objects
    if (typeof v === "string") out.push({ platform: k, text: v });
    else if (v && typeof v === "object") {
      // e.g. { default: "...", alt: "..." }
      for (const [kk, vv] of Object.entries(v)) {
        if (typeof vv === "string") out.push({ platform: `${k}.${kk}`, text: vv });
      }
    }
  }
  return out;
}

function applyTerminologyFixes(slot) {
  const copy = slot?.copy;
  if (!copy) return 0;
  let touched = 0;
  for (const [k, v] of Object.entries(copy)) {
    if (typeof v === "string") {
      const fixed = TERMINOLOGY_FIXES.reduce((s, f) => s.replace(f.pattern, f.replacement), v);
      if (fixed !== v) {
        copy[k] = fixed;
        touched++;
      }
    } else if (v && typeof v === "object") {
      for (const [kk, vv] of Object.entries(v)) {
        if (typeof vv === "string") {
          const fixed = TERMINOLOGY_FIXES.reduce((s, f) => s.replace(f.pattern, f.replacement), vv);
          if (fixed !== vv) {
            v[kk] = fixed;
            touched++;
          }
        }
      }
    }
  }
  return touched;
}

function sortDayPlanCards(slot) {
  const cards = slot?.plan?.cards;
  if (!Array.isArray(cards) || cards.length < 2) return false;
  const before = cards.map((c) => c.timeBlock || "").join("|");
  cards.sort((a, b) => {
    const aH = parseHour((a.timeBlock || "").split(/\s*-\s*/)[0]) ?? 99;
    const bH = parseHour((b.timeBlock || "").split(/\s*-\s*/)[0]) ?? 99;
    return aH - bH;
  });
  return cards.map((c) => c.timeBlock || "").join("|") !== before;
}

function dowMismatch(dateStr, copyText) {
  const dow = DOW_NAMES[new Date(dateStr + "T12:00:00").getDay()];
  const text = (copyText || "").toLowerCase();
  for (const [day, aliases] of Object.entries(DOW_ALIASES)) {
    if (day === dow) continue;
    for (const alias of aliases) {
      // Match "Monday Night", "Tuesday evening", etc. — day-of-week used as adjective.
      // `\\s*` between alias and descriptor lets us catch "Sunday afternoon" (space)
      // as well as "Sundaynight" (no space, rare but possible after copy editing).
      const trimmed = alias.trim();
      const re = new RegExp(`\\b${trimmed}\\s*(night|evening|afternoon|morning)\\b`, "i");
      if (re.test(text)) return `title implies ${day} but slot is ${dow}`;
    }
  }
  return null;
}

function outOfArea(slot) {
  // Allowlisted border venues (e.g. Kepler's Books) ship as in-area even
  // though their address falls in an out-of-area city.
  if (isBorderAllowedVenue(slot)) return null;
  // Do NOT scan the summary — third-party references leak through (e.g.
  // "...formerly of the San Francisco Chronicle..." is talking about a
  // speaker's old job, not the event location). Stick to fields that
  // describe the event's actual place.
  const haystack = [
    slot?.item?.venue,
    slot?.item?.title,
    slot?.item?.name,
    slot?.item?.address,
    slot?.item?.city,
    slot?.cityName,
  ].filter(Boolean).map((s) => String(s).toLowerCase()).join(" | ");
  if (!haystack) return null;
  for (const city of OUT_OF_AREA_CITIES) {
    const re = new RegExp(`\\b${city.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(haystack)) return `out-of-area (${city})`;
  }
  return null;
}

function isVirtual(slot) {
  const haystack = [
    slot?.item?.venue,
    slot?.item?.title,
    slot?.item?.name,
    slot?.item?.summary,
  ].filter(Boolean).join(" | ");
  for (const re of VIRTUAL_SIGNALS) if (re.test(haystack)) return "virtual/online event";
  return null;
}

function matchesCategory(text, patterns) {
  if (!text) return false;
  return patterns.some((re) => re.test(text));
}

function countDayPlanCities(slot) {
  const cards = slot?.plan?.cards || [];
  const cities = new Set();
  for (const c of cards) {
    const city = (c.city || c.cityName || "").trim().toLowerCase();
    if (city) cities.add(city);
  }
  return cities.size;
}

function dayPlanHasCategory(slot, patterns) {
  const cards = slot?.plan?.cards || [];
  return cards.some((c) => {
    const text = [c.title, c.name, c.featuredPlace, c.summary, c.blurb].filter(Boolean).join(" | ");
    return matchesCategory(text, patterns);
  });
}

// Remove obviously-bad cards from a day-plan (niche meetups, missing venues,
// internal commemorations). Returns {removed: number, reasons: string[]}.
function pruneBadCards(slot) {
  const cards = slot?.plan?.cards;
  if (!Array.isArray(cards) || cards.length === 0) return { removed: 0, reasons: [] };
  const reasons = [];
  const keep = [];
  for (const c of cards) {
    const title = String(c.title || c.name || "").trim();
    const venue = String(c.venue || c.address || "").trim();
    const badTitle = BAD_CARD_TITLE_PATTERNS.find((re) => re.test(title));
    if (badTitle) {
      reasons.push(`"${title}" (${badTitle})`);
      continue;
    }
    const hasLocation = (c.address && c.address.length > 2) || (c.neighborhood && c.neighborhood.length > 2) || (c.venue && c.venue.length > 2);
    if (!hasLocation) {
      reasons.push(`"${title}" (missing location)`);
      continue;
    }
    const badVenue = venue && BAD_CARD_VENUE_PATTERNS.find((re) => re.test(venue));
    if (badVenue) {
      reasons.push(`"${title}" @ "${venue}" (broken venue)`);
      continue;
    }
    keep.push(c);
  }
  const removed = cards.length - keep.length;
  if (removed > 0) slot.plan.cards = keep;
  return { removed, reasons };
}

// Drop wellness/spa cards beyond the first one across the whole window.
// We're oversaturated on spas — keep max 1 per 7-day rolling window.
function capSpaFrequency(schedule, dates) {
  const touched = [];
  const spaByDate = new Map();
  for (const date of dates) {
    const day = schedule.days?.[date];
    if (!day) continue;
    const dp = day["day-plan"];
    if (!dp || ["rejected", "published", "image-approved"].includes(dp.status)) continue;
    const cards = dp.plan?.cards || [];
    const spaIdx = cards.findIndex((c) => {
      const text = [c.title, c.name, c.featuredPlace, c.category].filter(Boolean).join(" | ");
      return matchesCategory(text, CATEGORY_KEYWORDS.spa);
    });
    if (spaIdx >= 0) spaByDate.set(date, { dp, cards, spaIdx });
  }
  // Greedy: keep earliest in each 7-day window, remove others.
  const kept = [];
  const sortedDates = [...spaByDate.keys()].sort();
  for (const date of sortedDates) {
    const d = new Date(date + "T12:00:00");
    const tooClose = kept.some((k) => {
      const kd = new Date(k + "T12:00:00");
      return Math.abs((d - kd) / 86400000) < 7;
    });
    if (tooClose) {
      const { dp, cards, spaIdx } = spaByDate.get(date);
      const removed = cards.splice(spaIdx, 1)[0];
      dp.plan.cards = cards;
      touched.push({ date, removed: removed.title || removed.name });
    } else {
      kept.push(date);
    }
  }
  return touched;
}

/**
 * Run the quality review across a schedule's days.
 *
 * @param {object} schedule - The full schedule.json object.
 * @param {object} [options]
 * @param {string[]} [options.dates] - Restrict to these dates. Defaults to
 *   all dates in the schedule.
 * @param {boolean} [options.resetFlaggedToDraft=true] - If true, flagged
 *   slots have status set to "draft" so the caller can re-run the generator
 *   to replace them. If false, slots are only annotated.
 * @returns {{autoFixed: Array, flagged: Array}}
 */
export function runQualityReview(schedule, options = {}) {
  const { resetFlaggedToDraft = true } = options;
  const dates = (options.dates && options.dates.length)
    ? options.dates
    : Object.keys(schedule?.days || {}).sort();

  const autoFixed = [];
  const flagged = [];

  // Pass 1: deterministic auto-fixes ─────────────────────────────────────
  for (const date of dates) {
    const day = schedule.days?.[date];
    if (!day) continue;
    for (const slotType of ["day-plan", "tonight-pick", "wildcard"]) {
      const slot = day[slotType];
      if (!slot) continue;
      if (slot.status === "rejected") continue;

      // Terminology fixes are safe text rewrites — apply even on approved
      // slots so mistakes don't ship just because they made it past review once.
      const termChanges = applyTerminologyFixes(slot);
      if (termChanges > 0) {
        autoFixed.push({ date, slotType, kind: "terminology", details: `${termChanges} fix(es)` });
      }

      // Structural fixes only on drafts.
      if (slot.status === "draft" && slotType === "day-plan") {
        const resorted = sortDayPlanCards(slot);
        if (resorted) {
          autoFixed.push({ date, slotType, kind: "chronology", details: "resorted cards" });
        }
        const pruneResult = pruneBadCards(slot);
        if (pruneResult.removed > 0) {
          autoFixed.push({ date, slotType, kind: "card-prune", details: `removed ${pruneResult.removed}: ${pruneResult.reasons.join("; ")}` });
        }
      }
    }
  }

  // Cap spa/massage frequency — at most 1 per 7-day window.
  const spaCapped = capSpaFrequency(schedule, dates);
  for (const t of spaCapped) {
    autoFixed.push({ date: t.date, slotType: "day-plan", kind: "spa-cap", details: `removed spa card: ${t.removed}` });
  }

  // Build a venue-by-date map for window checks ─────────────────────────
  // Only count slots with status in {draft, approved} — published is history.
  const venueByDate = new Map(); // date -> [{slotType, venue, title}]
  for (const date of Object.keys(schedule?.days || {})) {
    const day = schedule.days[date];
    const entries = [];
    for (const slotType of ["tonight-pick", "wildcard"]) {
      const slot = day[slotType];
      if (!slot || slot.status === "rejected") continue;
      const venue = normalize(slot.item?.venue);
      const title = normalize(slot.item?.title || slot.item?.name);
      if (venue || title) entries.push({ slotType, venue, title });
    }
    venueByDate.set(date, entries);
  }

  // Pass 2: flag issues that need regen ─────────────────────────────────
  for (const date of dates) {
    const day = schedule.days?.[date];
    if (!day) continue;

    // ── Day plan ──
    const dp = day["day-plan"];
    const dpStatus = dp?.status;
    const dpIsDraft = dpStatus === "draft";
    const dpIsLive = dp && !["rejected", "published"].includes(dpStatus);
    if (dp && dpIsDraft) {
      const cards = dp.plan?.cards || [];
      if (cards.length < 6) {
        flagged.push({ date, slotType: "day-plan", reason: `only ${cards.length} stops (need 6+)` });
      } else {
        const firstHour = parseHour((cards[0].timeBlock || "").split(/\s*-\s*/)[0]);
        if (firstHour !== null && firstHour > 11) {
          flagged.push({ date, slotType: "day-plan", reason: `starts too late (${cards[0].timeBlock})` });
        }
      }
    }
    // Hard-block checks on day-plan regardless of status (sprawl, virtual, saturated spa).
    if (dp && dpIsLive) {
      const cityCount = countDayPlanCities(dp);
      if (cityCount >= 5) {
        flagged.push({ date, slotType: "day-plan", reason: `too much driving (${cityCount} cities)` });
      }
      // Demographic coherence: spa cooldown across the window.
      const hasSpa = dayPlanHasCategory(dp, CATEGORY_KEYWORDS.spa);
      if (hasSpa) {
        // Count other spa day-plans within ±3 days.
        let spaNeighbors = 0;
        for (let off = -3; off <= 3; off++) {
          if (off === 0) continue;
          const d = new Date(date + "T12:00:00");
          d.setDate(d.getDate() + off);
          const neighbor = d.toISOString().slice(0, 10);
          const ndp = schedule.days?.[neighbor]?.["day-plan"];
          if (!ndp || ["rejected"].includes(ndp.status)) continue;
          if (dayPlanHasCategory(ndp, CATEGORY_KEYWORDS.spa)) spaNeighbors++;
        }
        if (spaNeighbors >= 2) {
          flagged.push({ date, slotType: "day-plan", reason: `spa saturation (${spaNeighbors + 1} spa plans in 7 days)` });
        }
      }
    }

    // ── Tonight pick ──
    const tp = day["tonight-pick"];
    const tpStatus = tp?.status;
    const tpIsDraft = tpStatus === "draft";
    const tpIsLive = tp && !["rejected", "published"].includes(tpStatus);
    if (tp && tpIsDraft) {
      const venue = normalize(tp.item?.venue);
      const title = normalize(tp.item?.title || tp.item?.name);

      // Broken/truncated venue
      if (venueLooksBroken(tp.item?.venue)) {
        flagged.push({ date, slotType: "tonight-pick", reason: `broken venue "${tp.item.venue}"` });
      }

      // Weak content
      for (const pat of WEAK_TONIGHT_PATTERNS) {
        if (pat.test(title) || pat.test(tp.item?.summary || "")) {
          flagged.push({ date, slotType: "tonight-pick", reason: `weak tonight content (${pat})` });
          break;
        }
      }

      // Same venue on an adjacent day (±1)
      if (venue) {
        for (const offset of [-1, 1]) {
          const d = new Date(date + "T12:00:00");
          d.setDate(d.getDate() + offset);
          const neighbor = d.toISOString().slice(0, 10);
          const entries = venueByDate.get(neighbor) || [];
          if (entries.some((e) => e.venue === venue)) {
            flagged.push({ date, slotType: "tonight-pick", reason: `venue repeat adjacent day (${venue})` });
            break;
          }
        }

        // Same venue 2+ times in 7-day window (centered on date)
        let count = 0;
        for (let off = -3; off <= 3; off++) {
          const d = new Date(date + "T12:00:00");
          d.setDate(d.getDate() + off);
          const neighbor = d.toISOString().slice(0, 10);
          const entries = venueByDate.get(neighbor) || [];
          if (entries.some((e) => e.venue === venue)) count++;
        }
        if (count >= 3) {
          flagged.push({ date, slotType: "tonight-pick", reason: `venue saturated (${venue} ${count}× in 7 days)` });
        }
      }
    }
    // Hard-block checks for tonight-pick: fire regardless of approval status.
    // These are ship-blockers (wrong city, wrong day, virtual-only).
    if (tp && tpIsLive) {
      const title = normalize(tp.item?.title || tp.item?.name);
      const strs = allCopyStrings(tp);
      const copySample = strs.find((s) => s.text)?.text || title;
      const mm = dowMismatch(date, copySample) || dowMismatch(date, title);
      if (mm) flagged.push({ date, slotType: "tonight-pick", reason: mm, hardBlock: true });
      const ooa = outOfArea(tp);
      if (ooa) flagged.push({ date, slotType: "tonight-pick", reason: ooa, hardBlock: true });
      const virt = isVirtual(tp);
      if (virt) flagged.push({ date, slotType: "tonight-pick", reason: virt, hardBlock: true });
    }

    // ── Wildcard ──
    const wc = day["wildcard"];
    if (wc && wc.status === "draft") {
      const title = normalize(wc.item?.title || wc.item?.name);
      // sv-history shouldn't have a venue — skip venue checks for that subtype
      if (wc.subtype !== "sv-history") {
        const venue = normalize(wc.item?.venue);
        if (venueLooksBroken(wc.item?.venue)) {
          flagged.push({ date, slotType: "wildcard", reason: `broken venue "${wc.item.venue}"` });
        }
        if (venue) {
          for (const offset of [-1, 1]) {
            const d = new Date(date + "T12:00:00");
            d.setDate(d.getDate() + offset);
            const neighbor = d.toISOString().slice(0, 10);
            const entries = venueByDate.get(neighbor) || [];
            if (entries.some((e) => e.venue === venue)) {
              flagged.push({ date, slotType: "wildcard", reason: `venue repeat adjacent day (${venue})` });
              break;
            }
          }
        }
      }
      const strs = allCopyStrings(wc);
      const copySample = strs.find((s) => s.text)?.text || title;
      const mm = dowMismatch(date, copySample);
      if (mm) flagged.push({ date, slotType: "wildcard", reason: mm });
    }
  }

  // Pass 3: reset flagged slots ─────────────────────────────────────────
  // Dedup flags (one slot might have multiple reasons — only reset once).
  const seen = new Set();
  const uniqueFlagged = [];
  for (const f of flagged) {
    const key = `${f.date}::${f.slotType}`;
    if (seen.has(key)) {
      // Merge reason onto the existing entry
      const existing = uniqueFlagged.find((x) => x.date === f.date && x.slotType === f.slotType);
      if (existing) existing.reason += `; ${f.reason}`;
      continue;
    }
    seen.add(key);
    uniqueFlagged.push({ ...f });
  }

  // Merge hardBlock flag onto dedup'd entries (if any sub-flag was hardBlock,
  // the merged entry is hardBlock too).
  for (const f of flagged) {
    if (!f.hardBlock) continue;
    const match = uniqueFlagged.find((x) => x.date === f.date && x.slotType === f.slotType);
    if (match) match.hardBlock = true;
  }

  for (const f of uniqueFlagged) {
    const day = schedule.days[f.date];
    if (!day) continue;
    const existing = day[f.slotType];
    if (!existing) continue;
    const shouldDelete = resetFlaggedToDraft || f.hardBlock;
    if (!shouldDelete) continue;
    day._reviewHistory ??= [];
    day._reviewHistory.push({
      slotType: f.slotType,
      reason: f.reason,
      at: new Date().toISOString(),
      prevStatus: existing.status || null,
      prevTitle: existing.item?.title || existing.item?.name || existing.cityName || null,
      hardBlock: !!f.hardBlock,
    });
    delete day[f.slotType];
  }

  return { autoFixed, flagged: uniqueFlagged };
}
