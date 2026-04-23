// ---------------------------------------------------------------------------
// South Bay Signal — Central Path Configuration
// ---------------------------------------------------------------------------
// Single source of truth for all file paths used by generators and social ops.
// Import this instead of constructing paths ad-hoc in each script.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Repo root (two levels up from scripts/lib/)
export const REPO_ROOT = join(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Content roots
// ---------------------------------------------------------------------------

/** Generated + curated data consumed by the Astro build */
export const DATA_DIR = join(REPO_ROOT, "src", "data", "south-bay");

/** Public static assets */
export const PUBLIC_DIR = join(REPO_ROOT, "public");

// ---------------------------------------------------------------------------
// Generated artifact paths (committed to git, consumed by the build)
// ---------------------------------------------------------------------------

export const ARTIFACTS = {
  events:           join(DATA_DIR, "upcoming-events.json"),
  meetings:         join(DATA_DIR, "upcoming-meetings.json"),
  digests:          join(DATA_DIR, "digests.json"),
  cityBriefings:    join(DATA_DIR, "city-briefings.json"),
  aroundTown:       join(DATA_DIR, "around-town.json"),
  permits:          join(DATA_DIR, "permit-pulse.json"),
  healthScores:     join(DATA_DIR, "health-scores.json"),
  restaurantRadar:  join(DATA_DIR, "restaurant-radar.json"),
  foodOpenings:     join(DATA_DIR, "scc-food-openings.json"),
  realEstate:       join(DATA_DIR, "real-estate.json"),
  airQuality:       join(DATA_DIR, "air-quality.json"),
  outages:          join(DATA_DIR, "outages.json"),
  techBriefing:     join(DATA_DIR, "tech-briefing.json"),
  weekendPicks:     join(DATA_DIR, "weekend-picks.json"),
  springBreakPicks: join(DATA_DIR, "spring-break-picks.json"),
  apod:             join(DATA_DIR, "apod.json"),
  photos:           join(DATA_DIR, "photos.json"),
  curatedPhotos:    join(DATA_DIR, "curated-photos.json"),
  shortUrls:        join(DATA_DIR, "short-urls.json"),
  schoolCalendar:   join(DATA_DIR, "school-calendar.json"),
  places:           join(DATA_DIR, "places.json"),
  playwrightEvents: join(DATA_DIR, "playwright-events.json"),
  defaultPlans:     join(DATA_DIR, "default-plans.json"),
};

// ---------------------------------------------------------------------------
// Runtime state paths (gitignored, mutable, only exist on the Mini)
// ---------------------------------------------------------------------------

export const RUNTIME = {
  approvedQueue:    join(DATA_DIR, "social-approved-queue.json"),
  reviewHistory:    join(DATA_DIR, "social-review-history.json"),
  actionLog:        join(DATA_DIR, "social-action-log.json"),
  analytics:        join(DATA_DIR, "social-analytics.json"),
  postHistory:      join(DATA_DIR, "social-post-history.json"),
  blacklist:        join(DATA_DIR, "social-blacklist.json"),
  replies:          join(DATA_DIR, "social-replies.json"),
  recraftFeedback:  join(DATA_DIR, "recraft-feedback.json"),
  devStatusCache:   join(DATA_DIR, ".dev-status-cache.json"),
};

// ---------------------------------------------------------------------------
// Temp / transient
// ---------------------------------------------------------------------------

export const TEMP = {
  socialCards: "/tmp/sbs-social-cards",
  watchdogLog: "/tmp/sbs-watchdog.log",
};

// ---------------------------------------------------------------------------
// Generator metadata helper
// ---------------------------------------------------------------------------

/**
 * Standard metadata block for generated artifacts.
 * Every generator should include this at the top level of its JSON output.
 */
export function generatorMeta(generatorName, { sourceCount, sources, warnings } = {}) {
  const meta = {
    _meta: {
      generatedAt: new Date().toISOString(),
      generator: generatorName,
    },
  };
  if (sourceCount !== undefined) meta._meta.sourceCount = sourceCount;
  if (sources) meta._meta.sources = sources;
  if (warnings?.length) meta._meta.warnings = warnings;
  return meta._meta;
}
