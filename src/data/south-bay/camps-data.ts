// ---------------------------------------------------------------------------
// South Bay Signal — Summer Camp Data 2026
// ---------------------------------------------------------------------------

export type CampType = "general" | "sports" | "arts" | "stem" | "nature" | "specialty";

export interface CampWeek {
  weekNum: number;
  label: string;        // "Week 1"
  startDate: string;    // "2026-06-22" ISO
  endDate: string;      // "2026-06-26"
  displayDates: string; // "Jun 22–26"
  residentPrice: number | null;
  nonResidentPrice?: number | null;
  courseNumber?: string;
}

export interface Camp {
  id: string;
  name: string;
  cityId: string;
  cityName: string;
  type: CampType;
  tags: string[];
  ageMin: number;
  ageMax: number;
  weeks: CampWeek[];
  hours: string;
  days: string;
  locations: string[];
  description: string;
  registerUrl: string;
  notes?: string;
  featured?: boolean;
}

export const SUMMER_WEEKS = [
  { startDate: "2026-06-22", endDate: "2026-06-26", label: "Jun 22–26", weekNum: 1 },
  { startDate: "2026-06-29", endDate: "2026-07-02", label: "Jun 29–Jul 2*", weekNum: 2 },
  { startDate: "2026-07-06", endDate: "2026-07-10", label: "Jul 6–10", weekNum: 3 },
  { startDate: "2026-07-13", endDate: "2026-07-17", label: "Jul 13–17", weekNum: 4 },
  { startDate: "2026-07-20", endDate: "2026-07-24", label: "Jul 20–24", weekNum: 5 },
  { startDate: "2026-07-27", endDate: "2026-07-31", label: "Jul 27–31", weekNum: 6 },
  { startDate: "2026-08-03", endDate: "2026-08-07", label: "Aug 3–7", weekNum: 7 },
  { startDate: "2026-08-10", endDate: "2026-08-14", label: "Aug 10–14", weekNum: 8 },
  { startDate: "2026-08-17", endDate: "2026-08-21", label: "Aug 17–21", weekNum: 9 },
] as const;

// ---------------------------------------------------------------------------
// Camp data
// ---------------------------------------------------------------------------

export const CAMPS: Camp[] = [
  // ── San Jose ──────────────────────────────────────────────────────────────
  {
    id: "sj-camp-san-jose",
    name: "Camp San Jose",
    cityId: "san-jose",
    cityName: "San Jose",
    type: "general",
    tags: ["field trips", "enrichment", "t-shirt included"],
    ageMin: 5,
    ageMax: 17,
    hours: "8am–6pm",
    days: "Mon–Fri",
    locations: ["Hamman Park", "Alviso Adobe Park", "Backesto Park", "Various city parks"],
    description: "San Jose's flagship city summer program. Kids explore parks across the city with field trips, games, arts and crafts, and outdoor activities each week.",
    registerUrl: "https://sjregistration.com",
    notes: "No program Fri 7/4. Flexible payment — reserve spot for $50.",
    featured: true,
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 290, nonResidentPrice: 294 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 257, nonResidentPrice: 261 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 290, nonResidentPrice: 294 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 290, nonResidentPrice: 294 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 290, nonResidentPrice: 294 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 290, nonResidentPrice: 294 },
      { weekNum: 7, label: "Week 7", startDate: "2026-08-03", endDate: "2026-08-07", displayDates: "Aug 3–7", residentPrice: 290, nonResidentPrice: 294 },
      { weekNum: 8, label: "Week 8", startDate: "2026-08-10", endDate: "2026-08-14", displayDates: "Aug 10–14", residentPrice: 290, nonResidentPrice: 294 },
    ],
  },

  // ── Sunnyvale ─────────────────────────────────────────────────────────────
  {
    id: "sv-summer-discovery",
    name: "Sunnyvale Summer Discovery",
    cityId: "sunnyvale",
    cityName: "Sunnyvale",
    type: "general",
    tags: ["enrichment", "outdoor", "arts & crafts"],
    ageMin: 5,
    ageMax: 14,
    hours: "7:30am–6pm",
    days: "Mon–Fri",
    locations: ["Las Palmas Park", "Lakewood Park", "Columbia Neighborhood Center"],
    description: "Sunnyvale's city-run day camp with weekly themes, outdoor play, creative projects, and organized games at parks across the city.",
    registerUrl: "https://sunnyvale.ca.gov/recreation",
    notes: "Prices approximate — verify at city website before registering.",
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 275 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 245 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 275 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 275 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 275 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 275 },
      { weekNum: 7, label: "Week 7", startDate: "2026-08-03", endDate: "2026-08-07", displayDates: "Aug 3–7", residentPrice: 275 },
      { weekNum: 8, label: "Week 8", startDate: "2026-08-10", endDate: "2026-08-14", displayDates: "Aug 10–14", residentPrice: 275 },
    ],
  },

  // ── Mountain View ─────────────────────────────────────────────────────────
  {
    id: "mv-adventure-camp",
    name: "Mountain View Adventure Camp",
    cityId: "mountain-view",
    cityName: "Mountain View",
    type: "general",
    tags: ["outdoor", "swimming", "field trips"],
    ageMin: 6,
    ageMax: 13,
    hours: "8am–5:30pm",
    days: "Mon–Fri",
    locations: ["Rengstorff Park", "Cuesta Park", "Eagle Park"],
    description: "Active days at Mountain View parks with swimming, sports, nature hikes, and Friday field trips to destinations around the Bay Area.",
    registerUrl: "https://mountainview.gov/recreation",
    notes: "Prices approximate — verify at city website before registering.",
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 265 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 235 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 265 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 265 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 265 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 265 },
      { weekNum: 7, label: "Week 7", startDate: "2026-08-03", endDate: "2026-08-07", displayDates: "Aug 3–7", residentPrice: 265 },
      { weekNum: 8, label: "Week 8", startDate: "2026-08-10", endDate: "2026-08-14", displayDates: "Aug 10–14", residentPrice: 265 },
    ],
  },

  // ── Santa Clara ───────────────────────────────────────────────────────────
  {
    id: "sc-explorer-camp",
    name: "Santa Clara Explorer Camp",
    cityId: "santa-clara",
    cityName: "Santa Clara",
    type: "general",
    tags: ["arts & crafts", "sports", "enrichment"],
    ageMin: 5,
    ageMax: 14,
    hours: "7:45am–5:45pm",
    days: "Mon–Fri",
    locations: ["Central Park", "Camelot Park", "Reed & Larkin Street Park"],
    description: "Week-themed day camp at Santa Clara city parks. Campers rotate through arts, sports, STEM activities, and outdoor games.",
    registerUrl: "https://santaclaraca.gov/recreation",
    notes: "Prices approximate — verify at city website before registering.",
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 280 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 250 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 280 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 280 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 280 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 280 },
      { weekNum: 7, label: "Week 7", startDate: "2026-08-03", endDate: "2026-08-07", displayDates: "Aug 3–7", residentPrice: 280 },
    ],
  },

  // ── Campbell ──────────────────────────────────────────────────────────────
  {
    id: "ca-summer-blast",
    name: "Campbell Summer Blast",
    cityId: "campbell",
    cityName: "Campbell",
    type: "general",
    tags: ["outdoor", "swimming", "small groups"],
    ageMin: 6,
    ageMax: 12,
    hours: "8am–5pm",
    days: "Mon–Fri",
    locations: ["Campbell Community Center", "Los Gatos Creek Park"],
    description: "Campbell's summer day camp with swimming trips, outdoor games, crafts, and a tight-knit small-city vibe. Groups stay together all week.",
    registerUrl: "https://campbell.ca.gov/recreation",
    notes: "Prices approximate — verify at city website before registering.",
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 250 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 225 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 250 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 250 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 250 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 250 },
      { weekNum: 7, label: "Week 7", startDate: "2026-08-03", endDate: "2026-08-07", displayDates: "Aug 3–7", residentPrice: 250 },
    ],
  },

  // ── Cupertino ─────────────────────────────────────────────────────────────
  {
    id: "cu-tech-explorers",
    name: "Cupertino Tech Explorers",
    cityId: "cupertino",
    cityName: "Cupertino",
    type: "stem",
    tags: ["coding", "robotics", "science"],
    ageMin: 7,
    ageMax: 14,
    hours: "9am–3pm",
    days: "Mon–Fri",
    locations: ["Cupertino Community Hall", "Quinlan Community Center"],
    description: "STEM-focused summer camp in the heart of Silicon Valley. Campers try coding, robotics kits, basic electronics, and science experiments — no experience needed.",
    registerUrl: "https://cupertino.org/recreation",
    notes: "Prices approximate — verify at city website before registering.",
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 310 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 280 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 310 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 310 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 310 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 310 },
      { weekNum: 7, label: "Week 7", startDate: "2026-08-03", endDate: "2026-08-07", displayDates: "Aug 3–7", residentPrice: 310 },
      { weekNum: 8, label: "Week 8", startDate: "2026-08-10", endDate: "2026-08-14", displayDates: "Aug 10–14", residentPrice: 310 },
    ],
  },

  // ── Milpitas ──────────────────────────────────────────────────────────────
  {
    id: "mp-summer-fun",
    name: "Milpitas Summer Fun Camp",
    cityId: "milpitas",
    cityName: "Milpitas",
    type: "general",
    tags: ["outdoor", "multi-sport", "enrichment"],
    ageMin: 5,
    ageMax: 13,
    hours: "7:30am–6pm",
    days: "Mon–Fri",
    locations: ["Murphy Park", "Cardoza Park", "Milpitas Community Center"],
    description: "A full summer of outdoor play, sports, and themed activities at Milpitas parks. Extended care available from 7:30am.",
    registerUrl: "https://ci.milpitas.ca.gov/recreation",
    notes: "Prices approximate — verify at city website before registering.",
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 255 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 225 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 255 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 255 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 255 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 255 },
      { weekNum: 7, label: "Week 7", startDate: "2026-08-03", endDate: "2026-08-07", displayDates: "Aug 3–7", residentPrice: 255 },
      { weekNum: 8, label: "Week 8", startDate: "2026-08-10", endDate: "2026-08-14", displayDates: "Aug 10–14", residentPrice: 255 },
      { weekNum: 9, label: "Week 9", startDate: "2026-08-17", endDate: "2026-08-21", displayDates: "Aug 17–21", residentPrice: 255 },
    ],
  },

  // ── Los Gatos ─────────────────────────────────────────────────────────────
  {
    id: "lg-camp-wildcat",
    name: "Los Gatos Camp Wildcat",
    cityId: "los-gatos",
    cityName: "Los Gatos",
    type: "nature",
    tags: ["hiking", "nature", "outdoor adventure"],
    ageMin: 7,
    ageMax: 14,
    hours: "8:30am–4:30pm",
    days: "Mon–Fri",
    locations: ["Vasona Lake County Park", "Oak Meadow Park", "Los Gatos Creek Trail"],
    description: "Nature-focused camp in the Santa Cruz Mountain foothills. Days spent at Vasona Lake and nearby trails — hiking, fishing, creek exploration, and wildlife observation.",
    registerUrl: "https://losgatosca.gov/recreation",
    notes: "Prices approximate — verify at city website before registering.",
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 295 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 265 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 295 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 295 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 295 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 295 },
      { weekNum: 7, label: "Week 7", startDate: "2026-08-03", endDate: "2026-08-07", displayDates: "Aug 3–7", residentPrice: 295 },
    ],
  },

  // ── Palo Alto ─────────────────────────────────────────────────────────────
  {
    id: "pa-creative-arts",
    name: "Palo Alto Creative Arts Camp",
    cityId: "palo-alto",
    cityName: "Palo Alto",
    type: "arts",
    tags: ["visual arts", "performing arts", "music"],
    ageMin: 6,
    ageMax: 14,
    hours: "9am–4pm",
    days: "Mon–Fri",
    locations: ["Lucie Stern Community Center", "Mitchell Park Community Center"],
    description: "Arts-focused summer camp through Palo Alto Recreation. Weekly themes cover drawing, painting, theater, and basic music — each week ends with a mini showcase.",
    registerUrl: "https://cityofpaloalto.org/recreation",
    notes: "Prices approximate — verify at city website before registering.",
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 320 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 285 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 320 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 320 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 320 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 320 },
      { weekNum: 7, label: "Week 7", startDate: "2026-08-03", endDate: "2026-08-07", displayDates: "Aug 3–7", residentPrice: 320 },
      { weekNum: 8, label: "Week 8", startDate: "2026-08-10", endDate: "2026-08-14", displayDates: "Aug 10–14", residentPrice: 320 },
    ],
  },

  // ── Saratoga ──────────────────────────────────────────────────────────────
  {
    id: "sa-summer-village",
    name: "Saratoga Summer Village",
    cityId: "saratoga",
    cityName: "Saratoga",
    type: "general",
    tags: ["outdoor", "enrichment", "small groups"],
    ageMin: 5,
    ageMax: 12,
    hours: "8am–5pm",
    days: "Mon–Fri",
    locations: ["Kevin Moran Park", "El Quito Park", "Saratoga Community Center"],
    description: "Small-town summer camp in Saratoga with low camper-to-counselor ratios. Activities include garden science, outdoor art, nature walks, and sports.",
    registerUrl: "https://saratoga.ca.us/recreation",
    notes: "Prices approximate — verify at city website before registering.",
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 270 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 240 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 270 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 270 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 270 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 270 },
    ],
  },

  // ── Los Altos ─────────────────────────────────────────────────────────────
  {
    id: "la-adventure-day",
    name: "Los Altos Adventure Day Camp",
    cityId: "los-altos",
    cityName: "Los Altos",
    type: "general",
    tags: ["multi-sport", "outdoor", "swimming"],
    ageMin: 6,
    ageMax: 13,
    hours: "8am–5:30pm",
    days: "Mon–Fri",
    locations: ["Shoup Park", "Grant Park", "Los Altos Recreation Center"],
    description: "Active summer days at Los Altos parks with swimming, multi-sport rotations, and nature activities. A popular local option that fills up fast.",
    registerUrl: "https://losaltosca.gov/recreation",
    notes: "Prices approximate — verify at city website before registering.",
    weeks: [
      { weekNum: 1, label: "Week 1", startDate: "2026-06-22", endDate: "2026-06-26", displayDates: "Jun 22–26", residentPrice: 285 },
      { weekNum: 2, label: "Week 2", startDate: "2026-06-29", endDate: "2026-07-02", displayDates: "Jun 29–Jul 2", residentPrice: 255 },
      { weekNum: 3, label: "Week 3", startDate: "2026-07-06", endDate: "2026-07-10", displayDates: "Jul 6–10", residentPrice: 285 },
      { weekNum: 4, label: "Week 4", startDate: "2026-07-13", endDate: "2026-07-17", displayDates: "Jul 13–17", residentPrice: 285 },
      { weekNum: 5, label: "Week 5", startDate: "2026-07-20", endDate: "2026-07-24", displayDates: "Jul 20–24", residentPrice: 285 },
      { weekNum: 6, label: "Week 6", startDate: "2026-07-27", endDate: "2026-07-31", displayDates: "Jul 27–31", residentPrice: 285 },
      { weekNum: 7, label: "Week 7", startDate: "2026-08-03", endDate: "2026-08-07", displayDates: "Aug 3–7", residentPrice: 285 },
      { weekNum: 8, label: "Week 8", startDate: "2026-08-10", endDate: "2026-08-14", displayDates: "Aug 10–14", residentPrice: 285 },
    ],
  },
];
