// ---------------------------------------------------------------------------
// South Bay Signal — Time/date helpers (Pacific Time)
// ---------------------------------------------------------------------------
// Extracted from OverviewView for reuse across homepage sections.

const NOW = new Date();
export const NOW_PT = new Date(NOW.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
export const NOW_MINUTES = NOW_PT.getHours() * 60 + NOW_PT.getMinutes();
export const TODAY_ISO = NOW.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
export const MONTH = NOW_PT.getMonth() + 1;
export const NEXT_MONTH = MONTH === 12 ? 1 : MONTH + 1;
export const DAY_IDX = NOW_PT.getDay();
export const DAY_NAME = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][DAY_IDX] as string;
export const WEEKDAY = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][DAY_IDX];
export const MONTH_NAME = NOW.toLocaleDateString("en-US", { month: "long" });
export const NEXT_MONTH_NAME = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 1).toLocaleDateString("en-US", { month: "long" });

export const IS_WEEKEND_MODE = DAY_IDX === 5 || DAY_IDX === 6 || DAY_IDX === 0;
export const SHOW_WEEKEND_TOMORROW = DAY_IDX === 5 || DAY_IDX === 6;

const _tmrow = new Date(NOW_PT.getFullYear(), NOW_PT.getMonth(), NOW_PT.getDate() + 1);
export const TOMORROW_DAY_NAME = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][_tmrow.getDay()] as string;
export const TOMORROW_MONTH_NUM = _tmrow.getMonth() + 1;

export const NEXT_DAYS: Array<{ iso: string; label: string }> = Array.from({ length: 6 }, (_, i) => {
  const d = new Date(NOW_PT.getFullYear(), NOW_PT.getMonth(), NOW_PT.getDate() + i + 1);
  const iso = d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const label = d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
  return { iso, label };
});
export const TOMORROW_ISO = NEXT_DAYS[0]?.iso ?? "";
export const TOMORROW_LABEL = NEXT_DAYS[0]?.label ?? "Tomorrow";

// ── Time parsing ──

export function parseMinutes(timeStr: string, useLast = false): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(/\s*[,–\-]\s*/);
  const target = (useLast ? parts[parts.length - 1] : parts[0]).trim();
  const match = target.match(/^(\d+)(?::(\d+))?\s*(am|pm)$/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2] ?? "0");
  const ampm = match[3].toLowerCase();
  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h * 60 + m;
}

export function startMinutes(timeStr: string | undefined | null): number {
  if (!timeStr) return 999;
  return parseMinutes(timeStr, false) ?? 999;
}

export function formatTimeRange(time: string | undefined | null, endTime: string | undefined | null, isSports = false): string | null {
  if (!time) return null;
  if (!endTime || isSports) return time;
  const startPeriod = time.match(/(am|pm)$/i)?.[1]?.toUpperCase();
  const endPeriod = endTime.match(/(am|pm)$/i)?.[1]?.toUpperCase();
  if (startPeriod && endPeriod && startPeriod === endPeriod) {
    return `${time.replace(/\s*(am|pm)$/i, "")}–${endTime}`;
  }
  return `${time}–${endTime}`;
}

export function isNotEnded(timeStr: string | undefined | null): boolean {
  if (!timeStr) return true;
  const endMin = parseMinutes(timeStr, true);
  if (endMin === null) return true;
  return endMin > NOW_MINUTES;
}

export function hasNotStarted(timeStr: string | undefined | null): boolean {
  if (!timeStr) return true;
  const startMin = parseMinutes(timeStr, false);
  if (startMin === null) return true;
  return startMin > NOW_MINUTES;
}

export type TimeBucket = "now" | "morning" | "afternoon" | "evening" | "none";

export function timeBucket(timeStr: string | undefined | null): TimeBucket {
  if (!timeStr) return "none";
  const start = parseMinutes(timeStr, false);
  if (start === null) return "none";
  const end = parseMinutes(timeStr, true) ?? start + 120;
  if (start <= NOW_MINUTES && end > NOW_MINUTES) return "now";
  if (start < 12 * 60) return "morning";
  if (start < 17 * 60) return "afternoon";
  return "evening";
}

export const BUCKET_LABELS: Record<TimeBucket, string> = {
  now: "Happening Now",
  morning: "This Morning",
  afternoon: "This Afternoon",
  evening: "Tonight",
  none: "Also Today",
};
export const BUCKET_ORDER: TimeBucket[] = ["now", "morning", "afternoon", "evening", "none"];

// ── Freshness display ──

export function formatAge(isoStr: string | null | undefined): string {
  if (!isoStr) return "";
  const hours = (Date.now() - new Date(isoStr).getTime()) / 3600000;
  if (hours < 0.017) return "just now"; // < 1 min
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  if (hours < 48) return "yesterday";
  return `${Math.round(hours / 24)}d ago`;
}

// ── City label ──

export function cityLabel(city: string): string {
  return city.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
