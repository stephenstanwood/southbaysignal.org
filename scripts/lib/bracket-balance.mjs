/**
 * Bracket balancing for titles that survived a prefix strip.
 *
 * cleanTitle's CJK-prefix rule deletes everything before the first Latin
 * letter. When the English half of a bilingual title lives inside brackets,
 * that cut eats the opening bracket and orphans the closer:
 *
 *   "大朋友(50+)社區团体活动 ( Chinese Orchestra)" → "Chinese Orchestra)"
 *
 * That is an SJPL BiblioCommons recurring series, so it re-mangled on every
 * refresh — it shipped in the 2026-08-18 newsletter as "Chinese Orchestra)".
 *
 * Fixing it via TITLE_FIXES is not an option: that map is a replaceAll, so a
 * "Chinese Orchestra)" → "Chinese Orchestra" entry would also corrupt a
 * legitimate title like "Concert (Chinese Orchestra)".
 */

// Closer → its opener. Covers ASCII, fullwidth, and CJK lenticular brackets;
// bilingual library feeds mix all three.
const CLOSER_TO_OPENER = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
  ["）", "（"],
  ["】", "【"],
]);

const OPENERS = new Set(CLOSER_TO_OPENER.values());

/**
 * Drop closing brackets that have no matching opener earlier in the string.
 *
 * Each bracket type is counted independently — event titles don't nest mixed
 * bracket types, and independent counts stop one stray type from cascading
 * into another. Openers are always kept: the prefix strip consumes everything
 * before the first Latin letter, so any opener that survives still has its
 * content after it.
 *
 * @param {string} text
 * @returns {string} text with orphaned closing brackets removed
 */
export function dropUnmatchedClosers(text) {
  if (!text) return text;
  const open = new Map();
  let out = "";
  for (const ch of text) {
    if (OPENERS.has(ch)) {
      open.set(ch, (open.get(ch) ?? 0) + 1);
      out += ch;
      continue;
    }
    const opener = CLOSER_TO_OPENER.get(ch);
    if (opener !== undefined) {
      const depth = open.get(opener) ?? 0;
      if (depth === 0) continue; // orphaned closer — drop it
      open.set(opener, depth - 1);
    }
    out += ch;
  }
  return out;
}
