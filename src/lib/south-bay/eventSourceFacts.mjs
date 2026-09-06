// Occurrence-specific corrections verified against first-party sources.
// Keep these upstream of blurb resolution so nightly refreshes cannot restore
// a sparse aggregator record or its previously invented cached copy.
// Evidence: docs/qa/2026-09-05-newsletter.md and 2026-09-06-newsletter.md.
const DERBY_ATTENDANCE = "12 first-come, first-served tickets. The library’s pickup instructions conflict with its 2 PM start; confirm pickup timing with Berryessa Library before going.";
const CORRECTIONS = [
  {
    id: "sjpl-6a7bc1324cb69d003e203e28",
    date: "2026-09-06",
    url: "https://sjpl.bibliocommons.com/events/6a7bc1324cb69d003e203e28",
    facts: {
      time: "2:00 PM",
      endTime: "3:30 PM",
      sourceAudiences: ["Kids, ages 5-10"],
      audienceAge: "kids",
      kidFriendly: true,
      description: `Build and race two balloon-powered cars in Berryessa Library’s Community Room. Recommended for elementary students ages 5–10. ${DERBY_ATTENDANCE}`,
      blurb: "Build and race balloon-powered cars, recommended for ages 5–10.",
      attendanceNote: DERBY_ATTENDANCE,
      attendanceStatus: "needs-confirmation",
    },
  },
  {
    id: "cbdd438d7fbe",
    date: "2026-09-06",
    url: "https://losgatosca.libcal.com/event/17096186",
    facts: {
      sourceAudiences: ["Adults"],
      audienceAge: "adult",
      kidFriendly: false,
      description: "Training for adults in the Los Gatos Library Lobby, 4–5 PM, on recognizing an opioid overdose and using Narcan.",
      blurb: "Adults can learn to recognize an opioid overdose and use Narcan in the library lobby.",
    },
  },
  {
    id: "sanjosetheaters-eb92ddeb3f824327",
    date: "2026-09-05",
    title: /grupo duelo/i,
    venue: /san jose civic/i,
    facts: {
      description: "Óscar Iván Treviño and Grupo Duelo bring their norteño music to San Jose Civic on the Gravedad Tour 2026.",
      blurb: "Hear Óscar Iván Treviño and Grupo Duelo perform norteño music at San Jose Civic.",
    },
  },
  {
    id: "tm-Z7r9jZ1A7x78x",
    date: "2026-09-05",
    title: /lost 80['’]?s live/i,
    venue: /mountain winery/i,
    facts: {
      description: "Lost 80s Live features original vocalists or members, including Oingo Boingo Former Members, The Vapors, China Crisis, Big Country, B-Movie, Katrina, Icicle Works and Musical Youth. Show at 6 PM; doors at 4 PM.",
      blurb: "Hear Oingo Boingo Former Members, The Vapors, China Crisis and more at Lost 80s Live.",
      url: "https://lost80slive.com/event/mwc09052026/",
      time: "6:00 PM",
    },
  },
  {
    id: "sjpl-6a5280ebe564853d00fd6ea4",
    date: "2026-09-05",
    title: /pawsitive learning with town cats/i,
    venue: /vineland library/i,
    facts: {
      description: "Learn responsible cat care with Town Cats at Vineland Library, 2–3 PM. Recommended for ages 5+. Space is limited; tickets are available at the Information Desk starting at 1 PM.",
      blurb: "Learn cat care with Town Cats; pick up a ticket at Vineland Library’s Information Desk starting at 1 PM.",
      attendanceNote: "Recommended for ages 5+. Limited space; in-person ticket pickup at the Information Desk starts at 1 PM for the 2–3 PM program.",
    },
  },
];

export function applyVerifiedEventFacts(event) {
  const correction = CORRECTIONS.find((c) => event?.date === c.date && (
    event.id === c.id || (c.url && event.url === c.url)
      || (c.title?.test(event.title || "") && c.venue?.test(event.venue || ""))
  ));
  return correction ? { ...event, ...correction.facts } : event;
}

// Validate source claims, not the model's earlier blurb. Empty/truncated
// descriptions are not permission to invent whether an act is a cover band.
export function eventCopyFactConflict(text, event) {
  const copy = String(text || "");
  const source = `${event?.rawTitle || event?.title || ""} ${event?.description || ""}`;
  if (/\b(?:cover|tribute)[\s-]+(?:bands?|acts?|groups?|artists?)\b/i.test(copy)
      && !/\b(?:cover|tribute)\b/i.test(source)) return "unsupported cover/tribute identity";
  if (/\b(?:original|founding)\s+(?:members?|vocalists?|singers?|lineup)\b/i.test(copy)
      && !/\b(?:original|founding)\s+(?:members?|vocalists?|singers?|lineup)\b/i.test(source)) {
    return "unsupported original-member identity";
  }
  if (/\bbanda\b/i.test(copy) && !/\bbanda\b/i.test(source)) return "unsupported banda genre";
  return null;
}

function comparable(value) {
  return String(value || "").toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function copyMentionsEvent(text, event) {
  const rawTitle = String(event?.rawTitle || event?.title || "").split(/\s[–—-]\s/)[0];
  const title = comparable(rawTitle);
  const copy = comparable(text);
  if (title.length >= 5 && copy.includes(title)) return true;
  // Intros often omit a category prefix: "the balloon car derby" still
  // refers to "STEM: Balloon Car Derby" and needs the same attendance guard.
  const withoutPrefix = comparable(rawTitle.match(/^[^:]{1,32}:\s+(.+)$/)?.[1]);
  return withoutPrefix.length >= 10 && withoutPrefix.includes(" ") && copy.includes(withoutPrefix);
}
