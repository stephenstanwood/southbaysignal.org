// Library attendance instructions often appear after the opening paragraph.
// Preserve them before display-copy shortening or blurb generation, and keep
// the source's audience labels separate from guesses based on the prose.
import { stripHtml } from "./event-html.mjs";

const text = (html) => stripHtml(String(html || "").replace(/<!--[^]*?-->/g, ""));

export function libraryEventDetails(event, entities = {}) {
  const definition = event.definition || event;
  const labels = [
    ...(event.audiences || []),
    ...(definition.audienceIds || []).map((id) => entities.eventAudiences?.[id]),
  ];
  const sourceAudiences = [...new Set(labels.map((label) =>
    text(typeof label === "string" ? label : label?.name)).filter(Boolean))];
  const html = event.description || definition.description || event.shortdesc || "";
  const instructions = definition.registrationInfo?.instructions || "";
  const attendanceNote = [...new Set(`${html}\n${instructions}`
    .split(/<\/(?:p|li|div)>|<br\s*\/?>|\n/gi)
    .map(text)
    .filter((paragraph) => /\b(?:tickets?|first[-\s]come|space is limited|limited (?:space|seating))\b/i.test(paragraph)))]
    .join(" ");
  return {
    description: text(html),
    ...(sourceAudiences.length ? { sourceAudiences } : {}),
    ...(attendanceNote ? { attendanceNote } : {}),
  };
}
