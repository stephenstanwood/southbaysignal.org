// ---------------------------------------------------------------------------
// South Bay Signal — Transit & Infrastructure data
// Static snapshot, curated from public sources as of March 2026.
// ---------------------------------------------------------------------------

export type ServiceStatus = "normal" | "minor-delays" | "major-disruption" | "planned-outage";

export interface ServiceAlert {
  id: string;
  summary: string;
  detail?: string;
  affectedRoutes?: string;
  startDate?: string;
  /**
   * If set, alerts with endDate in the past (< today) should be removed on next data refresh.
   * Use ISO date string "YYYY-MM-DD" or human-readable estimate like "Est. mid-2030s".
   */
  endDate?: string;
}

export interface TransitAgency {
  id: string;
  name: string;
  shortName: string;
  emoji: string;
  color: string;
  status: ServiceStatus;
  statusNote: string;
  description: string;
  url: string;
  realtimeUrl?: string;
  alerts: ServiceAlert[];
  keyRoutes?: string[];
}

export interface RoadProject {
  id: string;
  title: string;
  highway: string;
  cities: string[];
  type: "construction" | "closure" | "lane-reduction" | "improvement";
  impact: "low" | "moderate" | "high";
  description: string;
  schedule?: string;
  source?: string;
}

export interface TransitMilestone {
  id: string;
  projectName: string;
  milestone: string;
  date: string;
  status: "completed" | "upcoming" | "in-progress";
  note?: string;
}

export const STATUS_CONFIG: Record<ServiceStatus, { label: string; color: string; bg: string; dot: string }> = {
  "normal":            { label: "Normal Service",     color: "#065F46", bg: "#D1FAE5", dot: "#10B981" },
  "minor-delays":      { label: "Minor Delays",       color: "#92400E", bg: "#FEF3C7", dot: "#F59E0B" },
  "major-disruption":  { label: "Major Disruption",   color: "#991B1B", bg: "#FEE2E2", dot: "#EF4444" },
  "planned-outage":    { label: "Planned Outage",      color: "#4B5563", bg: "#F3F4F6", dot: "#6B7280" },
};

// ── Transit agencies ─────────────────────────────────────────────────────────

export const TRANSIT_AGENCIES: TransitAgency[] = [
  {
    id: "caltrain",
    name: "Caltrain",
    shortName: "Caltrain",
    emoji: "🚆",
    color: "#C0392B",
    status: "normal",
    statusNote: "Electrified service running on schedule",
    description: "Baby Bullet and local service connecting San Jose to San Francisco, 77 miles of peninsula rail.",
    url: "https://www.caltrain.com",
    realtimeUrl: "https://www.caltrain.com/schedules/real-time-departures",
    keyRoutes: ["Baby Bullet (Limited stops)", "Limited (Express)", "Local (All stops)"],
    alerts: [
      {
        id: "caltrain-1",
        summary: "New electric fleet — all EMU trains as of 2024",
        detail: "Caltrain completed its electrification project, replacing diesel locomotives with Swiss-built electric multiple unit (EMU) trains. Quieter, faster acceleration, zero direct emissions.",
        startDate: "October 2024",
      },
    ],
  },
  {
    id: "vta",
    name: "VTA",
    shortName: "VTA",
    emoji: "🚌",
    color: "#2563EB",
    status: "normal",
    statusNote: "Check vta.org for current service status",
    description: "Santa Clara Valley Transportation Authority — light rail and bus service covering all of Santa Clara County.",
    url: "https://www.vta.org",
    realtimeUrl: "https://www.vta.org/go/real-time-info",
    keyRoutes: ["Line 901: Mountain View ↔ Winchester", "Line 902: Alum Rock ↔ Santa Teresa", "Line 500: Express bus SJ ↔ Palo Alto"],
    alerts: [],
  },
  {
    id: "bart",
    name: "BART",
    shortName: "BART",
    emoji: "🚇",
    color: "#1D4ED8",
    status: "normal",
    statusNote: "All lines running normally",
    description: "Bay Area Rapid Transit — regional heavy rail. Serves Milpitas and Berryessa/North San José stations in the South Bay.",
    url: "https://www.bart.gov",
    realtimeUrl: "https://www.bart.gov/schedules/real-time-departures",
    keyRoutes: ["Orange Line: Berryessa/N. San José ↔ Richmond", "Green Line: Berryessa/N. San José ↔ Daly City"],
    alerts: [
      {
        id: "bart-1",
        summary: "BART Phase II: San José Diridon extension in early construction",
        detail: "The 6-mile BART Silicon Valley Phase II extension from Berryessa to downtown San José and Santa Clara is in early construction. Four new stations planned: Alum Rock/28th, Downtown San José, Diridon, and Santa Clara. Expected opening mid-2030s.",
        affectedRoutes: "Future service",
        startDate: "2024",
        endDate: "Est. mid-2030s",
      },
    ],
  },
  {
    id: "ace",
    name: "ACE (Altamont Corridor Express)",
    shortName: "ACE Train",
    emoji: "🚂",
    color: "#7C3AED",
    status: "normal",
    statusNote: "Normal service, San José to Stockton",
    description: "Commuter rail connecting San José to the Central Valley via Livermore. Popular with reverse commuters and Central Valley workers.",
    url: "https://www.acerail.com",
    keyRoutes: ["San José Diridon → Stockton (weekday service only)"],
    alerts: [],
  },
];

// ── Road projects ─────────────────────────────────────────────────────────────

export const ROAD_PROJECTS: RoadProject[] = [
  {
    id: "road-1",
    title: "US-101 Express Lanes — Palo Alto to San José",
    highway: "US-101",
    cities: ["Palo Alto", "Mountain View", "Sunnyvale", "Santa Clara", "San José"],
    type: "improvement",
    impact: "moderate",
    description: "VTA is adding northbound and southbound express (toll) lanes on US-101 through the county. Construction active between Palo Alto and the county line, with lane reductions during overnight hours.",
    schedule: "Construction through mid-2027",
    source: "VTA / Caltrans",
  },
  {
    id: "road-2",
    title: "I-880 North: Paving and Interchange Work near Milpitas",
    highway: "I-880",
    cities: ["Milpitas", "San José"],
    type: "construction",
    impact: "moderate",
    description: "Caltrans resurfacing project between the I-680 interchange and the Milpitas/San José border. Expect intermittent lane closures on weeknight evenings (9pm–5am) through April.",
    schedule: "Weeknight closures through April 2026",
    source: "Caltrans District 4",
  },
  {
    id: "road-3",
    title: "Hwy 85 / I-280 Interchange Improvement",
    highway: "SR-85 / I-280",
    cities: ["Cupertino", "Los Altos", "Mountain View"],
    type: "improvement",
    impact: "high",
    description: "Multi-year project to reconfigure the SR-85/I-280 interchange near Cupertino to reduce weave conflicts. Major impact during construction windows — especially northbound SR-85 on-ramps. Check 511 before traveling.",
    schedule: "Active construction; completion est. 2028",
    source: "Caltrans",
  },
  {
    id: "road-4",
    title: "Downtown San José: Signal Timing & Streetscape Update",
    highway: "Downtown SJ surface streets",
    cities: ["San José"],
    type: "improvement",
    impact: "low",
    description: "City of San José is upgrading adaptive signal control on major downtown corridors (1st, 2nd, 4th Street) to improve flow. Also installing new pedestrian countdown signals and bike lane paint. Expect periodic lane closures.",
    schedule: "Rolling work through June 2026",
    source: "City of San José DDOT",
  },
  {
    id: "road-5",
    title: "Story Road Paving — East San José",
    highway: "Story Road / E. San José",
    cities: ["San José"],
    type: "construction",
    impact: "low",
    description: "Resurfacing and ADA ramp upgrades on Story Road between King Road and Capitol Expressway. Daytime lane closures with flaggers. Local access maintained.",
    schedule: "Spring 2026",
    source: "City of San José",
  },
  {
    id: "road-6",
    title: "Stevens Creek Blvd Bike Lanes — Cupertino to Santa Clara",
    highway: "Stevens Creek Blvd",
    cities: ["Cupertino", "Santa Clara"],
    type: "improvement",
    impact: "low",
    description: "Adding protected bike lanes on Stevens Creek Blvd between De Anza Blvd (Cupertino) and Winchester Blvd (Santa Clara). Some parking removal and signal adjustments. This is a major bike route connecting the two cities.",
    schedule: "Construction spring–summer 2026",
    source: "VTA / Cities of Cupertino & Santa Clara",
  },
];

// ── Transit project milestones ────────────────────────────────────────────────

export const TRANSIT_MILESTONES: TransitMilestone[] = [
  {
    id: "tm-1",
    projectName: "BART Phase II Silicon Valley",
    milestone: "Early construction underway — Alum Rock tunnel boring begins",
    date: "Q1 2026",
    status: "in-progress",
    note: "4 new stations: Alum Rock/28th St, Downtown SJ, Diridon, Santa Clara",
  },
  {
    id: "tm-2",
    projectName: "BART Phase II Silicon Valley",
    milestone: "Expected opening of all 4 stations",
    date: "Mid-2030s",
    status: "upcoming",
    note: "Will connect Berryessa/N. San José to downtown, Diridon Station, and Santa Clara",
  },
  {
    id: "tm-3",
    projectName: "Caltrain Electrification",
    milestone: "Full electric service launch",
    date: "October 2024",
    status: "completed",
    note: "All diesel trains retired; Swiss EMU fleet now in service",
  },
  {
    id: "tm-4",
    projectName: "Caltrain",
    milestone: "Future service to Salesforce Transit Center (SF)",
    date: "2027 est.",
    status: "upcoming",
    note: "Pending SF Downtown Extension (DTX) project, currently in early design",
  },
  {
    id: "tm-5",
    projectName: "VTA BART Operating Agreement",
    milestone: "Updated cost-share agreement for BART Phase II operations",
    date: "2025",
    status: "completed",
    note: "VTA and BART finalized the long-term operating agreement for the Silicon Valley extension",
  },
  {
    id: "tm-6",
    projectName: "US-101 Express Lanes (South Bay)",
    milestone: "Southbound lanes open: Mountain View to Palo Alto",
    date: "Mid-2026",
    status: "upcoming",
    note: "First South Bay segment of the Peninsula Express Lanes corridor",
  },
  {
    id: "tm-7",
    projectName: "Diridon Station Multimodal Hub",
    milestone: "Master plan approved; design development phase",
    date: "2025",
    status: "completed",
    note: "Future home of BART, Caltrain, ACE, VTA, and potential HSR service in one facility",
  },
];

// ── Quick links ───────────────────────────────────────────────────────────────

export const QUICK_LINKS = [
  { label: "511 SF Bay", description: "Real-time traffic, transit, and carpools", url: "https://511.org" },
  { label: "Caltrain Departures", description: "Live board for any Caltrain station", url: "https://www.caltrain.com/schedules/real-time-departures" },
  { label: "VTA Real-Time", description: "Bus and light rail live arrivals", url: "https://www.vta.org/go/real-time-info" },
  { label: "BART Real-Time", description: "Station departure boards system-wide", url: "https://www.bart.gov/schedules/real-time-departures" },
  { label: "Caltrans Quickmap", description: "Active incidents and road closures", url: "https://quickmap.dot.ca.gov" },
];

// ── Pulse stats ───────────────────────────────────────────────────────────────

export const TRANSIT_PULSE = [
  {
    value: "~16M",
    label: "Annual Caltrain Riders",
    note: "Approx. FY 2022-23 ridership",
  },
  {
    value: "77mi",
    label: "Caltrain Corridor",
    note: "SF to Gilroy along the Peninsula",
  },
  {
    value: "$6.1B",
    label: "BART Silicon Valley Cost",
    note: "Phase II: Berryessa → Diridon",
  },
];
