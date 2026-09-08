// Shared source HTML cleanup; preserve the established ingest behavior.
export function stripHtml(html) {
  if (!html) return "";
  return html
    // Decode entities first so entity-encoded tags like &lt;strong&gt; become <strong> before stripping
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#x2019;/gi, "\u2019").replace(/&#x2018;/gi, "\u2018")
    .replace(/&#x201C;/gi, "\u201C").replace(/&#x201D;/gi, "\u201D")
    .replace(/&#x2013;/gi, "\u2013").replace(/&#x2014;/gi, "\u2014")
    // Preserve `\u2026` \u2014 the catch-all stripper below would otherwise drop it,
    // which loses the `[\u2026]` marker that CHM's stripChmRssBoilerplate uses to
    // anchor the WordPress footer strip. Without this, the footer survives
    // until truncate() chops it mid-sentence ("The post\u2026").
    .replace(/&hellip;|&#8230;|&#x2026;/gi, "\u2026")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&[a-z]+;/g, "")
    // BiblioCommons (and other rich-text editors) occasionally save a word
    // wrapped across two adjacent same-tag inline-formatting runs — e.g.
    // `<strong>g</strong><strong>rades 4-5</strong>` from an SCCL Page
    // Turners listing. The catch-all tag-stripper below replaces each tag
    // with a single space, which turns the boundary into "g rades" (two
    // adjacent spaces collapse to one, leaving a literal space mid-word).
    // Drop the boundary when both tags are the same inline-formatting tag
    // so the word reunites before the catch-all runs.
    .replace(/<\/(strong|em|b|i|u|span)\b[^>]*><\1\b[^>]*>/gi, "")
    // Superscript/subscript tags wrap a fragment that's joined to the
    // preceding token with no whitespace — ordinal suffixes ("3<sup>rd</sup>"
    // → "3rd"), footnote markers, chemical formulas ("H<sub>2</sub>O").
    // The catch-all tag stripper replaces each tag with a space, which
    // turns "3<sup>rd</sup>" into "3 rd". Drop sup/sub tags without
    // inserting whitespace so the fragment stays joined.
    .replace(/<\/?(sup|sub)\b[^>]*>/gi, "")
    // Drop the CONTENT of style/script blocks before the catch-all below,
    // which only removes the tags and leaves the CSS/JS text in the prose.
    // LibCal wraps each "Click Here to Register" button in an inline <style>,
    // so all eight Community Preservation Lab descriptions shipped a rule set
    // ("#s_lc_event_16714527 { background: #228B22; ... }") into
    // playwright-events.json, saved from readers only by a later truncation.
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    // Then strip all HTML tags
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim();
}
