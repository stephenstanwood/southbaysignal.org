// Infer kidFriendly + indoorOutdoor tags for a place from its Google Places
// types, primary type, category, name, and price. Used by generate-places.mjs
// on every pass so new places are usable in kids plans without waiting on a
// curated backfill, and by autotag-places.mjs to fill gaps in the existing
// pool.
//
// Key design rule: many places have `bar` or `restaurant` in their
// secondary `types` array (a cinema with a lobby bar, a restaurant with
// a bar counter). Secondary type matches can't be treated as authoritative
// or we end up labeling "Pruneyard Cinemas" and every restaurant as not-
// kid-friendly. We only treat strongly-adult signals as hard negatives;
// ambiguous ones (plain "bar") only count when they're the PRIMARY type.

// Unambiguous adult-only when present anywhere in types. Keep this list
// tight — anything noisy (plain "bar", "wine_bar") goes in PRIMARY_NEGATIVE
// because Italian restaurants, cinemas, and family BBQs routinely have
// "wine_bar" or "bar" as a secondary type.
const STRONG_NEGATIVE_TYPES = new Set([
  "night_club",
  "nightclub",
  "casino",
  "strip_club",
  "adult_entertainment_store",
  "adult_entertainment",
  "cannabis_store",
  "smoke_shop",
  "tobacco_shop",
  "cigar_bar",
  "hookah_bar",
  "shooting_range",
  "gun_range",
  "firearms_retailer",
]);

// Adult-leaning, but only flag when they're the primary type. Secondary
// occurrence is noisy (cinemas + restaurants have these in the list).
const PRIMARY_NEGATIVE_TYPES = new Set([
  "bar",
  "sports_bar",
  "pub",
  "lounge_bar",
  "wine_bar",
  "cocktail_bar",
  "brewery",
  "beer_garden",
  "winery",
  "tattoo_parlor",
  "tattoo_shop",
  "pawn_shop",
  "nail_salon",
  "beauty_salon",
  "hair_salon",
  "barber_shop",
  "day_spa",
  "spa",
  "wellness_center",
  "yoga_studio",
  "liquor_store",
  "dispensary",
]);

// Kid-positive when either primary or anywhere in the types list.
const KID_POSITIVE_TYPES = new Set([
  "amusement_park",
  "amusement_center",
  "aquarium",
  "zoo",
  "botanical_garden",
  "library",
  "public_library",
  "park",
  "public_park",
  "national_park",
  "state_park",
  "playground",
  "bowling_alley",
  "ice_skating_rink",
  "skating_rink",
  "roller_skating_rink",
  "miniature_golf_course",
  "water_park",
  "trampoline_park",
  "children_museum",
  "childrens_museum",
  "movie_theater",
  "cinema",
  "museum",
  "art_gallery",
  "farm",
  "ranch",
]);

// Name-based kid-positive. Kept tight — "discovery" and "family" trigger
// false positives (thrift shops, community resource centers) with almost no
// recall value because real kid venues already hit on positive types.
const KID_POSITIVE_NAME = /\b(kids?|children'?s?|junior|petting|mini.?golf|playground|funplex|playland|bouncing|trampoline|splash\s*pad|story\s*time|storytime)\b/i;
// Name-based hard no. Only strong signals — no plain "bar" which lives in
// "Bar Cugino" or "Bar Harbor" style names that might be kid-ok.
const KID_NEGATIVE_NAME = /\b(winery|brewery|brewhouse|tap\s*room|taproom|cocktail\s*lounge|nightclub|night\s*club|21\+|adults?\s*only|cannabis|dispensary|smoke\s*shop|tobacco|hookah|cigar|firearm|gun\s*range|tattoo|massage\b|\bspa\b|waxing|lashes)\b/i;

const OUTDOOR_TYPES = new Set([
  "park",
  "public_park",
  "national_park",
  "state_park",
  "hiking_area",
  "trail_head",
  "dog_park",
  "beach",
  "garden",
  "botanical_garden",
  "zoo",
  "amusement_park",
  "water_park",
  "stadium",
  "sports_complex",
  "golf_course",
  "ski_resort",
  "campground",
  "farm",
  "ranch",
  "vineyard",
  "playground",
  "skate_park",
]);

const INDOOR_TYPES = new Set([
  "museum",
  "art_gallery",
  "library",
  "public_library",
  "movie_theater",
  "cinema",
  "bowling_alley",
  "casino",
  "restaurant",
  "cafe",
  "bar",
  "bakery",
  "store",
  "shopping_mall",
  "clothing_store",
  "book_store",
  "grocery_store",
  "supermarket",
  "gym",
  "fitness_center",
  "yoga_studio",
  "spa",
  "nail_salon",
  "beauty_salon",
  "hair_salon",
  "performing_arts_theater",
  "concert_hall",
  "escape_room",
  "children_museum",
  "childrens_museum",
  "ice_skating_rink",
  "skating_rink",
  "trampoline_park",
  "roller_skating_rink",
  "night_club",
  "nightclub",
]);

const OUTDOOR_NAME = /\b(park|trail|creek|preserve|lake|reservoir|beach|gardens?|plaza|farm|ranch|orchard|open\s*space|overlook|trailhead)\b/i;

function types(place) {
  const out = [];
  if (Array.isArray(place.types)) out.push(...place.types);
  return out.map((t) => (t || "").toString().toLowerCase());
}

function primary(place) {
  return (place.primaryType || "").toString().toLowerCase();
}

/** Return kidFriendly guess: true / false / null (unknown). Never overrides
 *  an already-set non-null value — the caller applies only when nullish. */
export function inferKidFriendly(place) {
  const t = types(place);
  const p = primary(place);
  const name = place.name || "";

  if (t.some((x) => STRONG_NEGATIVE_TYPES.has(x))) return false;
  if (p && PRIMARY_NEGATIVE_TYPES.has(p)) return false;
  if (place.category === "wellness") return false;
  if (KID_NEGATIVE_NAME.test(name)) return false;

  if (p && KID_POSITIVE_TYPES.has(p)) return true;
  if (KID_POSITIVE_NAME.test(name)) return true;
  if (t.some((x) => KID_POSITIVE_TYPES.has(x)) && place.category === "outdoor") return true;

  return null;
}

/** Return indoorOutdoor guess: 'indoor' / 'outdoor' / null. */
export function inferIndoorOutdoor(place) {
  const t = types(place);
  const p = primary(place);
  const name = place.name || "";

  if (p && OUTDOOR_TYPES.has(p)) return "outdoor";
  if (t.some((x) => OUTDOOR_TYPES.has(x))) return "outdoor";
  if (OUTDOOR_NAME.test(name) && !t.some((x) => INDOOR_TYPES.has(x))) return "outdoor";
  if (p && INDOOR_TYPES.has(p)) return "indoor";
  if (t.some((x) => INDOOR_TYPES.has(x))) return "indoor";

  if (place.category === "outdoor") return "outdoor";
  if (place.category === "museum") return "indoor";

  return null;
}

/** Apply both inferences to a place in-place. Never overwrites a non-null
 *  value — curated POIs and anything previously human-set stay authoritative.
 *  Returns { kidFriendlyChanged, indoorOutdoorChanged } for stats. */
export function autotagPlace(place) {
  let kfChanged = false;
  let ioChanged = false;

  if (place.kidFriendly === null || place.kidFriendly === undefined) {
    const guess = inferKidFriendly(place);
    if (guess !== null) {
      place.kidFriendly = guess;
      kfChanged = true;
    }
  }

  if (!place.indoorOutdoor) {
    const guess = inferIndoorOutdoor(place);
    if (guess) {
      place.indoorOutdoor = guess;
      ioChanged = true;
    }
  }

  return { kidFriendlyChanged: kfChanged, indoorOutdoorChanged: ioChanged };
}
