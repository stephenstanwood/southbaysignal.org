// ---------------------------------------------------------------------------
// South Bay Signal — shared types
// ---------------------------------------------------------------------------

export type City =
  | "campbell"
  | "cupertino"
  | "los-gatos"
  | "mountain-view"
  | "saratoga"
  | "sunnyvale"
  | "san-jose"
  | "santa-clara"
  | "los-altos"
  | "palo-alto"
  | "milpitas";

export type Category = "sports" | "events" | "government" | "technology" | "plan" | "development" | "transit" | "weather" | "food" | "camps";

export type Tab = "overview" | Category;

export interface TabDef {
  id: Tab;
  label: string;
}

export const TABS: TabDef[] = [
  { id: "overview", label: "Today" },
  { id: "plan", label: "Plan My Day" },
  { id: "camps", label: "Camps" },
  { id: "events", label: "Events" },
  { id: "government", label: "Gov" },
  { id: "technology", label: "Tech" },
  { id: "development", label: "Development" },
  { id: "food", label: "Food" },
  { id: "transit", label: "Transit" },
  { id: "weather", label: "Weather" },
  { id: "sports", label: "Sports" },
];

// ── Sports types ──

export type LeagueKey =
  | "nhl"
  | "ahl"
  | "nba"
  | "wnba"
  | "mlb"
  | "milb"
  | "mls"
  | "nwsl"
  | "nfl"
  | "ncaaf"
  | "ncaam";

export interface SouthBayTeam {
  key: string;
  name: string;
  shortName: string;
  league: LeagueKey;
  espnPath: string; // e.g. "hockey/nhl"
  abbreviation: string; // ESPN abbreviation to match against
  displayNameMatch?: string; // fallback matching against ESPN displayName
  fallbackLogoUrl?: string; // logo to use when team has no games in window
  color: string;
  textColor: string;
  primary?: boolean; // true = San Jose / local team
}

export interface ParsedGame {
  id: string;
  league: LeagueKey;
  leagueLabel: string;
  homeTeam: string;
  awayTeam: string;
  homeLogo?: string;
  awayLogo?: string;
  homeAbbr: string;
  awayAbbr: string;
  homeScore?: number;
  awayScore?: number;
  homeRecord?: string;
  awayRecord?: string;
  homeColor: string;
  awayColor: string;
  status: "pre" | "in" | "post";
  statusDetail: string;
  startTime: string;
  broadcasts: string[];
  isSouthBayHome: boolean; // is a south bay team the home team?
  southBayTeamKey: string; // which SB team is playing
}
