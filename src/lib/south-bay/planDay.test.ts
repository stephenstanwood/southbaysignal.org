// Minimal test harness for plan-day's pure helpers + bucket logic.
// Run: npm run test:plan-day

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseHour, fallbackBlurb, isMealVenueCandidate, scoreCandidates, buildCandidatePool } from "../../pages/api/plan-day.ts";
import { cleanDisplayCopy, cleanDisplayName } from "./displayText.mjs";
import { canonicalizeCard } from "./canonicalizeCard.mjs";
import { mealOpenForService } from "./mealService.mjs";
import {
  audienceBreadthPenalty,
  REGIONAL_ROUTINE_PENALTY_CUTOFF,
  requiresChildToAttend,
  routineEventPenalty,
  titleQualityPenalty,
  UNPROMPTED_AUDIENCE_PENALTY_CUTOFF,
} from "./editorialQuality.mjs";
import {
  bucketForHour,
  bucketForEvent,
  bucketOrderIndex,
  isBucket,
  BUCKET_ORDER,
  BUCKET_PASSED_AFTER_HOUR,
} from "./buckets.ts";
import {
  MEAL_PAIR_MAX_MILES,
  dayPlanPairingIssues,
  dominantPillarCity,
  filterAtomicPairCards,
  isWithinQualityBand,
  mealBrandKey,
  rankNearbyMeals,
} from "./dayPlanPairs.ts";

test("September 6 library constraints hold in the real planner pool", () => {
  for (const kids of [false, true]) {
    const pool = buildCandidatePool("san-jose", kids, new Set(), "2026-09-06");
    assert.equal(pool.some((c) => c.id === "event:sjpl-6a7bc1324cb69d003e203e28"), false,
      "unresolved ticket timing cannot become an afternoon pillar");
    if (kids) assert.equal(pool.some((c) => c.id === "event:cbdd438d7fbe"), false,
      "Adults audience cannot enter a kids plan");
  }
});

test("parseHour: AM/PM", () => {
  assert.equal(parseHour("9:00 AM"), 9);
  assert.equal(parseHour("12:00 AM"), 0);
  assert.equal(parseHour("12:00 PM"), 12);
  assert.equal(parseHour("7:30 PM"), 19);
  assert.equal(parseHour("11:45 PM"), 23);
});

test("parseHour: 24h", () => {
  assert.equal(parseHour("09:00"), 9);
  assert.equal(parseHour("23:15"), 23);
});

test("parseHour: unparseable", () => {
  assert.equal(parseHour("TBD"), null);
  assert.equal(parseHour("all day"), null);
  assert.equal(parseHour(""), null);
});

test("bucketForHour: activity slots", () => {
  assert.equal(bucketForHour(8), "morning");
  assert.equal(bucketForHour(11), "morning");
  assert.equal(bucketForHour(14), "afternoon");
  assert.equal(bucketForHour(18), "evening");
  assert.equal(bucketForHour(22), "evening");
});

test("bucketForHour: meal slots", () => {
  assert.equal(bucketForHour(8, "meal"), "breakfast");
  assert.equal(bucketForHour(12, "meal"), "lunch");
  assert.equal(bucketForHour(19, "meal"), "dinner");
});

test("bucketForEvent: 7 PM food event → dinner", () => {
  assert.equal(bucketForEvent("7:00 PM", "food"), "dinner");
});

test("bucketForEvent: 7 PM concert → evening", () => {
  assert.equal(bucketForEvent("7:00 PM", "music"), "evening");
});

test("bucketForEvent: 11 AM workshop → morning", () => {
  assert.equal(bucketForEvent("11:00 AM", "events"), "morning");
});

test("bucketForEvent: unparseable time → null", () => {
  assert.equal(bucketForEvent("TBD", "food"), null);
  assert.equal(bucketForEvent(null, "food"), null);
});

test("bucketOrderIndex: canonical order", () => {
  for (let i = 0; i < BUCKET_ORDER.length; i++) {
    assert.equal(bucketOrderIndex(BUCKET_ORDER[i]), i);
  }
});

test("activity and meal pairs age out together", () => {
  assert.equal(BUCKET_PASSED_AFTER_HOUR.morning, BUCKET_PASSED_AFTER_HOUR.breakfast);
  assert.equal(BUCKET_PASSED_AFTER_HOUR.afternoon, BUCKET_PASSED_AFTER_HOUR.lunch);
  assert.equal(BUCKET_PASSED_AFTER_HOUR.evening, BUCKET_PASSED_AFTER_HOUR.dinner);
});

test("isBucket: validates", () => {
  assert.equal(isBucket("breakfast"), true);
  assert.equal(isBucket("morning"), true);
  assert.equal(isBucket("evening"), true);
  assert.equal(isBucket("midnight"), false);
  assert.equal(isBucket(""), false);
  assert.equal(isBucket(null), false);
});

test("fallbackBlurb: deterministic per-name", () => {
  const a1 = fallbackBlurb("event", "food", "Taco Festival", null);
  const a2 = fallbackBlurb("event", "food", "Taco Festival", null);
  assert.equal(a1, a2, "same name → same blurb every render");
});

test("fallbackBlurb: different names can differ", () => {
  const names = ["A", "B", "C", "D", "E", "F", "G"].map((n) =>
    fallbackBlurb("event", "music", `Show ${n}`, null),
  );
  assert.ok(new Set(names).size >= 2, "deterministic but varied");
});

test("fallbackBlurb: unknown category falls to events pool", () => {
  const out = fallbackBlurb("event", "space-travel-jamboree", "Rocket Night", null);
  assert.ok(out.length > 0);
  assert.ok(!out.includes("swing by"), "never the 'swing by X' anti-pattern");
});

test("fallbackBlurb: place + known category", () => {
  const out = fallbackBlurb("place", "food", "Luna Mexican Kitchen", null);
  assert.ok(out.length > 0);
  assert.ok(!out.startsWith("Quick stop"), "specific category should not hit last-ditch");
});

test("fallbackBlurb: truly unknown source/category → last ditch", () => {
  const out = fallbackBlurb("place", "__missing__", "Test Place", null);
  assert.ok(out.length > 0);
});

test("editorial quality signals penalize scraped and routine listings, not normal hyphens", () => {
  assert.equal(titleQualityPenalty("Trail Clean-Up"), 0);
  assert.ok(titleQualityPenalty("Concert | Ticket Portal") > 0);
  assert.ok(routineEventPenalty({ title: "Planning Commission Meeting" }) >= 40);
  assert.ok(routineEventPenalty({ title: "Leisure Noon Origami" }) >= REGIONAL_ROUTINE_PENALTY_CUTOFF);
  assert.ok(routineEventPenalty({ title: "Spin the Wheel at Pearl Branch Library!" }) >= REGIONAL_ROUTINE_PENALTY_CUTOFF);
  assert.ok(routineEventPenalty({ title: "Live Music" }) >= REGIONAL_ROUTINE_PENALTY_CUTOFF);
  assert.ok(routineEventPenalty({ title: "One Night of Queen" }) === 0);
});

test("affiliation-limited offers cannot become unprompted top picks", () => {
  const csuNight = {
    title: "Bay FC CSU Night",
    description: "Join other Spartans for CSU Alumni Night with a reserved ticket section.",
    blurb: "Watch Bay FC as a CSU alumnus in a reserved section at PayPal Park.",
  };
  assert.ok(audienceBreadthPenalty(csuNight) >= UNPROMPTED_AUDIENCE_PENALTY_CUTOFF);
  assert.ok(audienceBreadthPenalty({ title: "Members Only Museum Preview" }) >= UNPROMPTED_AUDIENCE_PENALTY_CUTOFF);
  assert.ok(audienceBreadthPenalty({
    title: "Celebrating Legacy, Impact, and Service",
    blurb: "Hear speakers celebrate a sorority chapter's 65 years of service.",
  }) >= UNPROMPTED_AUDIENCE_PENALTY_CUTOFF);
  assert.ok(audienceBreadthPenalty({
    title: "Recent Grad Mixer",
    blurb: "Meet fellow recent grads and build your alumni network.",
  }) >= UNPROMPTED_AUDIENCE_PENALTY_CUTOFF);
  assert.equal(audienceBreadthPenalty({
    title: "Bay FC vs. Houston Dash",
    description: "Bay FC hosts Houston at PayPal Park.",
  }), 0);
  assert.equal(audienceBreadthPenalty({
    title: "Public talk with SJSU alumnus Jane Doe",
    description: "Everyone is welcome to hear a local engineer speak.",
  }), 0);
});

test("editorial choice cannot override a material deterministic quality gap", () => {
  assert.equal(isWithinQualityBand(72, 80, 10), true);
  assert.equal(isWithinQualityBand(69, 80, 10), false);
});

test("adult mode detects mislabeled caregiver-and-child programming", () => {
  assert.equal(requiresChildToAttend({ title: "Baby Wearing Dance", description: "For adult caregivers and pre-walking babies." }), true);
  assert.equal(requiresChildToAttend({ title: "One Night of Queen" }), false);
});

test("kid-friendly events receive one kids boost, not two", () => {
  const candidate = {
    id: "event:test",
    name: "Family Concert",
    category: "family",
    city: "campbell",
    address: "",
    lat: 37.28,
    lng: -121.95,
    locationPrecision: "exact" as const,
    source: "event" as const,
    eventDate: "2026-07-19",
    eventTime: "6:00 PM",
    kidFriendly: true,
    routinePenalty: 0,
    score: 0,
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const adultScore = scoreCandidates([{ ...candidate }], null, false, undefined, undefined, "2026-07-19")[0].score;
    const kidsScore = scoreCandidates([{ ...candidate }], null, true, undefined, undefined, "2026-07-19")[0].score;
    assert.equal(kidsScore - adultScore, 15);
  } finally {
    Math.random = originalRandom;
  }
});

test("meal venue guard excludes grocery stores and mislabeled business centers", () => {
  assert.equal(isMealVenueCandidate({ types: ["supermarket", "grocery_store", "food"], primaryType: "supermarket", displayType: "Asian grocery store", curated: false, address: "" }), false);
  assert.equal(isMealVenueCandidate({ types: ["business_center", "point_of_interest"], primaryType: "business_center", displayType: "Business center", curated: false, address: "" }), false);
  assert.equal(isMealVenueCandidate({ types: ["barbecue_restaurant", "restaurant"], primaryType: "barbecue_restaurant", displayType: "Barbecue restaurant", curated: true, address: "" }), true);
  assert.equal(isMealVenueCandidate({ types: ["cafe", "food"], primaryType: "cafe", displayType: "Cafe", curated: false, address: "" }), true);
});

test("meal venue guard uses primary business type and the requested service", () => {
  assert.equal(isMealVenueCandidate({ types: ["catering_service", "coffee_shop", "cafe", "bakery"], primaryType: "catering_service", displayType: "Caterer", curated: false, address: "123 Main St" }, "breakfast"), false);
  assert.equal(isMealVenueCandidate({ types: ["pastry_shop", "bakery", "food_store"], primaryType: "pastry_shop", displayType: "Pastry shop", curated: false, address: "168 Echo Ave Apt 1" }, "breakfast"), false);
  assert.equal(isMealVenueCandidate({ types: ["cafe", "food"], primaryType: "cafe", displayType: "Cafe", curated: false, address: "123 Main St" }, "dinner"), false);
  assert.equal(isMealVenueCandidate({ types: ["brunch_restaurant", "restaurant"], primaryType: "brunch_restaurant", displayType: "Brunch restaurant", curated: false, address: "123 Main St" }, "breakfast"), true);
  assert.equal(isMealVenueCandidate({ types: ["austrian_restaurant", "restaurant"], primaryType: "austrian_restaurant", displayType: "Austrian restaurant", curated: false, address: "123 Main St" }, "dinner"), true);
});

test("breakfast requires an explicit breakfast-service signal", () => {
  const fatima = {
    types: ["halal_restaurant", "grocery_store", "food_store", "restaurant"],
    primaryType: "halal_restaurant",
    displayType: "Halal restaurant",
    curated: false,
    address: "805 Scott Blvd, Santa Clara, CA",
    bestSlots: [],
  };
  assert.equal(isMealVenueCandidate(fatima, "breakfast"), false);
  assert.equal(isMealVenueCandidate(fatima, "lunch"), true);
  assert.equal(isMealVenueCandidate({ ...fatima, bestSlots: ["breakfast"] }, "breakfast"), true);
});

test("breakfast hours must cover the service anchor", () => {
  assert.equal(mealOpenForService({ wed: "10:00-21:00" }, "wed", "breakfast"), false);
  assert.equal(mealOpenForService({ wed: "09:00-21:00" }, "wed", "breakfast"), true);
});

test("display cleanup: strips CJK/Hangul translation fragments from names", () => {
  assert.equal(cleanDisplayName("世界生活館 Amazing Books & Gifts"), "Amazing Books & Gifts");
  assert.equal(cleanDisplayName("Paik's Noodle / 홍콩반점 산호세"), "Paik's Noodle");
  assert.equal(cleanDisplayName("Sizzling Pot House (鼎香砂锅馆)"), "Sizzling Pot House");
});

test("display cleanup: capitalizes proper adjectives in blurbs", () => {
  assert.equal(
    cleanDisplayCopy("Cupertino taiwanese restaurant on Stevens Creek Blvd, $$ sit-down."),
    "Cupertino Taiwanese restaurant on Stevens Creek Blvd, $$ sit-down.",
  );
  assert.equal(
    cleanDisplayCopy("More at https://example.com/taiwanese-food before taiwanese lunch."),
    "More at https://example.com/taiwanese-food before Taiwanese lunch.",
  );
});

test("meal pairing: quality wins inside the radius, distance enforces the ceiling", () => {
  const pillar = { lat: 37, lng: -122 };
  const ranked = rankNearbyMeals(pillar, [
    {
      id: "generic-close",
      lat: 37.006,
      lng: -122,
      rating: 4.4,
      ratingCount: 1_000,
      foodDistinctiveness: 0,
    },
    {
      id: "new-distinctive",
      lat: 37.035,
      lng: -122,
      rating: 4.7,
      ratingCount: 500,
      foodDistinctiveness: 9,
      newlyOpened: true,
      blurb: "A specific source-backed description long enough to earn the copy signal.",
    },
    {
      id: "too-far",
      lat: 37.1,
      lng: -122,
      rating: 5,
      ratingCount: 5_000,
      foodDistinctiveness: 12,
      newlyOpened: true,
    },
  ]);

  assert.equal(ranked[0].candidate.id, "new-distinctive");
  assert.ok(ranked[0].distanceMiles < MEAL_PAIR_MAX_MILES);
  assert.equal(ranked.some((entry) => entry.candidate.id === "too-far"), false);
});

test("meal pairing penalizes a chain against an equivalent independent", () => {
  const pillar = { lat: 37, lng: -122 };
  const ranked = rankNearbyMeals(pillar, [
    { id: "interesting-chain", lat: 37.01, lng: -122, rating: 4.7, ratingCount: 900, foodDistinctiveness: 9, isChain: true, chainLocations: 8 },
    { id: "independent", lat: 37.01, lng: -122, rating: 4.7, ratingCount: 900, foodDistinctiveness: 9 },
  ]);
  assert.equal(ranked[0].candidate.id, "independent");
});

test("meal brand identity collapses different branches of the same restaurant", () => {
  assert.equal(
    mealBrandKey("Oren's Hummus - Cupertino", "cupertino-id"),
    mealBrandKey("Oren's Hummus - Mountain View", "mountain-view-id"),
  );
  assert.notEqual(mealBrandKey("Oren's Hummus"), mealBrandKey("Dishdash"));
});

test("pillar-pairs validator accepts three reciprocal meal/activity pairs", () => {
  const cards = [
    { id: "breakfast", bucket: "breakfast" as const, role: "paired-meal" as const, pairedWithId: "morning", pairDistanceMiles: 1.2, pairLocationPrecision: "exact" as const, city: "campbell" },
    { id: "morning", bucket: "morning" as const, role: "pillar" as const, pairedWithId: "breakfast", city: "campbell" },
    { id: "lunch", bucket: "lunch" as const, role: "paired-meal" as const, pairedWithId: "afternoon", pairDistanceMiles: 3.1, pairLocationPrecision: "venue" as const, city: "palo-alto" },
    { id: "afternoon", bucket: "afternoon" as const, role: "pillar" as const, pairedWithId: "lunch", city: "palo-alto" },
    { id: "dinner", bucket: "dinner" as const, role: "paired-meal" as const, pairedWithId: "evening", pairDistanceMiles: 4.9, pairLocationPrecision: "exact" as const, city: "san-jose" },
    { id: "evening", bucket: "evening" as const, role: "pillar" as const, pairedWithId: "dinner", city: "san-jose" },
  ];
  assert.deepEqual(dayPlanPairingIssues(cards), []);
  assert.equal(dominantPillarCity(cards, "campbell"), "campbell", "three-way tie follows daypart order");
});

test("pillar-pairs validator catches broken links and arbitrary driving", () => {
  const issues = dayPlanPairingIssues([
    { id: "breakfast", bucket: "breakfast", role: "paired-meal", pairedWithId: "wrong", pairDistanceMiles: 7, pairLocationPrecision: "city" },
    { id: "morning", bucket: "morning", role: "pillar", pairedWithId: "breakfast" },
  ]);
  assert.ok(issues.some((issue) => issue.includes("breakfast does not point")));
  assert.ok(issues.some((issue) => issue.includes("7.0 miles")));
  assert.ok(issues.some((issue) => issue.includes("not venue-resolved")));
  assert.ok(issues.some((issue) => issue.includes("missing afternoon pillar")));
  assert.ok(issues.some((issue) => issue.includes("missing evening pillar")));
});

test("pillar-pairs validator rejects repeated restaurant brands across branches", () => {
  const cards = [
    { id: "meal:breakfast", name: "Oren's Hummus - Cupertino", bucket: "breakfast" as const, role: "paired-meal" as const, pairedWithId: "pillar:morning", pairDistanceMiles: 1, pairLocationPrecision: "exact" as const },
    { id: "pillar:morning", name: "Morning", bucket: "morning" as const, role: "pillar" as const, pairedWithId: "meal:breakfast" },
    { id: "meal:lunch", name: "Lunch Place", bucket: "lunch" as const, role: "paired-meal" as const, pairedWithId: "pillar:afternoon", pairDistanceMiles: 1, pairLocationPrecision: "exact" as const },
    { id: "pillar:afternoon", name: "Afternoon", bucket: "afternoon" as const, role: "pillar" as const, pairedWithId: "meal:lunch" },
    { id: "meal:dinner", name: "Oren's Hummus - Mountain View", bucket: "dinner" as const, role: "paired-meal" as const, pairedWithId: "pillar:evening", pairDistanceMiles: 1, pairLocationPrecision: "exact" as const },
    { id: "pillar:evening", name: "Evening", bucket: "evening" as const, role: "pillar" as const, pairedWithId: "meal:dinner" },
  ];
  assert.ok(dayPlanPairingIssues(cards).some((issue) => issue.includes("duplicate meal brand")));
});

test("atomic pair filtering removes a stale activity and its meal", () => {
  const cards = [
    { id: "activity", bucket: "morning" as const, role: "pillar" as const, pairedWithId: "meal" },
    { id: "meal", bucket: "breakfast" as const, role: "paired-meal" as const, pairedWithId: "activity", pairDistanceMiles: 1 },
    { id: "afternoon", bucket: "afternoon" as const, role: "pillar" as const, pairedWithId: "lunch" },
    { id: "lunch", bucket: "lunch" as const, role: "paired-meal" as const, pairedWithId: "afternoon", pairDistanceMiles: 1 },
  ];
  assert.deepEqual(
    filterAtomicPairCards(cards, new Set(["activity"])).map((card) => card.id),
    ["afternoon", "lunch"],
  );
});

test("shared-plan canonicalization preserves pair and chain-interest metadata", () => {
  const card = canonicalizeCard({
    id: "meal",
    name: "Interesting Chain",
    category: "food",
    city: "campbell",
    bucket: "breakfast",
    role: "paired-meal",
    pairedWithId: "activity",
    pairDistanceMiles: 1.2,
    pairLocationPrecision: "exact",
    interestingChain: true,
    chainInterestReasons: ["verified new opening"],
  });
  assert.equal(card.pairedWithId, "activity");
  assert.equal(card.pairLocationPrecision, "exact");
  assert.equal(card.interestingChain, true);
  assert.deepEqual(card.chainInterestReasons, ["verified new opening"]);
});
