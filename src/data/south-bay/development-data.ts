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
    id: "bart-phase2",
    name: "BART Silicon Valley Phase II",
    city: "San Jose / Santa Clara",
    cityId: "san-jose",
    category: "transit",
    status: "under-construction",
    description:
      "Extension of BART service from Berryessa Station through downtown San Jose — including a 4-mile underground tunnel — to a new terminus at Santa Clara Station near Levi's Stadium. When complete, it will connect South Bay residents directly to the broader Bay Area BART network.",
    scale: "6 miles, 2 new stations",
    developer: "Santa Clara Valley Transportation Authority",
    timeline: "Expected mid-2030s",
    featured: true,
  },

  {
    id: "google-downtown-west",
    name: "Google Downtown West",
    city: "San Jose",
    cityId: "san-jose",
    category: "mixed-use",
    status: "under-construction",
    description:
      "Google's landmark mixed-use development adjacent to Diridon Station. Approved by San Jose City Council in 2021, the project encompasses office space, thousands of housing units, retail, parks, and community amenities across multiple city blocks near the transit hub.",
    scale: "7.3M sq ft, 4,000+ housing units",
    developer: "Google / Lendlease",
    timeline: "Multiple phases through 2030s",
    featured: true,
  },

  {
    id: "milpitas-transit-district",
    name: "Milpitas BART Transit-Oriented Development",
    city: "Milpitas",
    cityId: "milpitas",
    category: "housing",
    status: "opening-soon",
    description:
      "Transit-oriented development projects surrounding the Milpitas and Berryessa BART stations are actively under construction, bringing new mixed-income housing, retail, and community amenities to the area. Several apartment complexes have recently opened or are nearing completion.",
    scale: "Multiple complexes, thousands of units",
    developer: "Various",
    timeline: "Multiple projects opening 2025–2027",
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
  },

  {
    id: "mineta-airport-terminal",
    name: "Mineta San José Airport Terminal B Modernization",
    city: "San Jose",
    cityId: "san-jose",
    category: "civic",
    status: "under-construction",
    description:
      "Major renovation of Terminal B at Norman Y. Mineta San José International Airport, adding gates, improving passenger flow, and upgrading facilities. Part of a broader effort to modernize the airport and expand regional air service capacity.",
    scale: "Terminal renovation + gate expansion",
    developer: "City of San José",
    timeline: "Phased completion through 2026–2027",
    featured: false,
  },

  // ── APPROVED ────────────────────────────────────────────────────────────

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
    id: "sunnyvale-moffett-park",
    name: "Sunnyvale Moffett Park Specific Plan",
    city: "Sunnyvale",
    cityId: "sunnyvale",
    category: "mixed-use",
    status: "approved",
    description:
      "Sunnyvale's Moffett Park Specific Plan transforms a major tech office district into a mixed-use neighborhood with housing, retail, and parks alongside office space. Several projects under this plan are in various stages of entitlement and construction.",
    scale: "Approximately 10,000 housing units at buildout",
    developer: "Multiple tech and residential developers",
    timeline: "Phased through 2035",
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
    id: "diridon-station-area",
    name: "Diridon Station Area Plan",
    city: "San Jose",
    cityId: "san-jose",
    category: "mixed-use",
    status: "approved",
    description:
      "San José's long-term plan for 250+ acres around Diridon Station — the South Bay's largest transit hub, served by Caltrain, VTA, Amtrak, and future BART and HSR. Envisions a dense, transit-oriented neighborhood with office towers, housing, retail, hotels, and public plazas replacing surface parking and underused industrial parcels.",
    scale: "250 acres",
    developer: "City of San José (multiple developers)",
    timeline: "Phased development through 2040s",
    featured: false,
  },

  {
    id: "google-north-bayshore",
    name: "Google North Bayshore Development",
    city: "Mountain View",
    cityId: "mountain-view",
    category: "mixed-use",
    status: "approved",
    description:
      "Mountain View's approved plan for Google's North Bayshore area — the largest development proposal in the city's history. The project includes housing, retail, parks, and Google office space in a neighborhood adjacent to the Bay. Mountain View approved a Precise Plan enabling thousands of new homes in an area previously limited to office use.",
    scale: "~7,000 housing units, office, retail",
    developer: "Google",
    timeline: "Long-term phased development",
    featured: true,
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

  {
    id: "north-san-jose-urban-villages",
    name: "North San José Urban Villages",
    city: "San Jose",
    cityId: "san-jose",
    category: "housing",
    status: "approved",
    description:
      "San José's Urban Village initiative designates transit-adjacent corridors for dense housing and mixed-use development. North San José has several active village plans enabling thousands of new residential units near tech campuses, VTA light rail, and future BART, targeting the Alviso, Berryessa, and Trimble Road corridors.",
    scale: "Thousands of units across multiple sites",
    developer: "Various developers",
    timeline: "Ongoing approvals through 2030s",
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
    id: "hsr-california",
    name: "California High-Speed Rail (San José–Bakersfield)",
    city: "San Jose",
    cityId: "san-jose",
    category: "transit",
    status: "proposed",
    description:
      "The Central Valley segment of California's high-speed rail project is under construction, but the extension connecting San José's Diridon Station remains in planning. If completed, it would link San José to LA in under 3 hours and make Diridon the South Bay's primary intercity rail hub.",
    scale: "Regional / statewide",
    developer: "California High-Speed Rail Authority",
    timeline: "San José connection: 2030s or later",
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
