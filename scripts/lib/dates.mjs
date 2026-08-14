// Shared date/time helpers for generate-*.mjs scripts.
// All formatting uses America/Los_Angeles to stay consistent with the
// rest of the site (avoids UTC-midnight off-by-one dropping events).

const PT = "America/Los_Angeles";

function pacificOffsetForCalendarDate(value) {
  // Midnight UTC is the prior Pacific afternoon, which is on the same side of
  // the 2 AM DST boundary as the target local midnight.
  const probe = new Date(`${value}T00:00:00Z`);
  const zoneName = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    timeZone: PT,
    timeZoneName: "longOffset",
  }).formatToParts(probe).find(({ type }) => type === "timeZoneName")?.value;
  const match = /^GMT([+-]\d{2}:\d{2})$/.exec(zoneName || "");
  if (!match) throw new RangeError(`could not resolve Pacific offset for: ${value}`);
  return match[1];
}

export function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d;
}

// For sources that return naive datetime strings (no timezone) in Pacific local time.
// new Date("2026-04-12T12:00") is parsed as UTC in some Node environments,
// and "2026-04-12 12:00:00" (space format from WP/Tribe APIs) is interpreted
// as UTC when the host TZ is UTC (e.g. Vercel build, Linux cron). We normalize
// the separator to T and append the correct PT offset before parsing.
export function parseDatePT(str) {
  if (!str) return null;
  // Date-only values are calendar dates, not UTC instants. BiblioCommons uses
  // this shape for all-day events; `new Date("2026-08-15")` is midnight UTC,
  // which renders as Aug 14 at 5:00 PM in Pacific time. Anchor the date at
  // Pacific midnight so it stays on the source's day and displayTime() keeps
  // treating it as all-day.
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(str);
  if (dateOnly) {
    try {
      isoDateParts(dateOnly[1]);
    } catch {
      return null;
    }
    const offset = pacificOffsetForCalendarDate(dateOnly[1]);
    str = `${dateOnly[1]}T00:00:00${offset}`;
  }
  // Accept both "T" and " " between date and time.
  const naive = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)\s*$/.exec(str);
  if (naive) {
    const month = parseInt(naive[1].slice(5, 7), 10);
    // PDT (UTC-7): Mar–Nov; PST (UTC-8): Dec–Feb
    const offset = (month >= 3 && month <= 11) ? "-07:00" : "-08:00";
    str = `${naive[1]}T${naive[2]}${offset}`;
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d;
}

export function isoDate(d) {
  if (!d) return null;
  const parts = d.toLocaleDateString("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit",
    timeZone: PT,
  }).split("/");
  return `${parts[2]}-${parts[0]}-${parts[1]}`;
}

export function todayPT() {
  return new Date().toLocaleDateString("en-CA", { timeZone: PT });
}

export function isoDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) throw new TypeError(`invalid ISO calendar date: ${value}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    throw new RangeError(`invalid ISO calendar date: ${value}`);
  }

  return { year, month, day, weekday: probe.getUTCDay() };
}

export function addIsoDays(value, offset) {
  const { year, month, day } = isoDateParts(value);
  const probe = new Date(Date.UTC(year, month - 1, day + Number(offset)));
  return probe.toISOString().slice(0, 10);
}

export function recurringWeekdayDates(startDate, weekday, horizonDays = 90) {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new RangeError(`invalid weekday: ${weekday}`);
  }
  if (!Number.isInteger(horizonDays) || horizonDays < 0) {
    throw new RangeError(`invalid recurrence horizon: ${horizonDays}`);
  }

  const dates = [];
  for (let offset = 0; offset <= horizonDays; offset++) {
    const date = addIsoDays(startDate, offset);
    if (isoDateParts(date).weekday === weekday) dates.push(date);
  }
  return dates;
}

export function displayDate(d) {
  if (!d) return "";
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    timeZone: PT,
  });
}

export function displayTime(d) {
  if (!d) return null;
  // Format in PT first, then check the formatted output for midnight. Using
  // `d.getHours()` to detect midnight is runtime-TZ dependent — when the cron
  // runs in UTC, a date that's midnight PT has getHours()==7, slipping past
  // the guard and emitting a misleading "12:00 AM" badge on the card.
  const formatted = d.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
    timeZone: PT,
  });
  if (formatted === "12:00 AM") return null; // midnight = probably no time set
  return formatted;
}
