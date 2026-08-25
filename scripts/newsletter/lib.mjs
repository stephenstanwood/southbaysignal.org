// ---------------------------------------------------------------------------
// South Bay Today — Daily Newsletter
// Shared helpers: env, Resend API, data loaders, HTML renderer.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvLocal } from "../lib/env.mjs";
import { ARTIFACTS, DATA_DIR } from "../lib/paths.mjs";
import { writeFileAtomic } from "../lib/io.mjs";
import { fetchForecast, DEFAULT_WEATHER_LAT, DEFAULT_WEATHER_LON } from "../../src/lib/south-bay/weatherProvider.mjs";
import { chainBrandKey, isNationalChain } from "../../src/lib/south-bay/chains.mjs";
import { isPlaceTemporarilyUnavailable } from "../../src/lib/south-bay/placeAvailability.mjs";
import { isEventPublishable } from "../../src/lib/south-bay/eventOccurrence.mjs";
import { isVirtualEvent, registrationLabel, requiresAdvanceRegistration } from "../../src/lib/south-bay/eventFilters.mjs";
import { normalizeAbsoluteHttpUrl } from "../../src/lib/south-bay/httpUrl.mjs";
import { dayKeyForIsoDate, mealServiceIssue } from "../../src/lib/south-bay/mealService.mjs";
import { selectDatedDefaultPlan } from "../../src/lib/south-bay/defaultPlanSelection.mjs";
import {
  audienceBreadthPenalty,
  isMarqueeEvent,
  routineEventPenalty,
  titleQualityPenalty,
  UNPROMPTED_AUDIENCE_PENALTY_CUTOFF,
} from "../../src/lib/south-bay/editorialQuality.mjs";
import { collectCanonicalNames, repairCanonicalNames } from "../../src/lib/south-bay/canonicalNames.mjs";
import { isVerifiedOpeningRecord } from "../lib/scc-food-openings.mjs";
import { formatMeetingTime, meetingClockMinutes } from "../lib/civic-meetings.mjs";

loadEnvLocal();

// ── Resend ─────────────────────────────────────────────────────────────────

const RESEND_BASE = "https://api.resend.com";
const SITE_URL = "https://southbaytoday.org";
const BRAND_AVATAR_URL = `${SITE_URL}/images/sbt-newsletter-avatar.png`;
const NEWSLETTER_ARCHIVE_PREFIX = "/newsletters";
const NEWSLETTER_OPENING_MAX_AGE_DAYS = 6;
const BLOCKED_NEWSLETTER_IMAGE_PATTERNS = [
  /images\.unsplash\.com\/photo-1585899873671-ade0aa28a821/i,
];

export async function resendFetch(path, init = {}) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing — add to .env.local");
  const res = await fetch(`${RESEND_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "object" && body?.message ? body.message : text;
    throw new Error(`Resend ${init.method || "GET"} ${path} → ${res.status}: ${msg}`);
  }
  return body;
}

// ── Date helpers (Pacific Time) ────────────────────────────────────────────

export function todayPT(now = new Date()) {
  // YYYY-MM-DD for "today" in America/Los_Angeles
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(now);
}

const EVENT_FEED_MAX_AGE_MS = 18 * 60 * 60 * 1000;

/**
 * A current-day newsletter may only use a recent event scrape. If the nightly
 * event job failed, an older file can still contain today's now-cancelled
 * listings; an empty event section is safer than publishing stale occurrences.
 * Historical previews remain available because their source file is archival
 * by definition rather than a live-send input.
 */
export function isEventFeedFreshForNewsletter(feed, date, now = new Date()) {
  if (date !== todayPT(now)) return true;
  const generatedAt = Date.parse(feed?.generatedAt || "");
  if (!Number.isFinite(generatedAt)) return false;
  const age = now.getTime() - generatedAt;
  return age >= 0 && age <= EVENT_FEED_MAX_AGE_MS;
}

export function formatLongDate(isoDate) {
  // "Wednesday, May 6, 2026" — interpret as PT to avoid TZ drift
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC ≈ stable
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(dt);
}

// ── Data loaders ───────────────────────────────────────────────────────────

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

let newsletterPlacesById = null;
function loadNewsletterPlacesById() {
  if (newsletterPlacesById) return newsletterPlacesById;
  try {
    const data = readJson(join(DATA_DIR, "places.json"));
    newsletterPlacesById = new Map((data.places || []).filter((place) => place?.id).map((place) => [place.id, place]));
  } catch {
    newsletterPlacesById = new Map();
  }
  return newsletterPlacesById;
}

// Resilient loader: a single missing/corrupt source file must NOT abort the
// whole newsletter. Returns `fallback` and warns, so the send proceeds with the
// sections it can build. (send.mjs still refuses a fully-empty issue.)
function loadOptional(path, fallback, label) {
  try {
    return readJson(path);
  } catch (err) {
    console.warn(`⚠️  newsletter: ${label} unavailable (${err.message}) — skipping that section`);
    return fallback;
  }
}

export function loadDefaultPlans() {
  return loadOptional(join(DATA_DIR, "default-plans.json"), { plans: {} }, "default-plans");
}

export function loadEvents() {
  return loadOptional(ARTIFACTS.events, { events: [] }, "events");
}

export function loadOpenings() {
  return loadOptional(ARTIFACTS.foodOpenings, { opened: [] }, "openings");
}

export function selectDefaultPlan(plans, date, { kids = false } = {}) {
  return selectDatedDefaultPlan(plans, date, { kids });
}

// ── Weather ────────────────────────────────────────────────────────────────
// Canonical provider: NWS primary, Open-Meteo fallback (see the decision
// record in src/lib/south-bay/weatherProvider.mjs). The newsletter previously
// fetched Open-Meteo directly and ran 6-8°F hot on heat days ("99°" emails
// while NWS/Google said 92-93°). No current temp on purpose: at the 6:00am
// build there is no trustworthy live reading, only the day's forecast.

export async function fetchWeather() {
  try {
    const { forecast, provider } = await fetchForecast(DEFAULT_WEATHER_LAT, DEFAULT_WEATHER_LON, { days: 2 });
    const today = forecast[0];
    if (!today) return null;
    return {
      emoji: today.emoji,
      high: today.high,
      low: today.low,
      rainPct: today.rainPct,
      dayDesc: today.desc,
      provider,
    };
  } catch (err) {
    console.warn(`⚠️  newsletter: weather unavailable (${err?.message}) — skipping weather strip`);
    return null;
  }
}

export function loadMeetings() {
  return loadOptional(ARTIFACTS.meetings, { meetings: {} }, "meetings");
}

export function loadRedditPulse() {
  return loadOptional(ARTIFACTS.redditPulse, { posts: [] }, "reddit-pulse");
}

// Day-plan hero poster URL for `date` (generated by generate-hero.mjs into
// newsletter-hero.json). Returns "" if absent/stale so newsletterVisuals falls
// back to a real card photo.
function loadNewsletterHero(date) {
  try {
    const hero = JSON.parse(readFileSync(join(DATA_DIR, "newsletter-hero.json"), "utf8"));
    return hero?.date === date ? (hero.imageUrl || "") : "";
  } catch {
    return "";
  }
}

// Reuses the regex-based parser from generate-sv-history.mjs.
export function loadMilestones() {
  let src;
  try {
    src = readFileSync(join(DATA_DIR, "tech-companies.ts"), "utf8");
  } catch {
    return [];
  }
  const startIdx = src.indexOf("export const TECH_MILESTONES");
  if (startIdx === -1) return [];
  const nextExport = src.indexOf("\nexport ", startIdx + 1);
  const section = nextExport !== -1 ? src.slice(startIdx, nextExport) : src.slice(startIdx);

  const milestones = [];
  const objectPattern = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let match;
  while ((match = objectPattern.exec(section)) !== null) {
    const block = match[0];
    const getStr = (k) => {
      const m = block.match(new RegExp(`${k}:\\s*["'\`]([\\s\\S]*?)["'\`]\\s*[,}]`));
      return m ? m[1] : null;
    };
    const getNum = (k) => {
      const m = block.match(new RegExp(`${k}:\\s*(\\d+)`));
      return m ? parseInt(m[1]) : null;
    };
    const id = getStr("id");
    const month = getNum("month");
    const day = getNum("day");
    if (!id || month === null || day === null) continue;
    milestones.push({
      id, company: getStr("company") || id, city: getStr("city") || "",
      foundedYear: getNum("foundedYear") || 0, month, day,
      tagline: getStr("tagline") || "", anniversaryNote: getStr("anniversaryNote") || "",
      url: getStr("url") || "",
    });
  }
  return milestones;
}

// ── Today's content assembler ──────────────────────────────────────────────

export async function assembleNewsletterData(date, opts = {}) {
  const editorialEnabled = opts.editorial ?? shouldRunEditorialPass();
  const defaultPlans = loadDefaultPlans();
  const eventFeed = loadEvents();
  const eventFeedFresh = isEventFeedFreshForNewsletter(eventFeed, date);
  if (!eventFeedFresh) {
    console.warn(`⚠️  newsletter: event feed is stale or undated — omitting current-day events rather than publishing unverified occurrences`);
  }
  const allEvents = eventFeedFresh
    ? (eventFeed.events || []).filter((event) => isEventPublishable(event))
    : [];
  const validEventIds = new Set(
    allEvents
      .filter((event) => event.date === date)
      .map((event) => `event:${event.id}`),
  );
  // Plan cards don't carry the virtual flag — only the event feed does — so
  // the newsletter re-checks against the live feed before publishing a card
  // as a place to go.
  const virtualEventIds = new Set(
    allEvents
      .filter((event) => isVirtualEvent(event))
      .map((event) => `event:${event.id}`),
  );
  // Likewise for the advance-registration gate: plan cards carry no
  // registration field, so the id set is rebuilt from the live feed. This is
  // the layer that would have stopped the Aug 12 2026 issue even if the plan
  // itself came from cache or predated the ingest fix.
  const registrationGatedEventIds = new Set(
    allEvents
      .filter((event) => requiresAdvanceRegistration(event))
      .map((event) => `event:${event.id}`),
  );
  const selectedPlan = selectDefaultPlan(defaultPlans.plans, date);
  const dayPlan = makeNewsletterPlan(selectedPlan, date, {
    validEventIds,
    virtualEventIds,
    registrationGatedEventIds,
  });

  const todayEvents = allEvents
    .filter((e) => e.date === date && !e.ongoing)
    .filter((e) => e.time && !/^12:00\s*am/i.test(e.time))
    .sort((a, b) => parseTimeMinutes(a.time) - parseTimeMinutes(b.time));

  const openings = loadOpenings();
  const recentOpenings = (openings.opened || [])
    .filter((o) => isFreshOpening(o, date))
    .slice(0, 6);

  // Every council meeting on today's calendar, at whatever hour it convenes —
  // the section heading, not this filter, decides whether "tonight" is a claim
  // the email is entitled to make. startTime and closedSession ride along from
  // the artifact so the renderer can be specific about both.
  const meetings = loadMeetings().meetings || {};
  const civicMeetings = Object.entries(meetings)
    .filter(([, m]) => m?.date === date)
    .map(([city, m]) => ({ city, ...m }));

  const [, monthStr, dayStr] = date.split("-");
  const milestones = loadMilestones();
  const todayHistory = milestones.filter(
    (m) => m.month === parseInt(monthStr) && m.day === parseInt(dayStr)
  );

  const recentSelections = loadRecentNewsletterSelections(date);
  const redditCandidates = pickRedditPosts(loadRedditPulse().posts || [], 10, recentSelections);
  const redditPosts = redditCandidates.slice(0, 4);
  const weather = await fetchWeather();
  const tonightPick = pickTonightEvent(todayEvents, recentSelections);
  const featuredEvents = pickFeaturedEvents(todayEvents, { dayPlan, tonightPick, limit: 10, recent: recentSelections });
  const dayPlanBlurb = dayPlan ? buildDayPlanBlurb(dayPlan, weather) : "";
  const tonightPickBlurb = tonightPick ? buildTonightBlurb(tonightPick) : "";
  const visuals = newsletterVisuals({
    date,
    longDate: formatLongDate(date),
    dayPlan,
    tonightPick,
    featuredEvents,
    recentOpenings,
    redditPosts,
  });

  const data = {
    date,
    longDate: formatLongDate(date),
    dayPlan, dayPlanBlurb,
    tonightPick, tonightPickBlurb,
    todayEvents,
    featuredEvents,
    recentOpenings,
    civicMeetings,
    weather,
    todayHistory,
    redditPosts,
    visuals,
    editorial: null,
    editorialMeta: { status: editorialEnabled ? "pending" : "disabled" },
  };

  if (!editorialEnabled) return data;

  // Editorial failure must never kill the 6am send — degrade to the
  // deterministic build (same philosophy as the hero: a failed extra never
  // blocks the email).
  try {
    return await applyEditorialPass(data, {
      eventCandidates: pickEditorialEventCandidates(todayEvents, { dayPlan, limit: 36, recent: recentSelections }),
      openingCandidates: recentOpenings,
      redditCandidates,
      recentSelections,
    });
  } catch (err) {
    console.warn(`⚠️  newsletter: editorial pass failed (${String(err?.message || err).slice(0, 300)}) — sending deterministic build`);
    data.editorialMeta = { status: "failed", error: String(err?.message || err).slice(0, 300) };
    return data;
  }
}

export function makeNewsletterPlan(plan, date, { validEventIds = null, virtualEventIds = null, registrationGatedEventIds = null } = {}) {
  if (!plan?.cards?.length) return null;
  const isPairPlan = plan.selectionModel === "pillar-pairs-v1" || plan.cards.some((card) => card.role);
  // Defense-in-depth against bad picks: generic chain branches are excluded,
  // while branches that generation marked interesting remain eligible.
  // Legacy plans can lose a card; a pillar-pairs plan is atomic and must be
  // rejected whole rather than quietly severing a meal relationship.
  const rejectedCards = [];
  const cards = plan.cards.filter((c) => {
    if (isNationalChain(c.name) && c.interestingChain !== true) {
      rejectedCards.push({ card: c, reason: "generic chain branch" });
      return false;
    }
    if (isPlaceTemporarilyUnavailable(c)) {
      rejectedCards.push({ card: c, reason: "temporarily unavailable" });
      return false;
    }
    const isEventCard = c.source === "event" || String(c.id || "").startsWith("event:");
    if (
      isEventCard &&
      c.locked !== true &&
      audienceBreadthPenalty({ title: c.name, description: c.description, blurb: c.blurb }) >= UNPROMPTED_AUDIENCE_PENALTY_CUTOFF
    ) {
      rejectedCards.push({ card: c, reason: "affiliation-limited audience" });
      return false;
    }
    if (isEventCard && validEventIds && !validEventIds.has(c.id)) {
      rejectedCards.push({ card: c, reason: "absent from current event feed" });
      return false;
    }
    // Hard exclusion, never a score penalty. A field-guide card is a place to
    // go, paired with a meal within five miles of it; an online-only event has
    // no such place, so no amount of quality makes it a valid pillar. This is
    // the gate the 2026-08-05 CRC meeting walked through when the only defense
    // was scoreEvent()'s -20.
    if (isEventCard && virtualEventIds && virtualEventIds.has(c.id)) {
      rejectedCards.push({ card: c, reason: "virtual (no physical destination)" });
      return false;
    }
    if (isEventCard && isVirtualEvent({ title: c.name, description: c.description || c.blurb })) {
      rejectedCards.push({ card: c, reason: "virtual (no physical destination)" });
      return false;
    }
    // Same shape of error, different gate: a field-guide card tells the reader
    // to show up at a stated time. An appointment-only or registration-required
    // program cannot honour that, so it is rejected whole rather than demoted.
    // This is the check the Aug 12 2026 Vintage Media Lab card needed.
    if (isEventCard && registrationGatedEventIds && registrationGatedEventIds.has(c.id)) {
      rejectedCards.push({ card: c, reason: "requires advance registration" });
      return false;
    }
    return true;
  });
  for (const { card, reason } of rejectedCards) {
    console.warn(`⚠️  newsletter: ${isPairPlan ? "rejecting plan for" : "dropping"} ${reason} day-plan card "${card.name}" (${card.bucket || card.timeBlock || "?"})`);
  }
  if (isPairPlan && rejectedCards.length) return null;
  if (!cards.length) return null;
  if (isPairPlan) {
    const pairProblems = newsletterPairingIssues(cards);
    if (pairProblems.length) {
      console.warn(`⚠️  newsletter: rejecting invalid pillar-pairs plan: ${pairProblems.join("; ")}`);
      return null;
    }
    const mealProblems = newsletterMealIntegrityIssues(cards, plan.planDate || date);
    if (mealProblems.length) {
      console.warn(`⚠️  newsletter: rejecting meal-service mismatch: ${mealProblems.join("; ")}`);
      return null;
    }
  }
  return {
    ...plan,
    cards,
    planDate: plan.planDate || date,
    cityName: cityName(plan.city),
    planUrl: plan.planUrl || `${SITE_URL}/`,
  };
}

function newsletterPairingIssues(cards) {
  const pairs = [["morning", "breakfast"], ["afternoon", "lunch"], ["evening", "dinner"]];
  const byBucket = new Map(cards.map((card) => [card.bucket, card]));
  const issues = [];
  if (cards.length !== 6 || byBucket.size !== 6) issues.push("expected six unique bucket cards");
  const mealBrands = new Map();
  for (const mealBucket of ["breakfast", "lunch", "dinner"]) {
    const meal = byBucket.get(mealBucket);
    if (!meal) continue;
    const brand = chainBrandKey(meal.name) || meal.id;
    if (mealBrands.has(brand)) {
      issues.push(`duplicate meal brand: ${mealBrands.get(brand)} / ${meal.name || meal.id}`);
    } else {
      mealBrands.set(brand, meal.name || meal.id);
    }
  }
  for (const [pillarBucket, mealBucket] of pairs) {
    const pillar = byBucket.get(pillarBucket);
    const meal = byBucket.get(mealBucket);
    if (!pillar || !meal) { issues.push(`missing ${pillarBucket}/${mealBucket}`); continue; }
    if (pillar.role !== "pillar" || meal.role !== "paired-meal") issues.push(`wrong roles for ${pillarBucket}/${mealBucket}`);
    if (pillar.pairedWithId !== meal.id || meal.pairedWithId !== pillar.id) issues.push(`broken links for ${pillarBucket}/${mealBucket}`);
    if (!Number.isFinite(meal.pairDistanceMiles) || meal.pairDistanceMiles > 5.05) issues.push(`invalid distance for ${mealBucket}`);
    if (!["exact", "venue"].includes(meal.pairLocationPrecision)) issues.push(`unverified proximity for ${mealBucket}`);
  }
  return issues;
}

function newsletterMealIntegrityIssues(cards, date) {
  const dayKey = dayKeyForIsoDate(date);
  if (!dayKey) return [];
  const placesById = loadNewsletterPlacesById();
  const issues = [];
  for (const card of cards || []) {
    if (!["breakfast", "lunch", "dinner"].includes(card.bucket)) continue;
    const placeId = String(card.id || "").replace(/^place:/, "");
    const place = placesById.get(placeId);
    if (!place) continue;
    const issue = mealServiceIssue(place, card.bucket, dayKey);
    if (issue) issues.push(`${card.name || place.name || card.bucket}: ${issue}`);
  }
  return issues;
}

// Build-time image reachability cache. Email clients can't run an onError
// fallback the way the React Events tab does, so a dead URL becomes a permanent
// broken-image glyph in the inbox. The single biggest source of this: Google
// Places photoRefs expire (~30 days) and then /api/place-photo 404s every one
// of them (~54% of events resolve their image via photoRef). We verify each
// candidate URL once during assembly (verifyNewsletterImages) and drop only the
// ones that return a *definitive* non-image response — transient network errors
// are left as "unknown" so a build-time blip never blanks every image.
const imageVerification = new Map(); // resolved URL -> true (ok) | false (dead)

function isVerifiedDead(url) {
  return imageVerification.get(String(url || "")) === false;
}

function usableImage(url) {
  const value = normalizeAbsoluteHttpUrl(url) || "";
  if (isBlockedNewsletterImage(value)) return "";
  if (isVerifiedDead(value)) return "";
  // place-photo proxy URLs are keyed for verification by their ref (reachability
  // is size-independent), so a known-dead ref is dropped regardless of w/h.
  const m = value.match(/\/api\/place-photo\?ref=([^&]+)/);
  if (m && isVerifiedDead(`placephoto:${safeDecode(m[1])}`)) return "";
  return value;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function isValidPhotoRef(ref) {
  return typeof ref === "string" && ref.trim() && !ref.includes("://") && !ref.includes("..") && !/\s/.test(ref);
}

function placePhotoUrl(ref, w, h) {
  return `${SITE_URL}/api/place-photo?ref=${encodeURIComponent(ref)}&w=${w}&h=${h}`;
}

// Events and places carry their image either as a full URL (`image`) or as a
// Google Places photo reference (`photoRef` — the single most common source,
// ~54% of events). The site renders photoRef through /api/place-photo; email
// needs an absolute URL, so resolve it here. Without this, every Places-sourced
// event shows up imageless in the inbox — the recurring "no image" bug.
function resolveImageUrl(item, w = 144, h = 144) {
  const direct = usableImage(item?.image);
  if (direct) return direct;
  const ref = item?.photoRef;
  if (isValidPhotoRef(ref)) {
    if (isVerifiedDead(`placephoto:${ref}`)) return "";
    return placePhotoUrl(ref, w, h);
  }
  return "";
}

function isSpecificEventPageUrl(value) {
  const normalized = normalizeAbsoluteHttpUrl(value);
  if (!normalized) return false;
  const url = new URL(normalized);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (/^\/(?:events?|calendar|concert-series)?$/i.test(path)) return false;
  return true;
}

// Tonight's Pick attribution makes a stronger claim than an ordinary event
// thumbnail: the photo is presented as coming from the linked occurrence
// page. A venue photoRef is therefore ineligible, as is an explicit image on
// a generic venue calendar. If either piece is missing, render no image and
// no credit rather than inventing a relationship between them.
function tonightPickEventImage(pick) {
  if (!pick || !isSpecificEventPageUrl(pick.url)) return "";
  const occurrenceUrl = normalizeAbsoluteHttpUrl(pick.url);
  const imageSourceUrl = normalizeAbsoluteHttpUrl(pick.imageSourceUrl);
  if (!occurrenceUrl || imageSourceUrl !== occurrenceUrl) return "";
  const alt = normalizeComparable(pick.imageAlt);
  const titleTokens = new Set(normalizeComparable(pick.title).split(/\s+/).filter((token) => token.length >= 4));
  if (!alt || !alt.split(/\s+/).some((token) => titleTokens.has(token))) return "";
  return usableImage(pick.image);
}

// ── Build-time image reachability probe ──────────────────────────────────────
// Returns true (loads as an image), false (definitive non-image: 4xx or a 2xx
// that isn't an image), or null (transient: timeout / network error / 5xx — we
// leave these as "unknown" rather than blanking a possibly-fine image).
async function probeImage(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "SouthBayTodayBot/1.0 (+https://southbaytoday.org; newsletter image check)" },
    });
    if (res.status >= 500) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    return res.ok && ct.startsWith("image");
  } catch {
    return null;
  }
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(Math.max(1, limit), queue.length || 1) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

// Verify every image URL the newsletter is about to render and cache the result
// so usableImage/resolveImageUrl can drop the dead ones. Best-effort: failures
// to probe are treated as "unknown" and the image is kept.
export async function verifyNewsletterImages(data) {
  if (!data) return { checked: 0, dead: 0 };
  const directUrls = new Set();
  const refs = new Set();
  const addDirect = (url) => {
    const v = normalizeAbsoluteHttpUrl(url);
    if (v && !isBlockedNewsletterImage(v)) directUrls.add(v);
  };
  const addItem = (item) => {
    if (!item) return;
    addDirect(item.image);
    if (isValidPhotoRef(item.photoRef)) refs.add(item.photoRef);
  };

  for (const c of orderedCards(data.dayPlan)) addItem(c);
  addItem(data.tonightPick);
  for (const e of data.featuredEvents || []) addItem(e);
  for (const o of data.recentOpenings || []) addItem(o);
  for (const p of data.redditPosts || []) addDirect(p?.image);
  // Hero / OG image are direct URLs derived from the same content set.
  for (const k of ["dayPlanImage", "tonightPickImage", "archiveImage"]) addDirect(data.visuals?.[k]);

  const tasks = [
    ...[...directUrls].map((u) => ({ key: u, url: u })),
    ...[...refs].map((r) => ({ key: `placephoto:${r}`, url: placePhotoUrl(r, 144, 144) })),
  ].filter((t) => !imageVerification.has(t.key));

  await runWithConcurrency(tasks, 8, async ({ key, url }) => {
    const ok = await probeImage(url);
    if (ok !== null) imageVerification.set(key, ok);
  });

  const dead = tasks.filter((t) => imageVerification.get(t.key) === false).length;
  if (dead) console.log(`  🖼  newsletter images: ${dead}/${tasks.length} candidates unreachable — hidden to avoid broken tiles`);
  return { checked: tasks.length, dead };
}

// Every string the issue's own source data spells a proper name with. The
// editorial pass sees these verbatim in its packet, so a name it hands back
// spelled differently is a corruption, not a house-style call.
function issueCanonicalNames(data) {
  const texts = [];
  const pushItem = (item) => {
    if (!item) return;
    for (const value of [item.rawTitle, item.title, item.name, item.venue, item.blurb, item.description]) {
      const text = String(value || "").trim();
      if (text) texts.push(text);
    }
  };
  for (const card of orderedCards(data?.dayPlan)) pushItem(card);
  pushItem(data?.tonightPick);
  for (const list of [data?.featuredEvents, data?.todayEvents, data?.recentOpenings]) {
    for (const item of list || []) pushItem(item);
  }
  return collectCanonicalNames(texts);
}

/**
 * Deterministic guard on generated prose: the editorial pass may rewrite
 * anything it likes except the spelling of a proper name the issue's own
 * source data already spells correctly.
 *
 * The Aug 13 2026 issue shipped "Mistah F. A. B." in the preheader, the intro,
 * and the field guide while the deterministic event card — rendered from the
 * same source string — said "Mistah F.A.B." Prompt guidance alone cannot be
 * trusted with this; the check has to run after the model, on its output.
 *
 * Mutates and returns `data`. Idempotent, so both call sites are cheap.
 */
export function repairNewsletterProperNames(data) {
  if (!data) return data;
  const names = issueCanonicalNames(data);
  if (!names.length) return data;

  for (const key of ["dayPlanBlurb", "tonightPickBlurb"]) {
    if (typeof data[key] === "string") data[key] = repairCanonicalNames(data[key], names);
  }
  if (data.editorial && typeof data.editorial === "object") {
    for (const [key, value] of Object.entries(data.editorial)) {
      if (typeof value === "string") data.editorial[key] = repairCanonicalNames(value, names);
    }
  }
  // Editor-supplied title overrides are generated prose too. Only the override
  // copies carry rawTitle, so this never writes back onto a shared source event.
  for (const event of [data.tonightPick, ...(data.featuredEvents || [])]) {
    if (event?.rawTitle && typeof event.title === "string") {
      event.title = repairCanonicalNames(event.title, names);
    }
  }

  // Card blurbs are generated prose as well: event-blurb-cache.json is written
  // by an LLM off each event's description, and it is where the third live
  // spelling ("Mistah FAB") sat. They render verbatim on the card, so they get
  // the same treatment. Descriptions are left alone — they are the source the
  // canonical spelling is read from, not something to rewrite.
  for (const item of [
    ...orderedCards(data?.dayPlan),
    data.tonightPick,
    ...(data.featuredEvents || []),
    ...(data.recentOpenings || []),
  ]) {
    if (typeof item?.blurb === "string") item.blurb = repairCanonicalNames(item.blurb, names);
  }
  return data;
}

// The single pre-render pass over fully-assembled (post-editorial) data: repair
// any proper name the editor respelled, verify reachability of all candidate
// images, then recompute visuals so the hero / OG image also skip anything now
// known dead. Call this once, right before renderEmail. The name repair also
// runs where the editorial output lands; repeating it here is the catch-all for
// any prose path that reaches render without going through applyEditorialJson.
export async function finalizeNewsletterImages(data) {
  if (!data) return data;
  repairNewsletterProperNames(data);
  await verifyNewsletterImages(data);
  data.visuals = newsletterVisuals({
    date: data.date,
    longDate: data.longDate,
    dayPlan: data.dayPlan,
    tonightPick: data.tonightPick,
    featuredEvents: data.featuredEvents,
    recentOpenings: data.recentOpenings,
    redditPosts: data.redditPosts,
  });
  return data;
}

function firstResolvedImage(items, w = 144, h = 144) {
  for (const item of items || []) {
    const url = resolveImageUrl(item, w, h);
    if (url) return url;
  }
  return "";
}

function isBlockedNewsletterImage(url) {
  return BLOCKED_NEWSLETTER_IMAGE_PATTERNS.some((re) => re.test(String(url || "")));
}

function firstUsableImage(items, picker) {
  for (const item of items || []) {
    const image = usableImage(picker(item));
    if (image) return image;
  }
  return "";
}

function newsletterVisuals({ date, longDate, dayPlan, tonightPick, featuredEvents, recentOpenings, redditPosts }) {
  const dayPlanImage = usableImage(loadNewsletterHero(date))
    || firstUsableImage(orderedCards(dayPlan), (c) => c.image);
  const tonightPickImage = tonightPickEventImage(tonightPick);
  const eventsImage = firstResolvedImage(featuredEvents, 144, 144);
  const openingsImage = firstResolvedImage(recentOpenings, 116, 116);
  const conversationImage = firstUsableImage(redditPosts, (p) => p.image);
  const archiveImage = dayPlanImage || tonightPickImage || eventsImage || openingsImage || conversationImage || "";

  return {
    dayPlanImage,
    dayPlanImageAlt: `South Bay Today field guide for ${longDate}`,
    tonightPickImage,
    tonightPickImageAlt: tonightPick?.imageAlt || tonightPick?.title || "Tonight's pick",
    archiveImage,
    eventsImage,
    openingsImage,
    conversationImage,
  };
}

function daysBetween(fromDate, toDate) {
  if (!fromDate || !toDate) return Infinity;
  const from = new Date(`${fromDate}T12:00:00Z`).getTime();
  const to = new Date(`${toDate}T12:00:00Z`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Infinity;
  return Math.round((to - from) / 86400000);
}

function isFreshOpening(opening, date) {
  if (!isVerifiedOpeningRecord(opening)) return false;
  const age = daysBetween(opening?.date, date);
  return Number.isFinite(age) && age >= 0 && age <= NEWSLETTER_OPENING_MAX_AGE_DAYS;
}

const BUCKET_LABEL = {
  breakfast: "Breakfast",
  morning: "Morning",
  lunch: "Lunch",
  afternoon: "Afternoon",
  dinner: "Dinner",
  evening: "Evening",
};
const BUCKET_ORDER = ["morning", "breakfast", "afternoon", "lunch", "evening", "dinner"];

function orderedCards(plan) {
  const cards = plan?.cards || [];
  return [...cards].sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.bucket);
    const bi = BUCKET_ORDER.indexOf(b.bucket);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return parseTimeMinutes(a.eventTime || a.timeBlock) - parseTimeMinutes(b.eventTime || b.timeBlock);
  });
}

function humanList(items) {
  const clean = items.filter(Boolean);
  if (clean.length <= 1) return clean[0] || "";
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")}, and ${clean.at(-1)}`;
}

function buildDayPlanBlurb(plan, weather) {
  const cards = orderedCards(plan);
  const pillars = cards.filter((card) => card.role === "pillar");
  const activityPicks = pillars.length === 3
    ? pillars
    : cards.filter((card) => ["morning", "afternoon", "evening"].includes(card.bucket));
  const cities = [...new Set(activityPicks.map((c) => cityName(c.city)).filter(Boolean))].slice(0, 3);
  const names = activityPicks.map((card) => card.name).filter(Boolean).slice(0, 3);
  const dayDesc = weather?.dayDesc ? lowerFirst(weather.dayDesc) : "steady weather";
  const weatherBit = weather
    ? `${dayDesc}, high ${weather.high}°`
    : "a full day of options";
  const cityBit = cities.length ? ` across ${humanList(cities)}` : " across the South Bay";
  const picksBit = names.length ? `: ${humanList(names)}` : "";
  const pairingBit = pillars.length === 3
    ? " Each one comes with a nearby meal, so these are three self-contained pairings, not one six-stop route."
    : "";
  return `Today's guide starts with the three strongest activity picks${cityBit}${picksBit}.${pairingBit} Weather looks like ${weatherBit}.`;
}

function lowerFirst(s) {
  if (!s) return "";
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function trimPeriod(s) {
  return String(s || "").trim().replace(/[.。]+$/, "");
}

function buildTonightBlurb(event) {
  const why = event.blurb || event.description || "";
  const detail = why
    ? trimPeriod(why).slice(0, 220)
    : "A specific, low-friction evening option if you want one clear answer";
  return sanitizeTonightPickBlurb(`${detail}.`, event)
    || "A specific, low-friction evening option if you want one clear answer.";
}

function pickTonightEvent(events, recent = null) {
  const choices = events
    .filter(isTonightPickCandidate)
    .map((e) => ({ event: e, score: scoreEvent(e, true) + recentRepeatPenalty(e, recent, true) }))
    .sort((a, b) => b.score - a.score);
  return choices[0]?.event || null;
}

function isTonightPickCandidate(e) {
  if (!e || !e.url) return false;
  // Tonight's Pick is "the single best answer to what should I do tonight" —
  // an online-only event is never that, whether the feed flagged it or only
  // its copy gives it away.
  if (isVirtualEvent(e)) return false;
  // Same reasoning: Tonight's Pick is a walk-up answer. An event that needs a
  // booking made days earlier cannot be one, so it is excluded here rather
  // than penalized. It remains eligible for the listing sections below, where
  // it prints a "Reserve ahead" / "Appointment required" tag.
  if (requiresAdvanceRegistration(e)) return false;
  if (audienceBreadthPenalty(e) >= UNPROMPTED_AUDIENCE_PENALTY_CUTOFF) return false;
  const minutes = parseTimeMinutes(e.time);
  if (!Number.isFinite(minutes) || minutes < 16 * 60 || minutes >= 24 * 60) return false;
  const text = `${e.title || ""} ${e.venue || ""} ${e.category || ""}`.toLowerCase();
  return !/\b(board|commission|committee|meeting|study session|webinar|book club|maintenance|cleanup|clean-up|repair|workday|work day)\b/i.test(text);
}

function pickFeaturedEvents(events, { dayPlan, tonightPick, limit, recent = null }) {
  const used = new Set();
  for (const c of orderedCards(dayPlan)) {
    used.add(normalizeComparable(c.name));
    used.add(normalizeComparable(c.id));
  }
  if (tonightPick) used.add(normalizeComparable(tonightPick.title));
  const ranked = events
    .filter((e) => !used.has(normalizeComparable(e.title)) && !used.has(normalizeComparable(e.id)))
    .filter((e) => audienceBreadthPenalty(e) < UNPROMPTED_AUDIENCE_PENALTY_CUTOFF)
    .map((e) => ({ event: e, score: scoreEvent(e, false) + recentRepeatPenalty(e, recent, false) }))
    .sort((a, b) => b.score - a.score || parseTimeMinutes(a.event.time) - parseTimeMinutes(b.event.time));
  // Per-source cap so one prolific feed (a library system, one meetup group)
  // can't fill the whole section — the shortlist was library-heavy before the
  // editor ever saw it.
  const out = [];
  const bySource = new Map();
  for (const { event } of ranked) {
    const source = event.source || "other";
    const n = bySource.get(source) || 0;
    if (n >= 3) continue;
    bySource.set(source, n + 1);
    out.push(event);
    if (out.length >= limit) break;
  }
  return out;
}

// Lowercase on purpose — compare with post.sub.toLowerCase(). The old Set
// mixed casings and missed the scraper's actual "MountainView", so every
// r/MountainView post ate the -70 "not local" penalty and vanished.
const LOCAL_REDDIT_SUBS = new Set([
  "sanjose", "sunnyvale", "santaclara", "mountainview", "paloalto",
  "cupertino", "losgatos", "campbell", "milpitas", "losaltos", "saratoga",
]);
const LOCAL_REDDIT_TERMS = /\b(san jose|south bay|santa clara|sunnyvale|mountain view|palo alto|cupertino|campbell|los gatos|saratoga|los altos|milpitas|morgan hill|gilroy)\b/i;

function pickRedditPosts(posts, limit, recent = null) {
  return posts
    // Hard-drop threads the email already ran in the last 3 days — the
    // conversation section repeated verbatim day after day.
    .filter((post) => {
      const days = recent?.redditTitles.get(normalizeComparable(post.displayTitle || post.title));
      return days === undefined || days > 3;
    })
    .map((post, index) => ({ post, score: scoreRedditPost(post, index) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.post);
}

function isLocalRedditSub(sub) {
  return LOCAL_REDDIT_SUBS.has(String(sub || "").toLowerCase());
}

// RSS carries no vote/comment counts (Reddit's unauthenticated .json API 403s —
// see generate-reddit-pulse.mjs), so every post lands here with score:0/
// numComments:0. Ranking leans on locality + recency only; `index` is the
// post's rank in loadRedditPulse().posts, which is already recency-sorted.
function scoreRedditPost(post, index) {
  const title = `${post.displayTitle || post.title || ""} ${post.summary || ""}`;
  let score = Math.max(0, 60 - index * 4);
  if (isLocalRedditSub(post.sub)) score += 45;
  if (LOCAL_REDDIT_TERMS.test(title)) score += 30;
  if (!isLocalRedditSub(post.sub) && !LOCAL_REDDIT_TERMS.test(title)) score -= 70;
  return score;
}

function normalizeComparable(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export { isMarqueeEvent, isTonightPickCandidate };

function scoreEvent(e, tonight) {
  let score = 0;
  const hour = parseTimeMinutes(e.time);
  if (Number.isFinite(hour) && hour < 9999) score += 10;
  if (tonight && hour >= 17 * 60) score += 10;
  if (isMarqueeEvent(e)) score += tonight ? 18 : 12;
  if (e.image) score += 5;
  if (e.blurb) score += 8;
  // Free is a perk for the calendar list, but Tonight's Pick is the one slot
  // meant to be the single best answer to "what should I do tonight" — being
  // free shouldn't outrank a headliner there.
  if (e.cost === "free" && !tonight) score += 4;
  if (e.kidFriendly) score += 2;
  // Demotion, not exclusion — this score only ranks "Also on the calendar",
  // where a virtual event is still a real thing a reader can attend and is
  // labelled "Virtual" by eventMeta(). The slots that imply a destination
  // (field-guide pillars, Tonight's Pick) exclude virtual outright upstream.
  if (isVirtualEvent(e)) score -= 20;
  // Same treatment for an event that has run out of seats: still listed, still
  // labelled "Registration full" (a waitlist may open), but it should not lead
  // a list whose promise is "worth checking before you make plans". Events that
  // merely need booking are NOT demoted — they are attendable if the reader
  // acts, and the label tells them to.
  if (e?.registration === "full") score -= 15;
  score -= titleQualityPenalty(e.title);
  score -= routineEventPenalty(e);
  score -= audienceBreadthPenalty(e);
  return score;
}

function shouldRunEditorialPass() {
  const v = String(process.env.SBT_NEWSLETTER_EDITORIAL || "1").toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

function pickEditorialEventCandidates(events, { dayPlan, limit, recent = null }) {
  const used = new Set();
  for (const c of orderedCards(dayPlan)) {
    used.add(normalizeComparable(c.name));
    used.add(normalizeComparable(c.id));
  }

  const eligible = events
    .filter((e) => e.url)
    .filter((e) => audienceBreadthPenalty(e) < UNPROMPTED_AUDIENCE_PENALTY_CUTOFF)
    .filter((e) => !used.has(normalizeComparable(e.title)) && !used.has(normalizeComparable(e.id)))
    .map((event) => ({
      event,
      score: scoreEvent(event, false) + editorialEventBoost(event) + recentRepeatPenalty(event, recent, false),
    }));

  const topOverall = [...eligible].sort((a, b) => b.score - a.score).slice(0, Math.ceil(limit * 0.75));
  const evening = [...eligible]
    .filter(({ event }) => parseTimeMinutes(event.time) >= 16 * 60)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  const chronological = [...eligible]
    .sort((a, b) => parseTimeMinutes(a.event.time) - parseTimeMinutes(b.event.time))
    .slice(0, 8);

  const seen = new Set();
  const bySource = new Map();
  const merged = [];
  for (const { event } of [...topOverall, ...evening, ...chronological]) {
    const key = normalizeComparable(event.id || event.title);
    if (seen.has(key)) continue;
    seen.add(key);
    // Cap any single source at a third of the shortlist — one library feed
    // was pre-skewing the whole pool before the editor could balance it.
    const source = event.source || "other";
    const n = bySource.get(source) || 0;
    if (n >= Math.ceil(limit / 3)) continue;
    bySource.set(source, n + 1);
    merged.push(event);
    if (merged.length >= limit) break;
  }
  return merged;
}

function editorialEventBoost(e) {
  let score = 0;
  if (/\b(concert|jazz|festival|market|launch|opening|workshop|tour|hike|dance|film|comedy|theater|theatre)\b/i.test(e.title || "")) score += 8;
  if (/\b(farmers'? market|storytime|reading buddies|book club|office hours)\b/i.test(e.title || "")) score -= 4;
  if (parseTimeMinutes(e.time) >= 17 * 60) score += 3;
  if (e.venue) score += 2;
  return score;
}

async function applyEditorialPass(data, candidates) {
  const packet = buildEditorialPacket(data, candidates);
  const prompt = buildEditorialPrompt(packet);
  const { raw, via } = await callClaudeNewsletterEditor(prompt);
  const edit = parseClaudeJson(raw);
  const revised = applyEditorialJson(data, candidates, edit);
  revised.editorialMeta = {
    status: "claude",
    via,
    model: via === "anthropic-api"
      ? (process.env.SBT_NEWSLETTER_API_MODEL || "claude-fable-5")
      : (process.env.SBT_NEWSLETTER_CLAUDE_MODEL || "fable"),
    eventCandidates: candidates.eventCandidates.length,
    openingCandidates: candidates.openingCandidates.length,
    redditCandidates: candidates.redditCandidates.length,
    generatedAt: new Date().toISOString(),
  };
  return revised;
}

// Exported for the same reason civicMeetingsHeading is: the editor's intro is
// written off this packet, so its claims need a test that doesn't call the API.
export function buildEditorialPacket(data, candidates) {
  return {
    date: data.longDate,
    editorialMemory: newsletterMemoryForPrompt(loadNewsletterEditorialMemory()),
    weather: data.weather ? {
      high: data.weather.high,
      low: data.weather.low,
      rainPct: data.weather.rainPct,
      description: data.weather.dayDesc,
    } : null,
    dayPlan: data.dayPlan ? {
      city: data.dayPlan.cityName || cityName(data.dayPlan.city),
      cards: orderedCards(data.dayPlan).map((c, idx) => ({
        idx,
        slot: BUCKET_LABEL[c.bucket] || c.timeBlock || "Idea",
        name: c.name,
        time: c.eventTime || c.timeBlock || "",
        venue: c.venue || "",
        city: cityName(c.city),
        cost: planCardPriceBand(c) || "",
        blurb: compactText(c.blurb, 180),
      })),
    } : null,
    eventCandidates: candidates.eventCandidates.map((e, idx) => compactEventForEditor(e, idx)),
    openingCandidates: candidates.openingCandidates.map((o, idx) => ({
      idx,
      name: o.name,
      city: o.cityName || o.cityId || "",
      address: o.address || "",
      opened: o.date || "",
      blurb: compactText(o.blurb, 180),
    })),
    // `time` read m.time, a field no meeting record has ever carried, so the
    // editor wrote about tonight's civic calendar with no clock in front of it.
    meetings: data.civicMeetings.map((m, idx) => ({
      idx,
      city: cityName(m.city),
      body: m.bodyName || "Meeting",
      time: formatMeetingTime(m.startTime) || "",
      location: m.location || "",
      // `time` is the hour the public may attend, which is not always the hour
      // the city's calendar posts. The 2026-08-25 issue wrote "Sunnyvale at
      // 4:30 … the afternoon to scratch a civic itch" off a posted start that
      // was the closed session; say so plainly so the intro can't repeat it.
      ...(m.closedSession
        ? { closedSession: true, note: CLOSED_SESSION_LABEL }
        : m.closedSessionStart
          ? { note: `${closedSessionPrefaceLabel(m)} (not open to the public); the public session starts at ${formatMeetingTime(m.startTime)}` }
          : {}),
    })),
    history: data.todayHistory.map((h, idx) => ({
      idx,
      company: h.company,
      city: h.city,
      year: h.foundedYear,
      note: compactText(h.anniversaryNote || h.tagline, 240),
    })),
    redditCandidates: candidates.redditCandidates.map((p, idx) => ({
      idx,
      sub: p.sub || "",
      title: p.displayTitle || p.title || "",
      score: p.score || 0,
      comments: p.numComments || 0,
      summary: compactText(p.summary, 180),
    })),
    recentlySent: candidates.recentSelections?.summaries?.length
      ? candidates.recentSelections.summaries
      : undefined,
  };
}

const NEWSLETTER_HISTORY_FILE = join(DATA_DIR, "newsletter-send-history.jsonl");
const NEWSLETTER_MEMORY_FILE = join(DATA_DIR, "newsletter-editorial-memory.json");

// Read back what recent sends actually featured. The history file was
// write-only for two months, so the same reddit threads, tonight picks, and
// venues could repeat day after day with nothing noticing. Returns Maps of
// normalized title/venue -> daysAgo (smallest wins). Missing file (fresh
// checkout, laptop dev) = empty maps, zero penalties.
export function loadRecentNewsletterSelections(today, days = 5) {
  const recent = {
    tonightTitles: new Map(),
    featuredTitles: new Map(),
    redditTitles: new Map(),
    venues: new Map(),
    summaries: [], // compact per-day summary for the editor packet
  };
  let lines;
  try {
    lines = readFileSync(NEWSLETTER_HISTORY_FILE, "utf8").trim().split("\n").slice(-14);
  } catch {
    return recent;
  }
  const remember = (map, key, daysAgo) => {
    const k = normalizeComparable(key);
    if (!k) return;
    const prev = map.get(k);
    if (prev === undefined || daysAgo < prev) map.set(k, daysAgo);
  };
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const daysAgo = daysBetween(entry?.date, today);
    // daysAgo >= 1: a same-morning rebuild must not penalize its own picks.
    if (!Number.isFinite(daysAgo) || daysAgo < 1 || daysAgo > days) continue;
    const sel = entry.selections || {};
    remember(recent.tonightTitles, sel.tonightPick, daysAgo);
    remember(recent.venues, sel.tonightPickVenue, daysAgo);
    for (const t of sel.featuredEvents || []) remember(recent.featuredTitles, t, daysAgo);
    for (const v of sel.featuredEventVenues || []) remember(recent.venues, v, daysAgo);
    for (const t of sel.reddit || []) remember(recent.redditTitles, t, daysAgo);
    if (daysAgo <= 3) {
      recent.summaries.push({
        daysAgo,
        tonightPick: sel.tonightPick || null,
        featuredEvents: (sel.featuredEvents || []).slice(0, 10),
      });
    }
  }
  return recent;
}

// Negative score adjustment for events the newsletter already showed recently.
function recentRepeatPenalty(e, recent, tonight) {
  if (!recent) return 0;
  const title = normalizeComparable(e.title);
  const venue = normalizeComparable(e.venue);
  let penalty = 0;
  const tonightDays = recent.tonightTitles.get(title);
  if (tonightDays !== undefined) penalty += tonight ? 25 : 12;
  const featuredDays = recent.featuredTitles.get(title);
  if (featuredDays !== undefined && featuredDays <= 3) penalty += 12;
  const venueDays = venue ? recent.venues.get(venue) : undefined;
  if (venueDays !== undefined && venueDays <= 2) penalty += 6;
  return -penalty;
}

function loadNewsletterEditorialMemory() {
  try {
    return JSON.parse(readFileSync(NEWSLETTER_MEMORY_FILE, "utf8"));
  } catch {
    return null;
  }
}

function newsletterMemoryForPrompt(memory) {
  if (!memory) return null;
  return {
    guidance: (memory.guidance || []).slice(-10),
    recentReflections: (memory.reflections || []).slice(-5).map((r) => ({
      date: r.date,
      score: r.score,
      keepDoing: r.keepDoing,
      improveNext: r.improveNext,
      avoid: r.avoid,
    })),
  };
}

function compactEventForEditor(e, idx) {
  return {
    idx,
    id: e.id || "",
    title: e.title || "",
    time: e.time || "",
    venue: e.venue || "",
    city: eventLocality(e),
    category: e.category || "",
    cost: e.cost || "",
    source: e.source || "",
    ...(isMarqueeEvent(e) ? { marquee: true } : {}),
    audience: e.audienceAge || (e.kidFriendly ? "kids/family" : ""),
    blurb: compactText(e.blurb || e.description, 220),
  };
}

function buildEditorialPrompt(packet) {
  return `You are the morning editor for South Bay Today, a genuinely useful local briefing for Santa Clara County.

Thesis: we have an excellent pile of local data and access to strong AI, so the email should feel edited, selective, and coherent. The target reaction is: "oh damn, this is my morning South Bay briefing."

Your job:
- Read the editor packet.
- Use the editorialMemory notes when present; they are lessons from prior sends.
- Choose what belongs in the email.
- Cut boring, overly generic, repetitive, or awkward items.
- Write the morning note and section blurbs.
- Return structured JSON only.

Voice:
- Smart, warm, specific, lightly opinionated. A competent local friend who actually read the calendar.
- Useful beats hype. Never describe a day or part of a day as quiet, slow, thin, light, sparse, sleepy, soft, or weak. There is always something to do; frame the useful options and strongest patterns without apologizing for the calendar.
- Write like a person talks. Avoid stiff phrasing like "daytime favors practical use of time."
- Do not over-explain geography or logistics. The day plan is a set of ideas, not a route defense.
- The day plan is deliberately three quality-first activity pillars: morning, afternoon, and evening. Each has one nearby meal. Treat them as three independent pairings; cities may differ and that is not a flaw.
- When the field-guide cards span multiple cities, never claim the day, route, plan, or field guide stays close to, centers on, clusters around, or remains within one city or downtown.
- A chain card appears only when upstream found a branch-specific reason it is interesting. Write from that supplied reason; never recommend a familiar logo merely for convenience.
- Preserve all six field-guide cards. Removing one card breaks a pillar/meal pair; selection mistakes must be fixed upstream, not hidden in the newsletter.
- Do not tell readers what they are "passing on" or what a choice means skipping. Explain why the selected thing is worth noticing.
- No corporate newsletter voice. No "unlock", "curated just for you", "vibrant", "hidden gem", or "don't miss."
- Avoid em dashes. Use commas, periods, or parentheses.
- Tonight's Pick already prints its time, venue, and city on a metadata line. Start tonightPickBlurb with a complete sentence about why to go; never repeat or lead with "at [time] at [venue]" metadata.

Fact rules:
- Use only facts in the packet. Do not infer addresses, prices, ages, quality, or popularity.
- Spell proper names exactly as the packet spells them, punctuation and all. Initials keep their packet form: "Mistah F.A.B.", never "Mistah F. A. B." or "Mistah FAB".
- Do not claim "every event." This is a selected briefing.
- Selected indexes must come from the arrays provided.
- If a section has weak material, select fewer items.

Selection guidance:
- Pick one evening item only if it starts at 4 PM or later, is specific, local, and plausible as a good answer to "what should I do tonight?" Never pick maintenance, cleanup, repair, meetings, webinars, or generic admin/service items.
- Prefer events with broad reader relevance. Affiliation-limited offers, alumni nights, members-only previews, and institution-specific ticket sections belong in the searchable calendar, not the newsletter's recommendation slots.
- If a nationally touring act or headline show is on tonight (look for "marquee": true, or a big-name venue like Shoreline, Mountain Winery, SAP Center), it is almost always the tonight pick. A famous name at a famous venue beats a pleasant free local event — readers can find the plaza jazz series on their own; they will be annoyed to learn tomorrow that you buried the headliner.
- Featured events should be balanced: adult/family/free/outdoor/culture when available. Do not let generic library items crowd out stronger citywide events unless the day is genuinely family-heavy.
- Check recentlySent (when present): do not repeat a tonight pick from the last few days, and avoid re-featuring the same events unless they are genuinely still the best option. Repetition is the fastest way to make the email feel robotic.
- Reddit items should be South Bay-specific conversation, not generic Bay Area chatter.
- Openings should be readable and genuinely fresh; skip raw, overly bureaucratic, or week-old entries if they make the email worse.
- Raw scraped titles are often ugly ("Fugetsu \\- Sunnyvale", clickbait punctuation, ALL CAPS). When you select an event whose title reads like a feed dump, supply a cleaned title in titleOverrides — keep the real event/venue names, drop the junk, max 70 characters. Only rewrite what needs it.

Return JSON with exactly these keys:
{
  "briefing": "2-3 sentences opening the morning. Mention the strongest patterns or useful clusters in today's material.",
  "dayPlanHeadline": "short headline for the field guide",
  "dayPlanBlurb": "2-3 sentences making the plan feel intentional and useful",
  "tonightPickIdx": 0,
  "tonightPickBlurb": "1-2 sentences why this is the evening pick, using only packet facts",
  "featuredEventIdxs": [0, 1, 2, 3, 4, 5],
  "titleOverrides": {"3": "Cleaned-up title for candidate 3"},
  "eventsHeading": "Also on the calendar",
  "eventsNote": "1 sentence explaining the shape of the selected events",
  "openingIdxs": [0, 1],
  "openingsHeading": "Newly opened",
  "openingsNote": "1 sentence, or empty string if not useful",
  "redditIdxs": [0, 1, 2, 3],
  "conversationHeading": "short section heading",
  "conversationNote": "1 sentence framing the local chatter"
}

Use null for tonightPickIdx if none is strong enough, and empty arrays for weak optional sections — these are honored as deliberate cuts, not errors. Use {} for titleOverrides when nothing needs fixing.

EDITOR PACKET:
${JSON.stringify(packet, null, 2)}
`;
}

// Read per call, like the model and timeout below — a module-level constant
// would freeze the path at import time and silently ignore the environment the
// scheduled send actually runs under.
const claudeCli = () => process.env.CLAUDE_CLI_PATH || "/opt/homebrew/bin/claude";

/**
 * Editorial pass, with a metered fallback.
 *
 * The Max-plan CLI is the primary path because it is free at the margin. When
 * it fails — usage cap, auth expiry, a wedged binary — the pass would otherwise
 * degrade to the deterministic build and the day's issue would quietly lose its
 * editing. The Anthropic API runs the identical prompt for roughly $1 an issue,
 * which is worth paying to keep the voice consistent on the days the plan is
 * exhausted. If the API path is unavailable too, the caller still degrades to
 * the deterministic build — a missed send is never acceptable.
 *
 * Returns { raw, via } so the send can record which path produced the edit.
 */
export async function callClaudeNewsletterEditor(instructions) {
  try {
    return { raw: await runClaudeCliEditor(instructions), via: "claude-cli" };
  } catch (cliError) {
    const detail = String(cliError?.message || cliError).slice(0, 200);
    if (!process.env.ANTHROPIC_API_KEY) throw cliError;
    console.warn(`⚠️  newsletter: claude CLI editorial failed (${detail}) — retrying on the Anthropic API`);
    try {
      return { raw: await runAnthropicApiEditor(instructions), via: "anthropic-api" };
    } catch (apiError) {
      // Surface both, so a degraded issue says why in one line.
      throw new Error(`CLI: ${detail} | API: ${String(apiError?.message || apiError).slice(0, 200)}`);
    }
  }
}

async function runClaudeCliEditor(instructions) {
  // Fable default since 2026-07-14 — the editorial pass is pure taste work,
  // so it gets the best model on the Max plan. Measured ~7-8 min on the full
  // packet, hence the 10-min timeout and the 5:50am launchd start (send still
  // lands ~6:00). A timeout degrades to the deterministic build, never a
  // missed send.
  const model = process.env.SBT_NEWSLETTER_CLAUDE_MODEL || "fable";
  const timeoutMs = Number(process.env.SBT_NEWSLETTER_CLAUDE_TIMEOUT_MS || 600_000);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(value);
    };
    const proc = spawn(claudeCli(), [
      "-p",
      "--model", model,
      "--output-format", "text",
      "--no-session-persistence",
    ], { cwd: "/tmp", timeout: timeoutMs });
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => finish(new Error(`claude spawn failed: ${err.message}`)));
    proc.on("close", (code, signal) => {
      if (signal) return finish(new Error(`claude killed by ${signal}: ${(stderr || stdout).slice(0, 500)}`));
      if (code !== 0) return finish(new Error(`claude exit ${code}: ${(stderr || stdout).slice(0, 500)}`));
      finish(null, stdout);
    });
    proc.stdin.end(instructions);
  });
}

/**
 * Metered twin of the CLI path. Matches the CLI's model tier so a fallback
 * issue reads in the same voice — override with SBT_NEWSLETTER_API_MODEL to
 * trade quality for cost (Opus 5 is roughly half Fable's rate).
 *
 * Streamed because the editorial pass runs for minutes on the full packet, well
 * past the point where a non-streaming request risks an HTTP timeout.
 */
async function runAnthropicApiEditor(instructions) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.SBT_NEWSLETTER_API_MODEL || "claude-fable-5";

  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64_000,
    // Fable thinks unconditionally — configuring `thinking` at all is a 400.
    output_config: { effort: process.env.SBT_NEWSLETTER_API_EFFORT || "high" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: instructions }],
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error(`editorial request refused (${message.stop_details?.category ?? "unknown"})`);
  }
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function parseClaudeJson(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error(`Claude editor returned non-JSON: ${cleaned.slice(0, 500)}`);
  }
}

// A cleaned title must still be about the same event: require at least one
// substantial shared token with the original title/venue/city. Prevents a
// hallucinated rewrite from describing a different event; a miss just ships
// the raw title.
function isTitleAnchoredToEvent(title, event) {
  const text = normalizeComparable(title);
  if (!text || !event) return false;
  const anchorText = normalizeComparable(`${event.title || ""} ${event.venue || ""} ${eventLocality(event) || ""}`);
  const anchorTokensSet = new Set(anchorText.split(/\s+/).filter((t) => t.length >= 4));
  return text.split(/\s+/).some((t) => t.length >= 4 && anchorTokensSet.has(t));
}

export function sanitizeGeographicBriefing(value, dayPlan) {
  const text = String(value || "").trim();
  if (!text) return "";
  const cityLabels = [...new Set((dayPlan?.cards || [])
    .map((card) => String(card?.city || "").trim())
    .filter(Boolean))]
    .map((slug) => slug.replace(/-/g, " "));
  if (cityLabels.length <= 1) return text;

  const falseCompactClaim = (sentence) => {
    const normalized = normalizeComparable(sentence);
    const namedPlanCities = cityLabels.filter((label) => normalized.includes(label)).length;
    // "Starts in San Jose, then moves to Campbell" is honest even though it
    // contains one-city language. The dangerous claim names at most one of
    // the several cities actually represented by the cards.
    if (namedPlanCities >= 2) return false;
    const planSubject = /\b(field guide|day|route|plan|it)\b/i.test(sentence);
    const compactLanguage = /\b(stays?|keeps?|remains?|cent(?:er|red|ers)|clusters?|close to|near|around|within)\b/i.test(sentence);
    const singleArea = /\b(downtown|one city|single city|one compact area)\b/i.test(sentence)
      || cityLabels.some((label) => normalized.includes(label));
    return planSubject && compactLanguage && singleArea;
  };

  return (text.match(/[^.!?]+[.!?]?/g) || [text])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !falseCompactClaim(sentence))
    .join(" ")
    .trim();
}

function applyEditorialJson(data, candidates, edit) {
  // Editor decisions are honored: explicit null / empty arrays are deliberate
  // cuts, not parse failures. Fallbacks fire only when a key is missing or
  // malformed. (The old behavior silently overrode the editor's "no good
  // tonight pick" and refilled deliberately-emptied sections with the raw
  // uncurated lists — the "editor" was a figurehead.)
  const overrides = (edit.titleOverrides && typeof edit.titleOverrides === "object") ? edit.titleOverrides : {};
  const withTitleOverride = (event, idx) => {
    const cleaned = newsletterCopyString(typeof overrides[String(idx)] === "string" ? overrides[String(idx)] : "", 90);
    if (!cleaned || cleaned === event.title || !isTitleAnchoredToEvent(cleaned, event)) return event;
    return { ...event, title: cleaned, rawTitle: event.title };
  };
  const eventByIdx = new Map(candidates.eventCandidates.map((e, idx) => [idx, withTitleOverride(e, idx)]));
  const openingByIdx = new Map(candidates.openingCandidates.map((o, idx) => [idx, o]));
  const redditByIdx = new Map(candidates.redditCandidates.map((p, idx) => [idx, p]));

  const tonightIdx = integerOrNull(edit.tonightPickIdx);
  const editedTonightPick = tonightIdx === null ? null : eventByIdx.get(tonightIdx) || null;
  const tonightPick = editedTonightPick && isTonightPickCandidate(editedTonightPick)
    ? editedTonightPick
    : null;
  const tonightOptedOut = "tonightPickIdx" in edit && edit.tonightPickIdx === null;
  const featuredProvided = Array.isArray(edit.featuredEventIdxs);
  const openingsProvided = Array.isArray(edit.openingIdxs);
  const redditProvided = Array.isArray(edit.redditIdxs);

  const featured = pickByIndexes(eventByIdx, edit.featuredEventIdxs, 10)
    .filter((e) => !tonightPick || normalizeComparable(e.id || e.title) !== normalizeComparable(tonightPick.id || tonightPick.title));
  const fallbackFeatured = data.featuredEvents
    .filter((e) => !tonightPick || normalizeComparable(e.id || e.title) !== normalizeComparable(tonightPick.id || tonightPick.title));

  const openings = pickByIndexes(openingByIdx, edit.openingIdxs, 6)
    .filter((o) => isFreshOpening(o, data.date));
  const reddit = pickByIndexes(redditByIdx, edit.redditIdxs, 4);
  const finalTonightPick = tonightPick || (tonightOptedOut ? null : data.tonightPick);
  const cleanedTonightBlurb = tonightPick
    ? sanitizeTonightPickBlurb(edit.tonightPickBlurb, tonightPick)
    : "";
  const editedTonightBlurb = tonightPick && isBlurbAnchoredToEvent(cleanedTonightBlurb, tonightPick)
    ? cleanedTonightBlurb
    : "";

  // "Provided but resolved to nothing from a non-empty list" still reads as
  // malformed (bad indexes) and falls back; a provided EMPTY list is a cut.
  const useEditorList = (provided, rawList, resolved) =>
    provided && !(rawList.length && !resolved.length);

  // The plan is an atomic set of three pillar/meal pairs. Editorial can
  // rewrite its framing, but cannot silently sever a pair by dropping a card.
  const dayPlan = data.dayPlan;
  const editedDayPlanBlurb = sanitizeGeographicBriefing(
    newsletterCopyString(edit.dayPlanBlurb, 650),
    dayPlan,
  );
  const editedBriefing = sanitizeGeographicBriefing(
    newsletterCopyString(edit.briefing, 800),
    dayPlan,
  );

  const revised = {
    ...data,
    dayPlan,
    dayPlanBlurb: editedDayPlanBlurb || data.dayPlanBlurb,
    tonightPick: finalTonightPick,
    tonightPickBlurb: editedTonightBlurb || (finalTonightPick ? buildTonightBlurb(finalTonightPick) : ""),
    featuredEvents: useEditorList(featuredProvided, featuredProvided ? edit.featuredEventIdxs : [], featured)
      ? uniqueItems(featured, 10)
      : uniqueItems(fallbackFeatured, 10),
    recentOpenings: useEditorList(openingsProvided, openingsProvided ? edit.openingIdxs : [], openings)
      ? openings
      : data.recentOpenings.filter((o) => isFreshOpening(o, data.date)),
    redditPosts: useEditorList(redditProvided, redditProvided ? edit.redditIdxs : [], reddit)
      ? reddit
      : data.redditPosts,
    editorial: {
      briefing: editedBriefing,
      dayPlanHeadline: newsletterCopyString(edit.dayPlanHeadline, 120),
      eventsHeading: newsletterCopyString(edit.eventsHeading, 80),
      eventsNote: newsletterCopyString(edit.eventsNote, 240),
      openingsHeading: newsletterCopyString(edit.openingsHeading, 80),
      openingsNote: newsletterCopyString(edit.openingsNote, 220),
      conversationHeading: newsletterCopyString(edit.conversationHeading, 80),
      conversationNote: newsletterCopyString(edit.conversationNote, 320),
    },
  };

  repairNewsletterProperNames(revised);

  revised.visuals = newsletterVisuals({
    date: revised.date,
    longDate: revised.longDate,
    dayPlan: revised.dayPlan,
    tonightPick: revised.tonightPick,
    featuredEvents: revised.featuredEvents,
    recentOpenings: revised.recentOpenings,
    redditPosts: revised.redditPosts,
  });

  return revised;
}

function integerOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function pickByIndexes(map, raw, limit) {
  const out = [];
  const seen = new Set();
  const indexes = Array.isArray(raw) ? raw : [];
  for (const value of indexes) {
    const idx = Number(value);
    if (!Number.isInteger(idx)) continue;
    if (seen.has(idx)) continue;
    const item = map.get(idx);
    if (!item) continue;
    seen.add(idx);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueItems(items, max) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = normalizeComparable(item?.id || item?.title || item?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function isBlurbAnchoredToEvent(blurb, event) {
  const text = normalizeComparable(blurb);
  if (!text || !event) return false;
  const anchors = [
    event.title,
    event.venue,
    eventLocality(event),
  ].flatMap(anchorTokens);
  return anchors.some((token) => token.length >= 5 && text.includes(token));
}

export function sanitizeTonightPickBlurb(value, event) {
  const cleaned = newsletterCopyString(value, 500);
  if (!cleaned || !event) return cleaned;

  const firstSentence = cleaned.match(/^([^.!?]+[.!?])(?:\s+|$)([\s\S]*)$/);
  if (!firstSentence) return cleaned;

  const time = String(event.time || "").trim();
  const venue = String(event.venue || "").trim();
  const locality = eventLocality(event);
  const fragments = new Set();
  const addFragment = (fragment) => {
    const normalized = normalizeComparable(fragment);
    if (!normalized) return;
    fragments.add(normalized);
    fragments.add(`tonight ${normalized}`);
    if (event.cost === "free") fragments.add(`free ${normalized}`);
  };

  addFragment(time && `at ${time}`);
  addFragment(venue && `at ${venue}`);
  addFragment(locality && `in ${locality}`);
  addFragment(time && venue && `at ${time} at ${venue}`);
  addFragment(time && locality && `at ${time} in ${locality}`);
  addFragment(venue && locality && `at ${venue} in ${locality}`);
  addFragment(time && venue && locality && `at ${time} at ${venue} in ${locality}`);

  if (!fragments.has(normalizeComparable(firstSentence[1]))) return cleaned;
  return newsletterCopyString(firstSentence[2], 500);
}

function anchorTokens(value) {
  const normalized = normalizeComparable(value);
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/).filter((token) => token.length >= 5);
  return [normalized, ...tokens];
}

export function truncateNewsletterCopy(value, max) {
  if (typeof value !== "string") return "";
  const clean = value.trim();
  if (clean.length <= max) return clean;
  if (max <= 1) return "…".slice(0, Math.max(0, max));

  const head = clean.slice(0, max - 1);
  const sentenceEnds = [...head.matchAll(/[.!?](?=\s|$)/g)];
  const lastSentenceEnd = sentenceEnds.at(-1)?.index;
  if (Number.isInteger(lastSentenceEnd) && lastSentenceEnd + 1 >= Math.floor(max * 0.6)) {
    return head.slice(0, lastSentenceEnd + 1).trimEnd();
  }

  const wordSafe = head.replace(/\s+\S*$/, "").replace(/[,:;\-–—]+$/, "").trimEnd();
  return `${wordSafe || head.trimEnd()}…`;
}

function limitedString(value, max) {
  return truncateNewsletterCopy(value, max);
}

const DAY_CONTEXT_WORDS = [
  "today", "tonight", "day", "calendar", "lineup", "morning", "daytime", "afternoon", "evening",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];
const DAY_CONTEXT = `(?:this\\s+)?(?:the\\s+)?(?:${DAY_CONTEXT_WORDS.join("|")})`;
const DOWNBEAT_DAY_LANGUAGE = "(?:quiet|quieter|quietest|slow|slower|slowest|thin|thinner|thinnest|light|lighter|lightest|sparse|sparser|sparsest|sleepy|soft|weak)";

function newsletterCopyString(value, max) {
  const cleaned = rewriteAwkwardNewsletterLanguage(rewriteDownbeatDayLanguage(limitedString(value, max)));
  return hasBlockedNewsletterCopyLanguage(cleaned) ? "" : cleaned;
}

function rewriteDownbeatDayLanguage(value) {
  return String(value || "")
    .replace(
      new RegExp(`\\b(${DAY_CONTEXT})\\s+(?:looks|feels|seems|is|are|runs)\\s+(?:a\\s+little\\s+|pretty\\s+|comparatively\\s+|relatively\\s+|more\\s+|less\\s+)?${DOWNBEAT_DAY_LANGUAGE}\\b`, "gi"),
      (_match, period) => `${period} has useful options`
    )
    .replace(
      new RegExp(`\\b(${DAY_CONTEXT})\\s+has\\s+(?:a\\s+)?${DOWNBEAT_DAY_LANGUAGE}\\s+(?:feel|shape|stretch|window)\\b`, "gi"),
      (_match, period) => `${period} has useful options`
    );
}

function hasDownbeatDayLanguage(value) {
  const text = String(value || "");
  const dayThenTerm = new RegExp(`\\b${DAY_CONTEXT}\\b[^.!?]{0,80}\\b${DOWNBEAT_DAY_LANGUAGE}\\b`, "i");
  const termThenDay = new RegExp(`\\b${DOWNBEAT_DAY_LANGUAGE}\\s+${DAY_CONTEXT}\\b`, "i");
  return dayThenTerm.test(text) || termThenDay.test(text);
}

function rewriteAwkwardNewsletterLanguage(value) {
  return String(value || "")
    .replace(/\b(daytime|the day|today)\s+favors\s+practical use of time\b/gi, "today is good for practical errands and easy outings");
}

function hasBlockedNewsletterCopyLanguage(value) {
  const text = String(value || "");
  return hasDownbeatDayLanguage(text)
    || /\b(?:passing on|means passing|choosing it means|choose it means|skip(?:ping)? over)\b/i.test(text)
    || /\b(?:rather than stops on a route|as alternatives rather than|not a route|route defense)\b/i.test(text);
}

function compactText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Ask Claude to rewrite social copy as a newsletter blurb.
export async function rewriteForEmail(text, kind /* "plan" | "pick" */) {
  if (!text) return "";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing — add to .env.local");

  const SYSTEM = "You're an editor for South Bay Today, a hyperlocal Santa Clara County newsletter. Voice: smart, well-informed neighbor — direct, warm, never corporate. You take social copy and rewrite it for the morning email.";

  const guidance = kind === "pick"
    ? "This is the 'tonight's pick' blurb for a single event. 1-3 sentences. Email gets an image + a CTA button below the text, so don't say things like 'tap the link' or 'see below'."
    : "This is the 'plan for your day' blurb covering 5-8 stops. 2-4 sentences. Email gets an image of the schedule + a 'See the full plan' button below the text, so don't repeat the URL or say 'all linked here'.";

  const prompt = `${guidance}

Strip @-handles, hashtags, and trailing URL-dependent CTAs. Use natural place names ("Ridge Vineyards" not "@RidgeVineyards"). Keep specifics — venue names, times, what people will do. Read like a friend telling them what's on.

Original social copy:
"""
${text}
"""

Return ONLY the rewritten blurb, no quotes, no preamble.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content?.[0]?.text || "").trim().replace(/^["']|["']$/g, "");
}

function parseTimeMinutes(timeStr) {
  if (!timeStr) return 9999;
  const m = timeStr.match(/^(\d+)(?::(\d+))?\s*(am|pm)/i);
  if (!m) return 9999;
  let h = parseInt(m[1]);
  const min = m[2] ? parseInt(m[2]) : 0;
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h * 60 + min;
}

// ── HTML rendering ─────────────────────────────────────────────────────────

const PALETTE = {
  ink: "#1a1a2e",
  muted: "#5b6478",
  faint: "#9099a8",
  border: "#e4e6ee",
  bg: "#ffffff",
  card: "#f7f6fb",
  blue: "#3b4ef0",
  purple: "#7c3aed",
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CITY_LABEL = {
  "san-jose": "San Jose", "santa-clara": "Santa Clara", "sunnyvale": "Sunnyvale",
  "mountain-view": "Mountain View", "palo-alto": "Palo Alto", "cupertino": "Cupertino",
  "campbell": "Campbell", "los-gatos": "Los Gatos", "saratoga": "Saratoga",
  "los-altos": "Los Altos", "milpitas": "Milpitas", "morgan-hill": "Morgan Hill",
  "menlo-park": "Menlo Park", "gilroy": "Gilroy", "santa-clara-county": "Santa Clara County",
};
const cityName = (id) => CITY_LABEL[id] || (id || "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
function eventLocality(event) {
  return String(event?.locality || "").trim() || cityName(event?.city);
}

export function renderEmail(data) {
  const safeBriefing = sanitizeGeographicBriefing(data.editorial?.briefing, data.dayPlan);
  const safeDayPlanBlurb = sanitizeGeographicBriefing(data.dayPlanBlurb, data.dayPlan);
  const safeTonightPickBlurb = data.tonightPick
    ? sanitizeTonightPickBlurb(data.tonightPickBlurb, data.tonightPick) || buildTonightBlurb(data.tonightPick)
    : "";
  const safeData = safeBriefing === (data.editorial?.briefing || "")
      && safeDayPlanBlurb === (data.dayPlanBlurb || "")
      && safeTonightPickBlurb === (data.tonightPickBlurb || "")
    ? data
    : {
        ...data,
        dayPlanBlurb: safeDayPlanBlurb,
        tonightPickBlurb: safeTonightPickBlurb,
        editorial: { ...(data.editorial || {}), briefing: safeBriefing },
      };
  const subject = `South Bay Today — ${safeData.longDate}`;
  const html = wrapShell(subject, [
    headerBlock(safeData),
    weatherStrip(safeData.weather),
    leadImageBlock(safeData),
    briefingBlock(safeData.editorial?.briefing),
    dayPlanBlock(safeData.dayPlan, safeData.dayPlanBlurb, safeData.editorial),
    tonightPickBlock(safeData.tonightPick, safeData.tonightPickBlurb, safeData.visuals),
    eventsBlock(safeData.featuredEvents, safeData.todayEvents.length, safeData.editorial),
    openingsBlock(safeData.recentOpenings, safeData.date, safeData.editorial),
    meetingsBlock(safeData.civicMeetings),
    historyBlock(safeData.todayHistory),
    conversationBlock(safeData.redditPosts, safeData.editorial),
    footerBlock(),
  ].filter(Boolean).join("\n"), safeData);
  return { subject, html };
}

function wrapShell(subject, body, data = null) {
  const description = compactText(data?.editorial?.briefing || data?.dayPlanBlurb || "A morning South Bay briefing with the field guide, events, openings, civic notes, and local conversation.", 220);
  const image = data?.visuals?.archiveImage || "";
  const imageMeta = image
    ? `<meta property="og:image" content="${esc(image)}">
<meta name="twitter:image" content="${esc(image)}">`
    : "";
  const twitterCard = image ? "summary_large_image" : "summary";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(subject)}">
<meta property="og:description" content="${esc(description)}">
${imageMeta}
<meta property="og:site_name" content="South Bay Today">
<meta property="og:type" content="article">
<meta name="twitter:card" content="${twitterCard}">
<meta name="twitter:title" content="${esc(subject)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  /* Dark-mode overrides for clients that honor prefers-color-scheme (Apple Mail,
     iOS Mail, Outlook for Mac). Attribute selectors key off the exact PALETTE hex
     values used inline, so no per-section markup changes are needed; accent
     colors (blue #3b4ef0, purple #7c3aed) are intentionally left vibrant. Gmail
     and Outlook-Windows ignore <style> media queries and keep the light theme. */
  @media (prefers-color-scheme: dark) {
    [style*="background:#ffffff"] { background:#16161f !important; }
    [style*="background:#f7f6fb"] { background:#1f1f2b !important; }
    [style*="color:#1a1a2e"] { color:#ececf3 !important; }
    [style*="color:#5b6478"] { color:#aeb6c6 !important; }
    [style*="color:#9099a8"] { color:#8b93a4 !important; }
    [style*="#e4e6ee"] { border-color:#2e2e40 !important; }
    [style*="8px solid #f7f6fb"] { border-color:#1f1f2b !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PALETTE.card};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${PALETTE.ink};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(description)}</div>
<div style="max-width:620px;margin:0 auto;background:${PALETTE.bg};">
${body}
</div>
</body>
</html>`;
}

function headerBlock(data) {
  return `<div style="padding:24px 28px 14px 28px;border-bottom:1px solid ${PALETTE.border};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
    <tr>
      <td style="width:58px;vertical-align:middle;padding-right:14px;">
        <img src="${esc(BRAND_AVATAR_URL)}" alt="" width="54" height="54" style="width:54px;height:54px;border-radius:50%;display:block;border:2px solid #ffffff;">
      </td>
      <td style="vertical-align:middle;">
        <div style="font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:${PALETTE.purple};font-weight:700;">South Bay Today</div>
        <div style="font-size:22px;font-weight:700;margin-top:4px;color:${PALETTE.ink};">${esc(data.longDate)}</div>
      </td>
    </tr>
  </table>
</div>`;
}

function weatherStrip(w) {
  if (!w) return "";
  const rain = w.rainPct >= 30 ? ` · ${w.rainPct}% rain` : "";
  const cond = (w.dayDesc || "").toLowerCase();
  return `<div style="padding:14px 28px;background:${PALETTE.card};font-size:14px;color:${PALETTE.muted};">
  ${esc(w.emoji)} ${cond ? `${esc(cond)} · ` : ""}high <strong style="color:${PALETTE.ink};">${esc(w.high)}°</strong>, low ${esc(w.low)}°${rain}
</div>`;
}

function briefingBlock(briefing) {
  if (!briefing) return "";
  return `<div style="padding:22px 28px;border-bottom:1px solid ${PALETTE.border};">
  <div style="font-size:16px;line-height:1.6;color:${PALETTE.ink};">${esc(briefing)}</div>
</div>`;
}

function leadImageBlock(data) {
  const image = usableImage(data?.visuals?.dayPlanImage);
  if (!image) return "";
  const planUrl = data?.dayPlan?.planUrl || SITE_URL;
  const alt = data?.visuals?.dayPlanImageAlt || `South Bay Today field guide for ${data?.longDate || "today"}`;
  return `<div style="padding:22px 28px 0 28px;">
  <a href="${esc(planUrl)}" style="display:block;text-decoration:none;">
    <img src="${esc(image)}" alt="${esc(alt)}" width="564" style="width:100%;height:auto;display:block;border-radius:12px;border:1px solid ${PALETTE.border};">
  </a>
</div>`;
}

function dayPlanBlock(plan, blurb, editorial = null) {
  if (!plan) return "";
  const cards = orderedCards(plan);
  if (!cards.length) return "";
  const rows = cards.map(planCardRow).join("\n");
  const headline = editorial?.dayPlanHeadline || "Three standout picks for today";
  const cta = plan.planUrl
    ? `<a href="${esc(plan.planUrl)}" style="display:inline-block;background:${PALETTE.blue};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px;margin-top:18px;">Open the live guide →</a>`
    : "";
  return `<div style="padding:28px;">
  <div style="font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:${PALETTE.purple};font-weight:700;margin-bottom:8px;">Today's field guide</div>
  <div style="font-size:18px;font-weight:700;color:${PALETTE.ink};margin-bottom:8px;">${esc(headline)}</div>
  <div style="font-size:15px;line-height:1.6;color:${PALETTE.ink};margin-bottom:16px;">${esc(blurb)}</div>
  <table style="width:100%;border-collapse:collapse;"><tbody>${rows}</tbody></table>
  ${cta}
</div>`;
}

function tonightPickBlock(pick, blurb, visuals = null) {
  if (!pick) return "";
  const meta = eventMeta(pick);
  const ticketUrl = pick.url || null;
  const image = tonightPickEventImage(pick);
  const imageCreditLabel = pick.venue ? `${pick.venue} event page` : "Event page";
  const imageCredit = image && ticketUrl
    ? `<div style="font-size:11px;line-height:1.4;color:${PALETTE.faint};margin:6px 0 16px 0;">Image source: <a href="${esc(ticketUrl)}" style="color:${PALETTE.muted};text-decoration:underline;">${esc(imageCreditLabel)}</a></div>`
    : "";
  const imageHtml = image
    ? `<img src="${esc(image)}" alt="${esc(pick.imageAlt || visuals?.tonightPickImageAlt || pick.title)}" width="564" style="width:100%;height:auto;display:block;border-radius:10px;margin:0;border:1px solid ${PALETTE.border};">${imageCredit}`
    : "";
  const ctaLabel = pick.cost === "paid" ? "Get tickets →" : "Event details →";
  const cta = ticketUrl
    ? `<a href="${esc(ticketUrl)}" style="display:inline-block;background:${PALETTE.blue};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px;margin-top:14px;">${esc(ctaLabel)}</a>`
    : "";
  return `<div style="padding:0 28px 28px 28px;border-top:1px solid ${PALETTE.border};padding-top:28px;">
  ${imageHtml}
  <div style="font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:${PALETTE.purple};font-weight:700;margin-bottom:8px;">Tonight's pick</div>
  <div style="font-size:18px;font-weight:700;color:${PALETTE.ink};">${esc(pick.title)}</div>
  ${meta ? `<div style="font-size:13px;color:${PALETTE.muted};margin-top:4px;">${esc(meta)}</div>` : ""}
  <div style="font-size:15px;line-height:1.6;color:${PALETTE.ink};margin-top:12px;">${esc(blurb)}</div>
  ${cta}
</div>`;
}

const MEAL_BUCKETS = new Set(["breakfast", "lunch", "dinner"]);

/**
 * The price band a plan card may advertise.
 *
 * `cost` describes the door; `costNote` describes the bill. For a pillar those
 * are the same thing — a free farmers market or a free workshop costs nothing
 * to attend, so "Free" is honest. For a paired meal they are not: San Pedro
 * Square Market carries cost:"free" (the food hall is free to walk into) beside
 * costNote:"$15–30/person", and the 2026-08-11 issue printed "Dinner Nearby:
 * San Pedro Square Market — Dinner · San Jose · Free" for a paid dinner because
 * the door flag outranked the bill. On a meal card only the bill may speak; if
 * no band is known the segment is omitted rather than guessed.
 */
export function planCardPriceBand(card) {
  const band = card?.costNote || card?.kidsCostNote || null;
  if (card?.role === "paired-meal" || MEAL_BUCKETS.has(card?.bucket)) return band;
  return card?.cost === "free" ? "Free" : band;
}

function planCardRow(card) {
  const bucketLabel = BUCKET_LABEL[card.bucket] || card.timeBlock || "Idea";
  const label = card.role === "pillar"
    ? `${bucketLabel} pick`
    : card.role === "paired-meal"
      ? `${bucketLabel} nearby`
      : bucketLabel;
  const name = card.url || card.mapsUrl
    ? `<a href="${esc(card.url || card.mapsUrl)}" style="color:${PALETTE.ink};text-decoration:none;font-weight:700;">${esc(card.name)}</a>`
    : `<span style="color:${PALETTE.ink};font-weight:700;">${esc(card.name)}</span>`;
  const meta = [
    card.eventTime || card.timeBlock,
    card.venue,
    card.city ? cityName(card.city) : null,
    planCardPriceBand(card),
  ].filter(Boolean).join(" · ");
  const blurb = card.blurb
    ? `<div style="font-size:13px;color:${PALETTE.muted};line-height:1.45;margin-top:3px;">${esc(card.blurb)}</div>`
    : "";
  return `<tr>
    <td width="92" style="padding:10px 12px 10px 0;border-bottom:1px solid ${PALETTE.border};vertical-align:top;">
      <div style="font-size:12px;color:${PALETTE.faint};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;">${esc(label)}</div>
    </td>
    <td style="padding:10px 0;border-bottom:1px solid ${PALETTE.border};vertical-align:top;">
      <div style="font-size:15px;line-height:1.35;">${name}</div>
      ${meta ? `<div style="font-size:13px;color:${PALETTE.muted};margin-top:3px;">${esc(meta)}</div>` : ""}
      ${blurb}
    </td>
  </tr>`;
}

function eventMeta(e) {
  // A virtual event says "Virtual" and drops the city. The venue stays as the
  // host, but the locality is the part that reads as "go here" — printing
  // "San Jose State University · San Jose" for an online-only meeting is the
  // exact claim that made the 2026-08-05 issue wrong.
  const virtual = isVirtualEvent(e);
  // "Free" without "Appointment required" is how the Aug 12 2026 issue made
  // Palo Alto's Vintage Media Lab read as a walk-up afternoon. The gate is the
  // single most decision-relevant fact about a listing, so it prints in the
  // same slot as Virtual, ahead of the venue.
  return [
    e.time,
    virtual ? "Virtual" : null,
    registrationLabel(e) || null,
    e.venue,
    virtual ? null : eventLocality(e),
    e.cost === "free" ? "Free" : null,
  ].filter(Boolean).join(" · ");
}

function chronologicalEvents(events) {
  return [...(events || [])].sort((a, b) => {
    const timeDelta = parseTimeMinutes(a.time) - parseTimeMinutes(b.time);
    if (timeDelta) return timeDelta;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

function newsletterSectionHeading(value, fallback) {
  const clean = compactText(value, 80);
  const comparable = clean.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!clean || comparable === "on the calendar" || comparable === "also also on the calendar") return fallback;
  if (comparable === "newly open") return "Newly opened";
  return clean;
}

function eventsBlock(events, totalCount = events?.length || 0, editorial = null) {
  if (!events?.length) return "";
  const displayEvents = chronologicalEvents(events);
  const rows = displayEvents.map((e) => {
    const image = resolveImageUrl(e, 144, 144);
    const thumb = image
      ? `<td width="72" style="padding:10px 12px 10px 0;border-bottom:1px solid ${PALETTE.border};vertical-align:top;">
          <img src="${esc(image)}" alt="" width="72" height="72" style="width:72px;height:72px;display:block;border-radius:8px;object-fit:cover;">
        </td>`
      : "";
    const title = e.url
      ? `<a href="${esc(e.url)}" style="color:${PALETTE.ink};text-decoration:none;font-weight:600;">${esc(e.title)}</a>`
      : `<span style="color:${PALETTE.ink};font-weight:600;">${esc(e.title)}</span>`;
    const meta = eventMeta(e);
    const blurb = e.blurb
      ? `<div style="font-size:13px;color:${PALETTE.muted};line-height:1.45;margin-top:3px;">${esc(e.blurb)}</div>`
      : "";
    // No image → span both columns so text fills the row instead of being crammed
    // into the 72px image column (the shared table is sized by the rows that DO have images).
    return `<tr>${thumb}<td${image ? "" : ' colspan="2"'} style="padding:10px 0;border-bottom:1px solid ${PALETTE.border};vertical-align:top;">
      <div>${title}</div>
      ${meta ? `<div style="font-size:13px;color:${PALETTE.muted};margin-top:2px;">${esc(meta)}</div>` : ""}
      ${blurb}
    </td></tr>`;
  }).join("\n");
  const heading = newsletterSectionHeading(editorial?.eventsHeading, "Also on the calendar");
  const countNote = editorial?.eventsNote || (totalCount > events.length
    ? `The site has ${totalCount} timed events for today; these are the ones most likely to be useful.`
    : "A short list of timed events worth checking before you make plans.");
  return `<div style="padding:28px;border-top:8px solid ${PALETTE.card};">
  <div style="font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:${PALETTE.purple};font-weight:700;margin-bottom:6px;">${esc(heading)}</div>
  <div style="font-size:13px;color:${PALETTE.muted};line-height:1.45;margin-bottom:12px;">${esc(countNote)} <a href="https://southbaytoday.org/#events" style="color:${PALETTE.blue};text-decoration:none;">Open the full calendar →</a></div>
  <table style="width:100%;border-collapse:collapse;"><tbody>${rows}</tbody></table>
</div>`;
}

function openingsBlock(openings, date, editorial = null) {
  const freshOpenings = (openings || []).filter((o) => isFreshOpening(o, date));
  if (!freshOpenings.length) return "";
  const items = freshOpenings.map((o) => {
    const cityId = (o.cityId || o.cityName || "").toLowerCase().replace(/ /g, "-");
    const locParts = [o.address, cityName(cityId)].filter(Boolean);
    const loc = locParts.length ? ` <span style="color:${PALETTE.muted};">— ${esc(locParts.join(", "))}</span>` : "";
    const age = openingAge(o.date, date);
    const blurb = o.blurb ? `<div style="font-size:13px;color:${PALETTE.muted};line-height:1.45;margin-top:2px;">${esc(o.blurb)}</div>` : "";
    const image = resolveImageUrl(o, 116, 116);
    const thumb = image
      ? `<td width="58" style="padding:0 12px 12px 0;vertical-align:top;"><img src="${esc(image)}" alt="" width="58" height="58" style="width:58px;height:58px;display:block;border-radius:8px;object-fit:cover;"></td>`
      : "";
    return `<table style="width:100%;border-collapse:collapse;margin-bottom:10px;"><tbody><tr>
      ${thumb}
      <td style="vertical-align:top;padding:0 0 12px 0;">
        <div style="font-size:15px;color:${PALETTE.ink};"><strong>${esc(o.name)}</strong>${loc}</div>
        ${age ? `<div style="font-size:12px;color:${PALETTE.faint};margin-top:2px;">${esc(age)}</div>` : ""}
        ${blurb}
      </td>
    </tr></tbody></table>`;
  }).join("");
  const heading = newsletterSectionHeading(editorial?.openingsHeading, "Newly opened");
  const note = editorial?.openingsNote
    ? `<div style="font-size:13px;color:${PALETTE.muted};line-height:1.45;margin-bottom:12px;">${esc(editorial.openingsNote)}</div>`
    : "";
  return `<div style="padding:28px;border-top:8px solid ${PALETTE.card};">
  <div style="font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:${PALETTE.purple};font-weight:700;margin-bottom:6px;">${esc(heading)}</div>
  ${note}
  ${items}
</div>`;
}

function openingAge(openedDate, todayDate) {
  const days = daysBetween(openedDate, todayDate);
  if (!Number.isFinite(days)) return "";
  if (days === 0) return "Opened today";
  if (days === 1) return "Opened yesterday";
  return `Opened ${days} days ago`;
}

// "Tonight" is a promise about the clock, so only an evening start may claim it.
// The 2026-08-11 issue filed San José's 1:30 PM council meeting (over before
// dinner) and Milpitas's 4:00 PM special meeting under "Civic Meetings
// Tonight". Afternoon council business is still worth surfacing, so the section
// keeps every meeting and steps the heading down to "today" instead.
const EVENING_START_MINUTES = 17 * 60; // 5:00 PM
const CLOSED_SESSION_LABEL = "Closed session, not open to the public";

// A sitting whose posted hour was a closed session, moved forward by
// resolvePublicStart to the first block a reader can attend. Naming the closed
// hour keeps the email honest about why the time it prints isn't the one on the
// city's calendar page.
function closedSessionPrefaceLabel(meeting) {
  const closed = formatMeetingTime(meeting?.closedSessionStart);
  return closed ? `Closed session from ${closed}` : null;
}

export function meetingStartsInEvening(meeting) {
  const minutes = meetingClockMinutes(meeting?.startTime);
  return minutes !== null && minutes >= EVENING_START_MINUTES;
}

/** An unknown start time can't be vouched for, so it reads as "today" too. */
export function civicMeetingsHeading(meetings) {
  if (!meetings?.length) return "";
  return meetings.every((m) => meetingStartsInEvening(m))
    ? "Civic meetings tonight"
    : "Civic meetings today";
}

// Print the start time so a reader can tell a 1:30 PM sitting from a 7 PM one,
// and say plainly when a meeting is closed. Cupertino's 2026-08-11 item was a
// "Non-Televised Special Meeting Closed Session" published as a plain council
// meeting in Conference Room C — nothing a reader could attend or watch.
function civicMeetingDetail(meeting) {
  return [
    formatMeetingTime(meeting?.startTime),
    meeting?.location,
    meeting?.closedSession ? CLOSED_SESSION_LABEL : closedSessionPrefaceLabel(meeting),
  ].filter(Boolean).join(" · ");
}

function meetingsBlock(meetings) {
  if (!meetings?.length) return "";
  const rows = meetings.map((m) => {
    const link = m.url ? `<a href="${esc(m.url)}" style="color:${PALETTE.blue};text-decoration:none;">${esc(m.bodyName || "Meeting")}</a>` : esc(m.bodyName || "Meeting");
    const detail = civicMeetingDetail(m);
    return `<div style="font-size:14px;margin-bottom:6px;"><strong>${esc(cityName(m.city))}</strong> — ${link}${detail ? ` <span style="color:${PALETTE.muted};">· ${esc(detail)}</span>` : ""}</div>`;
  }).join("");
  return `<div style="padding:28px;border-top:8px solid ${PALETTE.card};">
  <div style="font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:${PALETTE.purple};font-weight:700;margin-bottom:14px;">${esc(civicMeetingsHeading(meetings))}</div>
  ${rows}
</div>`;
}

function historyBlock(history) {
  if (!history?.length) return "";
  const items = history.map((h) => {
    const link = h.url ? `<a href="${esc(h.url)}" style="color:${PALETTE.blue};text-decoration:none;">${esc(h.company)}</a>` : esc(h.company);
    return `<div style="margin-bottom:10px;">
      <div style="font-weight:600;">${link} <span style="color:${PALETTE.muted};font-weight:400;">· ${esc(h.foundedYear)} · ${esc(h.city)}</span></div>
      <div style="font-size:14px;color:${PALETTE.ink};line-height:1.5;margin-top:2px;">${esc(h.anniversaryNote || h.tagline)}</div>
    </div>`;
  }).join("");
  return `<div style="padding:28px;border-top:8px solid ${PALETTE.card};">
  <div style="font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:${PALETTE.purple};font-weight:700;margin-bottom:14px;">On this day in Silicon Valley</div>
  ${items}
</div>`;
}

function conversationBlock(posts, editorial = null) {
  if (!posts?.length) return "";
  const items = posts.map((p) => {
    const title = p.displayTitle || p.title || "";
    const sub = p.sub ? `r/${p.sub}` : "";
    const meta = [
      sub,
      p.score ? `↑ ${p.score}` : null,
      p.numComments ? `💬 ${p.numComments}` : null,
    ].filter(Boolean).join(" · ");
    const thumb = p.image
      ? `<img src="${esc(p.image)}" alt="" width="64" height="64" style="width:64px;height:64px;display:block;border-radius:6px;object-fit:cover;">`
      : "";
    const titleHtml = p.permalink
      ? `<a href="${esc(p.permalink)}" style="color:${PALETTE.ink};text-decoration:none;font-weight:600;line-height:1.4;">${esc(title)}</a>`
      : `<span style="color:${PALETTE.ink};font-weight:600;line-height:1.4;">${esc(title)}</span>`;
    const summary = p.summary
      ? `<div style="font-size:13px;color:${PALETTE.muted};line-height:1.45;margin-top:3px;">${esc(p.summary)}</div>`
      : "";
    return `<tr>
      <td width="64" style="padding:10px 0;border-bottom:1px solid ${PALETTE.border};vertical-align:top;">${thumb}</td>
      <td style="padding:10px 0 10px 12px;border-bottom:1px solid ${PALETTE.border};vertical-align:top;">
        <div>${titleHtml}</div>
        ${summary}
        <div style="font-size:12px;color:${PALETTE.faint};margin-top:4px;letter-spacing:0.3px;">${esc(meta)}</div>
      </td>
    </tr>`;
  }).join("\n");
  const heading = editorial?.conversationHeading || "The Conversation";
  const note = editorial?.conversationNote || "What people are talking about across the South Bay (via Reddit).";
  return `<div style="padding:28px;border-top:8px solid ${PALETTE.card};">
  <div style="font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:${PALETTE.purple};font-weight:700;margin-bottom:6px;">${esc(heading)}</div>
  <div style="font-size:13px;color:${PALETTE.muted};margin-bottom:14px;">${esc(note)}</div>
  <table style="width:100%;border-collapse:collapse;"><tbody>${items}</tbody></table>
</div>`;
}

function footerBlock() {
  return `<div style="padding:28px;border-top:8px solid ${PALETTE.card};font-size:14px;color:${PALETTE.muted};line-height:1.6;">
  <p style="margin:0 0 10px 0;">Thanks for letting us into your morning ☀️</p>
  <p style="margin:0 0 10px 0;">If you spot something we missed—a new restaurant, a great event, a story worth telling—just hit reply. I read everything.</p>
  <p style="margin:14px 0 0 0;color:${PALETTE.ink};">- Stephen Stanwood</p>
  <p style="margin:18px 0 0 0;font-size:12px;color:${PALETTE.faint};">South Bay Today · <a href="https://southbaytoday.org" style="color:${PALETTE.faint};">southbaytoday.org</a> · <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:${PALETTE.faint};">unsubscribe</a></p>
</div>`;
}

// ── Discord DM + self-improvement loop ─────────────────────────────────────

export async function publishNewsletterArchive(data, html) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN missing for newsletter HTML archive");

  const { del, put } = await import("@vercel/blob");
  const pathname = `newsletters/${data.date}.html`;

  try {
    await del(pathname, { token });
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (!/not.?found|404|BlobNotFoundError/i.test(msg)) throw err;
  }

  await put(pathname, archiveNewsletterHtml(html), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "text/html; charset=utf-8",
    token,
    cacheControlMaxAge: 0,
  });
  return newsletterArchiveUrl(data.date);
}

function newsletterArchiveUrl(date) {
  return `${SITE_URL}${NEWSLETTER_ARCHIVE_PREFIX}/${date}`;
}

export async function sendNewsletterDiscordDm(data, subject, archiveUrl = null) {
  const content = renderDiscordDm(data, subject, archiveUrl);
  await sendDiscordDmChunks(content);
}

export async function recordNewsletterSend({ data, subject, broadcastId = null, archiveUrl = null }) {
  const sentAt = new Date().toISOString();
  appendFileSync(NEWSLETTER_HISTORY_FILE, JSON.stringify({
    sentAt,
    date: data.date,
    subject,
    broadcastId,
    archiveUrl,
    editorialMeta: data.editorialMeta,
    selections: newsletterSelectionSnapshot(data),
  }) + "\n");

  try {
    await reflectOnNewsletter({ data, subject, sentAt });
  } catch (err) {
    console.warn(`editorial reflection failed: ${err.message}`);
  }
}

function archiveNewsletterHtml(html) {
  return String(html || "")
    .replace(
      /<a href="\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}"[^>]*>unsubscribe<\/a>/gi,
      "unsubscribe from the email"
    )
    .replace(/\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/g, "https://southbaytoday.org");
}

function renderDiscordDm(data, subject, archiveUrl) {
  const lines = [`📬 **${subject}**`];
  const blurb = newsletterDmBlurb(data);
  if (blurb) lines.push("", blurb);
  if (archiveUrl) lines.push("", `Full email: ${archiveUrl}`);
  return lines.join("\n");
}

function newsletterDmBlurb(data) {
  const drafted = data.editorial?.briefing || data.dayPlanBlurb || "";
  if (drafted) return compactText(drafted, 900);

  const bits = [];
  if (data.dayPlan?.cards?.length) {
    const cities = [...new Set(orderedCards(data.dayPlan).map((c) => cityName(c.city)).filter(Boolean))].slice(0, 3);
    bits.push(`Today's field guide has ${data.dayPlan.cards.length} stops${cities.length ? ` around ${humanList(cities)}` : ""}.`);
  }
  if (data.tonightPick) {
    bits.push(`Tonight's pick is ${data.tonightPick.title}${data.tonightPick.time ? ` at ${data.tonightPick.time}` : ""}.`);
  }
  if (data.featuredEvents?.length) {
    const totalEvents = data.todayEvents?.length || data.featuredEvents.length;
    bits.push(`${totalEvents} timed events are on the board, led by ${humanList(data.featuredEvents.slice(0, 3).map((e) => e.title))}.`);
  }
  const freshOpenings = (data.recentOpenings || []).filter((o) => isFreshOpening(o, data.date));
  if (freshOpenings.length) {
    bits.push(`Food radar has ${humanList(freshOpenings.slice(0, 2).map((o) => o.name))}.`);
  }

  return compactText(bits.join(" ") || "Today's South Bay Today email is ready, with the field guide, events, openings, civic notes, and local conversation.", 900);
}

function renderDiscordDigest(data, subject) {
  const lines = [`📬 **${subject}**`];
  if (data.editorial?.briefing) lines.push("", data.editorial.briefing);
  if (data.weather) {
    lines.push("", `**Weather:** high ${data.weather.high}°, low ${data.weather.low}°, ${String(data.weather.dayDesc || "").toLowerCase()}.`);
  }
  if (data.dayPlan?.cards?.length) {
    lines.push("", `**${data.editorial?.dayPlanHeadline || "Today's field guide"}**`);
    if (data.dayPlanBlurb) lines.push(data.dayPlanBlurb);
    for (const c of orderedCards(data.dayPlan).slice(0, 6)) {
      const meta = [c.eventTime || c.timeBlock, c.venue, c.city ? cityName(c.city) : null].filter(Boolean).join(" · ");
      lines.push(`• ${markdownLink(c.name, c.url || c.mapsUrl)}${meta ? ` — ${meta}` : ""}`);
    }
  }
  if (data.tonightPick) {
    lines.push("", `**Tonight:** ${markdownLink(data.tonightPick.title, data.tonightPick.url)}`);
    const meta = eventMeta(data.tonightPick);
    if (meta) lines.push(meta);
    if (data.tonightPickBlurb) lines.push(data.tonightPickBlurb);
  }
  if (data.featuredEvents?.length) {
    lines.push("", `**${newsletterSectionHeading(data.editorial?.eventsHeading, "Also on the calendar")}**`);
    if (data.editorial?.eventsNote) lines.push(data.editorial.eventsNote);
    for (const e of chronologicalEvents(data.featuredEvents)) {
      const meta = eventMeta(e);
      lines.push(`• ${markdownLink(e.title, e.url)}${meta ? ` — ${meta}` : ""}`);
    }
  }
  const freshOpenings = (data.recentOpenings || []).filter((o) => isFreshOpening(o, data.date));
  if (freshOpenings.length) {
    lines.push("", `**${newsletterSectionHeading(data.editorial?.openingsHeading, "Newly opened")}**`);
    if (data.editorial?.openingsNote) lines.push(data.editorial.openingsNote);
    for (const o of freshOpenings.slice(0, 5)) {
      lines.push(`• ${o.name}${o.cityName ? ` — ${o.cityName}` : ""}${o.blurb ? `: ${o.blurb}` : ""}`);
    }
  }
  if (data.civicMeetings?.length) {
    lines.push("", `**${civicMeetingsHeading(data.civicMeetings)}**`);
    for (const m of data.civicMeetings) {
      const detail = civicMeetingDetail(m);
      lines.push(`• ${cityName(m.city)} — ${m.bodyName || "Meeting"}${detail ? ` · ${detail}` : ""}`);
    }
  }
  if (data.todayHistory?.length) {
    lines.push("", "**On this day in Silicon Valley**");
    for (const h of data.todayHistory) lines.push(`• ${h.company} (${h.foundedYear}, ${h.city}): ${h.anniversaryNote || h.tagline}`);
  }
  if (data.redditPosts?.length) {
    lines.push("", `**${data.editorial?.conversationHeading || "The Conversation"}**`);
    if (data.editorial?.conversationNote) lines.push(data.editorial.conversationNote);
    for (const p of data.redditPosts) {
      const meta = [p.sub ? `r/${p.sub}` : null, p.numComments ? `${p.numComments} comments` : null].filter(Boolean).join(" · ");
      lines.push(`• ${markdownLink(p.displayTitle || p.title, p.permalink)}${meta ? ` — ${meta}` : ""}`);
    }
  }
  lines.push("", "https://southbaytoday.org");
  return lines.join("\n");
}

function newsletterSelectionSnapshot(data) {
  return {
    briefing: data.editorial?.briefing || "",
    dayPlan: orderedCards(data.dayPlan).map((c) => c.name),
    tonightPick: data.tonightPick?.title || null,
    tonightPickVenue: data.tonightPick?.venue || null,
    featuredEvents: chronologicalEvents(data.featuredEvents || []).map((e) => e.title),
    featuredEventVenues: chronologicalEvents(data.featuredEvents || []).map((e) => e.venue || ""),
    openings: (data.recentOpenings || []).filter((o) => isFreshOpening(o, data.date)).map((o) => o.name),
    meetings: (data.civicMeetings || []).map((m) => `${cityName(m.city)} ${m.bodyName || "Meeting"}`),
    history: (data.todayHistory || []).map((h) => h.company),
    reddit: (data.redditPosts || []).map((p) => p.displayTitle || p.title),
  };
}

async function reflectOnNewsletter({ data, subject, sentAt }) {
  const prompt = `You are improving South Bay Today's daily newsletter generator.

Read the newsletter that just went out. Give a concise editorial critique that will make TOMORROW'S newsletter better.

Return JSON only:
{
  "score": 1-10,
  "keepDoing": ["specific thing to preserve"],
  "improveNext": ["specific instruction for tomorrow's editor pass"],
  "avoid": ["pattern to avoid"],
  "guidance": ["short reusable rule for future prompt memory"],
  "dataDefects": [{ "area": "duplicate|url|cost|time|title|venue|image|civic|other", "detail": "what is wrong in the underlying record", "example": "the exact event/title/value that shows it" }]
}

Be specific. Do not praise generic structure. Focus on selection quality, local usefulness, awkward copy, repetition, over/under-indexing family events, and whether the email feels like a real morning briefing.

Sort every criticism into the right bucket, because they go to different places:
- "guidance" = something TOMORROW'S EDITOR can fix by writing or selecting differently from the same data. Wording, ordering, tone, what to lead with, what to cut.
- "dataDefects" = something WRONG IN THE SOURCE RECORD that no amount of editing can fix — the same event ingested twice under different titles, a start time or price that contradicts the venue's own page, a primary link that is a bare registration form or shortener instead of an event page, a garbled scraped title, a missing cost field.

This split matters: a data defect filed as guidance just tells the editor to keep papering over it, and it will be back tomorrow. Put it in "dataDefects" so it reaches the pipeline that owns it. Leave "dataDefects" empty when the underlying data was clean — do not invent entries to fill it.

NEWSLETTER:
${renderDiscordDigest(data, subject)}
`;
  const { raw } = await callClaudeNewsletterEditor(prompt);
  const reflection = parseClaudeJson(raw);
  saveNewsletterReflection({ reflection, data, subject, sentAt });
}

function saveNewsletterReflection({ reflection, data, subject, sentAt }) {
  const current = loadNewsletterEditorialMemory() || { guidance: [], reflections: [] };
  const entry = {
    date: data.date,
    subject,
    sentAt,
    score: numberInRange(reflection.score, 1, 10),
    keepDoing: stringArray(reflection.keepDoing, 4, 180),
    improveNext: stringArray(reflection.improveNext, 6, 220),
    avoid: stringArray(reflection.avoid, 6, 180),
  };
  // Dedupe before capping: recurring critiques (chains, raw titles) used to
  // pile up as near-identical rephrasings, crowding the 10-item prompt window
  // with one lesson stated ten ways. Latest phrasing wins.
  const guidanceCandidates = [
    ...(current.guidance || []),
    ...stringArray(reflection.guidance, 8, 220),
    ...entry.improveNext,
  ];
  const seenGuidance = new Set();
  const guidance = [];
  for (const g of guidanceCandidates.reverse()) {
    const key = normalizeComparable(g).split(/\s+/).slice(0, 8).join(" ");
    if (!key || seenGuidance.has(key)) continue;
    seenGuidance.add(key);
    guidance.unshift(g);
  }
  const output = {
    _meta: { updatedAt: new Date().toISOString(), generator: "newsletter self-reflection" },
    guidance: guidance.slice(-24),
    dataDefects: mergeDataDefects(current.dataDefects, reflection.dataDefects, data.date),
    reflections: [...(current.reflections || []), entry].slice(-30),
  };
  writeFileAtomic(NEWSLETTER_MEMORY_FILE, JSON.stringify(output, null, 2) + "\n");
}

// Areas map to the pipeline stage that owns the fix. Anything the editor
// labels outside this set lands in "other" rather than being dropped —
// a mislabelled real defect is still worth surfacing.
const DATA_DEFECT_AREAS = new Set([
  "duplicate", "url", "cost", "time", "title", "venue", "image", "civic", "other",
]);

/** Stable id for a defect row. */
export function dataDefectKey(defect) {
  const words = normalizeComparable(defect.detail || "").split(/\s+/).filter(Boolean);
  return `${defect.area}:${words.slice(0, 8).join(" ")}`;
}

function defectWords(detail) {
  return new Set(
    normalizeComparable(detail || "").split(/\s+/).filter((w) => w.length >= 4),
  );
}

/**
 * Does this new defect describe the same problem as an existing row?
 *
 * A prefix key alone is too brittle here: the editor re-derives its findings
 * from scratch each morning, so the same defect comes back reworded ("…once
 * from the ticketing feed" vs "…the venue calendar and a ticket vendor").
 * A prefix match files those as two one-offs, which is precisely the signal
 * we're trying to measure — content-word overlap survives the rephrasing.
 */
function isSameDefect(a, b) {
  if (a.area !== b.area) return false;
  const wa = defectWords(a.detail);
  const wb = defectWords(b.detail);
  // Require enough substance on both sides that overlap means something —
  // two three-word complaints shouldn't fuse on a single shared noun.
  if (wa.size < 4 || wb.size < 4) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  // Overlap coefficient, not jaccard: the two phrasings routinely differ in
  // length ("…once from the ticketing feed" vs "…the venue calendar and a
  // ticket vendor"), and jaccard penalises the extra trailing detail hard
  // enough that a clear repeat scores 0.47 and reads as a new defect.
  return inter / Math.min(wa.size, wb.size) >= 0.6;
}

/**
 * Fold today's editor-reported data defects into the running ledger.
 *
 * Recurrence is the whole point: a defect the editor names once may be a
 * one-off bad record, but one it names six mornings running is a pipeline
 * that isn't fixing it. `count` + `firstSeen` are what make that visible —
 * previously every recurrence was just re-phrased guidance telling the
 * editor to keep working around it.
 */
export function mergeDataDefects(existing, incoming, date) {
  const byKey = new Map();
  for (const d of Array.isArray(existing) ? existing : []) {
    if (d && d.key) byKey.set(d.key, { ...d });
  }
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (!raw || typeof raw !== "object") continue;
    const detail = String(raw.detail || "").trim().slice(0, 220);
    if (!detail) continue;
    const area = DATA_DEFECT_AREAS.has(String(raw.area || "").toLowerCase())
      ? String(raw.area).toLowerCase()
      : "other";
    const defect = { area, detail };
    // Exact key first, then a content-overlap match against existing rows so
    // a reworded repeat bumps the original instead of opening a second row.
    let key = dataDefectKey(defect);
    let prior = byKey.get(key);
    if (!prior) {
      for (const candidate of byKey.values()) {
        if (isSameDefect(candidate, defect)) { prior = candidate; key = candidate.key; break; }
      }
    }
    byKey.set(key, {
      key,
      area,
      // Latest phrasing wins — it describes the most recent occurrence.
      detail,
      example: String(raw.example || "").trim().slice(0, 180) || prior?.example || "",
      firstSeen: prior?.firstSeen || date,
      lastSeen: date,
      count: (prior?.count || 0) + 1,
    });
  }
  // Most recently seen first; the tail is stale one-offs from fixed issues.
  return [...byKey.values()]
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)) || b.count - a.count)
    .slice(0, 40);
}

// Deliberately NOT fed back into the editor's prompt window (see
// newsletterMemoryForPrompt). The editor must re-derive defects from what it
// actually sees each morning — if we handed it yesterday's list it would echo
// them back and `count` would measure our own prompt, not whether the
// pipeline still ships the defect.
export function loadNewsletterDataDefects() {
  const memory = loadNewsletterEditorialMemory();
  return Array.isArray(memory?.dataDefects) ? memory.dataDefects : [];
}

/**
 * Render open data defects for the newsletter job's stdout. The 2pm
 * daily-digest sweep relays each task's final output verbatim, so printing
 * here is what actually carries these into the triage channel instead of
 * leaving them in a gitignored file nobody opens.
 *
 * Returns "" when there is nothing worth escalating, so a clean run stays quiet.
 */
export function formatDataDefectEscalation(defects, { recurringThreshold = 3, staleDays = 14, today = null } = {}) {
  const open = (defects || []).filter((d) => d && d.detail);
  if (!open.length) return "";
  // Age out defects nobody has seen recently — the pipeline likely fixed them.
  // An entry with no lastSeen is kept rather than aged out: mergeDataDefects
  // always sets it, so a missing one means something is wrong and hiding it
  // is worse than showing it.
  const fresh = today
    ? open.filter((d) => !d.lastSeen || daysBetween(d.lastSeen, today) <= staleDays)
    : open;
  if (!fresh.length) return "";

  const recurring = fresh.filter((d) => (d.count || 0) >= recurringThreshold);
  const lines = [];
  lines.push(`newsletter data defects: ${fresh.length} open, ${recurring.length} recurring (seen ${recurringThreshold}+ mornings)`);
  const describe = (d) => {
    const span = d.firstSeen && d.firstSeen !== d.lastSeen ? ` since ${d.firstSeen}` : "";
    const eg = d.example ? ` — e.g. ${d.example}` : "";
    return `  [${d.area}] ×${d.count || 1}${span}: ${d.detail}${eg}`;
  };
  if (recurring.length) {
    lines.push("RECURRING — the editor keeps working around these; the fix belongs upstream:");
    for (const d of recurring) lines.push(describe(d));
  }
  const oneOffs = fresh.filter((d) => (d.count || 0) < recurringThreshold);
  if (oneOffs.length) {
    lines.push(`New/one-off (${oneOffs.length}):`);
    for (const d of oneOffs.slice(0, 10)) lines.push(describe(d));
  }
  return lines.join("\n");
}

function numberInRange(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function stringArray(value, limit, maxLen) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => limitedString(v, maxLen))
    .filter(Boolean)
    .slice(0, limit);
}

function markdownLink(label, url) {
  const clean = escapeMarkdown(label || "");
  if (!url) return clean;
  return `[${clean}](${url})`;
}

function escapeMarkdown(s) {
  return String(s || "").replace(/([\\`*_{}[\]()#+.!|>~-])/g, "\\$1");
}

function resolveDiscordBotToken() {
  try {
    const txt = readFileSync(join(homedir(), ".claude/channels/discord/.env"), "utf8");
    const match = txt.match(/DISCORD_BOT_TOKEN\s*=\s*"?([^"\n]+)"?/);
    if (match) return match[1].trim();
  } catch {}
  return process.env.CAT_SIGNAL_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || null;
}

async function sendDiscordDmChunks(content) {
  const token = resolveDiscordBotToken();
  const channel = process.env.DISCORD_DM_CHANNEL || process.env.STEPHEN_DM_CHANNEL_ID || "1486102002474811524";
  if (!token) throw new Error("DISCORD_BOT_TOKEN missing for newsletter DM");
  const chunks = splitDiscordMessage(content, 1850);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : "";
    const res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: `${prefix}${chunks[i]}`.slice(0, 1990) }),
    });
    if (!res.ok) {
      throw new Error(`Discord DM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }
}

function splitDiscordMessage(content, maxLen) {
  const chunks = [];
  let cur = "";
  for (const para of String(content || "").split("\n")) {
    const next = cur ? `${cur}\n${para}` : para;
    if (next.length <= maxLen) {
      cur = next;
    } else {
      if (cur) chunks.push(cur);
      cur = para.length > maxLen ? para.slice(0, maxLen) : para;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ── Newsletter config (audience id stored locally) ─────────────────────────

export const CONFIG_PATH = join(DATA_DIR, "newsletter-config.json");

export function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}

export const FROM_ADDRESS = "The South Bay Today <stephen@southbaytoday.org>";
export const REPLY_TO = "stephen@stanwood.dev";
