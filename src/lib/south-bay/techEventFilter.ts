// ---------------------------------------------------------------------------
// Tech tab — "is this a tech event?" test
// ---------------------------------------------------------------------------
// Lives here rather than inside TechnologyView so the keyword/exclude pair can
// be exercised directly. The Tech tab shows at most five upcoming events, so a
// recurring false positive doesn't just add noise — it evicts the real talks.
// ---------------------------------------------------------------------------

export const TECH_EVENT_KEYWORDS =
  /\b(ai|robot|silicon|tech|chip|algorithm|startup|venture|humanoid|machine learning|neural|innovation|physical ai|autonomous)\b/i;

// Library one-on-one tech-help appointments match TECH_EVENT_KEYWORDS on
// "tech" but are a help desk, not a tech event, and South Bay library systems
// publish them under a moving set of names. The original list caught "1-on-1"
// and "one-on-one"; the same programs also ship as "1:1 Tech Mentor", "1 on 1
// Tech Assistance / Asistencia Tecnología", and a bare "Tech Mentor".
export const TECH_EVENT_EXCLUDES =
  /\bhelp\b|digital skills|computer help|tech help|tech mentor|tech assistance|tech tutor|tech coach|1-on-1|one-on-one|\b1\s*:\s*1\b|\b1\s+on\s+1\b/i;

export interface TechEventCandidate {
  title: string;
  venue?: string;
}

export function isTechEvent(e: TechEventCandidate): boolean {
  // Everything the Computer History Museum runs qualifies on venue alone.
  const isChm = !!e.venue?.toLowerCase().includes("computer history");
  const isTechTitle =
    TECH_EVENT_KEYWORDS.test(e.title) && !TECH_EVENT_EXCLUDES.test(e.title);
  return isChm || isTechTitle;
}
