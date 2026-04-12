// ---------------------------------------------------------------------------
// South Bay Today — Slot Scheduler
// Pre-assigns each approved post to a specific publish slot based on
// event date, quality, and current queue occupancy. Replaces the reactive
// "score at publish time" model with explicit scheduling.
//
// Three primary publish slots (America/Los_Angeles, matches launchd cron):
//   07:15  Signature   — flagship "here's what to do today" post, best graphic
//   11:45  Tonight     — single best thing to do tonight, best graphic
//   16:30  Wildcard    — restaurant openings, SV history, local data, evergreen
//
// Three secondary slots are defined but DISABLED (launchd does not fire them):
//   09:30  disabled
//   14:10  disabled
//   18:45  disabled
// ---------------------------------------------------------------------------

export const SLOTS = ["07:15", "09:30", "11:45", "14:10", "16:30", "18:45"];

/**
 * Editorial role for each slot. "disabled" slots are defined here for
 * reference but the launchd plist does not fire them. Primary slots only:
 * 07:15, 11:45, 16:30.
 */
export const SLOT_ROLES = {
  "07:15": "signature",  // Flagship: best plan for the day, images prioritized
  "09:30": "disabled",
  "11:45": "tonight",    // Tonight pick: single best evening event, images prioritized
  "14:10": "disabled",
  "16:30": "wildcard",   // Wildcard: restaurant openings, SV history, local data
  "18:45": "disabled",
};

/** The three active publish slots (launchd fires at these times). */
export const PRIMARY_SLOTS = Object.entries(SLOT_ROLES)
  .filter(([, role]) => role !== "disabled")
  .map(([slot]) => slot); // ["07:15", "11:45", "16:30"]

/** Return today's date in Pacific Time as YYYY-MM-DD. */
export function todayPT() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** Return current HH:MM in Pacific Time. */
export function nowHHMM_PT() {
  return new Date().toLocaleTimeString("en-GB", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Day of week (0=Sun, 6=Sat) for a YYYY-MM-DD string in PT. */
export function dowPT(dateStr) {
  return new Date(dateStr + "T12:00:00-07:00").getDay();
}

/** Add N days to a YYYY-MM-DD string. Returns new YYYY-MM-DD. */
export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00-07:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** Days between two YYYY-MM-DD strings (b - a). */
export function daysBetween(a, b) {
  const da = new Date(a + "T12:00:00-07:00");
  const db = new Date(b + "T12:00:00-07:00");
  return Math.round((db - da) / 86400000);
}

/**
 * Event date extractor. Handles post.item.date, post.date, or extracts
 * from title in a few known formats.
 */
export function getEventDate(post) {
  return post?.item?.date || post?.date || null;
}

/**
 * Classify a post's editorial role to match it to the right publish slot.
 *
 * Returns one of: "wildcard" | "tonight" | "signature"
 *
 * - wildcard (16:30): restaurant openings, evergreen content, non-urgent posts
 * - tonight (11:45): evening events framed as "tonight", or events starting ≥5 PM
 * - signature (07:15): everything else — the flagship daily post
 */
export function slotRole(post) {
  // Restaurant openings are always wildcard content
  if (post.postType === "restaurant_opening") return "wildcard";

  // Check copy for "tonight" / "this evening" framing → tonight slot
  const copyText = JSON.stringify(post.copy || {}).toLowerCase();
  if (/\btonight\b|\bthis evening\b/.test(copyText)) return "tonight";

  // Events with an evening start time (≥5 PM) → tonight slot
  const eventHour = parseItemHour(post.item?.time || "");
  if (eventHour !== null && eventHour >= 17) return "tonight";

  return "signature";
}

/** Parse hour from time strings like "7:00 PM", "19:00", "2pm", etc. */
function parseItemHour(timeStr) {
  if (!timeStr) return null;
  const lower = timeStr.toLowerCase().trim();
  const match = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!match) return null;
  let hour = parseInt(match[1]);
  const ampm = match[3];
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  return hour;
}

/**
 * Return the primary slot time string for a given role, or null if not found.
 */
function roleToSlot(role) {
  const entry = Object.entries(SLOT_ROLES).find(([, r]) => r === role);
  return entry ? entry[0] : null;
}

/**
 * Given an event date and today, return an ordered list of candidate
 * publish dates (YYYY-MM-DD) from most-preferred to least-preferred.
 */
export function computePreferredDates(eventDate, today = todayPT()) {
  const daysUntil = daysBetween(today, eventDate);
  if (daysUntil < 0) return []; // past event, don't schedule
  const event = eventDate;
  const eventDow = dowPT(eventDate);
  const isWeekendEvent = eventDow === 0 || eventDow === 6;

  // Same-day event: publish today only
  if (daysUntil === 0) return [today];

  // Tomorrow: publish today and tomorrow morning
  if (daysUntil === 1) return [today, event];

  // 2-3 days out: the day before gets priority, then day-of
  if (daysUntil === 2) return [addDays(event, -1), event, today];
  if (daysUntil === 3) return [addDays(event, -1), addDays(event, -2), event];

  // 4-7 days out: ramp up — start mid-week for weekend events
  if (daysUntil >= 4 && daysUntil <= 7) {
    if (isWeekendEvent) {
      // For a Sat/Sun event: prefer Thu/Fri publish (closest non-weekend workdays)
      const candidates = [];
      for (let offset = -2; offset >= -4; offset--) {
        const d = addDays(event, offset);
        const dow = dowPT(d);
        if (dow >= 1 && dow <= 5) candidates.push(d); // Mon-Fri
      }
      candidates.push(addDays(event, -1), event);
      return candidates;
    }
    return [addDays(event, -2), addDays(event, -3), addDays(event, -1), event];
  }

  // 8-14 days out: publish 3-5 days before
  if (daysUntil >= 8 && daysUntil <= 14) {
    return [addDays(event, -3), addDays(event, -4), addDays(event, -5), addDays(event, -2)];
  }

  // 15-21 days out: publish ~week before
  if (daysUntil >= 15 && daysUntil <= 21) {
    return [addDays(event, -7), addDays(event, -6), addDays(event, -5)];
  }

  // Farther out: publish ~10 days before
  return [addDays(event, -10), addDays(event, -9), addDays(event, -8)];
}

/**
 * Within a given publish date, return PRIMARY slot times in order of preference
 * based on how far the event is from publish day.
 *
 * Only returns primary slots (07:15, 11:45, 16:30).
 */
export function preferredSlotsForDate(publishDate, eventDate) {
  const daysUntil = daysBetween(publishDate, eventDate);
  if (daysUntil === 0) {
    // Same day: morning flagship first so it's seen before the event
    return ["07:15", "11:45", "16:30"];
  }
  if (daysUntil === 1) {
    // Day before: wildcard slot works for "tomorrow" teases; morning as backup
    return ["16:30", "11:45", "07:15"];
  }
  if (daysUntil >= 2 && daysUntil <= 3) {
    // A couple days ahead: midday works for advance notice
    return ["11:45", "07:15", "16:30"];
  }
  // Further out: morning slots — fresh-morning scroll
  return ["07:15", "11:45", "16:30"];
}

/**
 * Check if a given (date, slot) is already occupied by a non-published post.
 * Returns true if the slot is taken.
 */
export function isSlotOccupied(queue, date, slot) {
  for (const p of queue) {
    if (p.published) continue;
    const s = p.scheduledSlot;
    if (!s) continue;
    if (s.date === date && s.time === slot) return true;
  }
  return false;
}

/**
 * Check if a given (date, slot) is already in the past.
 */
export function isSlotInPast(date, slot, today = todayPT(), nowHHMM = nowHHMM_PT()) {
  if (date < today) return true;
  if (date > today) return false;
  return slot <= nowHHMM;
}

/**
 * Assign a publish slot to a post based on its event date, editorial role,
 * and the current state of the queue.
 *
 * Only assigns to PRIMARY_SLOTS (07:15, 11:45, 16:30). Secondary slots
 * (09:30, 14:10, 18:45) are disabled and will never be assigned.
 *
 * Role-matching: the post's slotRole() is used to prefer the matching slot
 * (signature→07:15, tonight→11:45, wildcard→16:30). Falls back to other
 * primary slots if the preferred one is occupied.
 *
 * Returns { date, time, assignedAt, role } or null if no suitable slot exists.
 *
 * @param {object} post - Queue item with item.date set
 * @param {Array} queue - Full approved queue (to check slot occupancy)
 * @param {object} [opts]
 * @param {string} [opts.today] - Override today's date (for testing)
 * @param {string} [opts.nowHHMM] - Override current time (for testing)
 */
export function assignSlot(post, queue, opts = {}) {
  const today = opts.today || todayPT();
  const nowHHMM = opts.nowHHMM || nowHHMM_PT();
  const eventDate = getEventDate(post);

  // No event date = no planned slot. Fall back to reactive at publish time.
  if (!eventDate) return null;

  const preferredDates = computePreferredDates(eventDate, today);
  if (preferredDates.length === 0) return null; // past event

  const role = slotRole(post);
  const roleSlot = roleToSlot(role); // preferred slot for this post's role

  for (const date of preferredDates) {
    // Skip if date is in the past (shouldn't happen but guard anyway)
    if (date < today) continue;

    // Get time-appropriate slot order (primary slots only), then push the
    // role-matching slot to the front so it's tried first.
    const timeSlots = preferredSlotsForDate(date, eventDate);
    const slotOrder = roleSlot
      ? [roleSlot, ...timeSlots.filter((s) => s !== roleSlot)]
      : timeSlots;

    for (const slot of slotOrder) {
      if (isSlotInPast(date, slot, today, nowHHMM)) continue;
      if (isSlotOccupied(queue, date, slot)) continue;
      return {
        date,
        time: slot,
        role,
        assignedAt: new Date().toISOString(),
      };
    }
  }

  // All preferred slots are full or in the past — spill to any available
  // primary slot between today and event date.
  const event = eventDate;
  let cursor = today;
  while (cursor <= event) {
    // Role slot first, then remaining primary slots
    const spillOrder = roleSlot
      ? [roleSlot, ...PRIMARY_SLOTS.filter((s) => s !== roleSlot)]
      : PRIMARY_SLOTS;
    for (const slot of spillOrder) {
      if (isSlotInPast(cursor, slot, today, nowHHMM)) continue;
      if (isSlotOccupied(queue, cursor, slot)) continue;
      return {
        date: cursor,
        time: slot,
        role,
        assignedAt: new Date().toISOString(),
        fallback: true,
      };
    }
    cursor = addDays(cursor, 1);
  }

  return null;
}

/**
 * Find the current publish slot: given `nowHHMM`, return the slot time
 * string the cron is most likely firing for (the primary slot whose scheduled
 * time is closest to now, within a ±30 min window).
 */
export function currentPublishSlot(nowHHMM = nowHHMM_PT()) {
  const nowMin = hhmmToMinutes(nowHHMM);
  let best = null;
  let bestDelta = Infinity;
  for (const slot of PRIMARY_SLOTS) {
    const delta = Math.abs(hhmmToMinutes(slot) - nowMin);
    if (delta < bestDelta && delta <= 30) {
      best = slot;
      bestDelta = delta;
    }
  }
  return best;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Find all posts scheduled for the current slot. Returns an array sorted
 * by quality score descending (in case multiple were assigned to the same
 * slot — should never happen, but defensive).
 */
export function postsForCurrentSlot(queue, opts = {}) {
  const today = opts.today || todayPT();
  const slot = opts.slot || currentPublishSlot();
  if (!slot) return [];
  return queue
    .filter(
      (p) =>
        !p.published &&
        p.scheduledSlot?.date === today &&
        p.scheduledSlot?.time === slot,
    )
    .sort((a, b) => (b.item?.score || 0) - (a.item?.score || 0));
}
