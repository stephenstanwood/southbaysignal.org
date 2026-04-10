// ---------------------------------------------------------------------------
// South Bay Signal — Social Data Loader
// Reads all SBS data sources and normalizes into candidate items
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY_MAP, CITY_NAMES } from "./constants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "src", "data", "south-bay");

function readJson(filename) {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, filename), "utf8"));
  } catch {
    return null;
  }
}

function normalizeCategory(cat) {
  return CATEGORY_MAP[cat] || cat || "community";
}

function cityDisplayName(cityId) {
  return CITY_NAMES[cityId] || cityId;
}

function today() {
  return new Date().toISOString().split("T")[0];
}

function daysFromNow(dateStr) {
  if (!dateStr) return 999;
  const d = new Date(dateStr + "T12:00:00");
  const now = new Date();
  return Math.round((d - now) / 86400000);
}

// ── Load upcoming events ────────────────────────────────────────────────────

function loadEvents() {
  const data = readJson("upcoming-events.json");
  if (!data?.events) return [];

  return data.events.map((e) => ({
    id: e.id,
    title: e.title,
    summary: e.description || "",
    category: normalizeCategory(e.category),
    city: e.city,
    cityName: cityDisplayName(e.city),
    venue: e.venue || "",
    date: e.date,
    time: e.time || null,
    endTime: e.endTime || null,
    url: e.url || "",
    sbsUrl: "/",
    sourceType: "event",
    source: e.source || "",
    cost: e.cost || "",
    kidFriendly: e.kidFriendly || false,
    ongoing: e.ongoing || false,
    confidence: 0.8,
  }));
}

// ── Load around-town items ──────────────────────────────────────────────────

function loadAroundTown() {
  const data = readJson("around-town.json");
  if (!data?.items) return [];

  return data.items.map((item) => ({
    id: item.id,
    title: item.headline,
    summary: item.summary || "",
    category: normalizeCategory(item.source),
    city: item.cityId,
    cityName: item.cityName || cityDisplayName(item.cityId),
    venue: "",
    date: item.date,
    time: null,
    endTime: null,
    url: item.sourceUrl || "",
    sbsUrl: "/#government",
    sourceType: "around-town",
    source: item.source || "",
    cost: "",
    kidFriendly: false,
    ongoing: false,
    confidence: 0.7,
  }));
}

// ── Load council digests ────────────────────────────────────────────────────

function loadDigests() {
  const data = readJson("digests.json");
  if (!data) return [];

  return Object.values(data)
    .filter((d) => d.city && d.summary)
    .map((d) => ({
      id: `digest-${d.city}-${d.meetingDateIso}`,
      title: d.title || `${d.cityName} City Council`,
      summary: d.summary,
      category: "civic",
      city: d.city,
      cityName: d.cityName || cityDisplayName(d.city),
      venue: "",
      date: d.meetingDateIso,
      time: null,
      endTime: null,
      url: d.sourceUrl || "",
      sbsUrl: "/#government",
      sourceType: "digest",
      source: "council",
      cost: "",
      kidFriendly: false,
      ongoing: false,
      confidence: 0.9,
      keyTopics: d.keyTopics || [],
    }));
}

// ── Load weekend picks ──────────────────────────────────────────────────────

function loadWeekendPicks() {
  const data = readJson("weekend-picks.json");
  if (!data?.picks) return [];

  return data.picks.map((p) => ({
    id: p.id,
    title: p.title,
    summary: p.why || "",
    category: normalizeCategory(p.category),
    city: p.city,
    cityName: cityDisplayName(p.city),
    venue: p.venue || "",
    date: p.date,
    time: p.time || null,
    endTime: null,
    url: p.url || "",
    sbsUrl: "/#events",
    sourceType: "weekend-pick",
    source: "curated",
    cost: p.cost || "",
    kidFriendly: false,
    ongoing: false,
    confidence: 0.95,
  }));
}

// ── Load restaurant radar ───────────────────────────────────────────────────

function loadRestaurantRadar() {
  const data = readJson("restaurant-radar.json");
  if (!data?.items) return [];

  return data.items
    .filter((r) => r.signal === "opening")
    .map((r) => ({
      id: r.id,
      title: r.name ? `${r.name} — ${r.address}` : r.address,
      summary: r.blurb || r.description || "",
      category: "food",
      city: r.city,
      cityName: cityDisplayName(r.city),
      venue: r.name || r.address,
      date: r.date,
      time: null,
      endTime: null,
      url: r.url || "",
      sbsUrl: "/#food",
      sourceType: "restaurant",
      source: "restaurant-radar",
      cost: "",
      kidFriendly: false,
      ongoing: false,
      confidence: 0.85,
    }));
}

// ── Load permit pulse (notable permits) ─────────────────────────────────────

function loadPermitPulse() {
  const data = readJson("permit-pulse.json");
  if (!data?.cities) return [];

  const items = [];
  for (const [cityId, cityData] of Object.entries(data.cities)) {
    if (!cityData.permits) continue;
    for (const p of cityData.permits) {
      if (p.valuation < 100000) continue; // only notable permits
      items.push({
        id: p.id,
        title: `${p.categoryLabel}: ${p.address}`,
        summary: p.description || "",
        category: "development",
        city: cityId,
        cityName: cityDisplayName(cityId),
        venue: p.address,
        date: p.issueDate,
        time: null,
        endTime: null,
        url: "",
        sbsUrl: "/#development",
        sourceType: "permit",
        source: "permit",
        cost: "",
        kidFriendly: false,
        ongoing: false,
        confidence: 0.5,
        valuation: p.valuation,
      });
    }
  }
  return items;
}

// ── Load APOD ───────────────────────────────────────────────────────────────

function loadApod() {
  const data = readJson("apod.json");
  if (!data?.title) return [];

  return [
    {
      id: `apod-${data.date}`,
      title: `NASA Image of the Day: ${data.title}`,
      summary: data.explanation ? data.explanation.slice(0, 200) : "",
      category: "community",
      city: "",
      cityName: "",
      venue: "",
      date: data.date,
      time: null,
      endTime: null,
      url: data.hdurl || data.url || "",
      sbsUrl: "/",
      sourceType: "apod",
      source: "NASA",
      cost: "",
      kidFriendly: true,
      ongoing: false,
      confidence: 1.0,
    },
  ];
}

// ── Main loader ─────────────────────────────────────────────────────────────

/**
 * Load all candidate items from SBS data.
 * Returns normalized array sorted by date (newest first).
 */
export function loadAllCandidates() {
  const candidates = [
    ...loadEvents(),
    ...loadAroundTown(),
    ...loadDigests(),
    ...loadWeekendPicks(),
    ...loadRestaurantRadar(),
    ...loadPermitPulse(),
    ...loadApod(),
  ];

  // Sort by date descending
  candidates.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return candidates;
}

/**
 * Filter candidates for a specific date (YYYY-MM-DD).
 */
export function candidatesForDate(candidates, date) {
  return candidates.filter((c) => c.date === date);
}

/**
 * Filter candidates happening today or in the future.
 */
export function upcomingCandidates(candidates, maxDaysAhead = 21) {
  const t = today();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + maxDaysAhead);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  return candidates.filter((c) => {
    if (!c.date) return true; // undated items (ongoing) pass through
    return c.date >= t && c.date <= cutoffStr;
  });
}

/**
 * Filter candidates for tonight (today, with time after 4pm or no time).
 */
export function tonightCandidates(candidates) {
  const t = today();
  return candidates.filter((c) => {
    if (c.date !== t) return false;
    if (!c.time) return true; // no time = could be tonight
    const hour = parseInt(c.time.split(":")[0]) || parseInt(c.time);
    if (c.time.toLowerCase().includes("pm") && hour !== 12) return true;
    if (hour >= 16) return true;
    return false;
  });
}

/**
 * Filter candidates for this weekend (Fri-Sun).
 */
export function weekendCandidates(candidates) {
  const now = new Date();
  const dayOfWeek = now.getDay();
  // Find next Friday (or today if it's Fri/Sat/Sun)
  const daysToFri = dayOfWeek <= 5 ? 5 - dayOfWeek : dayOfWeek === 6 ? 6 : 5;
  const fri = new Date(now);
  fri.setDate(fri.getDate() + (dayOfWeek >= 5 ? 0 : daysToFri));
  const sun = new Date(fri);
  sun.setDate(sun.getDate() + 2);

  const friStr = fri.toISOString().split("T")[0];
  const sunStr = sun.toISOString().split("T")[0];

  return candidates.filter((c) => c.date && c.date >= friStr && c.date <= sunStr);
}

/**
 * Filter civic/government candidates.
 */
export function civicCandidates(candidates) {
  const civicTypes = new Set(["around-town", "digest", "permit"]);
  const civicCats = new Set(["civic", "development"]);
  return candidates.filter(
    (c) => civicTypes.has(c.sourceType) || civicCats.has(c.category)
  );
}
