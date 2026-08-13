// Proper names that arrive spelled correctly in an issue's source data must
// survive the newsletter's LLM editorial pass.
//
// On 2026-08-13 the generated intro, field guide, and preheader all rendered
// the artist "Mistah F.A.B." as "Mistah F. A. B." while the deterministic
// event card — built straight from the same source string — was right. Three
// spellings shipped in one email because nothing compared generated prose
// against the data it was generated from.
//
// This module is that comparison: collect the spellings the issue's own source
// data uses, then repair generated prose that respells one of them with
// different spacing, punctuation, or case around the initials.
//
// Scope is deliberately narrow. A canonical name here is a capitalized word
// immediately followed by a dotted initialism ("Mistah F.A.B.", "Cafe R.M.S.").
// The leading word is the anchor: without it a bare "FAB" or a stray "F. A."
// could be anything, and a repair that fires on ordinary prose is worse than
// the corruption it fixes. An initialism with nothing capitalized in front of
// it — "6 P.M.", a standalone "T.I." — is left alone for the same reason, as
// is any initialism that reads as an abbreviation rather than a name.

const MAX_CANONICAL_NAMES = 200;

/** Dotted initialisms that are abbreviations, not names. One of these can
 * legitimately follow a capitalized word ("Saturday P.M.") and would otherwise
 * become canonical, which would turn ordinary "6 PM" prose into "6 P.M." */
const ABBREVIATION_INITIALISMS = new Set([
  "AM", "PM", "US", "USA", "UK", "EU", "DC", "NY", "LA", "SF",
  "EG", "IE", "PT", "PST", "PDT", "ET", "EST", "EDT",
  "RSVP", "AKA", "BYOB", "VIP", "DIY", "ASAP", "TBA", "TBD",
]);

const INITIALISM = /^(?:\p{Lu}\.){2,}$/u;
// No trailing period: a capitalized word that ends in one is far more likely to
// be ending a sentence than to be part of the name that follows it.
const NAME_WORD = /^\p{Lu}[\p{L}\p{N}'’&-]*$/u;

function normalizeToken(token) {
  return String(token)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/['’]s$/u, "")
    .replace(/[^\p{L}\p{N}.]+$/u, "");
}

function initialsOf(initialism) {
  return initialism.replace(/\./g, "");
}

/**
 * Canonical names in one string, as `${leadWord} ${initialism}` pairs.
 * Only the single adjacent capitalized word is kept: it is enough of an anchor
 * to make a repair safe, and a longer lead only narrows what the repair can
 * match.
 */
export function extractCanonicalNames(text) {
  const tokens = String(text || "").split(/\s+/).map(normalizeToken);
  const names = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const initialism = tokens[i];
    if (!INITIALISM.test(initialism)) continue;
    if (ABBREVIATION_INITIALISMS.has(initialsOf(initialism))) continue;
    const lead = tokens[i - 1];
    if (!NAME_WORD.test(lead) || INITIALISM.test(lead)) continue;
    names.push(`${lead} ${initialism}`);
  }
  return names;
}

/** Canonical names across every source string an issue drew on. */
export function collectCanonicalNames(texts) {
  const names = new Set();
  for (const text of texts || []) {
    for (const name of extractCanonicalNames(text)) {
      names.add(name);
      if (names.size >= MAX_CANONICAL_NAMES) return [...names];
    }
  }
  return [...names];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match a literal word in either case, so the repair also catches a name the
 * editor downcased. The matched text is preserved verbatim in the replacement:
 * only the initials are rewritten, so a lead word that is capitalized purely
 * because it opened a sentence never gets capitalized mid-sentence. */
function anyCaseLiteral(word) {
  return [...word]
    .map((ch) => {
      if (ch === "'" || ch === "’") return "['’]";
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      return lower === upper ? escapeRegex(ch) : `[${escapeRegex(lower)}${escapeRegex(upper)}]`;
    })
    .join("");
}

const patternCache = new Map();

/**
 * A pattern for every way the initials of `name` can be mangled while still
 * plainly being the same name: spaces wedged between them ("F. A. B."), a
 * dropped final period ("F.A.B"), or the periods dropped entirely ("FAB").
 *
 * The initials themselves stay case-sensitive. Matching a bare "FAB" case
 * -insensitively would let a canonical "Group I.T.S." rewrite the ordinary
 * words "Group its" — the whole failure mode this guard exists to prevent.
 */
function variantPattern(name) {
  if (patternCache.has(name)) return patternCache.get(name);
  const cut = name.lastIndexOf(" ");
  const lead = cut === -1 ? "" : name.slice(0, cut);
  const initialism = cut === -1 ? name : name.slice(cut + 1);
  const letters = [...initialsOf(initialism)];
  if (!lead || letters.length < 2) {
    patternCache.set(name, null);
    return null;
  }
  const spaced = [
    ...letters.slice(0, -1).map((letter) => `${escapeRegex(letter)}\\s*\\.`),
    escapeRegex(letters.at(-1)),
  ].join("\\s*");
  const bare = letters.map(escapeRegex).join("");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}.])(${anyCaseLiteral(lead)})\\s+(?:${spaced}|${bare})(?:\\s*\\.)?(?![\\p{L}\\p{N}.])`,
    "gu",
  );
  patternCache.set(name, pattern);
  return pattern;
}

/**
 * Restore the canonical spelling of any name in `names` that `text` respells.
 * Repairs in place rather than rejecting the prose — a mangled initial is not a
 * reason to throw away an otherwise good edit. Idempotent: text already using
 * the canonical spelling comes back byte-identical.
 */
export function repairCanonicalNames(text, names) {
  let out = String(text ?? "");
  if (!out) return out;
  for (const name of names || []) {
    const pattern = variantPattern(name);
    if (!pattern) continue;
    const canonicalInitialism = name.slice(name.lastIndexOf(" ") + 1);
    pattern.lastIndex = 0;
    out = out.replace(pattern, (_match, lead) => `${lead} ${canonicalInitialism}`);
  }
  return out;
}
