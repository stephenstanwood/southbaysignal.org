// ---------------------------------------------------------------------------
// Reddit pulse: summaries that only re-say their own headline
// ---------------------------------------------------------------------------
// The "Around town" section prints a post's headline and, under it, the
// classifier's one-sentence summary. When the summary just restates the
// headline, the pair reads as machine-generated filler and the second line
// costs the reader a re-read for nothing.
//
// The 2026-09-07 issue shipped the clearest possible case:
//   headline  "VTA defends its plan to extend BART to downtown San Jose"
//   summary   "VTA defends its plan to extend BART service to downtown San Jose."
// One novel word ("service") across a whole sentence.
//
// A summary that genuinely adds framing stays. From the same feed:
//   "San Jose Lowrider Day 2026" / "Annual San Jose Lowrider Day showcased
//   custom cars in downtown San Jose."  -> adds annual, showcased, custom, cars
//   "Bars with Dodger games" / "A Dodgers fan asks for San Jose bars that show
//   Dodgers games and other fans to watch with."
// Both keep their summaries. The threshold is deliberately low so the filter
// only removes pure restatement, never a thin-but-real summary.
//
// The generator also has a hard echo path worth catching: a post the
// classifier never returned falls back to `summary: c.title` verbatim.
// ---------------------------------------------------------------------------

/** Words that carry no information about the subject. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "so", "as", "at", "by", "for",
  "from", "in", "into", "of", "on", "onto", "to", "with", "without", "about",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this",
  "that", "these", "those", "there", "here", "will", "would", "can", "could",
  "has", "have", "had", "do", "does", "did", "not", "no", "s", "t",
]);

/**
 * Content words, lightly stemmed so a plural in one line matches its singular
 * in the other ("games"/"game", "services"/"service").
 */
function contentWords(text) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const out = new Set();
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    out.add(word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
  }
  return out;
}

/** How many content words the summary contributes beyond the headline. */
export function novelWordCount(title, summary) {
  const titleWords = contentWords(title);
  let novel = 0;
  for (const word of contentWords(summary)) {
    if (!titleWords.has(word)) novel += 1;
  }
  return novel;
}

/**
 * True when the summary should be dropped rather than printed: it is missing,
 * it is the headline verbatim, or it adds at most MIN_NOVEL_WORDS - 1 content
 * words of its own.
 */
export const MIN_NOVEL_WORDS = 3;

export function summaryEchoesTitle(title, summary) {
  const text = String(summary || "").trim();
  if (!text) return true;
  const headline = String(title || "").trim();
  if (!headline) return false;
  if (text.replace(/[.\s]+$/, "").toLowerCase() === headline.replace(/[.\s]+$/, "").toLowerCase()) {
    return true;
  }
  return novelWordCount(headline, text) < MIN_NOVEL_WORDS;
}
