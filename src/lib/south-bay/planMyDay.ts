// ---------------------------------------------------------------------------
// South Bay Signal — Plan My Day algorithm
// Builds a time-blocked day itinerary from events + POIs, filtered by
// user preferences and weather conditions.
// ---------------------------------------------------------------------------

import {
  SOUTH_BAY_EVENTS,
  type SBEvent,
  type DayOfWeek,
} from "../../data/south-bay/events-data";
import { SOUTH_BAY_POIS } from "../../data/south-bay/poi-data";
import upcomingJson from "../../data/south-bay/upcoming-events.json";

// ── Public input/output types ─────────────────────────────────────────────────

export type Who =
  | "solo"
  | "couple"
  | "family-young"
  | "family-kids"
  | "teens"
  | "group";

export type Duration =
  | "morning"
  | "afternoon"
  | "evening"
  | "full-day"
  | "quick";

export type VibeType = "outdoors" | "indoors" | "mix";
export type BudgetType = "free" | "some" | "anything";

export interface PlanInput {
  who: Who;
  duration: Duration;
  vibe: VibeType;
  budget: BudgetType;
  date?: Date; // defaults to today
  homeCity?: string; // user's preferred city for proximity scoring
}

export interface PlanStop {
  time: string; // display label, e.g. "9:00 AM"
  slotLabel: string; // "Morning", "Midday", "Afternoon", "Evening"
  title: string;
  venue: string;
  city: string;
  cost: "free" | "low" | "paid";
  costNote?: string;
  kidFriendly: boolean;
  why: string;
  emoji: string;
  url?: string;
  isEvent: boolean;
  isTodaySpecial: boolean; // event active today
  indoorOutdoor: "indoor" | "outdoor" | "both";
}

export interface DayPlan {
  stops: PlanStop[];
  weatherNote: string;
  headline: string;
}

// ── Internal types ─────────────────────────────────────────────────────────────

type TimeSlot = "morning" | "lunch" | "afternoon" | "evening";

interface Candidate {
  id: string;
  title: string;
  venue: string;
  city: string;
  citySlug: string; // e.g. "san-jose" for proximity scoring
  cost: "free" | "low" | "paid";
  costNote?: string;
  kidFriendly: boolean;
  why: string;
  emoji: string;
  url?: string;
  isEvent: boolean;
  isTodaySpecial: boolean;
  hasDayRestriction: boolean; // event has specific days[] — only show when active
  indoorOutdoor: "indoor" | "outdoor" | "both";
  category: string;
  bestSlots: TimeSlot[];
}

interface WeatherInfo {
  isRainy: boolean;
  isHot: boolean; // >88°F
  isSunny: boolean;
  isCold: boolean; // <50°F
  raw: string;
}

// ── City proximity ──────────────────────────────────────────────────────────

// Distance tiers between South Bay cities (0 = same, 1 = adjacent, 2 = nearby, 3 = far)
const CITY_DISTANCE: Record<string, Record<string, number>> = {
  "san-jose":      { "san-jose": 0, "campbell": 1, "santa-clara": 1, "milpitas": 1, "los-gatos": 2, "saratoga": 2, "cupertino": 1, "sunnyvale": 2, "mountain-view": 2, "palo-alto": 3 },
  "campbell":      { "campbell": 0, "san-jose": 1, "los-gatos": 1, "saratoga": 1, "cupertino": 2, "santa-clara": 2, "sunnyvale": 2, "mountain-view": 3, "milpitas": 3, "palo-alto": 3 },
  "los-gatos":     { "los-gatos": 0, "campbell": 1, "saratoga": 1, "san-jose": 2, "cupertino": 2, "santa-clara": 2, "sunnyvale": 3, "mountain-view": 3, "milpitas": 3, "palo-alto": 3 },
  "saratoga":      { "saratoga": 0, "los-gatos": 1, "campbell": 1, "cupertino": 1, "san-jose": 2, "sunnyvale": 2, "santa-clara": 2, "mountain-view": 2, "palo-alto": 3, "milpitas": 3 },
  "cupertino":     { "cupertino": 0, "saratoga": 1, "santa-clara": 1, "sunnyvale": 1, "campbell": 2, "san-jose": 1, "los-gatos": 2, "mountain-view": 2, "palo-alto": 2, "milpitas": 2 },
  "santa-clara":   { "santa-clara": 0, "san-jose": 1, "cupertino": 1, "sunnyvale": 1, "milpitas": 2, "campbell": 2, "mountain-view": 1, "saratoga": 2, "los-gatos": 2, "palo-alto": 2 },
  "sunnyvale":     { "sunnyvale": 0, "santa-clara": 1, "cupertino": 1, "mountain-view": 1, "san-jose": 2, "milpitas": 2, "saratoga": 2, "campbell": 2, "palo-alto": 2, "los-gatos": 3 },
  "mountain-view": { "mountain-view": 0, "sunnyvale": 1, "palo-alto": 1, "santa-clara": 1, "cupertino": 2, "san-jose": 2, "milpitas": 2, "los-gatos": 3, "campbell": 3, "saratoga": 2 },
  "palo-alto":     { "palo-alto": 0, "mountain-view": 1, "sunnyvale": 2, "santa-clara": 2, "cupertino": 2, "san-jose": 3, "milpitas": 3, "los-gatos": 3, "campbell": 3, "saratoga": 3 },
  "milpitas":      { "milpitas": 0, "san-jose": 1, "santa-clara": 2, "sunnyvale": 2, "cupertino": 2, "mountain-view": 2, "campbell": 3, "los-gatos": 3, "saratoga": 3, "palo-alto": 3 },
};

function getCityDistance(from: string, to: string): number {
  return CITY_DISTANCE[from]?.[to] ?? 2;
}

// ── Slot configuration ────────────────────────────────────────────────────────

const SLOT_META: Record<TimeSlot, { label: string; time: string }> = {
  morning: { label: "Morning", time: "9:00 AM" },
  lunch: { label: "Midday", time: "12:00 PM" },
  afternoon: { label: "Afternoon", time: "2:00 PM" },
  evening: { label: "Evening", time: "6:00 PM" },
};

function getSlotsForDuration(duration: Duration): TimeSlot[] {
  if (duration === "full-day") return ["morning", "lunch", "afternoon", "evening"];
  if (duration === "morning") return ["morning"];
  if (duration === "afternoon") return ["lunch", "afternoon"];
  if (duration === "evening") return ["evening"];
  // "quick" — pick based on current time
  const hour = new Date().getHours();
  if (hour < 12) return ["morning"];
  if (hour < 17) return ["afternoon"];
  return ["evening"];
}

// ── Weather parsing ────────────────────────────────────────────────────────────

function parseWeather(raw: string): WeatherInfo {
  const lower = raw.toLowerCase();
  const isRainy =
    lower.includes("rain") ||
    lower.includes("drizzle") ||
    lower.includes("shower") ||
    lower.includes("thunder");
  const isSunny =
    lower.includes("clear") ||
    lower.includes("sunny") ||
    lower.includes("fair") ||
    lower.includes("mostly clear");

  const tempMatch = raw.match(/(\d+)°[FC]/);
  const temp = tempMatch ? parseInt(tempMatch[1]) : 70;
  const isHot = temp > 88;
  const isCold = temp < 50;

  return { isRainy, isHot, isSunny, isCold, raw };
}

function buildWeatherNote(weather: WeatherInfo, input: PlanInput): string {
  if (weather.isRainy) {
    return `${weather.raw} · We've leaned into indoor options today`;
  }
  if (weather.isHot) {
    return `${weather.raw} · Steering you toward shaded and indoor spots`;
  }
  if (weather.isSunny && input.vibe !== "indoors") {
    return `${weather.raw} · Great day to be outside`;
  }
  if (weather.isCold) {
    return `${weather.raw} · Favoring cozy indoor options`;
  }
  return weather.raw;
}

// ── Day-of-week helpers ───────────────────────────────────────────────────────

function isActiveOnDate(e: SBEvent, date: Date): boolean {
  const ptLocale = { timeZone: "America/Los_Angeles" } as const;
  const month = parseInt(date.toLocaleDateString("en-US", { ...ptLocale, month: "numeric" }));
  const dayName = date.toLocaleDateString("en-US", { ...ptLocale, weekday: "long" }).toLowerCase() as DayOfWeek;

  if (e.months && !e.months.includes(month)) return false;
  if (!e.days) return e.recurrence !== "seasonal"; // seasonal without days = whole-season, not a daily event
  return e.days.includes(dayName);
}

// ── Upcoming event helpers ────────────────────────────────────────────────────

const UPCOMING_CAT_EMOJI: Record<string, string> = {
  arts: "🎨", family: "👨‍👩‍👦", community: "🤝", sports: "⚽",
  education: "📚", music: "🎵", outdoor: "🌳", market: "🥦", food: "🍽️",
};

const SKIP_TITLE = /\b(closed|closure|closing|canceled|cancelled)\b/i;

function timeToBestSlots(time: string | null | undefined): TimeSlot[] {
  if (!time) return ["morning", "afternoon", "evening"];
  const m = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return ["morning", "afternoon", "evening"];
  let h = parseInt(m[1]);
  const pm = m[3].toUpperCase() === "PM";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  if (h < 12) return ["morning"];
  if (h < 14) return ["lunch", "afternoon"];
  if (h < 17) return ["afternoon"];
  return ["evening"];
}

function buildUpcomingCandidates(date: Date): Candidate[] {
  const dateStr = date.toISOString().split("T")[0];
  const allEvents = (upcomingJson as { events: Array<{
    id: string; title: string; date: string; time?: string | null;
    venue?: string; city?: string; category?: string; cost?: string;
    description?: string; url?: string; kidFriendly?: boolean; ongoing?: boolean;
  }> }).events || [];

  return allEvents
    .filter((e) =>
      e.date === dateStr &&
      !e.ongoing &&
      !SKIP_TITLE.test(e.title)
    )
    .map((e) => {
      const cat = e.category ?? "community";
      const indoorOutdoor: "indoor" | "outdoor" | "both" =
        ["outdoor", "market", "sports"].includes(cat) ? "outdoor" :
        ["arts", "education", "music", "food"].includes(cat) ? "indoor" : "both";
      const cost: "free" | "low" | "paid" =
        e.cost === "free" ? "free" : e.cost === "low" ? "low" : "paid";
      const desc = e.description?.trim();
      const why = desc && desc.length > 0 && !desc.startsWith("http")
        ? (desc.length > 120 ? desc.slice(0, 117) + "…" : desc)
        : e.title;
      return {
        id: `upcoming-${e.id}`,
        title: e.title,
        venue: e.venue ?? "",
        city: cityLabel(e.city ?? ""),
        citySlug: e.city ?? "",
        cost,
        kidFriendly: e.kidFriendly ?? false,
        why,
        emoji: UPCOMING_CAT_EMOJI[cat] ?? "📅",
        url: e.url,
        isEvent: true,
        isTodaySpecial: true,
        hasDayRestriction: true,
        indoorOutdoor,
        category: cat,
        bestSlots: timeToBestSlots(e.time),
      } as Candidate;
    });
}

// ── Candidate building ────────────────────────────────────────────────────────

function eventIndoorOutdoor(e: SBEvent): "indoor" | "outdoor" | "both" {
  if (["outdoor", "market", "sports"].includes(e.category)) return "outdoor";
  if (["arts", "education", "music", "food"].includes(e.category)) return "indoor";
  return "both";
}

function eventBestSlots(e: SBEvent): TimeSlot[] {
  const map: Record<string, TimeSlot[]> = {
    market: ["morning"],
    outdoor: ["morning", "afternoon"],
    sports: ["afternoon", "evening"],
    arts: ["afternoon", "evening"],
    music: ["evening"],
    education: ["morning", "afternoon"],
    family: ["morning", "afternoon"],
    community: ["afternoon", "evening"],
    food: ["lunch", "afternoon", "evening"],
  };
  return map[e.category] ?? ["morning", "afternoon"];
}

function cityLabel(city: string): string {
  return city
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function buildCandidates(date: Date): Candidate[] {
  const candidates: Candidate[] = [];

  for (const e of SOUTH_BAY_EVENTS) {
    if (e.category === "sports") continue; // skip generic recurring sports — no confirmed game dates
    candidates.push({
      id: `event-${e.id}`,
      title: e.title,
      venue: e.venue,
      city: cityLabel(e.city),
      citySlug: e.city,
      cost: e.cost,
      costNote: e.costNote,
      kidFriendly: e.kidFriendly,
      why: e.description,
      emoji: e.emoji,
      url: e.url,
      isEvent: true,
      isTodaySpecial: isActiveOnDate(e, date),
      hasDayRestriction: !!(e.days && e.days.length > 0),
      indoorOutdoor: eventIndoorOutdoor(e),
      category: e.category,
      bestSlots: eventBestSlots(e),
    });
  }

  for (const p of SOUTH_BAY_POIS) {
    candidates.push({
      id: `poi-${p.id}`,
      title: p.title,
      venue: p.venue,
      city: cityLabel(p.city),
      citySlug: p.city,
      cost: p.cost,
      costNote: p.costNote,
      kidFriendly: p.kidFriendly,
      why: p.why,
      emoji: p.emoji,
      url: p.url,
      isEvent: false,
      isTodaySpecial: false,
      hasDayRestriction: false,
      indoorOutdoor: p.indoorOutdoor,
      category: p.category,
      bestSlots: p.bestSlots,
    });
  }

  // Layer in specific upcoming events for the target date
  const upcomingCandidates = buildUpcomingCandidates(date);
  return [...candidates, ...upcomingCandidates];
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreCandidate(
  c: Candidate,
  slot: TimeSlot,
  input: PlanInput,
  weather: WeatherInfo,
  used: Set<string>,
  usedCategories: Set<string>,
  lastCitySlug: string | null,
): number {
  if (used.has(c.id)) return -9999;

  let s = 0;

  // Slot fit
  if (c.bestSlots.includes(slot)) s += 10;
  else s -= 8;

  // City proximity — prefer events near user's home city
  if (input.homeCity && c.citySlug) {
    const dist = getCityDistance(input.homeCity, c.citySlug);
    if (dist === 0) s += 12;       // same city
    else if (dist === 1) s += 6;   // adjacent
    else if (dist === 2) s += 0;   // nearby, neutral
    else s -= 8;                   // far away
  }

  // Geographic flow — prefer stops near the previous stop
  if (lastCitySlug && c.citySlug) {
    const flow = getCityDistance(lastCitySlug, c.citySlug);
    if (flow === 0) s += 6;        // same city as last stop
    else if (flow === 1) s += 3;   // adjacent
    else if (flow >= 3) s -= 6;    // far jump — bad day flow
  }

  // Lunch slot: strongly prefer food/neighborhood
  if (slot === "lunch") {
    if (c.category === "food" || c.category === "neighborhood") s += 18;
    if (c.category === "market") s += 8;
  }

  // Vibe match
  const io = c.indoorOutdoor;
  if (input.vibe === "outdoors") {
    if (io === "outdoor") s += 14;
    else if (io === "both") s += 4;
    else s -= 10;
  } else if (input.vibe === "indoors") {
    if (io === "indoor") s += 14;
    else if (io === "both") s += 4;
    else s -= 10;
  } else {
    // mix: slight diversity bonus
    s += 2;
  }

  // Weather overrides
  if (weather.isRainy) {
    if (io === "outdoor") s -= 22;
    if (io === "indoor") s += 8;
  }
  if (weather.isHot) {
    if (io === "outdoor") s -= 12;
    if (io === "indoor") s += 5;
  }
  if (weather.isCold) {
    if (io === "outdoor") s -= 6;
  }
  if (weather.isSunny && input.vibe !== "indoors") {
    if (io === "outdoor") s += 6;
  }

  // Kid-friendliness
  const needsKids = input.who === "family-young" || input.who === "family-kids";
  if (needsKids) {
    if (c.kidFriendly) s += 18;
    else s -= 30; // hard exclusion in practice
  }

  // Budget
  if (input.budget === "free") {
    if (c.cost === "free") s += 15;
    else if (c.cost === "low") s -= 12;
    else s -= 35;
  } else if (input.budget === "some") {
    if (c.cost === "free") s += 6;
    else if (c.cost === "low") s += 10;
    else s -= 6;
  } else {
    // anything
    if (c.cost === "free") s += 3;
    else if (c.cost === "low") s += 5;
  }

  // Category diversity — strongly penalize reusing the same category
  if (usedCategories.has(c.category)) s -= 30;

  // Today bonus — this is happening right now
  if (c.isTodaySpecial) s += 20;

  // Day-restricted events not active today: exclude them entirely
  if (c.hasDayRestriction && !c.isTodaySpecial) return -9999;

  // Featured events
  if (c.isEvent && (c as Candidate & { featured?: boolean }).featured) s += 5;

  // Audience fit
  if (input.who === "solo" || input.who === "couple") {
    if (["outdoor", "museum", "neighborhood"].includes(c.category)) s += 3;
  }
  if (input.who === "teens") {
    if (["outdoor", "sports"].includes(c.category)) s += 5;
    if (c.category === "education") s -= 3;
  }
  if (input.who === "group") {
    if (["food", "neighborhood", "market"].includes(c.category)) s += 6;
  }

  return s;
}

// ── Headline generation ───────────────────────────────────────────────────────

function buildHeadline(input: PlanInput, stops: PlanStop[]): string {
  const freeCount = stops.filter((s) => s.cost === "free").length;
  const hasToday = stops.some((s) => s.isTodaySpecial);

  if (input.who === "family-young") return "A perfect day for the little ones";
  if (input.who === "family-kids") return "A family day in the South Bay";
  if (hasToday) return "Your day, built around what's happening right now";
  if (freeCount === stops.length) return "A completely free day in the South Bay";
  if (input.vibe === "outdoors") return "A South Bay day built for the outdoors";
  if (input.vibe === "indoors") return "An indoors-forward South Bay day";
  if (input.duration === "quick") return "The best two hours near you";
  if (input.duration === "evening") return "A South Bay evening, sorted";
  return "Your South Bay day, curated";
}

// ── Main export ───────────────────────────────────────────────────────────────

export function buildDayPlan(input: PlanInput, weatherRaw: string): DayPlan {
  const date = input.date ?? new Date();
  const weather = parseWeather(weatherRaw);
  const slots = getSlotsForDuration(input.duration);
  const candidates = buildCandidates(date);
  const used = new Set<string>();
  const usedCategories = new Set<string>();
  const stops: PlanStop[] = [];
  let lastCitySlug: string | null = input.homeCity ?? null;

  for (const slot of slots) {
    const scored = candidates
      .map((c) => ({ c, score: scoreCandidate(c, slot, input, weather, used, usedCategories, lastCitySlug) }))
      .sort((a, b) => b.score - a.score);

    const winner = scored[0]?.c;
    if (!winner || scored[0].score < -100) continue;

    used.add(winner.id);
    usedCategories.add(winner.category);
    lastCitySlug = winner.citySlug || lastCitySlug;
    const meta = SLOT_META[slot];

    stops.push({
      time: meta.time,
      slotLabel: meta.label,
      title: winner.title,
      venue: winner.venue,
      city: winner.city,
      cost: winner.cost,
      costNote: winner.costNote,
      kidFriendly: winner.kidFriendly,
      why: winner.why,
      emoji: winner.emoji,
      url: winner.url,
      isEvent: winner.isEvent,
      isTodaySpecial: winner.isTodaySpecial,
      indoorOutdoor: winner.indoorOutdoor,
    });
  }

  return {
    stops,
    weatherNote: buildWeatherNote(weather, input),
    headline: buildHeadline(input, stops),
  };
}
