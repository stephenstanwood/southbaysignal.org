// ---------------------------------------------------------------------------
// South Bay Today — city metadata
// ---------------------------------------------------------------------------

import type { City } from "./types";

export interface CityConfig {
  id: City;
  name: string;
  website: string;
  lat: number;
  lon: number;
}

export const CITIES: CityConfig[] = [
  { id: "campbell",      name: "Campbell",      website: "https://www.campbellca.gov",      lat: 37.2872, lon: -121.9500 },
  { id: "cupertino",     name: "Cupertino",     website: "https://www.cupertino.org",       lat: 37.3230, lon: -122.0322 },
  { id: "los-gatos",     name: "Los Gatos",     website: "https://www.losgatosca.gov",      lat: 37.2261, lon: -121.9822 },
  { id: "mountain-view", name: "Mountain View", website: "https://www.mountainview.gov",    lat: 37.3861, lon: -122.0839 },
  { id: "saratoga",      name: "Saratoga",      website: "https://www.saratoga.ca.us",      lat: 37.2638, lon: -122.0230 },
  { id: "sunnyvale",     name: "Sunnyvale",     website: "https://www.sunnyvale.ca.gov",    lat: 37.3688, lon: -122.0363 },
  { id: "palo-alto",     name: "Palo Alto",     website: "https://www.cityofpaloalto.org",  lat: 37.4419, lon: -122.1430 },
  { id: "san-jose",      name: "San Jose",      website: "https://www.sanjoseca.gov",       lat: 37.3382, lon: -121.8863 },
  { id: "santa-clara",   name: "Santa Clara",   website: "https://www.santaclaraca.gov",    lat: 37.3541, lon: -121.9552 },
  { id: "los-altos",     name: "Los Altos",     website: "https://www.losaltosca.gov",      lat: 37.3852, lon: -122.1141 },
  { id: "milpitas",      name: "Milpitas",      website: "https://www.milpitas.gov",        lat: 37.4323, lon: -121.8996 },
  // Case-by-case picks only — not full coverage. Excluded from plan-day VALID_CITIES.
  { id: "santa-cruz",    name: "Santa Cruz",    website: "https://www.cityofsantacruz.com",  lat: 36.9741, lon: -122.0308 },
];

export const CITY_MAP = Object.fromEntries(
  CITIES.map((c) => [c.id, c]),
) as Record<City, CityConfig>;

export function getCityName(id: City): string {
  return CITY_MAP[id]?.name ?? id;
}
