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
];

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

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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
      // Match "Monday Night", "Tuesday evening", etc. — day-of-week used as adjective
      const re = new RegExp(`\\b${alias}(night|evening|afternoon|morning)\\b`, "i");
      if (re.test(text)) return `title implies ${day} but slot is ${dow}`;
    }
  }
  return null;
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
      // Never touch approved/published/rejected slots
      if (slot.status && !["draft"].includes(slot.status)) continue;

      const termChanges = applyTerminologyFixes(slot);
      if (termChanges > 0) {
        autoFixed.push({ date, slotType, kind: "terminology", details: `${termChanges} fix(es)` });
      }

      if (slotType === "day-plan") {
        const resorted = sortDayPlanCards(slot);
        if (resorted) {
          autoFixed.push({ date, slotType, kind: "chronology", details: "resorted cards" });
        }
      }
    }
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
    if (dp && dp.status === "draft") {
      const cards = dp.plan?.cards || [];
      if (cards.length < 5) {
        flagged.push({ date, slotType: "day-plan", reason: `only ${cards.length} stops` });
      } else {
        const firstHour = parseHour((cards[0].timeBlock || "").split(/\s*-\s*/)[0]);
        if (firstHour !== null && firstHour > 11) {
          flagged.push({ date, slotType: "day-plan", reason: `starts too late (${cards[0].timeBlock})` });
        }
      }
    }

    // ── Tonight pick ──
    const tp = day["tonight-pick"];
    if (tp && tp.status === "draft") {
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

      // Day-of-week mismatch (check first platform copy we find)
      const strs = allCopyStrings(tp);
      const copySample = strs.find((s) => s.text)?.text || title;
      const mm = dowMismatch(date, copySample);
      if (mm) flagged.push({ date, slotType: "tonight-pick", reason: mm });

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

  if (resetFlaggedToDraft) {
    for (const f of uniqueFlagged) {
      const day = schedule.days[f.date];
      if (!day) continue;
      // Delete the slot so the regenerator creates a fresh one. Keep a
      // note of why on a sibling key so we can inspect history.
      const existing = day[f.slotType];
      if (existing) {
        day._reviewHistory ??= [];
        day._reviewHistory.push({
          slotType: f.slotType,
          reason: f.reason,
          at: new Date().toISOString(),
          prevTitle: existing.item?.title || existing.item?.name || existing.cityName || null,
        });
        delete day[f.slotType];
      }
    }
  }

  return { autoFixed, flagged: uniqueFlagged };
}
