// ---------------------------------------------------------------------------
// South Bay Today — Day-Planning Homepage
// ---------------------------------------------------------------------------
// "What should we do today?" — list + card views with lock/skip/hide.
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback, useRef } from "react";
import type { City, Tab } from "../../../lib/south-bay/types";
import { CITIES } from "../../../lib/south-bay/cities";
import PhotoStrip from "./PhotoStrip";
import ForecastCard from "../cards/ForecastCard";
import defaultPlansJson from "../../../data/south-bay/default-plans.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DayCard {
  id: string;
  name: string;
  category: string;
  city: string;
  address: string;
  timeBlock: string;
  blurb: string;
  why: string;
  url?: string | null;
  mapsUrl?: string | null;
  cost?: string | null;
  costNote?: string | null;
  photoRef?: string | null;
  image?: string | null;
  venue?: string | null;
  source: "event" | "place";
  locked: boolean;
}

interface PlanResponse {
  cards: DayCard[];
  weather: string | null;
  city: string;
  kids: boolean;
  generatedAt: string;
  poolSize: number;
  /** Locked ids the server couldn't find — event cancelled, place archived.
   *  Client should purge these from state.locked so they stop haunting
   *  future shuffles. */
  invalidLockedIds?: string[];
}

type DismissType = "skip" | "hide";

interface DismissedEntry {
  type: DismissType;
  until?: string;
  permanent?: boolean;
}

interface LocalState {
  kids: boolean;
  dismissed: Record<string, DismissedEntry>;
  locked: string[];
  viewMode: "list" | "cards";
  /** Rolling ledger of places/events we've shown the user. Lets the API
   *  penalize recent repeats for up to 7 days so the same venue doesn't
   *  anchor every day. Capped and auto-pruned on load. */
  recentlyShown: RecentEntry[];
}

interface RecentEntry {
  id: string;
  name: string;
  ts: number; // epoch ms
}

const RECENT_MAX = 120;
const RECENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const ACCENT_COLORS = [
  "#FF6B35", "#E63946", "#06D6A0", "#7B2FBE", "#1A5AFF", "#FF3CAC",
];

const CATEGORY_EMOJI: Record<string, string> = {
  food: "🍽️", outdoor: "🌿", museum: "🏛️", entertainment: "🎭",
  wellness: "💆", shopping: "🛍️", arts: "🎨", events: "📅",
  sports: "⚾", neighborhood: "🏘️",
};

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

const STORAGE_KEY = "sbt-prefs";

function loadState(): LocalState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const now = new Date().toISOString().slice(0, 10);
    for (const [id, entry] of Object.entries(parsed.dismissed ?? {})) {
      const d = entry as DismissedEntry;
      if (d.type === "skip" && d.until && d.until < now) delete parsed.dismissed[id];
    }
    const cutoff = Date.now() - RECENT_MAX_AGE_MS;
    const recent = Array.isArray(parsed.recentlyShown)
      ? (parsed.recentlyShown as RecentEntry[])
          .filter((e) => e && typeof e.ts === "number" && e.ts >= cutoff && typeof e.id === "string")
      : [];
    return { ...defaultState(), ...parsed, recentlyShown: recent };
  } catch { return defaultState(); }
}

function defaultState(): LocalState {
  return { kids: false, dismissed: {}, locked: [], viewMode: "list", recentlyShown: [] };
}

/** Merge new card ids+names into the recent-shown ledger, drop duplicates
 *  so a name's timestamp always reflects the most recent view, and cap the
 *  list. The server reads this to penalize repeats across sessions. */
function mergeRecent(prev: RecentEntry[], cards: { id: string; name: string }[]): RecentEntry[] {
  const now = Date.now();
  const cutoff = now - RECENT_MAX_AGE_MS;
  const seenIds = new Set(cards.map((c) => c.id));
  const seenNames = new Set(cards.map((c) => normalizeLedgerName(c.name)));
  const kept = prev.filter(
    (e) => e.ts >= cutoff && !seenIds.has(e.id) && !seenNames.has(normalizeLedgerName(e.name)),
  );
  const fresh = cards.map((c) => ({ id: c.id, name: c.name, ts: now }));
  return [...fresh, ...kept].slice(0, RECENT_MAX);
}

function normalizeLedgerName(name: string | null | undefined): string {
  return (name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

const PLAN_ANCHORS: City[] = CITIES
  .filter((c) => c.id !== "santa-cruz")
  .map((c) => c.id);

/** Pick a random plan anchor, preferring one that isn't the last one used. */
function pickRandomAnchor(exclude?: City | null): City {
  const pool = exclude ? PLAN_ANCHORS.filter((c) => c !== exclude) : PLAN_ANCHORS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/** Pick the nearest-but-not-future anchor hour from the available set.
 *  e.g. at 3:53 PM → returns 13 (1 PM plan, not the 17:00 one which is future). */
function pickNearestAnchor(availableAnchors: number[], nowHour: number): number {
  const past = availableAnchors.filter((h) => h <= nowHour).sort((a, b) => b - a);
  if (past.length > 0) return past[0];
  // Before earliest anchor — use the earliest.
  return availableAnchors.slice().sort((a, b) => a - b)[0];
}

/** Compute the effective time context for planning. Late at night there's
 *  not enough day left to plan around, so we flip to tomorrow morning:
 *  cutoff is 8 PM for adults, 6 PM for kids. Returns what the API should
 *  receive (currentHour/currentMinute/planDate) plus whether we flipped.
 *  planDate uses PT so a user in another timezone still gets tomorrow in
 *  South Bay terms. */
function getEffectiveTime(kids: boolean): {
  isTomorrow: boolean;
  currentHour: number;
  currentMinute: number;
  planDate: string | undefined;
} {
  const now = new Date();
  const ptHour = Number(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }));
  const cutoff = kids ? 18 : 20;
  if (ptHour >= cutoff) {
    // Compute tomorrow's YYYY-MM-DD in PT. We do this by asking for PT's
    // date, adding one day, and formatting as ISO date.
    const ptTodayStr = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const [y, m, d] = ptTodayStr.split("-").map(Number);
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
    const planDate = tomorrow.toISOString().slice(0, 10);
    return { isTomorrow: true, currentHour: 9, currentMinute: 0, planDate };
  }
  return { isTomorrow: false, currentHour: now.getHours(), currentMinute: now.getMinutes(), planDate: undefined };
}

/** Load a pre-generated plan from default-plans.json for instant display.
 *  Picks a random anchor city so first-visit users see variety, not always Campbell.
 *  Picks the nearest-but-not-future anchor HOUR so users landing at 4 PM don't
 *  see a 9-AM-shaped plan. Returns { cards, anchor } so caller can remember. */
function loadDefaultPlan(kids: boolean): { cards: DayCard[]; anchor: City | null } {
  try {
    const json = defaultPlansJson as any;
    const plans = json.plans || {};
    const anchorHours: number[] = Array.isArray(json._meta?.anchorHours) && json._meta.anchorHours.length
      ? json._meta.anchorHours
      : [9]; // legacy default-plans.json without anchor suffix
    const eff = getEffectiveTime(kids);
    // Tomorrow mode: always use the morning anchor so the preview shows a
    // fresh day shape, not a stale evening slice.
    const chosenAnchor = eff.isTomorrow
      ? (anchorHours.includes(9) ? 9 : anchorHours.slice().sort((a, b) => a - b)[0])
      : pickNearestAnchor(anchorHours, eff.currentHour);
    const kidsSuffix = kids ? "kids" : "adults";

    // New hero schema: one plan per (kids × anchor). Falls back to the
    // old per-city schema for backward compat during rollout + for any
    // build where the generator hasn't run yet.
    const heroKey = `${kidsSuffix}:h${chosenAnchor}`;
    let plan = plans[heroKey];
    let city: City = (plan?.city as City) || pickRandomAnchor();
    if (!plan?.cards?.length) {
      // Legacy fallback.
      city = pickRandomAnchor();
      const anchoredKey = `${city}:${kidsSuffix}:h${chosenAnchor}`;
      const legacyKey = `${city}:${kidsSuffix}`;
      plan = plans[anchoredKey] || plans[legacyKey];
    }
    if (!plan?.cards?.length) return { cards: [], anchor: null };

    // Filter out cards whose timeBlock is in the past — only for today's
    // plans. In tomorrow mode, every card is in the future so skip the
    // filter entirely — but strip today-only event cards since the cache
    // was generated for today's event pool; a live fetch will backfill
    // tomorrow's real events.
    if (eff.isTomorrow) {
      return { cards: plan.cards.filter((c: DayCard) => c.source !== "event"), anchor: city };
    }
    const nowMin = eff.currentHour * 60 + eff.currentMinute;
    const cards = plan.cards.filter((c: DayCard) => {
      const m = c.timeBlock?.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!m) return true;
      let hrs = parseInt(m[1]);
      if (m[3].toUpperCase() === "PM" && hrs !== 12) hrs += 12;
      if (m[3].toUpperCase() === "AM" && hrs === 12) hrs = 0;
      return hrs * 60 + parseInt(m[2]) >= nowMin - 30;
    });
    return { cards, anchor: city };
  } catch {
    return { cards: [], anchor: null };
  }
}

function saveState(state: LocalState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

// ---------------------------------------------------------------------------
// User preference learning (persisted separately so prefs survive state resets)
// ---------------------------------------------------------------------------

const PREFS_KEY = "sbt-user-prefs";
const EMA_ALPHA = 0.3; // exponential moving average weight for new signals

interface UserPreferences {
  categoryScores: Record<string, number>; // positive = likes, negative = dislikes
  costBias: number;       // -1 (budget) to +1 (splurge)
  outdoorBias: number;    // -1 (indoor) to +1 (outdoor)
  totalInteractions: number;
}

function defaultPrefs(): UserPreferences {
  return { categoryScores: {}, costBias: 0, outdoorBias: 0, totalInteractions: 0 };
}

function loadPrefs(): UserPreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultPrefs();
    return { ...defaultPrefs(), ...JSON.parse(raw) };
  } catch { return defaultPrefs(); }
}

function savePrefs(prefs: UserPreferences) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

/** EMA update: blends new signal into existing value */
function ema(current: number, signal: number): number {
  return current * (1 - EMA_ALPHA) + signal * EMA_ALPHA;
}

/** Update preferences based on a user action on a card */
function recordInteraction(
  prefs: UserPreferences,
  card: DayCard,
  action: "lock" | "skip" | "hide",
): UserPreferences {
  const next = { ...prefs, categoryScores: { ...prefs.categoryScores } };
  next.totalInteractions++;

  // Category signal: lock = +1, skip = -0.3, hide = -1
  const catSignal = action === "lock" ? 1 : action === "skip" ? -0.3 : -1;
  const prev = next.categoryScores[card.category] ?? 0;
  next.categoryScores[card.category] = ema(prev, catSignal);

  // Cost signal: lock expensive = +, lock cheap = -, skip expensive = -, skip cheap = +
  const isExpensive = card.costNote && /\$\$|\$3|\$4|\$5|\$6/.test(card.costNote);
  const isCheap = card.cost === "free" || (card.costNote && /under|\$1|\$[5-9]\b/.test(card.costNote));
  if (action === "lock") {
    if (isExpensive) next.costBias = ema(next.costBias, 0.5);
    else if (isCheap) next.costBias = ema(next.costBias, -0.3);
  } else if (action === "skip" || action === "hide") {
    if (isExpensive) next.costBias = ema(next.costBias, -0.3);
  }

  // Outdoor signal from card category
  const isOutdoor = card.category === "outdoor" || card.category === "sports";
  const isIndoor = card.category === "museum" || card.category === "entertainment";
  if (action === "lock") {
    if (isOutdoor) next.outdoorBias = ema(next.outdoorBias, 0.5);
    else if (isIndoor) next.outdoorBias = ema(next.outdoorBias, -0.3);
  } else if (action === "hide") {
    if (isOutdoor) next.outdoorBias = ema(next.outdoorBias, -0.5);
    else if (isIndoor) next.outdoorBias = ema(next.outdoorBias, 0.3);
  }

  // Clamp biases to [-1, 1]
  next.costBias = Math.max(-1, Math.min(1, next.costBias));
  next.outdoorBias = Math.max(-1, Math.min(1, next.outdoorBias));

  return next;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  onNavigate: (tab: Tab) => void;
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// Regional anchor for any weather/forecast widget that needs a single city.
// SBT is an "explore the whole area" product now — there's no user-selected
// home city. Picking San Jose keeps the forecast stable and plausibly
// representative for the whole South Bay.
const REGIONAL_ANCHOR: City = "san-jose";

export default function SouthBayTodayView(_props: Props) {
  const [state, setState] = useState<LocalState>(() => loadState());
  // Random anchor for initial render so first-visit users see variety.
  // Use state.kids (from localStorage) so returning users see the right
  // mode on first paint — not always adults.
  const initialPlan = useRef<{ cards: DayCard[]; anchor: City | null } | null>(null);
  if (initialPlan.current === null) initialPlan.current = loadDefaultPlan(state.kids);
  const hasDefaultPlan = initialPlan.current.cards.length > 0;
  const [cards, setCards] = useState<DayCard[]>(initialPlan.current.cards);
  const [weather, setWeather] = useState<string | null>(() => {
    if (!hasDefaultPlan || !initialPlan.current?.anchor) return null;
    try {
      const json = defaultPlansJson as any;
      const plans = json.plans || {};
      const anchor = initialPlan.current.anchor;
      const kidsSuffix = state.kids ? "kids" : "adults";
      // Match whatever key we used for the cards — try every anchored key
      // for this city first, then the legacy un-anchored key.
      const anchorHours: number[] = Array.isArray(json._meta?.anchorHours)
        ? json._meta.anchorHours : [9];
      for (const h of anchorHours) {
        const w = plans[`${anchor}:${kidsSuffix}:h${h}`]?.weather;
        if (w) return w;
      }
      return plans[`${anchor}:${kidsSuffix}`]?.weather || null;
    } catch { return null; }
  });
  const [loading, setLoading] = useState(!hasDefaultPlan);
  const [swapLoading, setSwapLoading] = useState(false); // loading triggered by a dismiss
  const [replacedIds, setReplacedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [timeDisplay, setTimeDisplay] = useState(() => formatTime());
  // Live "now" signal so past cards fall off without a reload. planDateISO
  // is the target date of the plan in view — when it's today we filter
  // cards whose end time has already passed.
  const [nowMinutes, setNowMinutes] = useState(() => getNowMinutesPT());
  const [planDateISO, setPlanDateISO] = useState<string>(() => {
    const eff = getEffectiveTime(state.kids);
    return eff.planDate || getTodayISOInPT();
  });
  const fetchRef = useRef(0);
  const lastAnchorRef = useRef<City | null>(initialPlan.current.anchor);
  // Anchor diversity within a single session. Card-level variety is
  // persisted in state.recentlyShown (localStorage, 7-day window) so it
  // survives reloads and spans sessions.
  const recentAnchorsRef = useRef<City[]>(initialPlan.current.anchor ? [initialPlan.current.anchor] : []);
  const fetchPlanRef = useRef<(extraLockedIds?: string[], noCache?: boolean) => void>(() => {});
  const [prefs, setPrefs] = useState<UserPreferences>(loadPrefs);

  // Display city for forecast + weather label — user's persisted home city,
  // or san-jose (center of south bay) as a neutral default.
  const displayCity: City = REGIONAL_ANCHOR;

  // Keep the clock + nowMinutes live. 30 s is plenty — card end times are
  // minute-resolution, and re-renders bail when the value hasn't changed.
  useEffect(() => {
    const tick = () => {
      setTimeDisplay(formatTime());
      setNowMinutes(getNowMinutesPT());
    };
    const t = setInterval(tick, 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { saveState(state); }, [state]);

  // Seed the recent-shown ledger with the default plan's cards on first
  // paint so even the first shuffle has something to avoid. Runs once.
  useEffect(() => {
    const seed = initialPlan.current;
    if (!seed?.cards.length) return;
    setState((s) => ({
      ...s,
      recentlyShown: mergeRecent(s.recentlyShown, seed.cards.map((c) => ({ id: c.id, name: c.name }))),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchPlan = useCallback(async (extraLockedIds?: string[], noCache = false) => {
    const id = ++fetchRef.current;
    setLoading(true);
    setError(null);
    setTimeDisplay(formatTime());
    // Pick a fresh random anchor, avoiding the last 3 so SHUFFLE always
    // visibly shifts the plan to a different part of the south bay. If
    // pickRandomAnchor only accepts one "avoid", pass the most recent — the
    // server-side recentlyShown filter covers the rest.
    const anchor = pickRandomAnchor(lastAnchorRef.current);
    lastAnchorRef.current = anchor;
    recentAnchorsRef.current = [anchor, ...recentAnchorsRef.current].slice(0, 3);
    const allLocked = extraLockedIds
      ? [...new Set([...state.locked, ...extraLockedIds])]
      : state.locked;

    // Richer lock info: pair each locked id with the card's current timeBlock
    // so the server can anchor Claude's plan around it instead of defaulting
    // to 7 PM. We look up each locked id in the current `cards` state.
    const lockedCards = allLocked.map((id) => {
      const card = cards.find((c) => c.id === id);
      return { id, timeBlock: card?.timeBlock ?? null };
    });

    const eff = getEffectiveTime(state.kids);
    // Graduated variety signal: server scales the penalty by age, so
    // today's picks get -25, this-week picks get ~-7. Persisted across
    // sessions via localStorage (state.recentlyShown).
    const nowMs = Date.now();
    const recentPayload = state.recentlyShown.map((e) => ({
      id: e.id,
      name: e.name,
      daysAgo: Math.max(0, Math.floor((nowMs - e.ts) / (24 * 60 * 60 * 1000))),
    }));
    try {
      const res = await fetch("/api/plan-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city: anchor, kids: state.kids,
          lockedIds: allLocked, // keep for backward compat
          lockedCards,
          dismissedIds: Object.keys(state.dismissed),
          currentHour: eff.currentHour,
          currentMinute: eff.currentMinute,
          planDate: eff.planDate,
          preferences: prefs.totalInteractions >= 5 ? prefs : undefined,
          recentlyShown: recentPayload,
          recentAnchors: recentAnchorsRef.current,
          noCache,
        }),
      });
      if (id !== fetchRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data: PlanResponse = await res.json();
      const sorted = [...data.cards].sort((a, b) => parseTimeBlock(a.timeBlock) - parseTimeBlock(b.timeBlock));
      // Only show green lock icon for user-explicitly-locked cards, not auto-kept ones
      setCards(sorted.map((c) => ({ ...c, locked: state.locked.includes(c.id) })));
      setPlanDateISO(eff.planDate || getTodayISOInPT());
      setState((s) => ({
        ...s,
        recentlyShown: mergeRecent(s.recentlyShown, sorted.map((c) => ({ id: c.id, name: c.name }))),
      }));
      setReplacedIds(new Set());
      setWeather(data.weather);
      // Purge any locked IDs the server couldn't find (event cancelled,
      // place archived). Otherwise they haunt future shuffles as ghost locks.
      if (data.invalidLockedIds?.length) {
        setState((s) => ({
          ...s,
          locked: s.locked.filter((id) => !data.invalidLockedIds!.includes(id)),
        }));
      }
    } catch (err) {
      if (id === fetchRef.current) setError(err instanceof Error ? err.message : "Failed to plan your day");
    } finally {
      if (id === fetchRef.current) {
        setLoading(false);
        setSwapLoading(false);
      }
    }
  }, [state.kids, state.dismissed, state.locked, cards]);

  // Freshness policy for the pre-generated plan:
  //   age ≤ 26h  → show the cached plan, no refresh. The 2 AM nightly regen
  //                gives a fresh plan every morning; users get instant load
  //                and no surprise shuffle-after-landing.
  //   age > 26h  → hard-stale (cron missed its window). Fire an API call
  //                with loading state because the cached plan is stale
  //                enough to mislead.
  //
  // 26h spans the 2 AM nightly regen + a 2-hour buffer for cron delays.
  useEffect(() => {
    if (!hasDefaultPlan) {
      fetchPlan();
      return;
    }
    // Tomorrow mode can't be served from today's cache — the cached plan's
    // event pool is today-only, and tomorrow has its own events/weather.
    // Places render instantly (events were stripped in loadDefaultPlan);
    // this fetch backfills tomorrow's real events.
    if (getEffectiveTime(state.kids).isTomorrow) {
      fetchPlan();
      return;
    }
    const generatedAt = (defaultPlansJson as any)?._meta?.generatedAt;
    const ageMs = generatedAt ? Date.now() - new Date(generatedAt).getTime() : Infinity;
    const HARD_STALE_MS = 26 * 60 * 60 * 1000;
    if (ageMs > HARD_STALE_MS) {
      console.warn(`[sbt] default-plans age ${Math.round(ageMs / 3600000)}h exceeds 26h — forcing live fetch`);
      setLoading(true);
      fetchPlan();
    }
  }, []);

  // Keep fetchPlanRef current so callers always invoke the latest version
  useEffect(() => { fetchPlanRef.current = fetchPlan; }, [fetchPlan]);

  // Auto-flip to tomorrow's plan when today's plan is exhausted. Fires
  // when the last today-card's end time passes OR when the page crosses
  // midnight PT with a stale today plan still mounted. Reuses the
  // pre-generated tomorrow hero plan so we don't hit /api/plan-day.
  useEffect(() => {
    if (loading || cards.length === 0) return;
    const today = getTodayISOInPT();
    if (planDateISO > today) return; // already showing tomorrow
    const stillHasTodayCards = planDateISO === today && cards.some((c) => {
      const end = parseEndMinutes(c.timeBlock);
      return end === null ? true : end > nowMinutes;
    });
    if (stillHasTodayCards) return;
    const tom = loadTomorrowPlan(state.kids);
    if (!tom.cards.length) return;
    setCards(tom.cards);
    setPlanDateISO(getTomorrowISOInPT());
    setReplacedIds(new Set());
    lastAnchorRef.current = tom.anchor;
    recentAnchorsRef.current = tom.anchor ? [tom.anchor] : [];
    if (tom.weather) setWeather(tom.weather);
    setState((s) => ({
      ...s,
      recentlyShown: mergeRecent(s.recentlyShown, tom.cards.map((c) => ({ id: c.id, name: c.name }))),
    }));
    // Backfill tomorrow's real events — loadTomorrowPlan only has today's
    // cached places; fetch tomorrow's live plan to get tomorrow's event pool.
    fetchPlanRef.current?.();
  }, [cards, planDateISO, nowMinutes, loading, state.kids]);

  // Actions
  const handleKidsToggle = () => {
    const nextKids = !state.kids;
    setState((s) => ({ ...s, kids: nextKids }));
    // Try the pre-generated plan for the new mode first — that's the whole
    // point of pre-gen'ing both kids + adults plans at 2 AM. Only fall back
    // to a network shuffle if default-plans.json doesn't have the mode.
    const preGen = loadDefaultPlan(nextKids);
    if (preGen.cards.length > 0) {
      setCards(preGen.cards);
      lastAnchorRef.current = preGen.anchor;
      recentAnchorsRef.current = preGen.anchor ? [preGen.anchor] : [];
      setState((s) => ({
        ...s,
        recentlyShown: mergeRecent(s.recentlyShown, preGen.cards.map((c) => ({ id: c.id, name: c.name }))),
      }));
      setReplacedIds(new Set());
      const effNext = getEffectiveTime(nextKids);
      setPlanDateISO(effNext.planDate || getTodayISOInPT());
      // Swap the weather line to match the new mode's anchor.
      try {
        const json = defaultPlansJson as any;
        const plans = json.plans || {};
        const kidsSuffix = nextKids ? "kids" : "adults";
        const anchorHours: number[] = Array.isArray(json._meta?.anchorHours)
          ? json._meta.anchorHours : [9];
        for (const h of anchorHours) {
          const w = plans[`${preGen.anchor}:${kidsSuffix}:h${h}`]?.weather;
          if (w) { setWeather(w); break; }
        }
      } catch {}
      // Tomorrow mode: backfill real events via live fetch (pre-gen is
      // places-only in tomorrow mode).
      if (effNext.isTomorrow) setTimeout(() => fetchPlanRef.current?.(), 50);
      return;
    }
    // Fallback: hero plan missing for this mode → live fetch.
    setTimeout(() => fetchPlanRef.current?.(), 50);
  };
  const handleNewPlan = () => fetchPlan(undefined, true);
  const handleLock = (cardId: string) => {
    const card = cards.find((c) => c.id === cardId);
    if (card && !card.locked) {
      // Only record preference when locking (not unlocking)
      const updated = recordInteraction(prefs, card, "lock");
      setPrefs(updated);
      savePrefs(updated);
    }
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, locked: !c.locked } : c)));
    setState((s) => ({
      ...s,
      locked: s.locked.includes(cardId) ? s.locked.filter((id) => id !== cardId) : [...s.locked, cardId],
    }));
  };
  const handleDismiss = (cardId: string, type: DismissType) => {
    const card = cards.find((c) => c.id === cardId);
    if (card) {
      const updated = recordInteraction(prefs, card, type === "skip" ? "skip" : "hide");
      setPrefs(updated);
      savePrefs(updated);
    }
    // Immediately replace card content with in-place swap skeleton — no fade-out
    // so the rectangle stays put and just swaps its inner content.
    setSwapLoading(true);
    setReplacedIds((prev) => new Set([...prev, cardId]));

    // Keep all OTHER cards by passing them as extra locked IDs (not stored in state)
    const keepIds = cards.filter((c) => c.id !== cardId).map((c) => c.id);

    const entry: DismissedEntry = type === "hide"
      ? { type: "hide", permanent: true }
      : { type: "skip", until: new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) };
    setState((s) => ({
      ...s,
      dismissed: { ...s.dismissed, [cardId]: entry },
      locked: s.locked.filter((id) => id !== cardId),
    }));
    // Refetch with other cards auto-locked so only the dismissed slot changes
    setTimeout(() => fetchPlanRef.current(keepIds), 100);
  };

  // Tomorrow mode: 6pm for kids, 8pm for adults — same cutoff used in
  // Headline follows the plan date — if we've auto-flipped to tomorrow
  // (cards exhausted OR past 8 PM cutoff), say "tomorrow".
  const headline = planDateISO > getTodayISOInPT()
    ? "What should we do tomorrow?"
    : "What should we do today?";

  // Live card filter. Tomorrow-mode plans show everything (all future).
  // Today plans filter cards whose end time has already passed. Stale
  // plans from yesterday (tab left open past midnight) hide everything —
  // every stop is behind us.
  const todayPT = getTodayISOInPT();
  let visibleCards: DayCard[];
  if (planDateISO > todayPT) {
    visibleCards = cards;
  } else if (planDateISO < todayPT) {
    visibleCards = [];
  } else {
    visibleCards = cards.filter((c) => {
      const end = parseEndMinutes(c.timeBlock);
      return end === null ? true : end > nowMinutes;
    });
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "0 16px 80px" }}>
      {/* Weekly forecast banner */}
      <div style={{ marginBottom: 0, paddingTop: 12 }}>
        <ForecastCard homeCity={displayCity} />
      </div>

      {/* Header */}
      <div className="sbt-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 0 10px", gap: 12, flexWrap: "wrap" }}>
        <div className="sbt-time-row" style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div className="sbt-time-display" style={{ fontFamily: "'Inter', sans-serif", fontSize: 48, fontWeight: 900, letterSpacing: -2, color: "#000", lineHeight: 1 }}>{timeDisplay}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, fontWeight: 700, color: "#333", lineHeight: 1.2 }}>{headline}</div>
            {weather && <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "#888", lineHeight: 1.2 }}>🌤 {weather}</div>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Kids toggle */}
          <div role="group" aria-label="Audience" style={{ display: "flex", borderRadius: 14, border: "2px solid #000", overflow: "hidden" }}>
            <button aria-pressed={!state.kids} onClick={() => { if (state.kids) handleKidsToggle(); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 900, padding: "4px 10px", border: "none", background: !state.kids ? "#000" : "#fff", color: !state.kids ? "#fff" : "#888", cursor: "pointer", transition: "all 0.15s", textTransform: "uppercase", letterSpacing: 1 }}>No Kids</button>
            <button aria-pressed={state.kids} onClick={() => { if (!state.kids) handleKidsToggle(); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 900, padding: "4px 10px", border: "none", borderLeft: "2px solid #000", background: state.kids ? "#000" : "#fff", color: state.kids ? "#fff" : "#888", cursor: "pointer", transition: "all 0.15s", textTransform: "uppercase", letterSpacing: 1 }}>Kids</button>
          </div>
          {/* New Plan */}
          <button onClick={handleNewPlan} disabled={loading && !swapLoading} className={(loading && !swapLoading) ? "sbt-shuffle sbt-shuffle--loading" : "sbt-shuffle"}>Reshuffle ↻</button>
        </div>
      </div>

      {/* Photo scroll */}
      <div style={{ margin: "0 -16px 14px" }}>
        <PhotoStrip />
      </div>

      {/* Instruction line */}
      {visibleCards.length > 0 && (
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600, color: "#999", margin: "0 0 10px", textAlign: "right", letterSpacing: 0.2 }}>
          <span style={{ color: "#22c55e" }}>✓</span> Sounds great &nbsp;·&nbsp; <span style={{ color: "#ca8a04" }}>→</span> Not today &nbsp;·&nbsp; <span style={{ color: "#dc2626" }}>✕</span> Never
        </p>
      )}

      {/* Empty state — shown on error OR when planner returned zero cards.
          Instead of a dead end, give the user a weather snapshot + a handful
          of always-good options + the Events tab so they have somewhere to
          land. */}
      {(error || (!loading && visibleCards.length === 0)) && (
        <div style={{ padding: "24px 0", fontFamily: "'Inter', sans-serif" }}>
          <p style={{ fontSize: 16, fontWeight: 700, margin: 0, marginBottom: 4 }}>
            {error
              ? "Plan didn't load — try these classics"
              : cards.length > 0
                ? "That's a wrap on today's plan — shuffle for tomorrow or try these classics"
                : "Nothing in the pool right now — try these classics"}
          </p>
          {error && <p style={{ fontSize: 12, color: "#888", margin: 0, marginBottom: 10 }}>{error}</p>}
          {weather && <p style={{ fontSize: 13, color: "#555", margin: 0, marginBottom: 14 }}>{weather}</p>}
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <li style={{ padding: "10px 12px", background: "#fff", border: "1px solid #eee", borderRadius: 8, fontSize: 14 }}>
              <strong>Walk downtown Los Gatos.</strong> Coffee at Peet&apos;s, browse the shops on N Santa Cruz Ave, grab lunch wherever looks busy.
            </li>
            <li style={{ padding: "10px 12px", background: "#fff", border: "1px solid #eee", borderRadius: 8, fontSize: 14 }}>
              <strong>Computer History Museum + Shoreline.</strong> Hit the permanent exhibits, then walk the lake trail for an hour.
            </li>
            <li style={{ padding: "10px 12px", background: "#fff", border: "1px solid #eee", borderRadius: 8, fontSize: 14 }}>
              <strong>Santana Row stroll + dinner.</strong> Window-shop the open-air blocks, pick any of the patios for dinner.
            </li>
          </ul>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={handleNewPlan} style={{ padding: "8px 20px", borderRadius: 20, border: "2px solid #000", background: "#fff", cursor: "pointer", fontWeight: 700 }}>Try Again</button>
            <button onClick={() => _props.onNavigate("events")} style={{ padding: "8px 20px", borderRadius: 20, border: "2px solid #000", background: "#000", color: "#fff", cursor: "pointer", fontWeight: 700 }}>Browse Events →</button>
          </div>
        </div>
      )}

      {/* Loading — single card with verb inside */}
      {loading && visibleCards.length === 0 && (
        <div style={{ padding: "8px 0 20px", margin: "0 -16px" }}>
          <div style={{ display: "flex", background: "#fff", borderRadius: 10, border: "1px solid #f0f0f0", overflow: "hidden", opacity: 0, animation: "cardAppear 0.4s ease-out 0.1s forwards" }}>
            <div style={{ width: 20, backgroundImage: "linear-gradient(180deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC)", backgroundSize: "100% 200%", animation: "rainbow 3s ease infinite", flexShrink: 0 }} />
            <div style={{ flex: 1, padding: "28px 20px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <LoadingVerb />
            </div>
          </div>
        </div>
      )}

      {/* ═══ LIST VIEW ═══ */}
      {visibleCards.length > 0 && (
        <div
          className={loading && !swapLoading ? "sbt-cards sbt-cards--loading" : "sbt-cards"}
          style={{ display: "flex", flexDirection: "column", gap: 8, margin: "0 -16px" }}
        >
          {visibleCards.map((card, i) => {
            const accent = ACCENT_COLORS[i % ACCENT_COLORS.length];
            const emoji = CATEGORY_EMOJI[card.category] || "📍";
            const isReplaced = replacedIds.has(card.id);
            const cardUrl = card.source === "event" ? (card.url || card.mapsUrl) : (card.mapsUrl || card.url);

            // In-place swap skeleton — same outer wrapper as a normal card so
            // dimensions don't jump; just swaps the inner content for SwapVerb.
            if (isReplaced) {
              return (
                <div
                  key={card.id}
                  style={{
                    display: "flex",
                    gap: 0,
                    background: "#fff",
                    borderRadius: 10,
                    border: "1px solid #e8e8e8",
                    overflow: "hidden",
                    position: "relative" as const,
                  }}
                >
                  <div style={{ width: 6, background: accent, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 96 }}>
                    <SwapVerb />
                  </div>
                </div>
              );
            }

            return (
              <div
                key={card.id}
                style={{
                  display: "flex",
                  gap: 0,
                  background: "#fff",
                  borderRadius: 10,
                  border: "1px solid #e8e8e8",
                  overflow: "hidden",
                  animation: `fadeSlideIn 0.3s ease-out ${i * 0.05}s both`,
                  position: "relative" as const,
                }}
              >
                {/* Accent bar */}
                <div style={{ width: 6, background: accent, flexShrink: 0 }} />
                {/* Clickable area (whole card except traffic lights) */}
                {cardUrl ? (
                  <a
                    href={cardUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "flex", flex: 1, minWidth: 0, textDecoration: "none", color: "inherit", cursor: "pointer" }}
                  >
                    <CardInner card={card} emoji={emoji} accent={accent} />
                  </a>
                ) : (
                  <div style={{ display: "flex", flex: 1, minWidth: 0 }}>
                    <CardInner card={card} emoji={emoji} accent={accent} />
                  </div>
                )}
                {/* Traffic light actions */}
                <div className="tl-group">
                  <button onClick={() => handleLock(card.id)} title={card.locked ? "Unlock" : "Lock this"} className={`tl-btn tl-lock${card.locked ? " tl-lock--active" : ""}`}>✓</button>
                  <button onClick={() => handleDismiss(card.id, "skip")} title="Not today" className="tl-btn tl-skip">→</button>
                  <button onClick={() => handleDismiss(card.id, "hide")} title="Never show this" className="tl-btn tl-hide">✕</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Share button — share what's still on the table, not the full
          original plan. No point sending a friend stops that have already
          passed. */}
      {visibleCards.length > 1 && !loading && (
        <div style={{ textAlign: "center", padding: "16px 0 0" }}>
          <ShareButton cards={visibleCards} city={displayCity} kids={state.kids} weather={weather} />
        </div>
      )}

      <style>{`
        .sbt-shuffle {
          font-family: 'Inter', sans-serif;
          font-size: 11px;
          font-weight: 900;
          padding: 4px 14px;
          border-radius: 14px;
          border: 2px solid #000;
          background: linear-gradient(135deg, #1E3A8A, #4C1D95);
          color: #fff;
          cursor: pointer;
          text-transform: uppercase;
          letter-spacing: 1px;
          white-space: nowrap;
          position: relative;
          overflow: hidden;
          z-index: 0;
        }
        .sbt-shuffle:hover {
          filter: brightness(1.1);
        }
        .sbt-shuffle--loading {
          /* Base stays the idle gradient so the sweep reads as a highlight
             moving across the brand color, not a foreign loader. */
          cursor: wait;
        }
        .sbt-shuffle--loading::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(
            100deg,
            rgba(255,255,255,0) 20%,
            rgba(255,255,255,0.45) 50%,
            rgba(255,255,255,0) 80%
          );
          background-size: 250% 100%;
          animation: sweep 1.1s linear infinite;
          z-index: 0;
          pointer-events: none;
        }
        @keyframes sweep {
          0%   { background-position: 150% 0; }
          100% { background-position: -150% 0; }
        }
        /* Cards dim + desaturate during loading so the eye sees "this is
           about to change" the instant SHUFFLE is clicked. Transition is
           fast (180ms) so there's no gap between click and feedback. */
        .sbt-cards {
          transition: opacity 180ms ease, filter 180ms ease;
        }
        .sbt-cards--loading {
          opacity: 0.45;
          filter: grayscale(0.5) blur(1.5px);
          pointer-events: none;
        }
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes rainbow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes cardAppear {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes softGlow {
          0%, 100% { box-shadow: 0 0 0 rgba(0,0,0,0); }
          50% { box-shadow: 0 0 16px rgba(100,100,255,0.1); }
        }
        @keyframes blink {
          50% { opacity: 0; }
        }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeSlideOut {
          from { opacity: 1; transform: translateY(0) scale(1); max-height: 120px; }
          to { opacity: 0; transform: translateY(-8px) scale(0.97); max-height: 0; padding: 0; margin: 0; }
        }
        /* ── Traffic light buttons ── */
        .tl-group {
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 10px 12px 10px 0;
          flex-shrink: 0;
          align-items: center;
          justify-content: center;
        }
        .tl-btn {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 15px;
          font-weight: 700;
          padding: 0;
          transition: all 0.2s ease;
          animation: tlPulse 0.6s ease-out 0.5s 3;
        }
        .tl-btn:focus-visible {
          outline: 2px solid #000;
          outline-offset: 2px;
        }
        .tl-lock {
          border: 1.5px solid #bbf7d0;
          background: #dcfce7;
          color: #22c55e;
        }
        .tl-lock--active {
          border: 2px solid #16a34a;
          background: #22c55e;
          color: #fff;
        }
        .tl-skip {
          border: 1.5px solid #fde68a;
          background: #fef9c3;
          color: #ca8a04;
        }
        .tl-hide {
          border: 1.5px solid #fecaca;
          background: #fee2e2;
          color: #dc2626;
        }
        .tl-lock:hover { box-shadow: 0 0 12px rgba(34, 197, 94, 0.5); transform: scale(1.12); }
        .tl-skip:hover { box-shadow: 0 0 12px rgba(202, 138, 4, 0.4); transform: scale(1.12); }
        .tl-hide:hover { box-shadow: 0 0 12px rgba(220, 38, 38, 0.4); transform: scale(1.12); }
        .tl-lock--active:hover { box-shadow: 0 0 14px rgba(34, 197, 94, 0.6); }
        @keyframes tlPulse {
          0% { box-shadow: 0 0 0 0 rgba(150, 150, 150, 0.3); }
          70% { box-shadow: 0 0 0 8px rgba(150, 150, 150, 0); }
          100% { box-shadow: 0 0 0 0 rgba(150, 150, 150, 0); }
        }
        @media (max-width: 640px) {
          .loading-verb {
            font-size: 20px !important;
          }
          .sbt-header {
            flex-direction: column !important;
            align-items: flex-start !important;
            gap: 10px !important;
          }
          .sbt-time-row {
            flex-direction: column !important;
            align-items: flex-start !important;
            gap: 4px !important;
          }
          .sbt-time-display {
            font-size: 40px !important;
            letter-spacing: -1px !important;
          }
          .sbt-card-thumb {
            width: 64px !important;
            height: 64px !important;
          }
          .sbt-forecast-cell {
            padding: 8px 2px 6px !important;
          }
          .sbt-forecast-temp {
            font-size: 22px !important;
          }
          .sbt-forecast-emoji {
            font-size: 16px !important;
            margin-bottom: 4px !important;
          }
          .sbt-forecast-low {
            font-size: 9px !important;
          }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CardInner — shared inner layout for list cards
// ---------------------------------------------------------------------------

interface UnsplashPhoto {
  url: string;
  photographer: string;
  photographerUrl: string;
  unsplashUrl: string;
}

function CardInner({ card, emoji, accent }: { card: DayCard; emoji: string; accent: string }) {
  const [unsplash, setUnsplash] = useState<UnsplashPhoto | null>(null);

  useEffect(() => {
    // Skip Unsplash if we already have a photo from ingest (image URL) or Places (photoRef).
    if (card.photoRef || card.image) return;
    fetch(`/api/unsplash-photo?query=${encodeURIComponent(card.category)}`)
      .then((r) => r.json())
      .then((d: UnsplashPhoto) => { if (d.url) setUnsplash(d); })
      .catch(() => {});
  }, [card.id, card.category, card.photoRef, card.image]);

  const hasPhoto = card.photoRef || card.image || unsplash;
  // Direct image URL wins over Places photoRef — it's the ingest-time
  // resolved value (venue-shaped OG, event-specific art, or Recraft fallback).
  const thumbBg = card.image
    ? `url(${card.image}) center/cover no-repeat, #f0f0f0`
    : card.photoRef
      ? `url(/api/place-photo?ref=${encodeURIComponent(card.photoRef)}&w=200&h=200) center/cover no-repeat, #f0f0f0`
      : unsplash
        ? "transparent"
        : "#f5f5f5";

  return (
    <>
      {/* Thumbnail column */}
      <div style={{ flexShrink: 0, margin: "10px 0 10px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <div style={{
          width: 80, height: 80, borderRadius: 8, overflow: "hidden",
          background: thumbBg,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28,
        }}>
          {unsplash && !card.photoRef && !card.image
            ? <img src={unsplash.url} alt={card.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            : !hasPhoto ? emoji : null}
        </div>
        {/* Unsplash attribution — only when using Unsplash photo */}
        {unsplash && !card.photoRef && !card.image && (
          <div style={{ width: 80, fontSize: 7, lineHeight: 1.3, color: "#bbb", textAlign: "center" }}>
            <a href={unsplash.photographerUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#bbb", textDecoration: "none" }}>{unsplash.photographer}</a>
            {" · "}
            <a href={unsplash.unsplashUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#bbb", textDecoration: "none" }}>Unsplash</a>
          </div>
        )}
      </div>
      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 800, color: "#000", letterSpacing: -0.2 }}>{card.timeBlock}</span>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 9, fontWeight: 700, color: "#bbb", textTransform: "uppercase" as const, letterSpacing: 1 }}>{card.category}</span>
          {card.source === "event" && <span style={{ fontSize: 8, fontWeight: 800, color: "#fff", background: "#E63946", padding: "1px 5px", borderRadius: 3, fontFamily: "'Inter', sans-serif", letterSpacing: 0.5 }}>EVENT</span>}
        </div>
        <h3 style={{ fontFamily: "'Inter', sans-serif", fontSize: 17, fontWeight: 900, color: "#111", margin: "0 0 4px", lineHeight: 1.25 }}>{card.name}</h3>
        {card.source === "event" && card.venue && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "#999" }}>{card.venue}</span>
          </div>
        )}
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: "#555", margin: "0 0 4px", lineHeight: 1.45 }}>{card.blurb}</p>
        {(card.costNote || card.cost) && (
          <span style={{ display: "inline-block", marginTop: 5, fontSize: 10, fontWeight: 700, color: "#999", fontFamily: "'Inter', sans-serif", background: "#f5f5f5", padding: "2px 8px", borderRadius: 4 }}>{card.costNote || card.cost}</span>
        )}
      </div>
    </>
  );
}

/** Parse "2:30 PM - 4:00 PM" → minutes since midnight for sorting */
function parseTimeBlock(tb: string): number {
  const m = tb.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const pm = m[3].toUpperCase() === "PM";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h * 60 + min;
}

/** Parse the end time from "2:30 PM - 4:00 PM" → 240. Returns null if
 *  the timeBlock has no second half (e.g. "All day", "6 PM"); caller
 *  should keep such cards visible. */
function parseEndMinutes(tb: string): number | null {
  if (!tb) return null;
  const parts = tb.split(/\s*-\s*/);
  if (parts.length < 2) return null;
  const m = parts[1].match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

/** Minutes since midnight, in America/Los_Angeles. */
function getNowMinutesPT(): number {
  const hhmm = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

/** YYYY-MM-DD in America/Los_Angeles. */
function getTodayISOInPT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** Tomorrow's YYYY-MM-DD in America/Los_Angeles. */
function getTomorrowISOInPT(): string {
  const today = getTodayISOInPT();
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

/** Load the tomorrow-anchor hero plan from default-plans.json. Used when
 *  today's plan runs out mid-session so we can flip into the tomorrow
 *  view without a network round-trip. Mirrors loadDefaultPlan's hero
 *  lookup but hard-forces the morning anchor + skips the past filter. */
function loadTomorrowPlan(kids: boolean): { cards: DayCard[]; anchor: City | null; weather: string | null } {
  try {
    const json = defaultPlansJson as any;
    const plans = json.plans || {};
    const anchorHours: number[] = Array.isArray(json._meta?.anchorHours) && json._meta.anchorHours.length
      ? json._meta.anchorHours : [9];
    const chosenAnchor = anchorHours.includes(9) ? 9 : anchorHours.slice().sort((a, b) => a - b)[0];
    const kidsSuffix = kids ? "kids" : "adults";
    const heroKey = `${kidsSuffix}:h${chosenAnchor}`;
    let plan = plans[heroKey];
    let city: City = (plan?.city as City) || pickRandomAnchor();
    if (!plan?.cards?.length) {
      city = pickRandomAnchor();
      const anchoredKey = `${city}:${kidsSuffix}:h${chosenAnchor}`;
      const legacyKey = `${city}:${kidsSuffix}`;
      plan = plans[anchoredKey] || plans[legacyKey];
    }
    if (!plan?.cards?.length) return { cards: [], anchor: null, weather: null };
    // Strip today-only event cards — cache was generated for today's event
    // pool and tomorrow has its own events. Places survive.
    const cards = plan.cards.filter((c: DayCard) => c.source !== "event");
    return { cards, anchor: city, weather: plan.weather || null };
  } catch {
    return { cards: [], anchor: null, weather: null };
  }
}

const LOADING_VERBS = [
  "Planning", "Mapping out", "Dreaming up", "Cooking up",
  "Piecing together", "Scouting", "Curating", "Lining up", "Sketching out",
  "Assembling", "Rounding up", "Whipping up", "Mixing up", "Building",
  "Brainstorming", "Crafting", "Shuffling", "Dialing in", "Sorting out",
];

function LoadingVerb() {
  const [verbIdx, setVerbIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const verb = LOADING_VERBS[verbIdx % LOADING_VERBS.length];
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

  const verb = LOADING_VERBS[verbIdx % LOADING_VERBS.length];
  const full = `${verb} your day...`;
  const display = full.slice(0, charIdx);

  return (
    <p className="loading-verb" style={{ fontSize: 28, fontWeight: 900, textAlign: "center", margin: 0, minHeight: 36, background: "linear-gradient(90deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC, #FF6B35)", backgroundSize: "200% 100%", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text", animation: "rainbow 3s ease infinite", fontFamily: "'Inter', sans-serif", letterSpacing: -0.5, whiteSpace: "nowrap" }}>
      {display}<span style={{ WebkitTextFillColor: "#ccc", animation: "blink 0.8s step-end infinite" }}>|</span>
    </p>
  );
}

const SWAP_PHRASES = [
  "Looking for something else",
  "Finding an alternative",
  "Checking what's around",
  "Digging up options",
  "Scouting a replacement",
  "How about this?",
];

function SwapVerb() {
  const [idx, setIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const phrase = SWAP_PHRASES[idx % SWAP_PHRASES.length];
    const full = `${phrase}...`;

    if (!deleting && charIdx < full.length) {
      const t = setTimeout(() => setCharIdx((c) => c + 1), 35 + Math.random() * 25);
      return () => clearTimeout(t);
    }
    if (!deleting && charIdx >= full.length) {
      const t = setTimeout(() => setDeleting(true), 900);
      return () => clearTimeout(t);
    }
    if (deleting && charIdx > 0) {
      const t = setTimeout(() => setCharIdx((c) => c - 1), 18);
      return () => clearTimeout(t);
    }
    if (deleting && charIdx === 0) {
      setDeleting(false);
      setIdx((v) => v + 1);
    }
  }, [charIdx, deleting, idx]);

  const phrase = SWAP_PHRASES[idx % SWAP_PHRASES.length];
  const full = `${phrase}...`;
  const display = full.slice(0, charIdx);

  return (
    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 18, fontWeight: 700, color: "#ccc", textAlign: "center", margin: 0, minHeight: 24, width: "100%" }}>
      {display}<span style={{ opacity: 0.4, animation: "blink 0.8s step-end infinite" }}>|</span>
    </p>
  );
}

function ShareButton({ cards, city, kids, weather }: { cards: DayCard[]; city: string; kids: boolean; weather: string | null }) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    if (shareUrl) {
      // Already have a URL — just copy/share it
      await doShare(shareUrl);
      return;
    }
    setSharing(true);
    try {
      const res = await fetch("/api/share-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards, city, kids, weather }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setShareUrl(data.url);
      await doShare(data.url);
    } catch {
      // Silently fail
    } finally {
      setSharing(false);
    }
  };

  const doShare = async (url: string) => {
    if (navigator.share) {
      try {
        await navigator.share({ title: "My day plan — South Bay Today", url });
        return;
      } catch {}
    }
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <button
      onClick={handleShare}
      disabled={sharing}
      style={{
        fontFamily: "'Inter', sans-serif",
        fontSize: 12,
        fontWeight: 700,
        padding: "8px 20px",
        borderRadius: 20,
        border: "1.5px solid #ddd",
        background: "#fff",
        color: copied ? "#16a34a" : "#888",
        cursor: sharing ? "wait" : "pointer",
        transition: "all 0.2s",
      }}
    >
      {copied ? "Link copied!" : sharing ? "Creating link..." : "Share this plan ↗"}
    </button>
  );
}

function formatTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

