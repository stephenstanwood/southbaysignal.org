// ---------------------------------------------------------------------------
// South Bay Today — City Page
// ---------------------------------------------------------------------------
// Mini-homepage for a single city: today's events, next meeting, briefing,
// recent civic actions, and links back to the main site.

import { useState, useEffect, useMemo } from "react";
import type { City } from "../../../lib/south-bay/types";
import { CITY_MAP } from "../../../lib/south-bay/cities";
import { isVirtualEvent } from "../../../lib/south-bay/eventFilters.mjs";
import {
  TODAY_ISO, NOW_PT,
  startMinutes, formatTimeRange, hasNotStarted,
  formatAge,
} from "../../../lib/south-bay/timeHelpers";
import {
  type Bucket, BUCKET_ORDER, BUCKET_LABELS,
  isBucket, inferBucketFromTimeBlock,
} from "../../../lib/south-bay/buckets";

import upcomingMeetingsJson from "../../../data/south-bay/upcoming-meetings.json";
import digestsJson from "../../../data/south-bay/digests.json";
import redditPulseJson from "../../../data/south-bay/reddit-pulse.json";
import openNowCandidatesJson from "../../../data/south-bay/open-now-candidates.json";
import { isPlaceTemporarilyUnavailable } from "../../../lib/south-bay/placeAvailability.mjs";
import { openCampCountForCity } from "../../../lib/south-bay/cityCamps";

import Masthead from "../Masthead";
import ForecastCard from "../cards/ForecastCard";
import PhotoStrip from "../homepage/PhotoStrip";

// ── Types ──

type UpcomingEvent = {
  id: string;
  title: string;
  date: string;
  time: string | null;
  endTime?: string | null;
  venue: string;
  city: string;
  category: string;
  cost: string;
  url?: string | null;
  source: string;
  kidFriendly: boolean;
  virtual?: boolean;
  ongoing?: boolean;
  blurb?: string | null;
  description?: string | null;
};

// ── Category emoji ──

const CAT_EMOJI: Record<string, string> = {
  music: "🎵", arts: "🎨", family: "👨‍👩‍👦", education: "📚", community: "🤝",
  market: "🌽", food: "🍜", outdoor: "🌿", sports: "🏟️",
};

// ── Agenda items helpers ──
//
// upcoming-meetings.json already runs SKIP_PREFIXES/SKIP_STARTS_WITH/SKIP_REGEX
// at scrape time, but we run a second pass on the client so the panel never
// shows obvious closed-session boilerplate even if a city's filter coverage
// drifts. Be conservative — only drop items we're certain are non-substantive.
type AgendaItem = { title: string; sequence: number };

const CLIENT_AGENDA_DROP_RE = [
  /^conference with (?:legal counsel|real property|labor)/i,
  /^closed session/i,
  /^public hearing\b/i,
  /^approval of (?:the )?(?:[a-z\d ,]+ )?(?:meeting )?minutes\b/i,
];

function trimAgendaTitle(t: string): string {
  // Strip "Subject:" wrapper that some cities prepend
  let s = t.replace(/^subject:\s*/i, "").trim();
  // Drop trailing California Government Code references
  s = s.replace(/\s*\((?:california\s+)?government\s+code\s*[^)]*\)\s*$/i, "").trim();
  // Cap length so the panel doesn't blow up on a paragraph-length item
  if (s.length > 140) s = s.slice(0, 137) + "…";
  return s;
}

function filterAgendaItems(items: AgendaItem[] | undefined): AgendaItem[] {
  if (!items) return [];
  return items.filter((it) => {
    const t = (it.title || "").trim();
    if (t.length < 12) return false;
    return !CLIENT_AGENDA_DROP_RE.some((re) => re.test(t));
  });
}

// ── Props ──

type Props = {
  cityId: string;
  cityName: string;
};

export default function CityPage({ cityId, cityName }: Props) {
  const [weather, setWeather] = useState<string | null>(null);
  const [upcomingData, setUpcomingData] = useState<{ events: UpcomingEvent[]; generatedAt?: string } | null>(null);

  useEffect(() => {
    fetch(`/api/weather?city=${cityId}`)
      .then((r) => r.json())
      .then((d) => { setWeather(d.weather ?? null); })
      .catch(() => {});
  }, [cityId]);

  useEffect(() => {
    // City pages only render today/tomorrow/this-weekend, so the 14-day near
    // feed (~40% of the full payload) covers everything they show.
    fetch("/api/south-bay/upcoming-events-near")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setUpcomingData(d ?? { events: [] }))
      .catch(() => setUpcomingData({ events: [] }));
  }, []);

  // ── Events ── (per-day filtering happens inside CityEventsBlock)
  const allEvents = upcomingData?.events ?? [];
  const eventsGenAt = upcomingData?.generatedAt;

  // ── Meeting ──
  const meetings = (upcomingMeetingsJson as unknown as { meetings: Record<string, any> }).meetings ?? {};
  const nextMeeting = meetings[cityId];

  // ── Digest ──
  const digest = (digestsJson as Record<string, any>)[cityId];

  // "Tonight" highlight and digest staleness both depend on the visitor's
  // clock, which the build-time render can't know. First render uses neutral
  // values derived only from the JSON (not tonight; digest fresh if it has a
  // date, hidden if not) so server and client HTML match; the mount effect
  // applies the real clock. Worst case is a one-frame style/visibility tweak
  // in the bottom-of-page civic panel.
  const [meetingIsToday, setMeetingIsToday] = useState(false);
  const [digestAge, setDigestAge] = useState<number>(() => (digest?.meetingDateIso ? 0 : 999));
  useEffect(() => {
    setMeetingIsToday(nextMeeting?.date === TODAY_ISO);
    setDigestAge(
      digest?.meetingDateIso
        ? (Date.now() - new Date(digest.meetingDateIso).getTime()) / 86400000
        : 999,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId]);

  // ── City config ──
  const city = CITY_MAP[cityId as City];

  return (
    <>
      {/* Site-wide masthead + tab nav — same chrome as the main homepage so
          city pages feel like a scoped variant rather than a one-off
          sub-page. Activetab is null because city pages aren't a tab. */}
      <Masthead activeTab={null} />

      {/* City content — mirrors the homepage container width (800px) so the
          bucket grid + forecast strip land at homepage proportions. */}
      <div style={{ maxWidth: 800, margin: "0 auto", padding: "0 16px 80px" }}>
        {/* Sub-header strip: city name + "this is a city page" breadcrumb. */}
        <div style={{ padding: "16px 0 4px", textAlign: "center" }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" as const, color: "var(--sb-light)", marginBottom: 4 }}>
            Your city
          </div>
          <h1 style={{
            fontFamily: "var(--sb-serif)", fontWeight: 900, fontSize: 42,
            color: "var(--sb-ink)", margin: "0 0 4px", lineHeight: 1.05,
            letterSpacing: "-0.02em",
          }}>
            {cityName}
          </h1>
          {weather && (
            <div style={{ fontSize: 13, color: "var(--sb-muted)" }}>
              {weather}
              {eventsGenAt && (
                <span style={{ marginLeft: 8, fontSize: 11, color: "var(--sb-light)" }}>
                  · Updated {formatAge(eventsGenAt)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Camps pointer — one-line nudge to /camps, only when this city has
            a program still running this summer. Renders nothing otherwise. */}
        <CityCampsPointer cityId={cityId} cityName={cityName} />

        {/* 5-day forecast strip — same component the homepage uses. */}
        <div style={{ marginTop: 12, marginBottom: 0 }}>
          <ForecastCard homeCity={cityId as City} />
        </div>

        {/* Photo scroll — same curated Flickr marquee as the homepage, scoped
            to this city (falls back to the full South Bay pool when the
            city's tagged photo count is too thin for a seamless loop). */}
        <div style={{ margin: "14px -16px" }}>
          <PhotoStrip cityFilter={cityId} />
        </div>

        {/* ═══ YOUR DAY ═══ */}
        <CityDayPlan cityId={cityId as City} cityName={cityName} />

        {/* ═══ EVENTS (Today / Tomorrow / This Weekend) ═══ */}
        <CityEventsBlock events={allEvents} cityId={cityId} cityName={cityName} />

        {/* ═══ THE CONVERSATION (Reddit tiles) ═══ */}
        <CityRedditTiles cityId={cityId} cityName={cityName} />

        {/* ═══ OPEN RIGHT NOW — randomized "oh yeah, THAT place" panel ═══ */}
        <CityOpenNow cityId={cityId} cityName={cityName} />

        {/* ═══ AT CITY HALL — pinned to the bottom; next meeting + last digest
            side-by-side. */}
        <CityHallPanel
          nextMeeting={nextMeeting}
          meetingIsToday={meetingIsToday}
          digest={digest}
          digestAge={digestAge}
        />

        {/* ═══ FOOTER ═══ */}
        <div style={{ borderTop: "2px solid var(--sb-ink)", paddingTop: 16, marginTop: 28, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <a href="/" style={{ fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 14, color: "var(--sb-ink)", textDecoration: "none" }}>
            ← South Bay Today
          </a>
          {city?.website && (
            <a href={city.website} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--sb-muted)", textDecoration: "none" }}>
              {cityName} official site →
            </a>
          )}
        </div>
      </div>
    </>
  );
}


// ---------------------------------------------------------------------------
// City Camps Pointer — one-line nudge to /camps, only when this city has a
// program still open this summer. Colors match CampsView's own "mix it up"
// tip banner (#fffbeb/#fde68a/#92400e) so the cross-link feels like it comes
// from the same page it's pointing to, not a bolted-on ad.
// ---------------------------------------------------------------------------

function CityCampsPointer({ cityId, cityName }: { cityId: string; cityName: string }) {
  const count = openCampCountForCity(cityId);
  if (count === 0) return null;

  return (
    <a
      href="/camps"
      style={{
        display: "flex", alignItems: "center", gap: 8,
        marginTop: 10, padding: "10px 14px", borderRadius: 8,
        border: "1px solid #fde68a", background: "#fffbeb",
        color: "#92400e", textDecoration: "none",
        fontSize: 13, fontWeight: 600,
      }}
    >
      <span aria-hidden style={{ fontSize: 16, flexShrink: 0 }}>🏕️</span>
      <span>{count} camp{count === 1 ? "" : "s"} still open in {cityName} this summer</span>
      <span aria-hidden style={{ marginLeft: "auto", fontWeight: 700, flexShrink: 0 }}>→</span>
    </a>
  );
}

// ── Event Row ──

function EventRow({ event }: { event: UpcomingEvent }) {
  const time = formatTimeRange(event.time, event.endTime);
  const emoji = CAT_EMOJI[event.category] ?? "📅";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 0",
      borderBottom: "1px solid var(--sb-border-light)",
    }}>
      <span style={{ fontSize: 18, width: 26, textAlign: "center", flexShrink: 0 }}>{emoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{
            fontFamily: "var(--sb-serif)", fontWeight: 600, fontSize: 14,
            color: "var(--sb-ink)", lineHeight: 1.3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {event.url ? (
              <a href={event.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                {event.title}
              </a>
            ) : event.title}
          </span>
          {event.cost === "free" && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#D1FAE5", color: "#065F46" }}>FREE</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--sb-muted)", display: "flex", gap: 6, marginTop: 2 }}>
          {time && <span style={{ fontWeight: 600 }}>{time}</span>}
          {/* A bare venue on a city page reads as "here, in this city" — say
              Online first when the event has no physical location. */}
          {isVirtualEvent(event) && <span style={{ fontWeight: 600, color: "#1D4ED8" }}>· Online</span>}
          {event.venue && <span>· {event.venue}</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// City Day Plan — compact plan-day integration for city pages
// ---------------------------------------------------------------------------

// Accent colors + category emoji — mirror the homepage SouthBayTodayView so a
// resident's day plan looks the same across surfaces.
const ACCENT_COLORS = ["#FF6B35", "#E63946", "#06D6A0", "#7B2FBE", "#1A5AFF", "#FF3CAC"];
const CATEGORY_EMOJI: Record<string, string> = {
  food: "🍽️", outdoor: "🌿", museum: "🏛️", entertainment: "🎭",
  wellness: "💆", shopping: "🛍️", arts: "🎨", events: "📅",
  sports: "⚾", neighborhood: "🏘️",
};

type DayCard = {
  id: string; name: string; category: string; timeBlock: string;
  blurb: string; why: string;
  photoRef?: string | null;
  image?: string | null;
  url?: string | null; mapsUrl?: string | null;
  cost?: string | null; costNote?: string | null;
  bucket?: string;
  eventTime?: string | null;
  city?: string | null;
  venue?: string | null;
  source: "event" | "place";
  role?: "pillar" | "paired-meal";
  pairedWithId?: string | null;
  pairDistanceMiles?: number | null;
};

// Rotating verbs for the rainbow loader — same set the homepage uses so the
// "Planning your day…" line carries the same personality across surfaces.
const PLAN_LOADING_VERBS = [
  "Planning", "Mapping out", "Dreaming up", "Cooking up",
  "Piecing together", "Scouting", "Curating", "Lining up", "Sketching out",
  "Assembling", "Rounding up", "Whipping up", "Mixing up", "Building",
  "Brainstorming", "Crafting", "Shuffling", "Dialing in", "Sorting out",
];

function PlanLoadingVerb() {
  const [verbIdx, setVerbIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const verb = PLAN_LOADING_VERBS[verbIdx % PLAN_LOADING_VERBS.length];
    const full = `${verb} your day...`;
    if (!deleting && charIdx < full.length) {
      const t = setTimeout(() => setCharIdx((c) => c + 1), 40 + Math.random() * 30);
      return () => clearTimeout(t);
    }
    if (!deleting && charIdx >= full.length) {
      const t = setTimeout(() => setDeleting(true), 1200);
      return () => clearTimeout(t);
    }
    if (deleting && charIdx > 0) {
      const t = setTimeout(() => setCharIdx((c) => c - 1), 20);
      return () => clearTimeout(t);
    }
    if (deleting && charIdx === 0) {
      setDeleting(false);
      setVerbIdx((v) => v + 1);
    }
  }, [charIdx, deleting, verbIdx]);

  const verb = PLAN_LOADING_VERBS[verbIdx % PLAN_LOADING_VERBS.length];
  const display = `${verb} your day...`.slice(0, charIdx);

  return (
    <p style={{
      fontSize: 26, fontWeight: 900, textAlign: "center", margin: "30px 0",
      minHeight: 36,
      background: "linear-gradient(90deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC, #FF6B35)",
      backgroundSize: "200% 100%",
      WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
      animation: "cityPlanRainbow 3s ease infinite",
      fontFamily: "'Inter', sans-serif",
      letterSpacing: -0.5, whiteSpace: "nowrap",
    }}>
      {display}<span aria-hidden="true" style={{ WebkitTextFillColor: "#6b6178", animation: "cityPlanBlink 0.8s step-end infinite" }}>|</span>
      <style>{`
        @keyframes cityPlanRainbow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes cityPlanBlink {
          50% { opacity: 0; }
        }
      `}</style>
    </p>
  );
}

// Friendly city slug → display label. Used by the bucket card inner content
// so an "EVENT" pill renders the city as "Los Gatos" not "los-gatos".
function cityLabel(slug: string | null | undefined): string {
  if (!slug) return "";
  const city = CITY_MAP[slug as City];
  if (city) return city.name;
  return slug.split("-").map((s) => s[0]?.toUpperCase() + s.slice(1)).join(" ");
}

// ---------------------------------------------------------------------------
// Bucket-grid plan card UI — mirrors the homepage SouthBayTodayView. CardInner
// is the thumbnail + content block; BucketSlot is the 2-col grid cell that
// wraps it with a label header. Visual format intentionally identical so a
// resident moving from the homepage to a city page sees the same plan shape.
// ---------------------------------------------------------------------------

interface UnsplashPhoto {
  url: string;
  photographer: string;
  photographerUrl: string;
  unsplashUrl: string;
}

function CardInner({ card }: { card: DayCard }) {
  const emoji = CATEGORY_EMOJI[card.category] || "📍";
  const [unsplash, setUnsplash] = useState<UnsplashPhoto | null>(null);
  const [tier, setTier] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/unsplash-photo?query=${encodeURIComponent(card.category)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: UnsplashPhoto | null) => { if (!cancelled && d?.url) setUnsplash(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [card.category]);

  // Sources tried in order. <img onError> advances to the next tier so we can
  // detect 404s (expired Places photoRefs are common) — a CSS background-image
  // would silently render the fallback color. Final tier is the emoji.
  const sources: Array<{ url: string; isUnsplash: boolean }> = [];
  if (card.image) sources.push({ url: card.image, isUnsplash: false });
  if (card.photoRef) sources.push({ url: `/api/place-photo?ref=${encodeURIComponent(card.photoRef)}&w=200&h=200`, isUnsplash: false });
  if (unsplash) sources.push({ url: unsplash.url, isUnsplash: true });
  const current = tier < sources.length ? sources[tier] : null;
  const showEmoji = !current;

  const rawTimeHint = card.source === "event" ? (card.eventTime || card.timeBlock || "") : "";
  const timeHint = /\d/.test(rawTimeHint) ? rawTimeHint : "";

  return (
    <>
      <div style={{ flexShrink: 0, margin: "10px 0 10px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <div style={{
          width: 80, height: 80, borderRadius: 8, overflow: "hidden",
          background: "#f5f5f5",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28,
        }}>
          {current && (
            <img
              key={current.url}
              src={current.url}
              alt={card.name}
              onError={() => setTier((t) => t + 1)}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          )}
          {showEmoji && <span aria-hidden>{emoji}</span>}
        </div>
        {current?.isUnsplash && unsplash && (
          <div style={{ width: 80, fontSize: 7, lineHeight: 1.3, color: "#6b6178", textAlign: "center" }}>
            <a href={unsplash.photographerUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#6b6178", textDecoration: "none" }}>{unsplash.photographer}</a>
            {" · "}
            <a href={unsplash.unsplashUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#6b6178", textDecoration: "none" }}>Unsplash</a>
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          {timeHint && (
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 800, color: "#000", letterSpacing: -0.2 }}>{timeHint}</span>
          )}
          {!(card.source === "event" && card.category === "events") && (
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 9, fontWeight: 700, color: "#6b6178", textTransform: "uppercase" as const, letterSpacing: 1 }}>{card.category}</span>
          )}
          {card.city && (
            <>
              <span style={{ fontSize: 9, color: "#6b6178", fontWeight: 700 }}>·</span>
              <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 9, fontWeight: 700, color: "#6b6178", textTransform: "uppercase" as const, letterSpacing: 1 }}>{cityLabel(card.city)}</span>
            </>
          )}
          {card.source === "event" && <span style={{ fontSize: 8, fontWeight: 800, color: "#fff", background: "#8738F5", padding: "1px 5px", borderRadius: 3, fontFamily: "'Inter', sans-serif", letterSpacing: 0.5 }}>EVENT</span>}
        </div>
        <h3 style={{ fontFamily: "'Inter', sans-serif", fontSize: 17, fontWeight: 900, color: "#111", margin: "0 0 4px", lineHeight: 1.25 }}>{card.name}</h3>
        {card.source === "event" && card.venue && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#6b6178" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "#6b6178" }}>{card.venue}</span>
          </div>
        )}
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: "#555", margin: "0 0 4px", lineHeight: 1.45 }}>{card.blurb}</p>
      </div>
    </>
  );
}

function BucketSlot({ bucket, card, accent, animationDelay }: { bucket: Bucket; card: DayCard; accent: string; animationDelay: number }) {
  const cardUrl = card.source === "event" ? (card.url || card.mapsUrl) : (card.mapsUrl || card.url);
  return (
    <div className={`sbt-bucket${card.role ? ` sbt-bucket--${card.role}` : ""}`} style={{ animation: `cityFadeSlideIn 0.3s ease-out ${animationDelay}s both` }}>
      <div className="sbt-bucket-header">
        <span className="sbt-bucket-accent" style={{ background: accent }} />
        <span className="sbt-bucket-label">{BUCKET_LABELS[bucket]}</span>
        {card.role && (
          <span className={`sbt-bucket-role sbt-bucket-role--${card.role}`}>
            {card.role === "pillar" ? "Today’s pick" : "Nearby"}
          </span>
        )}
      </div>
      {cardUrl ? (
        <a href={cardUrl} target="_blank" rel="noopener noreferrer" className="sbt-bucket-link">
          <CardInner card={card} />
        </a>
      ) : (
        <div className="sbt-bucket-link">
          <CardInner card={card} />
        </div>
      )}
    </div>
  );
}

function CityDayPlan({ cityId, cityName }: { cityId: City; cityName: string }) {
  const [cards, setCards] = useState<DayCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/plan-day", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city: cityId, scope: "city", kids: false, currentHour: new Date().getHours() }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.cards) setCards(d.cards); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cityId]);

  // Group cards by bucket. Same logic as the homepage: prefer card.bucket,
  // fall back to inferring from clock-range timeBlock for legacy plans.
  const cardsByBucket = new Map<Bucket, DayCard>();
  const orphanCards: DayCard[] = [];
  for (const c of cards) {
    const bucket: Bucket | null = isBucket(c.bucket)
      ? (c.bucket as Bucket)
      : inferBucketFromTimeBlock(c.timeBlock, c.category);
    if (bucket) {
      if (!cardsByBucket.has(bucket)) cardsByBucket.set(bucket, c);
      else orphanCards.push(c);
    } else {
      orphanCards.push(c);
    }
  }

  if (loading) {
    return (
      <div style={{ marginBottom: 28 }}>
        <h2 className="city-plan-headline">What should we do in {cityName} today?</h2>
        <div style={{ padding: "8px 0 20px", margin: "0 -16px" }}>
          <div style={{ display: "flex", background: "#fff", borderRadius: 10, border: "1px solid #f0f0f0", overflow: "hidden", opacity: 0, animation: "cityCardAppear 0.4s ease-out 0.1s forwards" }}>
            <div style={{ width: 20, backgroundImage: "linear-gradient(180deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC)", backgroundSize: "100% 200%", animation: "cityPlanRainbow 3s ease infinite", flexShrink: 0 }} />
            <div style={{ flex: 1, padding: "28px 20px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <PlanLoadingVerb />
            </div>
          </div>
        </div>
        <style>{`
          @keyframes cityCardAppear {
            from { opacity: 0; transform: translateY(16px) scale(0.97); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
        `}</style>
      </div>
    );
  }

  if (!cards.length) return null;

  return (
    <div style={{ marginBottom: 28 }}>
      <h2 className="city-plan-headline">What should we do in {cityName} today?</h2>
      <div className="sbt-buckets">
        {BUCKET_ORDER.map((bucket, i) => {
          const card = cardsByBucket.get(bucket);
          if (!card) return null;
          const accent = ACCENT_COLORS[Math.floor(i / 2) % ACCENT_COLORS.length];
          return (
            <BucketSlot
              key={bucket}
              bucket={bucket}
              card={card}
              accent={accent}
              animationDelay={i * 0.05}
            />
          );
        })}
      </div>

      <style>{`
        .city-plan-headline {
          font-family: 'Playfair Display', Georgia, serif;
          font-size: 32px;
          font-weight: 800;
          color: #1a1a2e;
          letter-spacing: -0.5px;
          line-height: 1.15;
          margin: 0 0 14px;
        }
        @media (max-width: 480px) {
          .city-plan-headline { font-size: 26px; }
        }
        .sbt-buckets {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin: 0 -16px;
        }
        .sbt-buckets > .sbt-bucket:nth-child(odd):last-child {
          grid-column: 1 / -1;
        }
        @media (max-width: 640px) {
          .sbt-buckets {
            grid-template-columns: 1fr;
            gap: 8px;
            margin: 0 -8px;
          }
        }
        .sbt-bucket {
          background: #fff;
          border-radius: 12px;
          border: 1px solid #e8e8e8;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          position: relative;
          min-height: 140px;
        }
        .sbt-bucket--pillar {
          border-color: rgba(123, 47, 190, 0.30);
          box-shadow: 0 12px 26px rgba(31, 12, 73, 0.09);
        }
        .sbt-bucket-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 14px 6px;
        }
        .sbt-bucket-accent {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .sbt-bucket-label {
          font-family: 'Inter', sans-serif;
          font-size: 12px;
          font-weight: 900;
          color: #111;
          letter-spacing: 1px;
          text-transform: uppercase;
        }
        .sbt-bucket-role {
          margin-left: auto;
          border-radius: 999px;
          padding: 2px 7px;
          font-family: 'Inter', sans-serif;
          font-size: 8px;
          font-weight: 900;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .sbt-bucket-role--pillar { background: #13072f; color: #fff; }
        .sbt-bucket-role--paired-meal { border: 1px solid #ddd; color: #6b6178; }
        .sbt-bucket-link {
          display: flex;
          flex: 1;
          min-width: 0;
          text-decoration: none;
          color: inherit;
          cursor: pointer;
        }
        @keyframes cityFadeSlideIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// City Open Now — randomized "oh yeah, THAT place" panel.
// open-now-candidates.json holds ~30 top-rated places per city (rating ≥4.5,
// ratingCount ≥100). We filter to "open right now" per the user's PT clock,
// then shuffle the open set and pick 6. Each page mount yields a new random
// pick — purpose is variety, not consistency.
// ---------------------------------------------------------------------------

interface OpenNowCandidate {
  id: string;
  name: string;
  displayType: string | null;
  category: string | null;
  rating: number;
  ratingCount: number;
  priceLevel: number | null;
  hours: Record<string, string | undefined>;
  mapsUrl: string | null;
  url: string | null;
  photoRef?: string | null;
}

const OPEN_DAY_KEYS = ["sun","mon","tue","wed","thu","fri","sat"] as const;

const OPEN_CATEGORY_EMOJI: Record<string, string> = {
  food: "🍴",
  entertainment: "🎭",
  outdoor: "🌿",
  shopping: "🛍️",
  museum: "🏛️",
  wellness: "💆",
  arts: "🎨",
};

function parseClock(s: string): number | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function isOpenAt(hours: Record<string, string | undefined>, dayKey: string, mins: number): boolean {
  const range = hours[dayKey];
  if (!range) return false;
  const [openStr, closeStr] = range.split("-");
  const open = parseClock(openStr);
  const close = parseClock(closeStr);
  if (open == null || close == null) return false;
  // Handle past-midnight close: store closes at e.g. "02:00" tomorrow.
  if (close <= open) return mins >= open || mins < close;
  return mins >= open && mins < close;
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function CityOpenNow({ cityId, cityName }: { cityId: string; cityName: string }) {
  // Random selection happens once per mount — pin it in state so React's strict
  // mode double-render in dev doesn't show two different sets.
  const [tick, setTick] = useState(0);
  // "Open right now" is inherently clock-and-random, so the server render
  // (and the matching first client render) shows nothing; the panel pops in
  // post-mount. It lives near the bottom of the page, so no visible jank.
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  const allByCity = (openNowCandidatesJson as { cities?: Record<string, OpenNowCandidate[]> }).cities ?? {};
  const pool = (allByCity[cityId] ?? []).filter((place) => !isPlaceTemporarilyUnavailable(place));

  const picks = useMemo(() => {
    if (!ready || pool.length === 0) return [];
    const dayKey = OPEN_DAY_KEYS[NOW_PT.getDay()];
    const mins = NOW_PT.getHours() * 60 + NOW_PT.getMinutes();
    const open = pool.filter((p) => isOpenAt(p.hours, dayKey, mins));
    return shuffleInPlace([...open]).slice(0, 6);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId, tick, ready]);

  // Venue photo per pick: real Places photo when the candidate carries a
  // photoRef, Unsplash category lookup only for the refless minority.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    const base: Record<string, string> = {};
    const needsLookup = picks.filter((p) => {
      if (p.photoRef) {
        base[p.id] = `/api/place-photo?ref=${encodeURIComponent(p.photoRef)}&w=320&h=200`;
        return false;
      }
      return true;
    });
    setThumbs(base);
    Promise.all(needsLookup.map((p) => {
      const q = p.displayType || p.category || p.name;
      return fetch(`/api/unsplash-photo?query=${encodeURIComponent(q)}`)
        .then((r) => r.ok ? r.json() : null)
        .then((d) => d?.url ? { id: p.id, url: d.url as string } : null)
        .catch(() => null);
    })).then((results) => {
      if (cancelled) return;
      const map: Record<string, string> = { ...base };
      for (const r of results) if (r) map[r.id] = r.url;
      setThumbs(map);
    });
    return () => { cancelled = true; };
  }, [picks]);

  if (picks.length === 0) return null;

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10, gap: 12 }}>
        <h2 style={{ fontFamily: "var(--sb-serif)", fontWeight: 800, fontSize: 20, margin: 0, color: "var(--sb-ink)" }}>
          Open Right Now
        </h2>
        <button
          onClick={() => setTick((t) => t + 1)}
          aria-label="Shuffle"
          style={{
            fontSize: 11, fontWeight: 700, color: "var(--sb-ink)",
            background: "#fff", border: "1px solid var(--sb-border)",
            borderRadius: 100, padding: "4px 12px", cursor: "pointer",
          }}
        >
          Shuffle ↻
        </button>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
        gap: 10,
      }}>
        {picks.map((p) => {
          const emoji = (p.category && OPEN_CATEGORY_EMOJI[p.category]) || "📍";
          const thumb = thumbs[p.id];
          const ratingLabel = `★ ${p.rating.toFixed(1)}`;
          const ratingCount = p.ratingCount >= 1000 ? `${Math.round(p.ratingCount / 100) / 10}k` : `${p.ratingCount}`;
          return (
            <a
              key={p.id}
              href={p.mapsUrl || p.url || "#"}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "block",
                borderRadius: 10,
                overflow: "hidden",
                textDecoration: "none",
                color: "inherit",
                border: "1px solid var(--sb-border-light)",
                background: "#fff",
                transition: "transform 0.15s ease-out, box-shadow 0.15s ease-out",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.transform = "translateY(-2px)"; (e.currentTarget as HTMLAnchorElement).style.boxShadow = "0 6px 16px rgba(0,0,0,0.1)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.transform = ""; (e.currentTarget as HTMLAnchorElement).style.boxShadow = ""; }}
            >
              <div style={{
                aspectRatio: "16 / 10",
                background: thumb
                  ? `url(${thumb}) center/cover no-repeat, linear-gradient(135deg, #1e3a8a 0%, #4c1d95 100%)`
                  : "linear-gradient(135deg, #1e3a8a 0%, #4c1d95 100%)",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32,
              }}>
                {!thumb && emoji}
              </div>
              <div style={{ padding: "8px 10px" }}>
                <div style={{
                  fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 13,
                  color: "var(--sb-ink)", lineHeight: 1.25,
                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
                  overflow: "hidden",
                }}>
                  {p.name}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#92400e" }}>{ratingLabel}</span>
                  <span style={{ fontSize: 10, color: "var(--sb-light)" }}>({ratingCount})</span>
                  {p.displayType && (
                    <>
                      <span style={{ fontSize: 9, color: "var(--sb-light)" }}>·</span>
                      <span style={{
                        fontSize: 10, color: "var(--sb-muted)",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {p.displayType}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </a>
          );
        })}
      </div>

      <div style={{ marginTop: 8, fontSize: 10, color: "var(--sb-light)" }}>
        Top-rated spots open right now in {cityName} · shuffled for variety
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// City Hall Panel — civic card pinned at the bottom of the page.
// Two side-by-side cards on desktop (stacked on mobile): next meeting (with
// agenda preview) and last meeting (summary excerpt + link to full digest).
// ---------------------------------------------------------------------------

function CityHallPanel({
  nextMeeting,
  meetingIsToday,
  digest,
  digestAge,
}: {
  nextMeeting: any;
  meetingIsToday: boolean;
  digest: any;
  digestAge: number;
}) {
  const meetingItems = nextMeeting ? filterAgendaItems(nextMeeting.agendaItems) : [];
  const showDigest = !!(digest?.summary && digestAge < 30);

  if (!nextMeeting && !showDigest) return null;

  const isTonight = meetingIsToday && nextMeeting;

  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ fontFamily: "var(--sb-serif)", fontWeight: 800, fontSize: 20, margin: "0 0 12px", color: "var(--sb-ink)" }}>
        At City Hall
      </h2>

      <div className="sb-city-hall-grid">
        {/* Next meeting card */}
        {nextMeeting && (
          <div style={{
            background: isTonight ? "linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)" : "var(--sb-card)",
            border: isTonight ? "none" : "1px solid var(--sb-border-light)",
            borderRadius: 8,
            padding: "14px 16px",
            color: isTonight ? "#e0e7ff" : "var(--sb-ink)",
          }}>
            <div style={{
              fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
              letterSpacing: "0.1em", textTransform: "uppercase" as const,
              color: isTonight ? "#818cf8" : "var(--sb-muted)",
              marginBottom: 4,
            }}>
              {isTonight ? "Tonight" : "Next meeting"}
            </div>
            <div style={{ fontWeight: 700, fontSize: 15, color: isTonight ? "#fff" : "var(--sb-ink)" }}>
              {nextMeeting.bodyName} · {nextMeeting.displayDate}
            </div>
            {meetingItems.length > 0 && (
              <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                {meetingItems.slice(0, 3).map((it, i) => (
                  <li key={i} style={{
                    fontSize: 12, color: isTonight ? "#e0e7ff" : "var(--sb-ink)",
                    lineHeight: 1.4, paddingLeft: 10,
                    borderLeft: `2px solid ${isTonight ? "#6366f1" : "var(--sb-border-light)"}`,
                  }}>
                    {trimAgendaTitle(it.title)}
                  </li>
                ))}
                {meetingItems.length > 3 && (
                  <li style={{ fontSize: 11, color: isTonight ? "#a5b4fc" : "var(--sb-light)", paddingLeft: 10, fontStyle: "italic" }}>
                    +{meetingItems.length - 3} more on the agenda
                  </li>
                )}
              </ul>
            )}
            {nextMeeting.url && (
              <a href={nextMeeting.url} target="_blank" rel="noopener noreferrer"
                style={{ display: "inline-block", marginTop: 10, fontSize: 12, color: isTonight ? "#818cf8" : "var(--sb-accent)", textDecoration: "none", fontWeight: 600 }}>
                View agenda →
              </a>
            )}
          </div>
        )}

        {/* Last meeting summary card */}
        {showDigest && (
          <div style={{
            background: "var(--sb-card)",
            border: "1px solid var(--sb-border-light)",
            borderRadius: 8,
            padding: "14px 16px",
          }}>
            <div style={{
              fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
              letterSpacing: "0.1em", textTransform: "uppercase" as const,
              color: "var(--sb-muted)", marginBottom: 4,
            }}>
              Last meeting · {digest.meetingDate}
            </div>
            <p style={{ fontSize: 12, lineHeight: 1.55, color: "var(--sb-muted)", margin: "0 0 8px" }}>
              {digest.summary.slice(0, 240)}{digest.summary.length > 240 ? "…" : ""}
            </p>
            <a href="/gov" style={{ fontSize: 12, color: "var(--sb-accent)", textDecoration: "none", fontWeight: 600 }}>
              Full summary →
            </a>
          </div>
        )}
      </div>

      <style>{`
        .sb-city-hall-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          align-items: stretch;
        }
        @media (max-width: 720px) {
          .sb-city-hall-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}


// ---------------------------------------------------------------------------
// City Events Block — Today / Tomorrow / This Weekend pill block.
// Three buckets, not seven days. "This Weekend" = the next upcoming Sat+Sun
// combined into one view (or "today/tomorrow" if those happen to be Sat or
// Sun — we still show the dedicated weekend bucket so you can see both days
// side by side).
// ---------------------------------------------------------------------------

type EventsBucket = "today" | "tomorrow" | "weekend";

function getTomorrowIso(): string {
  const d = new Date(NOW_PT.getFullYear(), NOW_PT.getMonth(), NOW_PT.getDate() + 1);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function getWeekendIsos(): string[] {
  // Walk forward up to 7 days; collect the next Saturday + Sunday we can find.
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(NOW_PT.getFullYear(), NOW_PT.getMonth(), NOW_PT.getDate() + i);
    const day = d.getDay(); // 0 = sun, 6 = sat
    if (day === 6 || day === 0) {
      out.push(d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }));
    }
  }
  return out;
}

function CityEventsBlock({
  events,
  cityId,
  cityName,
}: {
  events: UpcomingEvent[];
  cityId: string;
  cityName: string;
}) {
  const TOMORROW_ISO = useMemo(() => getTomorrowIso(), []);
  const WEEKEND_ISOS = useMemo(() => getWeekendIsos(), []);

  const [bucket, setBucket] = useState<EventsBucket>("today");
  const [freeOnly, setFreeOnly] = useState(false);
  const [kidsOnly, setKidsOnly] = useState(false);

  const cityEvents = useMemo(
    () => events.filter((e) => e.city === cityId && !e.ongoing),
    [events, cityId],
  );

  // Count helpers — let the pills display tonnage so an empty bucket reads
  // as "—" rather than user clicking through to nothing.
  const counts = useMemo(() => {
    const passesFilters = (e: UpcomingEvent) => {
      if (freeOnly && e.cost !== "free") return false;
      if (kidsOnly && !e.kidFriendly) return false;
      return true;
    };
    let today = 0, tomorrow = 0, weekend = 0;
    for (const e of cityEvents) {
      if (!passesFilters(e)) continue;
      if (e.date === TODAY_ISO && hasNotStarted(e.time)) today++;
      if (e.date === TOMORROW_ISO) tomorrow++;
      if (WEEKEND_ISOS.includes(e.date)) {
        // Don't double-count: if today/tomorrow IS the weekend, the user
        // selects the weekend bucket explicitly to see both days together.
        if (e.date === TODAY_ISO && !hasNotStarted(e.time)) continue;
        weekend++;
      }
    }
    return { today, tomorrow, weekend };
  }, [cityEvents, freeOnly, kidsOnly, TOMORROW_ISO, WEEKEND_ISOS]);

  const bucketEvents = useMemo(() => {
    const passesFilters = (e: UpcomingEvent) => {
      if (freeOnly && e.cost !== "free") return false;
      if (kidsOnly && !e.kidFriendly) return false;
      return true;
    };
    let list: UpcomingEvent[] = [];
    if (bucket === "today") {
      list = cityEvents.filter((e) => e.date === TODAY_ISO && hasNotStarted(e.time) && passesFilters(e));
    } else if (bucket === "tomorrow") {
      list = cityEvents.filter((e) => e.date === TOMORROW_ISO && passesFilters(e));
    } else {
      list = cityEvents.filter((e) => {
        if (!WEEKEND_ISOS.includes(e.date)) return false;
        if (e.date === TODAY_ISO && !hasNotStarted(e.time)) return false;
        return passesFilters(e);
      });
    }
    // Sort weekend by date THEN time so Saturday events list before Sunday.
    return list.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return startMinutes(a.time) - startMinutes(b.time);
    });
  }, [cityEvents, bucket, TOMORROW_ISO, WEEKEND_ISOS, freeOnly, kidsOnly]);

  const allEventsHref = `/events?city=${encodeURIComponent(cityId)}`;
  // "More events →" link picks a sensible date to deep-link to.
  const moreHref = bucket === "today" || bucket === "tomorrow"
    ? `${allEventsHref}&date=${encodeURIComponent(bucket === "today" ? TODAY_ISO : TOMORROW_ISO)}`
    : allEventsHref;

  const emptyLabel = bucket === "today" ? "today"
    : bucket === "tomorrow" ? "tomorrow"
    : "this weekend";

  const pillSpec: Array<{ key: EventsBucket; label: string; count: number }> = [
    { key: "today",    label: "Today",         count: counts.today },
    { key: "tomorrow", label: "Tomorrow",      count: counts.tomorrow },
    { key: "weekend",  label: "This Weekend",  count: counts.weekend },
  ];

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10, gap: 12 }}>
        <h2 style={{ fontFamily: "var(--sb-serif)", fontWeight: 800, fontSize: 20, margin: 0, color: "var(--sb-ink)" }}>
          Events in {cityName}
        </h2>
        <a href={allEventsHref} style={{ fontSize: 11, fontWeight: 600, color: "var(--sb-ink)", textDecoration: "none", border: "1px solid var(--sb-border)", borderRadius: 100, padding: "4px 12px" }}>
          All events →
        </a>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {pillSpec.map(({ key, label, count }) => {
          const isSelected = bucket === key;
          return (
            <button
              key={key}
              onClick={() => setBucket(key)}
              aria-pressed={isSelected}
              style={{
                flex: "1 1 auto",
                padding: "10px 16px",
                borderRadius: 12,
                border: isSelected ? "1.5px solid var(--sb-ink)" : "1.5px solid var(--sb-border-light)",
                background: isSelected ? "var(--sb-ink)" : "#fff",
                color: isSelected ? "#fff" : "var(--sb-ink)",
                cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                lineHeight: 1.1,
                minWidth: 88,
              }}
            >
              <span style={{ fontFamily: "var(--sb-serif)", fontWeight: 800, fontSize: 14 }}>{label}</span>
              <span style={{
                fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
                letterSpacing: "0.06em", textTransform: "uppercase" as const,
                color: isSelected ? "rgba(255,255,255,0.85)" : "var(--sb-light)",
              }}>
                {count > 0 ? `${count} event${count === 1 ? "" : "s"}` : "—"}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        <button
          onClick={() => setFreeOnly((v) => !v)}
          aria-pressed={freeOnly}
          style={{
            fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 100,
            border: freeOnly ? "1.5px solid #065F46" : "1.5px solid var(--sb-border-light)",
            background: freeOnly ? "#D1FAE5" : "#fff",
            color: freeOnly ? "#065F46" : "var(--sb-muted)",
            cursor: "pointer",
          }}
        >
          Free only
        </button>
        <button
          onClick={() => setKidsOnly((v) => !v)}
          aria-pressed={kidsOnly}
          style={{
            fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 100,
            border: kidsOnly ? "1.5px solid #92400E" : "1.5px solid var(--sb-border-light)",
            background: kidsOnly ? "#FEF3C7" : "#fff",
            color: kidsOnly ? "#92400E" : "var(--sb-muted)",
            cursor: "pointer",
          }}
        >
          Kid-friendly
        </button>
      </div>

      {bucketEvents.length === 0 ? (
        <div style={{ padding: "14px 0", color: "var(--sb-muted)", fontSize: 13, fontStyle: "italic" }}>
          Nothing on the calendar for {emptyLabel}{(freeOnly || kidsOnly) ? " matching those filters." : "."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {bucketEvents.slice(0, 12).map((e, i) => {
            // In the weekend bucket, prepend a small day label when the date
            // changes so the user can tell Sat events from Sun events.
            const prev = i > 0 ? bucketEvents[i - 1] : null;
            const showDayHeader = bucket === "weekend" && (!prev || prev.date !== e.date);
            return (
              <div key={e.id}>
                {showDayHeader && (
                  <div style={{
                    fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
                    letterSpacing: "0.08em", textTransform: "uppercase" as const,
                    color: "var(--sb-muted)", marginTop: i === 0 ? 0 : 12, marginBottom: 4,
                  }}>
                    {new Date(e.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                  </div>
                )}
                <EventRow event={e} />
              </div>
            );
          })}
          {bucketEvents.length > 12 && (
            <a href={moreHref} style={{ fontSize: 12, fontWeight: 600, color: "var(--sb-accent)", padding: "8px 0", textDecoration: "none" }}>
              +{bucketEvents.length - 12} more events →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// City Reddit Tiles — tile-grid Reddit block scoped to this city.
// Visual cousin of homepage RedditPulseTeaser. Filter rule: local subs first,
// then regional subs that mention the city by name, then bare regional posts
// to keep the grid full when local subs are sparse.
// ---------------------------------------------------------------------------

interface ChatterPost {
  id: string;
  sub: string;
  title: string;
  displayTitle?: string;
  summary?: string;
  category?: string;
  score: number;
  numComments: number;
  ageHours: number;
  permalink: string;
  externalUrl?: string | null;
}

// City id → subreddit names that count as "the local sub" for this city.
// Case-insensitive match; canonical spellings the data uses.
const CITY_SUBREDDITS: Record<string, string[]> = {
  "san-jose":      ["SanJose"],
  "palo-alto":     ["PaloAlto"],
  "mountain-view": ["mountainview", "MountainView"],
  "sunnyvale":     ["Sunnyvale"],
  "santa-clara":   ["SantaClara"],
  "cupertino":     ["Cupertino"],
  "saratoga":      ["Saratoga_CA"],
  "los-gatos":     ["losgatos"],
  "milpitas":      ["Milpitas"],
  "campbell":      ["campbell", "Campbell"],
};

const REGIONAL_SUBS = new Set(["bayarea", "AskSF", "siliconvalley"]);

function chatterAge(hours: number): string {
  if (hours < 1) return "now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1d ago" : `${days}d ago`;
}

function CityRedditTiles({ cityId, cityName }: { cityId: string; cityName: string }) {
  const allPosts = ((redditPulseJson as { posts?: ChatterPost[] }).posts ?? []);
  const localSubs = (CITY_SUBREDDITS[cityId] ?? []).map((s) => s.toLowerCase());
  const cityNeedle = cityName.toLowerCase();

  const withImage = allPosts.filter((p) => !!(p as any).image);

  const scored = withImage.map((p) => {
    const subLower = (p.sub || "").toLowerCase();
    const isLocal = localSubs.includes(subLower);
    const isRegional = REGIONAL_SUBS.has(p.sub);
    const hay = `${p.title || ""} ${p.summary || ""}`.toLowerCase();
    const cityMention = hay.includes(cityNeedle);
    let rank = 99;
    if (isLocal) rank = 0;
    else if (isRegional && cityMention) rank = 1;
    else if (isRegional) rank = 2;
    return { post: p, rank };
  })
  .filter((x) => x.rank <= 2)
  .sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.post.ageHours - b.post.ageHours;
  });

  // Take up to 8 tiles. Smaller datasets (Los Gatos, Saratoga) ship whatever
  // they have so long as there are at least 2 candidates — a single tile reads
  // as broken, but 2-3 is fine in a 2-col mobile layout, and the desktop
  // 4-col grid just auto-flows with empty trailing cells.
  const TILE_TARGET = 8;
  const trimmed = scored.slice(0, TILE_TARGET);

  if (trimmed.length < 2) return null;

  // Subtitle reflects what's actually showing — if every visible tile is from a
  // regional sub, don't promise "r/<localsub>" content the user won't see.
  const hasLocalTile = trimmed.some((x) => x.rank === 0);
  const localLabel = (CITY_SUBREDDITS[cityId] ?? [])[0];
  const subtitle = hasLocalTile
    ? `From r/${localLabel} and regional subs`
    : `Regional chatter from the Bay Area`;

  return (
    <section
      aria-label={`Reddit chatter for ${cityName}`}
      style={{ marginTop: 8, marginBottom: 28, fontFamily: "'Inter', sans-serif" }}
    >
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ fontFamily: "var(--sb-serif)", fontSize: 20, fontWeight: 800, margin: 0, letterSpacing: -0.5, color: "var(--sb-ink)", lineHeight: 1.1 }}>
          The Conversation
        </h2>
        <p style={{ fontSize: 12, color: "var(--sb-muted)", margin: "3px 0 0", fontWeight: 500 }}>
          {subtitle}
        </p>
      </header>

      <div className="cr-grid">
        {trimmed.map(({ post: p }) => {
          const image = (p as any).image as string | undefined;
          return (
            <a
              key={p.id}
              href={p.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="cr-tile"
              style={{ background: image ? `#000 url(${image}) center/cover no-repeat` : "linear-gradient(135deg, #1e3a8a, #4c1d95)" }}
            >
              <div className="cr-tile-shade" />
              <div className="cr-tile-top">
                <span className="cr-badge">r/{p.sub}</span>
              </div>
              <div className="cr-tile-bottom">
                <div className="cr-title">{p.displayTitle || p.title}</div>
                <div className="cr-meta">
                  {p.score > 0 && <><span>↑ {p.score}</span><span>·</span></>}
                  {p.numComments > 0 && <><span>💬 {p.numComments}</span><span>·</span></>}
                  <span>{chatterAge(p.ageHours)}</span>
                </div>
              </div>
            </a>
          );
        })}
      </div>

      <p style={{ marginTop: 10, fontSize: 10, color: "var(--sb-light)", textAlign: "right" }}>
        Tap any post to jump into the thread on Reddit
      </p>

      <style>{`
        .cr-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
        }
        .cr-tile {
          position: relative;
          display: block;
          aspect-ratio: 1 / 1;
          border-radius: 12px;
          overflow: hidden;
          text-decoration: none;
          color: #fff;
          transition: transform 0.18s ease-out, box-shadow 0.18s ease-out;
          box-shadow: 0 1px 2px rgba(0,0,0,0.05);
          cursor: pointer;
        }
        .cr-tile:hover {
          transform: translateY(-2px) scale(1.02);
          box-shadow: 0 8px 20px rgba(0,0,0,0.18);
        }
        .cr-tile-shade {
          position: absolute;
          inset: 0;
          background: linear-gradient(to bottom, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.0) 30%, rgba(0,0,0,0.55) 75%, rgba(0,0,0,0.85) 100%);
          pointer-events: none;
        }
        .cr-tile-top {
          position: absolute;
          top: 6px; left: 6px; right: 6px;
          display: flex; align-items: center;
          gap: 6px;
          font-size: 9px; font-weight: 800;
          letter-spacing: 0.4px; text-transform: uppercase;
          z-index: 2;
        }
        .cr-badge {
          background: rgba(255,255,255,0.95);
          color: #111;
          padding: 3px 7px;
          border-radius: 999px;
          line-height: 1;
          white-space: nowrap;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .cr-tile-bottom {
          position: absolute;
          left: 10px; right: 10px; bottom: 8px;
          z-index: 2;
        }
        .cr-title {
          font-size: 13px;
          font-weight: 800;
          line-height: 1.2;
          color: #fff;
          text-shadow: 0 1px 2px rgba(0,0,0,0.5);
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
          margin-bottom: 3px;
        }
        .cr-meta {
          display: flex;
          gap: 5px;
          font-size: 9px;
          font-weight: 600;
          color: rgba(255,255,255,0.85);
          text-shadow: 0 1px 1px rgba(0,0,0,0.4);
        }
        @media (max-width: 760px) {
          .cr-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
          }
          .cr-title {
            font-size: 13px;
          }
        }
      `}</style>
    </section>
  );
}
