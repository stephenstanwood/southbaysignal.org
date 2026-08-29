/**
 * Hicklebee's (IndieCommerce / Drupal) event-list parsing.
 *
 * Split out of `generate-events.mjs` so the markup handling is unit-testable
 * without network access — the same reason `logo-audit.mjs` is shared between
 * its fetcher and its gate.
 *
 * Two traps are encoded here, both of which shipped as real bugs:
 *
 * 1. The page footer carries an "Upcoming Event" widget built from
 *    `event-block__*` classes. The original parser split on
 *    `class="event-block__first`, so it was reading that single-event footer
 *    widget rather than the real list, which uses `event-list__*` inside
 *    `<article class="event-list">`.
 * 2. `/events` renders the CURRENT month only. Upcoming coverage requires
 *    walking `/events/YYYY/MM` forward.
 */

/** "11:00am" / "5 p.m." → "11:00 AM" / "5:00 PM" (repo-wide clock format). */
export function hicklebeesClockTime(raw) {
  const match = String(raw || "").match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i);
  if (!match) return null;
  let h24 = parseInt(match[1], 10) % 12;
  if (match[3].toLowerCase() === "p") h24 += 12;
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  if (h24 === 0 && minutes === 0) return null;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);
  return minutes === 0
    ? `${h12}:00 ${ampm}`
    : `${h12}:${String(minutes).padStart(2, "0")} ${ampm}`;
}

export function decodeHicklebeesText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Month paths to walk, starting at `today`'s month. */
export function hicklebeesMonthPaths(today, monthsAhead) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(today || ""));
  if (!match) throw new TypeError(`invalid ISO calendar date: ${today}`);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const paths = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const d = new Date(Date.UTC(year, month + i, 1));
    paths.push(`/events/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return paths;
}

/**
 * Parse one month list page.
 *
 * `articleCount` is reported alongside the rows so the caller can tell a
 * genuinely quiet month (no articles at all) apart from parser drift
 * (articles present, none parsed).
 */
export function parseHicklebeesListPage(html) {
  const blocks = String(html || "").split(/<article[^>]*class="event-list"/).slice(1);
  const rows = [];

  for (const block of blocks) {
    const linkMatch = block.match(
      /class="event-list__title"[^>]*>\s*<a href="([^"]+)"[^>]*>(.*?)<\/a>/s,
    );
    if (!linkMatch) continue;
    const title = decodeHicklebeesText(linkMatch[2]);
    if (!title) continue;

    const dateRaw = block.match(/details--label">\s*Date:\s*<\/span>([\s\S]*?)<\/div>/)?.[1] || "";
    const dateMatch = dateRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!dateMatch) continue;
    const date =
      `${dateMatch[3]}-${String(dateMatch[1]).padStart(2, "0")}-${String(dateMatch[2]).padStart(2, "0")}`;

    const timeRaw = block.match(/details--label">\s*Time:\s*<\/span>([\s\S]*?)<\/div>/)?.[1] || "";
    const clockParts = decodeHicklebeesText(timeRaw)
      .split(/\s*[-–—]\s*|\s+to\s+/i)
      .map(hicklebeesClockTime)
      .filter(Boolean);

    const href = linkMatch[1];
    rows.push({
      title,
      date,
      time: clockParts[0] || null,
      endTime: clockParts[1] || null,
      url: href.startsWith("http") ? href : `https://hicklebees.com${href}`,
    });
  }

  return { rows, articleCount: blocks.length };
}
