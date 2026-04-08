// ---------------------------------------------------------------------------
// South Bay Signal — Homepage data layer
// ---------------------------------------------------------------------------
// Curates, ranks, and shapes data from all artifacts into a front-page feed.
// This is the "brain" of the homepage — determines what leads, what's secondary,
// and what gets surfaced based on city, time, and freshness.

import { useState, useEffect, useMemo } from "react";
import type { City, Tab } from "../../../lib/south-bay/types";
import { getCityName } from "../../../lib/south-bay/cities";
import {
  NOW_MINUTES, TODAY_ISO, DAY_IDX, MONTH, IS_WEEKEND_MODE,
  TOMORROW_ISO, NEXT_DAYS, parseMinutes, startMinutes, isNotEnded,
  hasNotStarted, timeBucket, type TimeBucket, BUCKET_ORDER,
  formatAge,
} from "../../../lib/south-bay/timeHelpers";

import upcomingJson from "../../../data/south-bay/upcoming-events.json";
import digestsJson from "../../../data/south-bay/digests.json";
import aroundTownJson from "../../../data/south-bay/around-town.json";
import cityBriefingsJson from "../../../data/south-bay/city-briefings.json";
import techBriefingJson from "../../../data/south-bay/tech-briefing.json";
import restaurantRadarJson from "../../../data/south-bay/restaurant-radar.json";
import upcomingMeetingsJson from "../../../data/south-bay/upcoming-meetings.json";
import healthScoresJson from "../../../data/south-bay/health-scores.json";
import curatedPhotosJson from "../../../data/south-bay/curated-photos.json";
import apodJson from "../../../data/south-bay/apod.json";
import airQualityJson from "../../../data/south-bay/air-quality.json";
import outagesJson from "../../../data/south-bay/outages.json";
import { SOUTH_BAY_EVENTS, type SBEvent, type DayOfWeek } from "../../../data/south-bay/events-data";
import { DEV_PROJECTS, STATUS_CONFIG } from "../../../data/south-bay/development-data";

// ── Types ──

export type UpcomingEvent = {
  id: string;
  title: string;
  date: string;
  displayDate?: string;
  time: string | null;
  endTime?: string | null;
  venue: string;
  city: string;
  category: string;
  cost: string;
  costNote?: string;
  description?: string;
  url?: string | null;
  source: string;
  kidFriendly: boolean;
  ongoing?: boolean;
};

export type LeadStory = {
  type: "civic" | "event" | "weather" | "opening" | "health" | "development";
  headline: string;
  lede: string;
  accentColor: string;
  emoji: string;
  tab?: Tab;
  url?: string;
  cityId?: string;
};

export type ForecastDay = {
  date: string;
  emoji: string;
  desc: string;
  high: number;
  low: number;
  rainPct: number;
};

export type CivicHighlight = {
  cityId: string;
  cityName: string;
  headline: string;
  summary: string;
  meetingDate?: string;
  sourceUrl?: string;
};

export type MeetingEntry = {
  date: string;
  displayDate: string;
  bodyName: string;
  location?: string;
  url?: string;
};

type AroundTownItem = {
  headline: string;
  summary: string;
  cityId: string;
  cityName: string;
  source: string;
  sourceUrl?: string;
  date: string;
};

// ── Helper to check static events ──

const DAY_NAME = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][DAY_IDX] as DayOfWeek;

function isActiveToday(e: SBEvent): boolean {
  if ((e as any).startDate && TODAY_ISO < (e as any).startDate) return false;
  if (e.months && !e.months.includes(MONTH)) return false;
  if (!e.days) return e.recurrence !== "seasonal";
  if (!e.days.includes(DAY_NAME)) return false;
  return isNotEnded(e.time);
}

// ── Main hook ──

export function useHomepageData(homeCity: City | null) {
  const [weather, setWeather] = useState<string | null>(null);
  const [forecast, setForecast] = useState<ForecastDay[] | null>(null);

  useEffect(() => {
    const cityParam = homeCity ? `?city=${homeCity}` : "";
    fetch(`/api/weather${cityParam}`)
      .then((r) => r.json())
      .then((d) => {
        setWeather(d.weather ?? null);
        setForecast(d.forecast ?? null);
      })
      .catch(() => {});
  }, [homeCity]);

  return useMemo(() => {
    // ── All upcoming events ──
    const rawUpcoming = (upcomingJson as { events: UpcomingEvent[]; generatedAt?: string }).events ?? [];
    const eventsGeneratedAt = (upcomingJson as any).generatedAt;

    // Collapse library closures
    const allUpcoming = collapseClosures(rawUpcoming);
    const todayEvents = allUpcoming.filter((e) => e.date === TODAY_ISO && !e.ongoing);
    const tomorrowEvents = allUpcoming.filter((e) => e.date === TOMORROW_ISO && !e.ongoing);

    // City-filtered events with fallback chain:
    // 1. City today → 2. All South Bay today → 3. Tomorrow
    const cityTodayEvents = homeCity
      ? todayEvents.filter((e) => e.city === homeCity)
      : todayEvents;

    // Events by time bucket — with late-evening fallback
    let bucketedEvents = bucketEvents(
      homeCity ? cityTodayEvents : todayEvents,
      homeCity,
    );

    // If city has nothing left today, try all South Bay
    let eventsSectionTitle = IS_WEEKEND_MODE
      ? "This Weekend"
      : homeCity ? `Today in ${getCityName(homeCity)}` : "Happening Today";

    if (bucketedEvents.length === 0 && homeCity) {
      bucketedEvents = bucketEvents(todayEvents, null);
      if (bucketedEvents.length > 0) {
        eventsSectionTitle = "Today in the South Bay";
      }
    }

    // If still nothing, show tomorrow
    let showingTomorrow = false;
    if (bucketedEvents.length === 0 && tomorrowEvents.length > 0) {
      bucketedEvents = bucketEvents(tomorrowEvents, homeCity);
      if (bucketedEvents.length === 0) {
        bucketedEvents = bucketEvents(tomorrowEvents, null);
      }
      eventsSectionTitle = "Tomorrow";
      showingTomorrow = true;
    }

    // Sports today
    const sportsToday = todayEvents
      .filter((e) => e.category === "sports" && startMinutes(e.time) > NOW_MINUTES)
      .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

    // Ongoing (multi-day)
    const ongoing = allUpcoming
      .filter((e) => e.ongoing === true && e.date <= TODAY_ISO && e.category !== "sports")
      .slice(0, 6);

    // ── Lead stories (ranked) ──
    const leadStories = pickLeadStories(homeCity);

    // ── Civic highlights ──
    const civicHighlights = pickCivicHighlights(homeCity);

    // ── Tonight's meetings ──
    const tonightMeetings = pickTonightMeetings();

    // ── New & notable ──
    const newNotable = pickNewNotable();

    // ── City briefing ──
    const cityBriefing = homeCity ? getCityBriefing(homeCity) : null;

    // ── Event counts ──
    const todayCount = todayEvents.length;
    const cityTodayCount = cityTodayEvents.length;

    // ── Photo of the day ──
    const photo = pickHeroPhoto(homeCity);

    // ── Freshness ──
    const freshness = {
      events: eventsGeneratedAt,
      meetings: (upcomingMeetingsJson as any).generatedAt,
      briefings: (cityBriefingsJson as any).generatedAt,
    };

    return {
      weather,
      forecast,
      leadStories,
      bucketedEvents,
      eventsSectionTitle,
      showingTomorrow,
      sportsToday,
      ongoing,
      civicHighlights,
      tonightMeetings,
      newNotable,
      cityBriefing,
      todayCount,
      cityTodayCount,
      tomorrowEvents,
      allUpcoming,
      photo,
      freshness,
    };
  }, [homeCity, weather, forecast]);
}

// ── Collapse library closures ──

function collapseClosures(events: UpcomingEvent[]): UpcomingEvent[] {
  const closurePattern = /\bClosed\b/i;
  const byDateSource = new Map<string, UpcomingEvent[]>();
  const nonClosure: UpcomingEvent[] = [];
  for (const e of events) {
    if (closurePattern.test(e.title) && e.source) {
      const key = `${e.date}::${e.source}`;
      if (!byDateSource.has(key)) byDateSource.set(key, []);
      byDateSource.get(key)!.push(e);
    } else {
      nonClosure.push(e);
    }
  }
  const collapsed: UpcomingEvent[] = [];
  for (const [, group] of byDateSource) {
    if (group.length >= 2) {
      const rep = group[0];
      collapsed.push({
        ...rep,
        id: `${rep.source.replace(/\s+/g, "-").toLowerCase()}-all-closed-${rep.date}`,
        title: `All ${rep.source} Locations Closed`,
        city: "multi",
        time: null,
        endTime: null,
      });
    } else {
      collapsed.push(...group);
    }
  }
  return [...nonClosure, ...collapsed].sort((a, b) => a.date.localeCompare(b.date));
}

// ── Bucket events by time of day ──

type BucketedEvents = Array<{ bucket: TimeBucket; label: string; events: UpcomingEvent[] }>;

function bucketEvents(events: UpcomingEvent[], homeCity: City | null): BucketedEvents {
  const active = events
    .filter((e) => e.category !== "sports" && isNotEnded(e.time))
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  const groups = new Map<TimeBucket, UpcomingEvent[]>();
  for (const e of active) {
    const b = timeBucket(e.time);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b)!.push(e);
  }

  const labels: Record<TimeBucket, string> = {
    now: "Happening Now",
    morning: "This Morning",
    afternoon: "This Afternoon",
    evening: "Tonight",
    none: "All Day",
  };

  return BUCKET_ORDER
    .filter((b) => groups.has(b))
    .map((b) => ({ bucket: b, label: labels[b], events: groups.get(b)! }));
}

// ── Pick lead stories ──

const GOVT_NOISE = [
  "roll call", "approval of minutes", "approval of agenda", "public comment",
  "consent calendar", "closed session", "adjournment", "pledge of allegiance",
  "presentations and proclamations", "multiple ways to watch", "live translation",
  "cancelled", "rescheduled", "postponed",
];

function isNoisyTopic(topic: string): boolean {
  const lower = topic.toLowerCase();
  return GOVT_NOISE.some((n) => lower.startsWith(n));
}

function pickLeadStories(homeCity: City | null): LeadStory[] {
  const stories: LeadStory[] = [];

  // 1. Civic/around-town lead
  const aroundItems = (aroundTownJson as { items: AroundTownItem[] }).items ?? [];
  const cityItems = homeCity ? aroundItems.filter((it) => it.cityId === homeCity) : [];
  const civicItem = cityItems[0] ?? aroundItems[0];
  if (civicItem) {
    stories.push({
      type: "civic",
      headline: civicItem.headline,
      lede: `${civicItem.cityName} · ${civicItem.summary.slice(0, 120)}${civicItem.summary.length > 120 ? "…" : ""}`,
      accentColor: "#1d4ed8",
      emoji: "🏛️",
      tab: "government",
      url: civicItem.sourceUrl,
      cityId: civicItem.cityId,
    });
  }

  // 2. Health closure alert
  const { flags = [] } = healthScoresJson as { flags?: Array<{ name: string; city: string; date: string; result: string; summary: string }> };
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];
  const closure = flags.find((f) => f.result === "Y" && f.date >= cutoff);
  if (closure) {
    stories.push({
      type: "health",
      headline: `${closure.name} temporarily closed`,
      lede: `${closure.city} · ${closure.summary?.slice(0, 110) ?? "Closed following health inspection."}`,
      accentColor: "#92400E",
      emoji: "⚠️",
      tab: "government",
    });
  }

  // 3. Development story
  const openingSoon = DEV_PROJECTS.filter((p) => p.status === "opening-soon");
  const underConstruction = DEV_PROJECTS.filter((p) => p.status === "under-construction");
  const devProject = openingSoon[0] ?? underConstruction[0];
  if (devProject) {
    const statusLabel = STATUS_CONFIG[devProject.status]?.label ?? devProject.status;
    stories.push({
      type: "development",
      headline: devProject.name,
      lede: devProject.description?.slice(0, 120) ?? `${statusLabel} · ${devProject.city}`,
      accentColor: "#b45309",
      emoji: "🏗️",
      tab: "development",
    });
  }

  // 4. Restaurant opening
  const radarItems = (restaurantRadarJson as any).items ?? [];
  const newOpening = radarItems[0];
  if (newOpening) {
    stories.push({
      type: "opening",
      headline: `Now open: ${newOpening.name}`,
      lede: `${newOpening.city} · ${newOpening.cuisine || newOpening.description || "New restaurant"}`,
      accentColor: "#059669",
      emoji: "🍽️",
      tab: "food",
    });
  }

  return stories;
}

// ── Civic highlights ──

function pickCivicHighlights(homeCity: City | null): CivicHighlight[] {
  const digests = digestsJson as Record<string, {
    city?: string;
    cityName?: string;
    summary?: string;
    keyTopics?: string[];
    meetingDate?: string;
    meetingDateIso?: string;
    sourceUrl?: string;
  }>;

  const highlights: CivicHighlight[] = [];
  const cityOrder = homeCity
    ? [homeCity, "san-jose", "sunnyvale", "mountain-view", "palo-alto", "cupertino", "santa-clara", "campbell", "los-gatos", "saratoga"]
    : ["san-jose", "sunnyvale", "mountain-view", "palo-alto", "cupertino", "santa-clara", "campbell", "los-gatos", "saratoga"];

  const seen = new Set<string>();
  for (const city of cityOrder) {
    if (seen.has(city)) continue;
    seen.add(city);
    const d = digests[city];
    if (!d?.summary) continue;
    const topic = d.keyTopics?.find((t) => !isNoisyTopic(t));
    highlights.push({
      cityId: city,
      cityName: d.cityName ?? getCityName(city as City),
      headline: topic ?? "City Council Update",
      summary: d.summary.slice(0, 140) + (d.summary.length > 140 ? "…" : ""),
      meetingDate: d.meetingDate,
      sourceUrl: d.sourceUrl,
    });
  }

  return highlights.slice(0, 4);
}

// ── Tonight's meetings ──

function pickTonightMeetings(): Array<{ cityName: string; bodyName: string; date: string; url?: string }> {
  const data = upcomingMeetingsJson as unknown as { meetings: Record<string, MeetingEntry> };
  if (!data.meetings) return [];

  return Object.entries(data.meetings)
    .filter(([, m]) => m.date === TODAY_ISO)
    .map(([cityId, m]) => ({
      cityName: getCityName(cityId as City),
      bodyName: m.bodyName,
      date: m.displayDate,
      url: m.url,
    }));
}

// ── New & notable ──

export type NotableItem = {
  type: "restaurant" | "permit" | "health";
  title: string;
  subtitle: string;
  emoji: string;
  url?: string;
};

function pickNewNotable(): NotableItem[] {
  const items: NotableItem[] = [];

  // Restaurant openings
  const radarItems = (restaurantRadarJson as any).items ?? [];
  for (const r of radarItems.slice(0, 2)) {
    items.push({
      type: "restaurant",
      title: r.name,
      subtitle: `${r.city} · ${r.cuisine || "New restaurant"}`,
      emoji: "🍽️",
    });
  }

  // Health closures
  const { flags = [] } = healthScoresJson as { flags?: Array<{ name: string; city: string; result: string; date: string }> };
  const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];
  const closures = flags.filter((f) => f.result === "Y" && f.date >= cutoff14).slice(0, 1);
  for (const c of closures) {
    items.push({
      type: "health",
      title: `${c.name} closed`,
      subtitle: `${c.city} · Health inspection`,
      emoji: "⚠️",
    });
  }

  return items.slice(0, 4);
}

// ── City briefing ──

export type CityBriefingData = {
  cityName: string;
  summary: string;
  highlights: Array<{ title: string; when: string | null; category: string; url: string | null }>;
  weekLabel: string;
};

function getCityBriefing(city: City): CityBriefingData | null {
  const data = cityBriefingsJson as { cities?: Record<string, any> };
  const b = data.cities?.[city];
  if (!b?.summary) return null;
  return {
    cityName: b.cityName,
    summary: b.summary,
    highlights: b.highlights ?? [],
    weekLabel: b.weekLabel ?? "",
  };
}

// ── Hero photo ──

export type HeroPhoto = {
  url: string;
  title: string;
  photographer: string;
  city?: string;
};

function pickHeroPhoto(homeCity: City | null): HeroPhoto | null {
  const photos = (curatedPhotosJson as unknown as { photos?: Array<{ url: string; title: string; photographer: string; city?: string }> }).photos;
  if (!photos?.length) return null;

  // Try city-specific first, then any
  if (homeCity) {
    const cityPhoto = photos.find((p) => p.city === homeCity);
    if (cityPhoto) return cityPhoto;
  }

  // Seeded daily shuffle
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return photos[dayOfYear % photos.length];
}
