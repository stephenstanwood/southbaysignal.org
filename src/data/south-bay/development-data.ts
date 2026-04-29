// ---------------------------------------------------------------------------
// South Bay Signal — Development Tracker
// Curated major development projects across the South Bay
// Data reflects publicly reported information as of March 2026
// ---------------------------------------------------------------------------

export type DevStatus =
  | "proposed"
  | "approved"
  | "under-construction"
  | "opening-soon"
  | "completed"
  | "on-hold";

export type DevCategory =
  | "transit"
  | "tech-campus"
  | "mixed-use"
  | "housing"
  | "retail"
  | "civic"
  | "infrastructure";

export interface DevProject {
  id: string;
  name: string;
  city: string;        // display name
  cityId: string;      // matches City type
  category: DevCategory;
  status: DevStatus;
  description: string;
  scale?: string;      // "7.3M sq ft", "4,000+ units", "$4.5B"
  developer?: string;
  timeline?: string;   // "Expected 2032" | "Completed 2024" | "Multiple phases"
  featured?: boolean;
  sourceNote?: string; // brief context on data source
}

// ── Status display config ───────────────────────────────────────────────────

export const STATUS_CONFIG: Record<
  DevStatus,
  { label: string; color: string; bg: string }
> = {
  proposed:           { label: "Proposed",          color: "#6b7280", bg: "#f3f4f6" },
  approved:           { label: "Approved",           color: "#1d4ed8", bg: "#eff6ff" },
  "under-construction": { label: "Under Construction", color: "#b45309", bg: "#fffbeb" },
  "opening-soon":     { label: "Opening Soon",       color: "#15803d", bg: "#f0fdf4" },
  completed:          { label: "Completed",          color: "#065f46", bg: "#ecfdf5" },
  "on-hold":          { label: "On Hold",            color: "#9ca3af", bg: "#f9fafb" },
};

export const CATEGORY_LABELS: Record<DevCategory, string> = {
  transit:      "Transit",
  "tech-campus": "Tech Campus",
  "mixed-use":  "Mixed-Use",
  housing:      "Housing",
  retail:       "Retail",
  civic:        "Civic",
  infrastructure: "Infrastructure",
};

// ── Projects ────────────────────────────────────────────────────────────────

export const DEV_PROJECTS: DevProject[] = [

  // ── OPENING SOON ────────────────────────────────────────────────────────

  {
    id: "related-santa-clara",
    name: "Related Santa Clara",
    city: "Santa Clara",
    cityId: "santa-clara",
    category: "mixed-use",
    status: "approved",
    description:
      "Formerly CityPlace Santa Clara. A large mixed-use development adjacent to Levi's Stadium planned by Related Companies. Approved by Santa Clara after years of litigation with San Jose. Includes office, hotel, retail, and entertainment uses across a multi-building campus.",
    scale: "Multi-building campus",
    developer: "Related Companies",
    timeline: "TBD",
    featured: false,
  },

  // ── UNDER CONSTRUCTION ──────────────────────────────────────────────────

  {
    id: "google-downtown-west",
    name: "Google Downtown West",
    city: "San Jose",
    cityId: "san-jose",
    category: "mixed-use",
    status: "under-construction",
    description:
      "Google's mixed-use development adjacent to Diridon Station, approved by San Jose City Council in 2021. The project spans office, housing, retail, parks, and community uses near the region's largest transit hub. Google has scaled back its office ambitions since the original approval but reaffirmed housing commitments; initial site work is underway.",
    scale: "Up to 7.3M sq ft; 4,000+ housing units planned",
    developer: "Google / Lendlease",
    timeline: "Phased — office timeline revised; housing phases ongoing",
    featured: true,
    sourceNote: "Lendlease announced exit from US construction in Sept 2023 — verify current developer/partner at sanjoseca.gov or google.com/downtownwest.",
  },

  {
    id: "milpitas-transit-district",
    name: "Milpitas BART Transit-Oriented Development",
    city: "Milpitas",
    cityId: "milpitas",
    category: "housing",
    status: "under-construction",
    description:
      "Multiple transit-oriented housing projects surrounding the Milpitas and Berryessa BART stations are in various stages of construction and completion. Early phases have delivered new apartments and retail near the stations. Later phases continue to bring mixed-income units and community amenities to this corridor.",
    scale: "Multiple complexes, thousands of units",
    developer: "Various",
    timeline: "Phased delivery 2024–2028",
    featured: false,
  },

  {
    id: "campbell-downtown-infill",
    name: "Downtown Campbell Mixed-Use Infill",
    city: "Campbell",
    cityId: "campbell",
    category: "mixed-use",
    status: "under-construction",
    description:
      "Multiple mixed-use projects are under construction along Campbell Avenue and the surrounding downtown core, continuing the revitalization of Campbell's walkable downtown. New residential units over ground-floor retail have been approved and are actively in development.",
    scale: "Multiple parcels",
    developer: "Various",
    timeline: "Ongoing through 2026–2027",
    featured: false,
  },

  {
    id: "downtown-campbell-market",
    name: "Campbell Pruneyard Expansion",
    city: "Campbell",
    cityId: "campbell",
    category: "retail",
    status: "under-construction",
    description:
      "The historic Pruneyard Shopping Center in Campbell is undergoing an expansion and renovation, bringing new retail tenants, restaurants, and improvements to the outdoor gathering spaces. The Pruneyard is a beloved local landmark and this investment reinforces Campbell's position as a destination for South Bay dining and shopping.",
    scale: "Retail and restaurant expansion",
    developer: "Thompson Thrift / Pruneyard Companies",
    timeline: "Ongoing",
    featured: false,
    sourceNote: "Developer attribution unverified — confirm current ownership at campbellca.gov or local records.",
  },

  {
    id: "mineta-airport-terminal",
    name: "Mineta San José Airport Terminal B Modernization",
    city: "San Jose",
    cityId: "san-jose",
    category: "civic",
    status: "under-construction",
    description:
      "Ongoing renovation of Terminal B at Norman Y. Mineta San José International Airport, with new gates, improved passenger flow, and upgraded concessions. The multi-year project is improving the airport experience as SJC continues to add routes and recover ridership after the pandemic. Construction is occurring in phases to keep the terminal operational.",
    scale: "Terminal renovation + gate expansion",
    developer: "City of San José",
    timeline: "Phased completion 2025–2027",
    featured: false,
  },

  {
    id: "supermicro-brokaw",
    name: "Super Micro Computer Manufacturing Expansion",
    city: "San Jose",
    cityId: "san-jose",
    category: "tech-campus",
    status: "under-construction",
    description:
      "Super Micro Computer (NASDAQ: SMCI) is building a new manufacturing facility at 688 E Brokaw Road in North San José, permitted in March 2026. The $72M warm-shell build-out will expand SMCI's AI server production capacity as demand for its GPU server systems continues to climb. Supermicro has its global headquarters and major manufacturing operations across San José.",
    scale: "$72M facility",
    developer: "Super Micro Computer",
    timeline: "Permitted March 2026",
    featured: false,
    sourceNote: "Permit details from San José city permit records, March 2026. Verify permit status at sjpermits.org.",
  },

  {
    id: "summer-hill-homes-los-gatos",
    name: "Solana at Los Gatos Lodge (SummerHill Homes)",
    city: "Los Gatos",
    cityId: "los-gatos",
    category: "housing",
    status: "under-construction",
    description:
      "SummerHill Homes is redeveloping the former Los Gatos Lodge site — a historic 8.9-acre motor inn at 50 Los Gatos-Saratoga Road that closed in September 2025 — into 155 townhome-style condominiums called Solana. The project was approved unanimously by the Los Gatos Town Council in March 2025 (the town's first SB 330 streamlined application) and SummerHill closed on the $78M property in October 2025. Groundbreaking followed in November 2025. The three-story Spanish Revival buildings include 26 affordable units (16 low-income, 10 moderate-income) priced around $400K–$600K; market-rate units are expected to list around $1.5M–$2M. Each home will include solar panels and the site includes a pedestrian path to Los Gatos High School.",
    scale: "155 townhome condos (26 affordable), 8.9 acres",
    developer: "SummerHill Homes",
    timeline: "Groundbreaking Nov 2025; move-ins expected 2027",
    featured: false,
    sourceNote: "Sources: Los Gatan, SF YIMBY, The Real Deal (Oct 2025). Verify current sales/construction status at summerhill.com.",
  },

  // ── APPROVED ────────────────────────────────────────────────────────────

  {
    id: "mv-east-middlefield-mixed-use",
    name: "East Middlefield Road Mixed-Use Development",
    city: "Mountain View",
    cityId: "mountain-view",
    category: "mixed-use",
    status: "approved",
    description:
      "Mountain View City Council approved a mixed-use housing project at East Middlefield Road at its March 24, 2026 meeting. The project adds residential units to one of Mountain View's key transit corridors, consistent with the city's goals for housing near employment centers and transit.",
    scale: "Residential + ground-floor uses",
    developer: "TBD",
    timeline: "Approved March 2026",
    featured: false,
  },

  {
    id: "santa-clara-station-area-plan",
    name: "Santa Clara Station Area Land Use Plan",
    city: "Santa Clara",
    cityId: "santa-clara",
    category: "mixed-use",
    status: "proposed",
    description:
      "Santa Clara is developing land use and design rules for the areas surrounding its major transit stations. The planning process — reviewed at a March 2026 City Council study session — will guide how transit-adjacent parcels are developed over the coming decades, with a focus on housing, walkability, and connections to VTA and future BART service.",
    scale: "Multiple station areas",
    developer: "City of Santa Clara",
    timeline: "Plan in development 2026",
    featured: false,
  },

  {
    id: "berryessa-bart-transit-village",
    name: "Berryessa BART Transit Village",
    city: "San Jose",
    cityId: "san-jose",
    category: "housing",
    status: "approved",
    description:
      "Large-scale transit-oriented housing development planned around the Berryessa and Alum Rock BART stations, enabled by San José's Urban Village program. Multiple projects have received approvals for dense residential adjacent to BART, bringing new workforce and market-rate housing to North San José.",
    scale: "Thousands of units across multiple sites",
    developer: "Various",
    timeline: "Active approvals and construction",
    featured: false,
  },

  {
    id: "los-gatos-downtown-mixed-use",
    name: "Los Gatos Downtown Mixed-Use Development",
    city: "Los Gatos",
    cityId: "los-gatos",
    category: "mixed-use",
    status: "approved",
    description:
      "Los Gatos has approved several infill mixed-use projects in its downtown core, adding residential units above ground-floor retail on Santa Cruz Avenue and adjacent streets. These smaller-scale projects preserve the town's character while adding needed housing.",
    scale: "Multiple small parcels",
    developer: "Various",
    timeline: "Active development",
    featured: false,
  },

  {
    id: "santana-row-residential",
    name: "Santana Row Residential Expansion",
    city: "San Jose",
    cityId: "san-jose",
    category: "mixed-use",
    status: "approved",
    description:
      "Federal Realty continues adding residential towers to the Santana Row mixed-use district, building on the area's established retail and dining success. New phases bring hundreds of additional apartments above ground-floor retail, reinforcing Santana Row's model as a live-work-shop walkable neighborhood.",
    scale: "Multiple residential towers",
    developer: "Federal Realty Investment Trust",
    timeline: "Ongoing phases",
    featured: false,
  },

  // ── PROPOSED ────────────────────────────────────────────────────────────

  {
    id: "wolfe-rd-housing-cupertino",
    name: "Wolfe Road Housing Development",
    city: "Cupertino",
    cityId: "cupertino",
    category: "housing",
    status: "proposed",
    description:
      "The Cupertino City Council held a study session on a new housing development at 10333 N. Wolfe Road in March 2026. If approved, this would add new residential units in North Cupertino near Apple Park and Stevens Creek.",
    scale: "Residential",
    developer: "TBD",
    timeline: "Study session March 2026; approval pending",
    featured: false,
  },

  {
    id: "downtown-sunnyvale",
    name: "Downtown Sunnyvale Revitalization",
    city: "Sunnyvale",
    cityId: "sunnyvale",
    category: "mixed-use",
    status: "proposed",
    description:
      "Sunnyvale is pursuing multiple mixed-use redevelopment proposals along Murphy Avenue and the Mathilda corridor to create a more vibrant downtown. Plans include ground-floor retail with residential above, streetscape improvements, and better connections to the Sunnyvale Caltrain station.",
    scale: "Multiple parcels",
    developer: "City of Sunnyvale + private developers",
    timeline: "In planning",
    featured: false,
  },

  // ── COMPLETED ───────────────────────────────────────────────────────────

  {
    id: "caltrain-electrification",
    name: "Caltrain Electrification",
    city: "Regional (San José to SF)",
    cityId: "san-jose",
    category: "transit",
    status: "completed",
    description:
      "After years of construction, Caltrain completed its electrification project and launched electric train service in late 2024. The new Swiss-made Stadler electric trains replaced diesel locomotives on the Peninsula corridor, cutting travel times, reducing emissions, and significantly increasing capacity.",
    scale: "51-mile electrified corridor",
    developer: "Peninsula Corridor Joint Powers Board",
    timeline: "Completed 2024",
    featured: true,
  },

  {
    id: "google-bay-view",
    name: "Google Bay View Campus",
    city: "Mountain View",
    cityId: "mountain-view",
    category: "tech-campus",
    status: "completed",
    description:
      "Google's striking new campus at NASA Research Park in Mountain View, designed by Heatherwick Studio and BIG. Features a distinctive dragonscale solar canopy roof, indoor garden courts, and net-zero energy design. Google began using Bay View in 2022 as its newest Bay Area headquarters building.",
    scale: "1.1M sq ft",
    developer: "Google",
    timeline: "Completed 2022",
    featured: true,
  },

  {
    id: "nvidia-voyager",
    name: "NVIDIA Voyager Campus",
    city: "Santa Clara",
    cityId: "santa-clara",
    category: "tech-campus",
    status: "completed",
    description:
      "NVIDIA's striking new headquarters campus in Santa Clara, anchored by the Voyager and Endeavor buildings designed by Gensler. The buildings are connected by a bridge and feature a triangular glass design that has become a visual landmark along the 101 corridor. NVIDIA moved its headquarters operations here as the company's growth accelerated.",
    scale: "~750,000 sq ft",
    developer: "NVIDIA",
    timeline: "Completed 2022",
    featured: true,
  },

];

// ── Pulse stats ─────────────────────────────────────────────────────────────

export const DEV_PULSE = [
  {
    value: DEV_PROJECTS.filter((p) => p.status === "under-construction").length.toString(),
    label: "Under Construction",
    note: "Active major projects",
  },
  {
    value: DEV_PROJECTS.filter((p) => p.status === "approved").length.toString(),
    label: "Approved",
    note: "Permitted, not yet built",
  },
  {
    value: DEV_PROJECTS.filter((p) => p.status === "completed").length.toString(),
    label: "Recently Completed",
    note: "Finished in past 5 years",
  },
  {
    value: DEV_PROJECTS.filter((p) => p.featured).length.toString(),
    label: "Signature Projects",
    note: "Generational developments",
  },
];
