// Editorial suppressions for event rows that must not publish until a human
// reconfirms them against a first-party occurrence page. A review date is a
// prompt to recheck the source, not an automatic expiry.

export const EVENT_EDITORIAL_SUPPRESSIONS = Object.freeze([
  Object.freeze({
    ids: Object.freeze(["sccl-6a5a7fe7fa641fe01af3cb52"]),
    title: /lotus lantern craft/i,
    venue: /cupertino library/i,
    date: "2026-08-19",
    reviewOn: "2026-08-26",
    reason:
      "SCCL BiblioCommons occurrence page and gateway record do not confirm this date or time.",
    source: "https://sccl.bibliocommons.com/events/6a5a7fe7fa641fe01af3cb52",
  }),
  Object.freeze({
    ids: Object.freeze(["sjpl-69d5759be2a2952aed0d5074"]),
    title: /wee explore outdoors/i,
    venue: /educational park/i,
    date: "2026-08-19",
    reviewOn: "2026-08-26",
    reason:
      "SJPL BiblioCommons occurrence page and gateway record do not confirm this date or time.",
    source: "https://sjpl.bibliocommons.com/events/69d5759be2a2952aed0d5074",
  }),
  Object.freeze({
    ids: Object.freeze(["sjpl-6a7e0ae8d4b10d0030064691"]),
    title: /knitting\/crocheting\/tatting\/bobbin lace club/i,
    venue: /east sj carnegie/i,
    date: "2026-08-19",
    reviewOn: "2026-08-26",
    reason:
      "SJPL BiblioCommons occurrence page and gateway record do not confirm this date or time.",
    source: "https://sjpl.bibliocommons.com/events/6a7e0ae8d4b10d0030064691",
  }),
]);

function normalizeDate(value) {
  return String(value || "").slice(0, 10);
}

export function isEventEditoriallySuppressed(event) {
  if (!event || typeof event !== "object") return false;

  const id = String(event.id || "");
  const title = String(event.title || event.name || "");
  const venue = String(event.venue || "");
  const date = normalizeDate(event.date);
  const url = String(event.url || "");

  return EVENT_EDITORIAL_SUPPRESSIONS.some((rule) => {
    if (rule.ids?.some((candidate) => candidate === id || url.includes(candidate.replace(/^[a-z]+-/, "")))) {
      return true;
    }
    if (date !== rule.date) return false;
    return rule.title.test(title) && rule.venue.test(venue);
  });
}
