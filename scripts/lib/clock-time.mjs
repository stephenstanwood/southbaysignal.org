// Clock-time validation + canonicalization for scraped event times.
//
// Scrapers across ~20 sources hand back wildly inconsistent time strings
// ("8PM", "10:30am", "12pm, 1pm, 2pm"). This module is the single gate that
// decides whether a string is a usable 12-hour clock time and, if so, what its
// canonical "8:00 PM" form is.
//
// The hour and minute are RANGE-checked, not just shape-checked. A bare
// /^\d{1,2}(:\d{2})?\s*(am|pm)$/ accepts "20pm" and "30pm" — which is exactly
// what a scraper emits when its own regex clips the hour off "8:20pm" — and
// those reached live event cards as "20:00 PM" and "30:00 PM". A 12-hour clock
// has no hour 0 and no hour 13+, so reject those and let the caller null the
// field; generate-events.mjs runs a URL-refetch backfill right afterward that
// can recover the real time. Missing beats wrong.

const TIME_PATTERN = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;

// Comma-separated session lists ("12pm, 1pm, 2pm") are judged on their last
// token — that's the form a few SJMA / inbound listings arrive in.
function lastToken(value) {
  return String(value).split(",").pop().trim();
}

export function isClockTime(value) {
  if (!value) return false;
  const match = TIME_PATTERN.exec(lastToken(value));
  if (!match) return false;
  const hour = parseInt(match[1], 10);
  if (hour < 1 || hour > 12) return false;
  if (match[2] !== undefined && parseInt(match[2], 10) > 59) return false;
  return true;
}

// Canonical "8:00 PM" form. Returns the input unchanged when it isn't a valid
// clock time, so callers can gate with isClockTime() first and never see a
// half-normalized string.
export function normalizeClockTime(value) {
  if (!value) return value;
  const match = TIME_PATTERN.exec(String(value).trim());
  if (!match) return value;
  const hour = parseInt(match[1], 10);
  if (hour < 1 || hour > 12) return value;
  const minutes = match[2] ?? "00";
  if (parseInt(minutes, 10) > 59) return value;
  return `${hour}:${minutes} ${match[3].toUpperCase()}`;
}
