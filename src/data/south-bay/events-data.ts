// ---------------------------------------------------------------------------
// South Bay Signal — events data
// ---------------------------------------------------------------------------
// Real events with specific schedules (day, time, season).
// Permanent venues and POIs live in poi-data.ts for Plan My Day.
// ---------------------------------------------------------------------------

import type { City } from "../../lib/south-bay/types";

export type EventCategory =
  | "market"
  | "family"
  | "music"
  | "arts"
  | "sports"
  | "community"
  | "outdoor"
  | "education"
  | "food";

export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type RecurrenceType = "weekly" | "biweekly" | "monthly" | "seasonal" | "ongoing";

export interface SBEvent {
  id: string;
  title: string;
  city: City;
  venue: string;
  address?: string;
  category: EventCategory;
  recurrence: RecurrenceType;
  days?: DayOfWeek[];
  time?: string;
  months?: number[]; // 1=Jan, 12=Dec. omit = year-round
  cost: "free" | "low" | "paid"; // free=0, low=<$15, paid=$15+
  costNote?: string;
  kidFriendly: boolean;
  description: string;
  url?: string;
  emoji: string;
  featured?: boolean;
  /**
   * Optional logo/cap image URL. Used for sports affiliates and venues whose
   * brand mark reads better than a Recraft illustration.
   */
  image?: string;
  /**
   * ISO date string (YYYY-MM-DD). If set, the event is not displayed before this date.
   * Use for venues temporarily closed (renovation, seasonal open, etc.).
   */
  startDate?: string;
}

export const SOUTH_BAY_EVENTS: SBEvent[] = [
  // ── FARMERS MARKETS ──────────────────────────────────────────────────────

  {
    id: "campbell-farmers-market",
    title: "Campbell Farmers Market",
    city: "campbell",
    venue: "Downtown Campbell",
    address: "Campbell Ave & Central Ave, Campbell",
    category: "market",
    recurrence: "weekly",
    days: ["sunday"],
    time: "9am – 1pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Year-round downtown market with produce, flowers, honey, specialty foods, and artisan goods. Live music most weeks.",
    url: "https://www.campbellfarmersmarket.com",
    emoji: "🌽",
    featured: true,
  },
  {
    id: "mv-castro-farmers-market",
    title: "Mountain View Farmers Market",
    city: "mountain-view",
    venue: "Mountain View Caltrain Station lot",
    address: "600 W Evelyn Ave, Mountain View",
    category: "market",
    recurrence: "weekly",
    days: ["sunday"],
    time: "9am – 1pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Beloved year-round market at the downtown Caltrain station lot, steps from Castro Street. Fresh produce, baked goods, artisan cheese, flowers, and prepared foods.",
    url: "https://www.cafarmersmkts.com/mountain-view-farmers-market",
    emoji: "🌸",
    featured: true,
  },
  {
    id: "sunnyvale-murphy-market",
    title: "Sunnyvale Farmers Market",
    city: "sunnyvale",
    venue: "Murphy Ave",
    address: "Murphy Ave, Sunnyvale",
    category: "market",
    recurrence: "weekly",
    days: ["saturday"],
    time: "9am – 1pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Weekly market on charming Murphy Ave in downtown Sunnyvale. Local produce, artisan foods, fresh flowers.",
    url: "https://sunnyvale.ca.gov/community/recreation-parks-and-cultural-services/special-events/sunnyvale-farmers-market",
    emoji: "🥦",
  },
  {
    id: "palo-alto-california-ave-market",
    title: "Palo Alto Farmers Market – California Ave",
    city: "palo-alto",
    venue: "California Ave",
    address: "California Ave, Palo Alto",
    category: "market",
    recurrence: "weekly",
    days: ["sunday"],
    time: "9am – 1pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Year-round Sunday market on California Avenue. Over 50 vendors with organic produce, specialty goods, and local artisans.",
    url: "https://uvfm.org/palo-alto-sundays",
    emoji: "🥕",
  },
  {
    id: "palo-alto-downtown-market",
    title: "Palo Alto Farmers Market – Downtown",
    city: "palo-alto",
    venue: "Gilman St",
    address: "Gilman St between Forest & Hamilton, Palo Alto",
    category: "market",
    recurrence: "weekly",
    days: ["saturday"],
    time: "8am – 12pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Volunteer-run Saturday market in the Gilman Street lots behind the downtown post office. Year-round, with a short break around the holidays.",
    url: "https://www.pafarmersmarket.org",
    emoji: "🍑",
  },
  {
    id: "los-gatos-farmers-market",
    title: "Los Gatos Farmers Market",
    city: "los-gatos",
    venue: "Town Plaza Park",
    address: "Main St & N Santa Cruz Ave, Los Gatos",
    category: "market",
    recurrence: "weekly",
    days: ["sunday"],
    time: "9am – 1pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Charming Sunday market at Town Plaza in downtown Los Gatos. Fresh produce, specialty foods, and artisan items.",
    url: "https://www.cafarmersmkts.com/losgatos-farmers-market",
    emoji: "🍓",
  },
  {
    id: "saratoga-village-market",
    title: "Saratoga Farmers Market",
    city: "saratoga",
    venue: "West Valley College",
    address: "14000 Fruitvale Ave, Saratoga",
    category: "market",
    recurrence: "weekly",
    days: ["saturday"],
    time: "9am – 1pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Year-round Saturday market at West Valley College, Parking Lot 3. Local produce and artisan vendors in a beautiful hillside setting.",
    url: "https://www.cafarmersmkts.com/saratoga-farmers-market",
    emoji: "🌼",
  },
  {
    id: "milpitas-market",
    title: "Milpitas Farmers Market",
    city: "milpitas",
    venue: "Great Mall",
    address: "882 Great Mall Dr, Milpitas",
    category: "market",
    recurrence: "weekly",
    days: ["sunday"],
    time: "8am – 1pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Year-round Sunday market at the Great Mall. Fresh produce and local vendors; accepts CalFresh EBT and Market Match.",
    url: "https://www.pcfma.org/market/milpitas-farmers-market",
    emoji: "🥬",
  },
  {
    id: "sj-willow-glen-market",
    title: "Willow Glen Farmers Market",
    city: "san-jose",
    venue: "Willow Glen Elementary School",
    address: "1425 Lincoln Ave, San Jose",
    category: "market",
    recurrence: "weekly",
    days: ["saturday"],
    time: "9am – 1pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Year-round Saturday market in the heart of Willow Glen. Popular neighborhood destination, rain or shine.",
    url: "https://uvfm.org/willow-glen-saturday",
    emoji: "🌿",
  },
  {
    id: "sj-downtown-market",
    title: "Downtown San Jose Farmers Market",
    city: "san-jose",
    venue: "San Pedro Street",
    address: "San Pedro St between Santa Clara & St John, San Jose",
    category: "market",
    recurrence: "weekly",
    days: ["friday"],
    time: "10am – 2pm",
    months: [6, 7, 8, 9, 10, 11, 12],
    cost: "free",
    kidFriendly: true,
    description:
      "Friday lunchtime market on San Pedro Street, early summer through mid-December. Fresh food, produce, and prepared meals for the downtown crowd.",
    url: "https://sjdowntown.com/downtown-farmers-market/",
    emoji: "🏙️",
  },
  {
    id: "los-altos-village-market",
    title: "Los Altos Village Farmers Market",
    city: "los-altos",
    venue: "State Street & Main Street",
    address: "State St, Los Altos",
    category: "market",
    recurrence: "weekly",
    days: ["thursday"],
    time: "4pm – 8pm",
    months: [5, 6, 7, 8, 9, 10],
    cost: "free",
    kidFriendly: true,
    description:
      "Charming seasonal Thursday market in the heart of Los Altos Village. Fresh produce, flowers, and artisan foods.",
    url: "https://www.pcfma.org/market/downtown-los-altos-farmers-market",
    emoji: "🌻",
  },
  {
    id: "cupertino-farmers-market",
    title: "Cupertino Farmers Market",
    city: "cupertino",
    venue: "De Anza College",
    address: "21250 Stevens Creek Blvd, Cupertino",
    category: "market",
    recurrence: "weekly",
    days: ["sunday"],
    time: "9am – 1pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Year-round Sunday market at De Anza College with fresh local produce, specialty foods, flowers, and artisan vendors.",
    url: "https://www.pcfma.org/market/de-anza-college-farmers-market",
    emoji: "🍎",
  },

  {
    id: "santana-row-farmers-market",
    title: "Santana Row Farmers Market",
    city: "san-jose",
    venue: "Santana Row",
    address: "377 Santana Row, San Jose",
    category: "market",
    recurrence: "weekly",
    days: ["wednesday"],
    time: "4pm – 8pm",
    months: [5, 6, 7, 8, 9],
    cost: "free",
    kidFriendly: true,
    description:
      "Outdoor farmers' market on Santana Row every Wednesday evening with organic produce, local cheeses, breads, flowers, and prepared foods.",
    url: "https://santanarow.com/event/farmers-market/",
    emoji: "🥬",
  },
  {
    id: "santana-row-makers-market",
    title: "Makers Market Local Artist Street Fair",
    city: "san-jose",
    venue: "Santana Row",
    address: "377 Santana Row, San Jose",
    category: "arts",
    recurrence: "monthly",
    days: ["saturday"],
    time: "11am – 6pm",
    cost: "free",
    kidFriendly: true,
    description:
      "Monthly street fair on the second Saturday with local artists, crafters, and makers. Handmade jewelry, ceramics, woodwork, apparel, live music. Sip & stroll event.",
    url: "https://santanarow.com/events/",
    emoji: "🎨",
  },
  {
    id: "santana-row-yoga",
    title: "Yoga & Pilates on The Row",
    city: "san-jose",
    venue: "Santana Row Park",
    address: "377 Santana Row, San Jose",
    category: "community",
    recurrence: "weekly",
    days: ["saturday"],
    time: "9am",
    months: [5, 6, 7, 8, 9, 10],
    cost: "free",
    kidFriendly: false,
    description:
      "Free Saturday morning yoga and Pilates in Santana Row Park with lululemon. Check-in at 8:30am, class at 9am. Bring your own mat.",
    url: "https://santanarow.com/events/",
    emoji: "🧘",
  },

  // ── MUSEUM PROGRAMS ────────────────────────────────────────────────────

  {
    id: "cdm-toddler-storytime",
    title: "Toddler Storytime — Children's Discovery Museum",
    city: "san-jose",
    venue: "Children's Discovery Museum",
    address: "180 Woz Way, San Jose",
    category: "family",
    recurrence: "weekly",
    days: ["wednesday", "thursday", "friday", "saturday", "sunday"],
    time: "11:30am",
    cost: "paid",
    costNote: "Included with museum admission",
    kidFriendly: true,
    description:
      "Drop-in storytime for toddlers in the Wonder Cabinet, Wednesday through Sunday at 11:30am.",
    url: "https://www.cdm.org/calendar/",
    emoji: "📖",
  },
  {
    id: "cdm-all-ages-storytime",
    title: "All Ages Storytime — Children's Discovery Museum",
    city: "san-jose",
    venue: "Children's Discovery Museum",
    address: "180 Woz Way, San Jose",
    category: "family",
    recurrence: "weekly",
    days: ["tuesday"],
    time: "11:30am",
    cost: "paid",
    costNote: "Included with museum admission",
    kidFriendly: true,
    description:
      "All-ages storytime in the Theatre every Tuesday at 11:30am.",
    url: "https://www.cdm.org/calendar/",
    emoji: "📚",
  },

  // ── LIBRARY PROGRAMS (with specific days/times) ────────────────────────

  {
    id: "campbell-library-music-movement",
    title: "Music & Movement — Campbell Library",
    city: "campbell",
    venue: "Campbell Library",
    address: "77 Harrison Ave, Campbell",
    category: "family",
    recurrence: "weekly",
    days: ["tuesday"],
    time: "10:30am",
    cost: "free",
    kidFriendly: true,
    description: "All-ages music and movement program at the newly reopened Campbell Library. 30 minutes of songs, instruments, and dancing.",
    url: "https://www.sccl.org/campbell",
    emoji: "🎵",
    startDate: "2026-05-26",
  },
  {
    id: "campbell-library-pajama-storytime",
    title: "Pajama Storytime — Campbell Library",
    city: "campbell",
    venue: "Campbell Library",
    address: "77 Harrison Ave, Campbell",
    category: "family",
    recurrence: "weekly",
    days: ["tuesday"],
    time: "6:30pm",
    cost: "free",
    kidFriendly: true,
    description: "Evening storytime for all ages — wear your pajamas. Wind-down stories before bed at the newly reopened Campbell Library.",
    url: "https://www.sccl.org/campbell",
    emoji: "🌙",
    startDate: "2026-05-26",
  },
  {
    id: "campbell-library-toddler-storytime",
    title: "Toddler Storytime — Campbell Library",
    city: "campbell",
    venue: "Campbell Library",
    address: "77 Harrison Ave, Campbell",
    category: "family",
    recurrence: "weekly",
    days: ["wednesday"],
    time: "10:30am",
    cost: "free",
    kidFriendly: true,
    description: "Storytime for ages 18 months – 5 years at the newly reopened Campbell Library.",
    url: "https://www.sccl.org/campbell",
    emoji: "📚",
    startDate: "2026-05-13",
  },
  {
    id: "campbell-library-baby-bounce",
    title: "Baby Bounce — Campbell Library",
    city: "campbell",
    venue: "Campbell Library",
    address: "77 Harrison Ave, Campbell",
    category: "family",
    recurrence: "weekly",
    days: ["thursday"],
    time: "10:30am",
    cost: "free",
    kidFriendly: true,
    description: "Storytime for babies 0–18 months at the newly reopened Campbell Library. Bouncing rhymes, songs, and lap-sit fun.",
    url: "https://www.sccl.org/campbell",
    emoji: "👶",
    startDate: "2026-06-04",
  },

  {
    id: "lg-library-baby-lapsit",
    title: "Baby Lap-Sit Storytime (Age 0–1) — Los Gatos Library",
    city: "los-gatos",
    venue: "Los Gatos Library",
    address: "110 E Main St, Los Gatos",
    category: "family",
    recurrence: "weekly",
    days: ["tuesday"],
    time: "9:30am",
    cost: "free",
    kidFriendly: true,
    description:
      "Storytime for babies age 0–1 in the Children's Room. Also offered Saturday mornings (Weekend Baby Lap-Sit).",
    url: "https://losgatosca.libcal.com",
    emoji: "👶",
  },
  {
    id: "lg-library-wonderful-ones",
    title: "Wonderful Ones Storytime — Los Gatos Library",
    city: "los-gatos",
    venue: "Los Gatos Library",
    address: "110 E Main St, Los Gatos",
    category: "family",
    recurrence: "weekly",
    days: ["thursday"],
    time: "11am",
    cost: "free",
    kidFriendly: true,
    description:
      "Storytime for one-year-olds in the Children's Room.",
    url: "https://losgatosca.libcal.com",
    emoji: "📖",
  },
  {
    id: "lg-library-preschool-storytime",
    title: "Preschool Storytime (Ages 2–5) — Los Gatos Library",
    city: "los-gatos",
    venue: "Los Gatos Library",
    address: "110 E Main St, Los Gatos",
    category: "family",
    recurrence: "weekly",
    days: ["wednesday"],
    time: "11am",
    cost: "free",
    kidFriendly: true,
    description:
      "Storytime for preschoolers ages 2–5 in the Children's Room.",
    url: "https://losgatosca.libcal.com",
    emoji: "📚",
  },

  {
    id: "lg-library-park-it-market",
    title: "Park-It Market — Los Gatos Library",
    city: "los-gatos",
    venue: "Los Gatos Library",
    address: "110 E Main St, Los Gatos",
    category: "food",
    recurrence: "biweekly",
    days: ["thursday"],
    time: "10am",
    cost: "free",
    kidFriendly: true,
    description:
      "West Valley Community Services offers free access to fresh produce, meat, dairy, dry goods and canned food on the 2nd and 4th Thursday of each month.",
    url: "https://www.wvcommunityservices.org",
    emoji: "🥬",
  },

  // ── CONCERT SERIES (specific schedules) ────────────────────────────────

  {
    id: "campbell-friday-music",
    title: "Campbell Summer Concert Series",
    city: "campbell",
    venue: "Orchard City Green",
    category: "music",
    recurrence: "weekly",
    days: ["thursday"],
    time: "6:30pm – 8pm",
    months: [7, 8],
    cost: "free",
    kidFriendly: true,
    description:
      "Free summer concerts on Orchard City Green with local bands, food, and drinks from nearby restaurants.",
    url: "https://www.campbellca.gov/280/Summer-Concert-Series",
    emoji: "🎸",
  },
  {
    id: "mv-free-concert-series",
    title: "Mountain View Free Summer Concerts",
    city: "mountain-view",
    venue: "Civic Center Plaza",
    category: "music",
    recurrence: "weekly",
    days: ["friday"],
    time: "6pm – 7:30pm",
    months: [6, 7, 8, 9],
    cost: "free",
    kidFriendly: true,
    description: "Free Friday-night outdoor concerts on Civic Center Plaza during the summer season.",
    url: "https://www.mountainview.gov/our-city/departments/community-services/special-events/concerts-on-the-plaza",
    emoji: "🎵",
  },
  {
    id: "los-gatos-summer-concerts",
    title: "Los Gatos Jazz on the Plazz",
    city: "los-gatos",
    venue: "Town Plaza Park",
    category: "music",
    recurrence: "weekly",
    days: ["wednesday"],
    time: "6:30pm – 8:30pm",
    months: [7, 8],
    cost: "free",
    kidFriendly: true,
    description:
      "Free Wednesday-evening jazz concerts in Town Plaza Park, presented by Los Gatos Music & Arts.",
    url: "https://www.losgatosmusicandarts.online/",
    emoji: "🎵",
  },
  {
    id: "sunnyvale-summer-concerts",
    title: "Sunnyvale Summer Concert Series",
    city: "sunnyvale",
    venue: "Murphy Avenue Plaza",
    category: "music",
    recurrence: "weekly",
    days: ["wednesday"],
    time: "6pm – 8:30pm",
    months: [7, 8],
    cost: "free",
    kidFriendly: true,
    description:
      "Free Wednesday-night summer music series on historic Murphy Avenue with live bands and local vendors.",
    url: "https://sunnyvaledowntown.org/events",
    emoji: "🎶",
  },
  {
    id: "santana-row-concerts",
    title: "Santana Row Weekend Concerts",
    city: "san-jose",
    venue: "Santana Row Plaza",
    category: "music",
    recurrence: "weekly",
    days: ["saturday", "sunday"],
    time: "Afternoons",
    months: [5, 6, 7, 8, 9, 10],
    cost: "free",
    kidFriendly: true,
    description:
      "Free live music in Santana Row's outdoor plaza on weekend afternoons during the warm season.",
    url: "https://www.santanarow.com/events/",
    emoji: "🎼",
  },

  // ── MONTHLY EVENTS ─────────────────────────────────────────────────────

  {
    id: "grpc-historic-orchard",
    title: "Volunteer in the Historic Orchard — Guadalupe River Park",
    city: "san-jose",
    venue: "Guadalupe Gardens Historic Orchard",
    address: "425 Seymour St, San Jose",
    category: "community",
    recurrence: "weekly",
    days: ["wednesday"],
    time: "9:30am – 11:30am",
    cost: "free",
    kidFriendly: true,
    description:
      "Help maintain the 3.3-acre Historic Orchard with UC Master Gardeners. Tree planting, pruning, mulching. Fruit donated to Second Harvest.",
    url: "https://grpg.org",
    emoji: "🌳",
  },
  {
    id: "grpc-heritage-rose-garden",
    title: "Volunteer in the Heritage Rose Garden",
    city: "san-jose",
    venue: "Heritage Rose Garden",
    address: "425 Seymour St, San Jose",
    category: "community",
    recurrence: "weekly",
    days: ["saturday"],
    time: "8:30am – 11:30am",
    cost: "free",
    kidFriendly: true,
    description:
      "Weeding, deadheading, pruning, and planting in the Heritage Rose Garden. Bring water and thick gloves.",
    url: "https://grpg.org",
    emoji: "🌹",
  },
  {
    id: "grpc-horticulture-open-hours",
    title: "Horticulture Open Hours — Guadalupe River Park",
    city: "san-jose",
    venue: "Guadalupe River Park",
    address: "425 Seymour St, San Jose",
    category: "community",
    recurrence: "monthly",
    days: ["friday"],
    time: "9am – 12pm",
    cost: "free",
    kidFriendly: true,
    description:
      "First Friday of every month. Seasonal park and gardens stewardship guided by GRPC's horticulturist — pruning, irrigation, mulching, and more.",
    url: "https://grpg.org",
    emoji: "🪴",
  },
  {
    id: "hakone-tea-ceremony",
    title: "Public Tea Ceremony — Hakone Gardens",
    city: "saratoga",
    venue: "Hakone Gardens",
    address: "21000 Big Basin Way, Saratoga",
    category: "arts",
    recurrence: "monthly",
    days: ["sunday"],
    time: "12pm, 1pm, 2pm",
    months: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    cost: "paid",
    costNote: "Separate from garden admission",
    kidFriendly: true,
    description:
      "Traditional Omote-senke tea ceremony demonstration on the first Sunday of every month, April through December. Three sessions available.",
    url: "https://www.hakonegardens.org",
    emoji: "🍵",
  },
  {
    id: "saratoga-nights",
    title: "Saratoga Nights",
    city: "saratoga",
    venue: "Historic Saratoga Village",
    address: "Big Basin Way, Saratoga",
    category: "community",
    recurrence: "monthly",
    days: ["thursday"],
    time: "5pm – 8pm",
    months: [5, 6, 7, 8, 9, 10],
    cost: "free",
    kidFriendly: true,
    description:
      "Monthly street festival in Historic Saratoga Village with live music, local food vendors, and community spirit. First Thursday, May through October.",
    url: "https://www.saratogachamber.org",
    emoji: "🌙",
  },
  {
    id: "sj-first-friday",
    title: "SoFA First Friday Art Walk",
    city: "san-jose",
    venue: "South First Street (SoFA District)",
    address: "South 1st Street, San Jose",
    category: "arts",
    recurrence: "monthly",
    days: ["friday"],
    time: "6pm – 10pm",
    cost: "free",
    kidFriendly: false,
    description:
      "Monthly art walk through San Jose's SoFA arts district on the first Friday. Galleries, studios, pop-up art, and street performers.",
    url: "https://www.southfirstfridays.com/",
    emoji: "🎭",
  },

  // ── SEASONAL / ANNUAL EVENTS ───────────────────────────────────────────

  {
    id: "sj-downtown-ice-rink",
    title: "Downtown San Jose Ice Rink",
    city: "san-jose",
    venue: "Rotary International Ice Rink",
    category: "family",
    recurrence: "seasonal",
    months: [11, 12, 1],
    cost: "low",
    costNote: "~$12 admission + skate rental",
    kidFriendly: true,
    description: "Outdoor holiday ice rink in downtown San Jose's Plaza de César Chávez. Nov–Jan.",
    url: "https://www.downtownicesj.com/",
    emoji: "⛸️",
  },
  {
    id: "viva-calle-sj",
    title: "Viva CalleSJ",
    city: "san-jose",
    venue: "San Jose streets (rotating routes)",
    category: "community",
    recurrence: "seasonal",
    months: [4, 5, 10, 11],
    cost: "free",
    kidFriendly: true,
    description:
      "Miles of San Jose streets temporarily closed to cars, open to walkers, cyclists, skaters, and dancers. Joyful open streets events in spring and fall.",
    url: "https://www.vivacallesj.org",
    emoji: "🚲",
    featured: true,
  },
  {
    id: "christmas-park-sj",
    title: "Christmas in the Park — San Jose",
    city: "san-jose",
    venue: "Plaza de César Chávez",
    address: "Paseo de San Antonio, San Jose",
    category: "community",
    recurrence: "seasonal",
    months: [11, 12],
    cost: "free",
    kidFriendly: true,
    description:
      "San Jose's beloved free holiday event. Hundreds of decorated trees, nightly entertainment, light displays — a longstanding downtown holiday tradition.",
    url: "https://christmasinthepark.com",
    emoji: "🎄",
    featured: true,
  },
  {
    id: "sj-jazz-summer-fest",
    title: "San Jose Jazz Summer Fest",
    city: "san-jose",
    venue: "Downtown San Jose",
    category: "music",
    recurrence: "seasonal",
    months: [8],
    cost: "free",
    costNote: "Street festival free; some ticketed stages",
    kidFriendly: true,
    description:
      "Three-day jazz festival with performances across downtown San Jose.",
    url: "https://sanjosejazz.org/summer-fest",
    emoji: "🎷",
    featured: true,
  },
  {
    id: "cinequest-film-festival",
    title: "Cinequest Film Festival",
    city: "san-jose",
    venue: "Downtown San Jose theaters",
    category: "arts",
    recurrence: "seasonal",
    months: [3],
    cost: "paid",
    costNote: "Individual films ~$15; passes available",
    kidFriendly: false,
    description:
      "Downtown San Jose film festival held each March, with independent films and premieres.",
    url: "https://cinequest.org",
    emoji: "🎬",
  },
  {
    id: "sunnyvale-art-wine-festival",
    title: "Sunnyvale Art & Wine Festival",
    city: "sunnyvale",
    venue: "Murphy Avenue, Sunnyvale",
    category: "community",
    recurrence: "seasonal",
    months: [5, 6],
    days: ["saturday", "sunday"],
    cost: "free",
    kidFriendly: true,
    description:
      "Two-day street festival with artists, wine and food vendors, and live music on multiple stages.",
    url: "https://www.sunnyvaleartandwine.com/",
    emoji: "🍷",
  },
  {
    id: "los-gatos-fiesta-artes",
    title: "Fiesta de Artes — Los Gatos",
    city: "los-gatos",
    venue: "Downtown Los Gatos",
    category: "arts",
    recurrence: "seasonal",
    months: [8],
    days: ["saturday", "sunday"],
    cost: "free",
    kidFriendly: true,
    description:
      "Annual August arts festival in downtown Los Gatos with juried artists, live music, and local food.",
    url: "https://losgatosfiesta.com/",
    emoji: "🎨",
  },
  {
    id: "sj-greek-festival",
    title: "San Jose Greek Festival",
    city: "san-jose",
    venue: "Saint Nicholas Greek Orthodox Church",
    address: "1260 Davis St, San Jose",
    category: "community",
    recurrence: "seasonal",
    months: [10],
    cost: "free",
    costNote: "Food and entertainment purchased separately",
    kidFriendly: true,
    description:
      "Three-day autumn festival celebrating Greek culture with authentic food, traditional dancing, and live music.",
    url: "https://www.sanjosegreekfestival.com/",
    emoji: "🫒",
  },
  {
    id: "tet-festival-sj",
    title: "Tet Festival — San Jose",
    city: "san-jose",
    venue: "Grand Century Mall area",
    address: "1111 Story Rd, San Jose",
    category: "community",
    recurrence: "seasonal",
    months: [1, 2],
    cost: "free",
    kidFriendly: true,
    description:
      "Lunar New Year / Tet celebrations around San Jose with cultural performances, food, firecrackers, and community pride.",
    url: "https://www.sanjose.org/lunarnewyear",
    emoji: "🏮",
    featured: true,
  },
  {
    id: "sj-jazz-winter-fest",
    title: "San Jose Jazz Winter Fest",
    city: "san-jose",
    venue: "San Jose Convention Center",
    category: "music",
    recurrence: "seasonal",
    months: [1],
    cost: "paid",
    costNote: "Individual sessions ~$25; day passes available",
    kidFriendly: false,
    description:
      "Indoor winter jazz festival at the Convention Center in January. World-class performers over two days.",
    url: "https://sanjosejazz.org/winter-fest",
    emoji: "🎷",
  },
  {
    id: "campbell-oktoberfest",
    title: "Campbell Oktoberfest",
    city: "campbell",
    venue: "Downtown Campbell",
    category: "community",
    recurrence: "seasonal",
    months: [10],
    days: ["saturday", "sunday"],
    cost: "free",
    costNote: "Beer and food purchased separately",
    kidFriendly: true,
    description:
      "Annual fall Oktoberfest in downtown Campbell with German beer, food, live bands, and family entertainment.",
    url: "https://campbelloktoberfest.com/",
    emoji: "🍺",
  },
  {
    id: "mountain-view-art-wine",
    title: "Mountain View Art & Wine Festival",
    city: "mountain-view",
    venue: "Castro Street, Mountain View",
    category: "community",
    recurrence: "seasonal",
    months: [9],
    days: ["saturday", "sunday"],
    cost: "free",
    kidFriendly: true,
    description:
      "Large street festival held the weekend after Labor Day, with artists, wineries, and live music on Castro Street.",
    url: "https://www.mvartwine.com",
    emoji: "🎨",
    featured: true,
  },

  // ── SPORTS SEASONS ─────────────────────────────────────────────────────

  {
    id: "sharks-home-games",
    title: "San Jose Sharks — Home Games",
    city: "san-jose",
    venue: "SAP Center",
    address: "525 W Santa Clara St, San Jose",
    category: "sports",
    recurrence: "seasonal",
    months: [10, 11, 12, 1, 2, 3, 4, 5, 6],
    cost: "paid",
    costNote: "Tickets from ~$35",
    kidFriendly: true,
    description:
      "NHL hockey at SAP Center during the regular season, Oct–Apr.",
    url: "https://www.nhl.com/sharks/schedule",
    emoji: "🦈",
    featured: true,
  },
  {
    id: "earthquakes-home-games",
    title: "San Jose Earthquakes — Home Games",
    city: "san-jose",
    venue: "PayPal Park",
    address: "1123 Coleman Ave, San Jose",
    category: "sports",
    recurrence: "seasonal",
    months: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    cost: "paid",
    costNote: "Tickets from ~$25",
    kidFriendly: true,
    description:
      "MLS soccer at PayPal Park. One of the most family-friendly and affordable pro sports experiences in the Bay.",
    url: "https://www.sjearthquakes.com/schedule",
    emoji: "⚽",
  },
  {
    id: "sj-giants-milb",
    title: "San Jose Giants — Home Games",
    city: "san-jose",
    venue: "Excite Ballpark",
    address: "588 E Alma Ave, San Jose",
    category: "sports",
    recurrence: "seasonal",
    months: [4, 5, 6, 7, 8, 9],
    cost: "low",
    costNote: "Tickets from ~$12",
    kidFriendly: true,
    description:
      "Minor League Baseball's SF Giants affiliate. Affordable, fun, great way to see tomorrow's MLB stars up close.",
    url: "https://www.milb.com/san-jose",
    emoji: "⚾",
    featured: true,
    image: "https://upload.wikimedia.org/wikipedia/commons/4/40/SanJoseGiantsCap.png",
  },
  {
    id: "bay-fc-games",
    title: "Bay FC — Home Games",
    city: "san-jose",
    venue: "PayPal Park",
    address: "1123 Coleman Ave, San Jose",
    category: "sports",
    recurrence: "seasonal",
    months: [3, 4, 5, 6, 7, 8, 9, 10, 11],
    cost: "paid",
    costNote: "Tickets from ~$20",
    kidFriendly: true,
    description:
      "Bay FC is the Bay Area's NWSL women's soccer team at PayPal Park. High-level women's soccer in an intimate, family-friendly stadium.",
    url: "https://www.bayfc.com/schedule",
    emoji: "⚽",
  },
  {
    id: "barracuda-home-games",
    title: "San Jose Barracuda — Home Games",
    city: "san-jose",
    venue: "Tech CU Arena",
    address: "1500 S 10th St, San Jose",
    category: "sports",
    recurrence: "seasonal",
    months: [10, 11, 12, 1, 2, 3, 4],
    cost: "paid",
    costNote: "Tickets from ~$15",
    kidFriendly: true,
    description:
      "AHL hockey — the San Jose Sharks' development affiliate. Affordable pro hockey with future NHL stars at Tech CU Arena.",
    url: "https://www.sjbarracuda.com/schedule",
    emoji: "🏒",
  },
];

// ── Derived helpers ──────────────────────────────────────────────────────────

export const EVENT_CATEGORIES: { id: EventCategory | "all"; label: string; emoji: string }[] = [
  { id: "all",       label: "All",       emoji: "✨" },
  { id: "community", label: "Community", emoji: "🤝" },
  { id: "arts",      label: "Arts",      emoji: "🎨" },
  { id: "music",     label: "Music",     emoji: "🎵" },
  { id: "education", label: "Education", emoji: "📚" },
  { id: "family",    label: "Family",    emoji: "👨‍👩‍👧" },
  { id: "outdoor",   label: "Outdoor",   emoji: "🌿" },
  { id: "sports",    label: "Sports",    emoji: "🏟️" },
  { id: "food",      label: "Food",      emoji: "🍽️" },
  { id: "market",    label: "Markets",   emoji: "🌽" },
];

export function getEventsForCity(
  city: City | "all",
  category: EventCategory | "all",
  currentMonth?: number,
): SBEvent[] {
  const month = currentMonth ?? new Date().getMonth() + 1;
  const today = new Date().toISOString().slice(0, 10);

  return SOUTH_BAY_EVENTS.filter((e) => {
    if (city !== "all" && e.city !== city) return false;
    if (category !== "all" && e.category !== category) return false;
    if (e.months && !e.months.includes(month)) return false;
    if (e.startDate && e.startDate > today) return false;
    return true;
  });
}
