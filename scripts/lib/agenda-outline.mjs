// ---------------------------------------------------------------------------
// Numbered-outline agenda parser
// ---------------------------------------------------------------------------
// Legistar and eScribe hand out agenda items as structured records. The two
// remaining South Bay portals do not: Los Altos (CivicClerk) serves the agenda
// as extracted plain text and Saratoga (CivicEngage) as a PDF. Both, once they
// are text, are the same document — a numbered outline where each item is a
// title line followed by its recommended action.
//
//   Los Altos     "    3.   Adoption of Resolution - History Museum Roof…"
//                 "         Adopt a resolution to authorize the City Manager…"
//
//   Saratoga      "1.4 Award of Contract Backfill Janitorial Services"
//                 "Recommended Action:"
//                 "Approve the proposed contract with YN Maintenance LLC…"
//
// So one parser, not two. It exists to feed a summarizer, which means the job
// is to keep what a resident would recognize as city business and drop what a
// summarizer would otherwise treat as content: Zoom instructions, Brown Act
// notices, attachment inventories, and the running page header.
// ---------------------------------------------------------------------------

// An agenda is preceded by however much participation boilerplate the city
// likes, and that boilerplate is itself numbered ("1.Attending the meeting in
// person at:"). Start at the first line that only ever appears once the agenda
// proper has begun.
const BODY_START = /^\s*(?:pledge of allegiance|call (?:the )?(?:meeting )?to order|roll call|establish quorum)\b/i;

// Everything after adjournment is ADA notices and records-inspection language.
const BODY_END = /^\s*(?:adjourn(?:ment)?|certificate of posting)\b/i;

// `N.` (Los Altos, "3.   Adoption of…") or `N.N` (Saratoga, "1.4 Award of…").
//
// The whitespace after the number is required, not optional. Without it every
// line that merely *begins* with digits reads as a new item, and agenda prose
// wraps mid-number constantly: "Section 21080.66" broke across lines as
// "080.66 (Attachment 1)", "987, 994, and 1005 Acacia" as "7, 994, and 1005",
// and "2026 Annual Community Awards" as its own item numbered 20.
const ITEM_START = /^\s*(\d{1,2}\.\d{1,2}|\d{1,2}\.)\s+(\S.*)$/;

/** "1.4" is a dotted outline; "1." is a flat one. */
function numberStyle(number) {
  return number.includes(".") && !number.endsWith(".") ? "dotted" : "flat";
}

// Lines that belong to an item but carry no information about what the item is.
const NOISE_LINE = [
  /^recommended actions?:?$/i,
  /^(?:staff|supplemental|informational)\s+report\b/i,
  /^attachment\s+[a-z0-9]+\b/i,
  /^exhibit\s+[a-z0-9]+\b/i,
  /^\d+\.\s*[\w\s.,'&()-]+\.(?:pdf|docx?|pptx?|xlsx?)$/i,
  /\.(?:pdf|docx?|pptx?|xlsx?)$/i,
  /^(?:presentation|powerpoint|slides)\b/i,
  // The running header/footer repeats on every page and lands mid-item.
  /meeting agenda\s*[–—-]\s*.*page \d+ of \d+/i,
  /^page \d+ of \d+$/i,
  /^\d{1,3}$/,
];

/** A section banner ("CONSENT CALENDAR") is structure, not an agenda item. */
function isBanner(line) {
  const t = line.trim();
  return t.length > 0 && t === t.toUpperCase() && /[A-Z]/.test(t);
}

function isNoise(line) {
  return NOISE_LINE.some((re) => re.test(line.trim()));
}

/**
 * Narrow raw agenda text to the lines between the meeting's opening formality
 * and its adjournment. Falls back to the whole document when neither marker is
 * present, so an unfamiliar layout degrades to "parse everything" rather than
 * "parse nothing".
 */
export function agendaBodyLines(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);

  const start = lines.findIndex((l) => BODY_START.test(l));
  const from = start === -1 ? 0 : start + 1;
  const endOffset = lines.slice(from).findIndex((l) => BODY_END.test(l));
  const to = endOffset === -1 ? lines.length : from + endOffset;
  return lines.slice(from, to);
}

/**
 * Parse a plain-text agenda into `{ number, title, detail }` items.
 *
 * `title` is the item's own line; `detail` is the prose under it with the
 * attachment list stripped. Both are already whitespace-collapsed.
 */
export function parseAgendaOutline(text, { maxDetailChars = 260 } = {}) {
  const items = [];
  let current = null;
  // A city numbers its agenda one way or the other, never both. Saratoga lists
  // the recommended actions under item 1.6 as a nested "1." / "2." — read as
  // top-level items those outrank the real ones and the summary describes a
  // landscaping contract twice. Lock to the style of the first item seen and
  // let anything else fall through as detail, which is what it is.
  let style = null;

  const flush = () => {
    if (!current) return;
    const detail = current.detail.join(" ").replace(/\s+/g, " ").trim();
    items.push({
      number: current.number,
      title: current.title.replace(/\s+/g, " ").trim(),
      detail: truncateAtWord(detail, maxDetailChars),
    });
    current = null;
  };

  for (const line of agendaBodyLines(text)) {
    const match = line.match(ITEM_START);
    // Section banners get numbered too ("1. CONSENT CALENDAR", "2. PUBLIC
    // HEARING"). They must never set the style, or Saratoga's outline locks to
    // flat on its consent-calendar banner and every real 1.N item is then
    // rejected in favor of the nested recommended actions under them.
    const isNumberedBanner = match !== null && isBanner(match[2]);
    if (match && !isNumberedBanner && (style === null || numberStyle(match[1]) === style)) {
      style ??= numberStyle(match[1]);
      flush();
      current = { number: match[1], title: match[2], detail: [] };
      continue;
    }
    if (isBanner(line)) { flush(); continue; }
    if (!current) continue;
    if (isNoise(line)) continue;
    current.detail.push(line);
  }
  flush();

  return items.filter((item) => item.title.length > 0);
}

function truncateAtWord(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Extracted PDF text can be structurally fine and still be unreadable: a font
 * subset with a custom encoding comes back as mojibake. Saratoga posts a
 * Chinese translation of every agenda next to the English one, and its text
 * layer decodes to `!"#$%&%'(')*+,-./`. Check before handing it to a model.
 */
export function looksLikeReadableAgenda(text) {
  const sample = String(text ?? "").slice(0, 4_000);
  if (sample.length < 200) return false;
  const plain = (sample.match(/[A-Za-z .,'()-]/g) ?? []).length;
  return plain / sample.length > 0.8;
}
