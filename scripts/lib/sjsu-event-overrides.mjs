const SEPTEMBER_10_READING_URL =
  "https://events.sjsu.edu/event/september-10-campus-reading-discussion-and-film";

// Localist currently publishes this one-day program as five all-day
// occurrences. SJSU's event poster is the controlling source: the discussion
// begins Sep. 10 at 4 PM in Sweeney Hall 413, followed by the film at 5:30 PM
// in Uchida Hall 124.
export function applyVerifiedSjsuEventOverride(event) {
  const url = String(event?.url || "").replace(/\/+$/, "");
  if (url !== SEPTEMBER_10_READING_URL) return event;
  if (event.date !== "2026-09-10") return null;

  return {
    ...event,
    displayDate: "Thu, Sep 10",
    time: "4:00 PM",
    endTime: null,
    venue: "Sweeney Hall 413 and Uchida Hall 124",
    description:
      "Dr. Emily Slusser leads a 4 PM discussion of Asimov's “Robbie” in Sweeney Hall 413, followed by a 5:30 PM screening of M3GAN in Uchida Hall 124.",
  };
}
