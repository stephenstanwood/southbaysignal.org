const PROSPECTIVE_SOURCE =
  /\b(?:scheduled|set|expected|slated)\s+to\s+(?:hear|consider|review|weigh|vote|decide|approve|adopt|reject|deny)\b|\b(?:council|commission|committee|board)\s+to\s+(?:hear|consider|review|weigh|vote|decide|approve|adopt|reject|deny)\b/i;
const CONFIRMED_ACTION =
  /\b(?:heard|considered|reviewed|weighed|voted|decided|approved|adopted|rejected|denied)\b/i;

export function meetingWithinBriefingWindow(meeting, start, end) {
  return Boolean(meeting?.date && meeting.date >= start && meeting.date <= end);
}

export function hasProspectiveCityHallUpgrade(text, aroundItems = []) {
  if (!CONFIRMED_ACTION.test(String(text || ""))) return false;

  const sourcedItems = aroundItems
    .map((item) => `${item?.headline || ""} ${item?.summary || ""}`.trim())
    .filter(Boolean);
  if (!sourcedItems.length || sourcedItems.some((item) => !PROSPECTIVE_SOURCE.test(item))) {
    return false;
  }

  return true;
}
