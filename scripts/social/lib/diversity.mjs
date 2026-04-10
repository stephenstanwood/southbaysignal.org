// ---------------------------------------------------------------------------
// South Bay Signal — Diversity Constraints
// Ensures post selections aren't dominated by one city/category/venue
// ---------------------------------------------------------------------------

import { DIVERSITY } from "./constants.mjs";

/**
 * Select top items while respecting diversity constraints.
 * Input must be pre-sorted by score descending.
 *
 * @param {Array} candidates - Scored candidates, sorted by score desc
 * @param {number} targetCount - How many items to select
 * @param {object} [opts] - Override diversity settings
 * @returns {Array} Selected items respecting diversity
 */
export function diverseSelect(candidates, targetCount, opts = {}) {
  // Scale diversity caps with targetCount so bigger batches get looser limits.
  // For targetCount=25 this yields maxCity=6, maxCat=7 — enough breathing room
  // to actually fill the batch without being dominated by one city/category.
  const maxCity = opts.maxSameCity ?? Math.max(DIVERSITY.maxSameCity, Math.ceil(targetCount / 4));
  const maxCat = opts.maxSameCategory ?? Math.max(DIVERSITY.maxSameCategory, Math.ceil(targetCount / 3.5));
  const minCities = opts.minUniqueCities ?? DIVERSITY.minUniqueCities;

  const maxSource = opts.maxSameSource ?? DIVERSITY.maxSameSource ?? Math.max(2, Math.ceil(targetCount * 0.3));
  // Cap per-day to force date spread. Default: ceil(target/7) + 1 so 20 posts → ~4/day max.
  const maxPerDay = opts.maxPerDay ?? Math.max(2, Math.ceil(targetCount / 7) + 1);

  const selected = [];
  const cityCounts = {};
  const catCounts = {};
  const sourceCounts = {};
  const dayCounts = {};
  const venuesSeen = new Set();

  for (const item of candidates) {
    if (selected.length >= targetCount) break;

    const city = item.city || "unknown";
    const cat = item.category || "other";
    const venue = (item.venue || "").toLowerCase();
    const source = (item.source || "unknown").toLowerCase();
    const day = item.date || "undated";

    // Check city cap
    if ((cityCounts[city] || 0) >= maxCity) continue;

    // Check category cap
    if ((catCounts[cat] || 0) >= maxCat) continue;

    // Check source cap (prevents Meetup or any single source from dominating)
    if ((sourceCounts[source] || 0) >= maxSource) continue;

    // Check per-day cap (spreads posts across days 2-14)
    if ((dayCounts[day] || 0) >= maxPerDay) continue;

    // Skip duplicate venues
    if (venue && venue.length > 3 && venuesSeen.has(venue)) continue;

    selected.push(item);
    cityCounts[city] = (cityCounts[city] || 0) + 1;
    catCounts[cat] = (catCounts[cat] || 0) + 1;
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    dayCounts[day] = (dayCounts[day] || 0) + 1;
    if (venue) venuesSeen.add(venue);
  }

  // If we haven't met minimum city diversity, try swapping
  const uniqueCities = new Set(selected.map((s) => s.city).filter(Boolean));
  if (uniqueCities.size < minCities && selected.length >= minCities) {
    // Find candidates from underrepresented cities
    const usedCities = uniqueCities;
    const alternatives = candidates.filter(
      (c) => c.city && !usedCities.has(c.city) && !selected.includes(c)
    );

    if (alternatives.length > 0) {
      // Replace the lowest-scored item with the best alternative
      const alt = alternatives[0];
      selected[selected.length - 1] = alt;
    }
  }

  return selected;
}
