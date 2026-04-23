// Shared date/time helpers for generate-*.mjs scripts.
// All formatting uses America/Los_Angeles to stay consistent with the
// rest of the site (avoids UTC-midnight off-by-one dropping events).

const PT = "America/Los_Angeles";

export function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d;
}

// For sources that return naive datetime strings (no timezone) in Pacific local time.
// new Date("2026-04-12T12:00") is parsed as UTC in some Node environments,
// so we append the correct PT offset before parsing.
export function parseDatePT(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str) && !/[Z+\-]\d{2}:?\d{2}$/.test(str) && !str.endsWith("Z")) {
    const month = parseInt(str.slice(5, 7), 10);
    // PDT (UTC-7): Mar–Nov; PST (UTC-8): Dec–Feb
    const offset = (month >= 3 && month <= 11) ? "-07:00" : "-08:00";
    str = str + offset;
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

export function displayDate(d) {
  if (!d) return "";
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    timeZone: PT,
  });
}

export function displayTime(d) {
  if (!d) return null;
  const h = d.getHours();
  const m = d.getMinutes();
  if (h === 0 && m === 0) return null; // midnight = probably no time set
  return d.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
    timeZone: PT,
  });
}
