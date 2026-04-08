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

    // ── Tonight's meetings ──
    const tonightMeetings = pickTonightMeetings();

    // ── Lead stories (ranked by freshness) ──
    const leadStories = pickLeadStories(homeCity, tonightMeetings, todayEvents);

    // ── Civic highlights ──
    const civicHighlights = pickCivicHighlights(homeCity);

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
    .filter((e) => e.category !== "sports" && isNotEnded(e.time) && !BORING_SIGNALS.test(e.title))
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

// Far-future development projects should never lead the homepage
const FAR_FUTURE = /203\d|204\d|long.term/i;

// Categories that make good hero stories
const HERO_CATEGORIES = new Set(["music", "arts", "community", "food", "outdoor", "sports", "market"]);
// Words that signal boring/internal events
const BORING_SIGNALS = /closed|cancelled|canceled|committee meeting|staff|internal|board of|grackle|webinar|101:|professional development/i;

function pickLeadStories(homeCity: City | null, todayMeetings: Array<{ cityName: string; bodyName: string }>, todayEvents: UpcomingEvent[]): LeadStory[] {
  const candidates: Array<LeadStory & { freshness: number }> = [];

  // ── Best event today (should often be the lead!) ──
  const eventCandidates = todayEvents
    .filter((e) =>
      e.category !== "sports" &&
      !BORING_SIGNALS.test(e.title) &&
      isNotEnded(e.time) &&
      (HERO_CATEGORIES.has(e.category) || e.cost === "free")
    )
    .sort((a, b) => {
      // Prefer: has time > all day, city match > not, free > paid, named venue > none
      let scoreA = 0, scoreB = 0;
      if (a.time) scoreA += 10;
      if (b.time) scoreB += 10;
      if (homeCity && a.city === homeCity) scoreA += 8;
      if (homeCity && b.city === homeCity) scoreB += 8;
      if (a.cost === "free") scoreA += 3;
      if (b.cost === "free") scoreB += 3;
      if (a.venue) scoreA += 2;
      if (b.venue) scoreB += 2;
      if (HERO_CATEGORIES.has(a.category)) scoreA += 5;
      if (HERO_CATEGORIES.has(b.category)) scoreB += 5;
      return scoreB - scoreA;
    });

  const bestEvent = eventCandidates[0];
  if (bestEvent) {
    const timeStr = bestEvent.time ? ` · ${bestEvent.time}` : "";
    const venueStr = bestEvent.venue ? ` at ${bestEvent.venue}` : "";
    const cityName = bestEvent.city === "multi" ? "" : getCityName(bestEvent.city as City);
    candidates.push({
      type: "event",
      headline: bestEvent.title,
      lede: `${cityName}${venueStr}${timeStr}${bestEvent.cost === "free" ? " · Free" : ""}`,
      accentColor: bestEvent.category === "music" ? "#7c3aed" : bestEvent.category === "arts" ? "#be185d" : bestEvent.category === "food" ? "#059669" : "#0369a1",
      emoji: bestEvent.category === "music" ? "🎵" : bestEvent.category === "arts" ? "🎨" : bestEvent.category === "food" ? "🍜" : bestEvent.category === "outdoor" ? "🌿" : "📅",
      tab: "events",
      freshness: 90,
    });
  }

  // ── Tonight at city hall ──
  if (todayMeetings.length > 0) {
    const names = todayMeetings.slice(0, 3).map((m) => m.cityName).join(", ");
    candidates.push({
      type: "civic",
      headline: todayMeetings.length === 1
        ? `${todayMeetings[0].cityName} ${todayMeetings[0].bodyName} meets tonight`
        : `${todayMeetings.length} city councils meet tonight`,
      lede: todayMeetings.length === 1
        ? `${todayMeetings[0].cityName} ${todayMeetings[0].bodyName} is in session tonight.`
        : `${names} — city councils are in session tonight.`,
      accentColor: "#4338ca",
      emoji: "🏛️",
      tab: "government",
      freshness: 85, // High but below best event — meetings are important but events lead
    });
  }

  // ── Civic / around-town (yesterday's council actions) ──
  const aroundItems = (aroundTownJson as { items: AroundTownItem[] }).items ?? [];
  const cityItems = homeCity ? aroundItems.filter((it) => it.cityId === homeCity) : [];
  const civicItem = cityItems[0] ?? aroundItems[0];
  if (civicItem) {
    const daysSince = (Date.now() - new Date(civicItem.date).getTime()) / 86400000;
    if (daysSince < 7) {
      candidates.push({
        type: "civic",
        headline: civicItem.headline,
        lede: `${civicItem.cityName} · ${civicItem.summary.slice(0, 120)}${civicItem.summary.length > 120 ? "…" : ""}`,
        accentColor: "#1d4ed8",
        emoji: "🏛️",
        tab: "government",
        url: civicItem.sourceUrl,
        cityId: civicItem.cityId,
        freshness: Math.max(0, 80 - daysSince * 15),
      });
    }
  }

  // ── Health closure (only if closure date is within 7 days) ──
  const { flags = [] } = healthScoresJson as { flags?: Array<{ name: string; city: string; date: string; result: string; summary: string }> };
  const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const closure = flags.find((f) => f.result === "Y" && f.date >= cutoff7d);
  if (closure) {
    // Only show if the summary looks clean (not raw cert data)
    const summary = closure.summary || "";
    const looksClean = summary.length > 20 && !summary.includes("certificate:");
    if (looksClean) {
      const daysSince = (Date.now() - new Date(closure.date).getTime()) / 86400000;
      candidates.push({
        type: "health",
        headline: `${closure.name} temporarily closed`,
        lede: `${closure.city} · ${summary.slice(0, 110)}`,
        accentColor: "#92400E",
        emoji: "⚠️",
        tab: "government",
        freshness: Math.max(0, 70 - daysSince * 15),
      });
    }
  }

  // ── Development (only near-term, opening-soon strongly preferred) ──
  const openingSoon = DEV_PROJECTS.filter(
    (p) => p.status === "opening-soon" && !FAR_FUTURE.test(p.timeline ?? "")
  );
  if (openingSoon.length > 0) {
    const p = openingSoon.find((p) => p.featured) ?? openingSoon[0];
    candidates.push({
      type: "development",
      headline: p.name,
      lede: p.description?.slice(0, 120) ?? `Opening soon · ${p.city}`,
      accentColor: "#b45309",
      emoji: "🏗️",
      tab: "development",
      freshness: 50,
    });
  }

  // ── Restaurant opening (only if data looks clean — skip raw permit codes) ──
  const radarItems = (restaurantRadarJson as any).items ?? [];
  for (const r of radarItems) {
    const desc = r.cuisine || r.description || "";
    // Skip entries with raw permit codes like "(Bp100%)" or "(Sti)"
    if (/\(B[ep]|Srp|Ti\b/.test(desc)) continue;
    if (!r.name || r.name.length < 3) continue;
    candidates.push({
      type: "opening",
      headline: `Now open: ${r.name}`,
      lede: `${getCityName(r.city as City)} · ${desc || "New restaurant"}`,
      accentColor: "#059669",
      emoji: "🍽️",
      tab: "food",
      freshness: 45,
    });
    break;
  }

  // Sort by freshness score, take top 4
  candidates.sort((a, b) => b.freshness - a.freshness);
  return candidates.slice(0, 4).map(({ freshness, ...story }) => story);
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

  const MAX_AGE_DAYS = 30;
  const seen = new Set<string>();
  for (const city of cityOrder) {
    if (seen.has(city)) continue;
    seen.add(city);
    const d = digests[city];
    if (!d?.summary) continue;
    // Skip stale digests — no year-old content on the front page
    if (d.meetingDateIso || d.meetingDate) {
      const dateStr = d.meetingDateIso ?? d.meetingDate ?? "";
      const age = (Date.now() - new Date(dateStr).getTime()) / 86400000;
      if (age > MAX_AGE_DAYS || isNaN(age)) continue;
    }
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

  // Restaurant openings (skip raw permit codes)
  const radarItems = (restaurantRadarJson as any).items ?? [];
  let restaurantCount = 0;
  for (const r of radarItems) {
    if (restaurantCount >= 2) break;
    const desc = r.cuisine || r.description || "";
    if (/\(B[ep]|Srp|Ti\b/.test(desc)) continue;
    if (!r.name || r.name.length < 3) continue;
    items.push({
      type: "restaurant",
      title: r.name,
      subtitle: `${getCityName(r.city as City)} · ${desc || "New restaurant"}`,
      emoji: "🍽️",
    });
    restaurantCount++;
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
