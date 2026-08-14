export const BOARDWALK_2026_SCHEDULE_URL =
  "https://beachboardwalk.com/wp-content/uploads/2026/06/26-142-Summer-Entertainment-Schedule-rev061126-1.pdf";

export const BOARDWALK_2026_SEASON_END = "2026-08-07";

const BOARDWALK_URL = "https://beachboardwalk.com/Free-Friday-Night-Bands";
const BOARDWALK_DESCRIPTION = "Free live music on the beach bandstand.";

function boardwalkBand(date, description = BOARDWALK_DESCRIPTION) {
  return Object.freeze({
    title: "Free Friday Night Bands at the Boardwalk",
    date,
    time: "6:30 PM",
    venue: "Santa Cruz Beach Boardwalk",
    address: "400 Beach St, Santa Cruz, CA 95060",
    url: BOARDWALK_URL,
    description,
    category: "music",
    cost: "free",
  });
}

// The official 2026 Boardwalk summer-entertainment schedule ends Aug 7.
// Keep the season boundary beside these manually curated rows so a projected
// late-August recurrence cannot silently return.
export const BOARDWALK_2026_EVENTS = Object.freeze([
  boardwalkBand(
    "2026-06-19",
    "Free live music on the beach bandstand. Bring a blanket — seating is first-come-first-served. Lineup announced monthly at beachboardwalk.com.",
  ),
  boardwalkBand("2026-06-26"),
  boardwalkBand("2026-07-03", "Free live music on the beach bandstand. Stay for the fireworks."),
  boardwalkBand("2026-07-10"),
  boardwalkBand("2026-07-17"),
  boardwalkBand("2026-07-24"),
  boardwalkBand("2026-07-31"),
  boardwalkBand("2026-08-07"),
]);
