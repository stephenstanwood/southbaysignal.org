import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEditorialPrompt,
  buildEditorialPacket,
  civicMeetingsHeading,
  planCardPriceBand,
  renderEmail,
  finalizeNewsletterImages,
  repairNewsletterProperNames,
  formatLongDate,
  isEventFeedFreshForNewsletter,
  isTonightPickCandidate,
  makeNewsletterPlan,
  sanitizeDayPlanBlurb,
  sanitizeGeographicBriefing,
  sanitizeTonightPickBlurb,
  selectDefaultPlan,
  todayPT,
  truncateNewsletterCopy,
  mergeDataDefects,
  dataDefectKey,
  formatDataDefectEscalation,
} from "./lib.mjs";

const BLOCKED_UNSPLASH = "https://images.unsplash.com/photo-1585899873671-ade0aa28a821?crop=entropy&w=400";

test("newsletter editor prompt forbids unsupported multi-day ordinal claims", () => {
  const prompt = buildEditorialPrompt({ todayEvents: [] });
  assert.match(prompt, /A prior preview still counts as a day of the event/);
  assert.match(prompt, /say "first public day" only when the packet explicitly supports it/);
  assert.match(prompt, /never turn that into "first day"/);
});

test("newsletter copy truncation never cuts a word in half", () => {
  const note = "Civic stakes lead the week, plus practical threads on car-free VTA life and getting through a heatwave without central AC.";
  const truncated = truncateNewsletterCopy(note, 90);

  assert.equal(truncated, "Civic stakes lead the week, plus practical threads on car-free VTA life and getting…");
  assert.ok(truncated.length <= 90);
});

test("newsletter preheader ends at a sentence instead of cutting the briefing mid-thought", () => {
  const briefing = "Tonight is a pick-your-show night: two stadium-scale concerts both start at 7, with a late stand-up set downtown if you want a second act. The daytime side leans free and hands-on, mostly at the libraries. Forecast is a high of 80 with a 26% chance of rain, so know your indoor fallback before committing to the outdoor picks.";
  const { html } = renderEmail({
    date: "2026-08-28",
    longDate: "Friday, August 28, 2026",
    weather: null,
    dayPlan: null,
    dayPlanBlurb: "",
    tonightPick: null,
    tonightPickBlurb: "",
    todayEvents: [], featuredEvents: [], recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
    visuals: {}, editorial: { briefing },
  });

  assert.match(html, /<meta name="description" content="Tonight is a pick-your-show night:[^"]*mostly at the libraries\.">/);
  assert.doesNotMatch(html, /content="[^"]*Forecast is a">/);
});

test("newsletter removes unsupported before-or-after meal timing claims", () => {
  const risky = "Close it out at The Mountain Winery, with fondue at La Fondue on either side of the show.";
  assert.equal(
    sanitizeDayPlanBlurb(risky, null),
    "Close it out at The Mountain Winery, with fondue at La Fondue.",
  );
});

function pairedPlanCards() {
  return [
    ["morning", "breakfast", "Morning Activity", "Breakfast Place"],
    ["afternoon", "lunch", "Afternoon Activity", "Lunch Place"],
    ["evening", "dinner", "Evening Activity", "Dinner Place"],
  ].flatMap(([pillarBucket, mealBucket, pillarName, mealName]) => {
    const pillarId = `pillar:${pillarBucket}`;
    const mealId = `meal:${mealBucket}`;
    return [
      { id: pillarId, name: pillarName, bucket: pillarBucket, role: "pillar", pairedWithId: mealId, source: "place", city: "san-jose" },
      { id: mealId, name: mealName, bucket: mealBucket, role: "paired-meal", pairedWithId: pillarId, pairDistanceMiles: 1.2, pairLocationPrecision: "exact", source: "place", city: "san-jose" },
    ];
  });
}

test("newsletter drops a temporarily unavailable place from a stale plan", () => {
  const plan = makeNewsletterPlan({
    city: "santa-clara",
    cards: [
      { id: "place:open-place", name: "Open Place", bucket: "morning" },
      { id: "place:ChIJUVuaM6zLj4ARoQSjNyb1ebQ", name: "De Saisset Museum", bucket: "afternoon" },
      { id: "event:evening", name: "Evening Event", bucket: "evening" },
    ],
  }, "2026-07-16");

  assert.deepEqual(plan.cards.map((card) => card.id), ["place:open-place", "event:evening"]);
});

test("newsletter rejects an invalid pillar-pairs plan instead of dropping half a pair", () => {
  const cards = pairedPlanCards();
  cards.find((card) => card.bucket === "lunch").pairDistanceMiles = 7;
  const plan = makeNewsletterPlan({ selectionModel: "pillar-pairs-v1", cards }, "2026-07-18");
  assert.equal(plan, null);
});

test("newsletter rejects a stale pair plan with an affiliation-limited pillar", () => {
  const cards = pairedPlanCards();
  Object.assign(cards.find((card) => card.bucket === "afternoon"), {
    name: "Bay FC CSU Night",
    source: "event",
    blurb: "Watch Bay FC as a CSU alumnus in a reserved section at PayPal Park.",
  });
  const plan = makeNewsletterPlan({ selectionModel: "pillar-pairs-v1", cards }, "2026-07-18");
  assert.equal(plan, null);
});

test("newsletter allows only chain branches with an explicit interest signal", () => {
  const generic = pairedPlanCards();
  generic.find((card) => card.bucket === "breakfast").name = "Peet's Coffee";
  assert.equal(makeNewsletterPlan({ selectionModel: "pillar-pairs-v1", cards: generic }, "2026-07-18"), null);

  const interesting = pairedPlanCards();
  const breakfast = interesting.find((card) => card.bucket === "breakfast");
  breakfast.name = "Peet's Coffee";
  breakfast.interestingChain = true;
  breakfast.chainInterestReasons = ["verified new opening"];
  assert.ok(makeNewsletterPlan({ selectionModel: "pillar-pairs-v1", cards: interesting }, "2026-07-18"));
});

test("newsletter rejects repeated restaurant brands even when branch ids differ", () => {
  const cards = pairedPlanCards();
  cards.find((card) => card.bucket === "breakfast").name = "Oren's Hummus - Cupertino";
  cards.find((card) => card.bucket === "dinner").name = "Oren's Hummus - Mountain View";
  assert.equal(makeNewsletterPlan({ selectionModel: "pillar-pairs-v1", cards }, "2026-07-18"), null);
});

test("newsletter rejects a stale pair plan with the wrong breakfast service", () => {
  const cards = pairedPlanCards();
  const breakfast = cards.find((card) => card.bucket === "breakfast");
  breakfast.id = "place:ChIJWRprdFrKj4AR2VYO8rJEUqE";
  breakfast.name = "Fatima Bazaar & Grill";
  cards.find((card) => card.bucket === "morning").pairedWithId = breakfast.id;
  assert.equal(makeNewsletterPlan({
    selectionModel: "pillar-pairs-v1",
    planDate: "2026-07-22",
    cards,
  }, "2026-07-22"), null);
});

// ── virtual events can never be a field-guide pillar ──
//
// The 2026-08-05 issue ran SJSU's online-only "Collegiate Recovery Community
// (CRC) All Recovery Meeting" as its AFTERNOON PICK, paired with a LUNCH
// NEARBY, inside a lede promising "three self-contained pairings." Nothing in
// the event's title or copy says virtual — only events.sjsu.edu does — and the
// only defense was scoreEvent()'s -20, which a good event outruns. A pillar is
// a place to go; there is no score at which an online event becomes one.

function virtualPillarPlan() {
  const cards = pairedPlanCards();
  const afternoon = cards.find((card) => card.bucket === "afternoon");
  afternoon.id = "event:sjsu-d0c9e71e4aec161b";
  afternoon.name = "Collegiate Recovery Community (CRC) All Recovery Meeting";
  afternoon.source = "event";
  afternoon.description =
    "Meet with students exploring recovery and substance-free living in a supportive group";
  cards.find((card) => card.bucket === "lunch").pairedWithId = afternoon.id;
  return { selectionModel: "pillar-pairs-v1", cards };
}

test("newsletter rejects a plan whose pillar the feed flags virtual", () => {
  const plan = virtualPillarPlan();
  const virtualEventIds = new Set(["event:sjsu-d0c9e71e4aec161b"]);
  const validEventIds = new Set(["event:sjsu-d0c9e71e4aec161b"]);
  assert.equal(
    makeNewsletterPlan(plan, "2026-08-05", { validEventIds, virtualEventIds }),
    null,
  );
});

test("a virtual pillar is rejected, not demoted, even with a perfect plan around it", () => {
  // Everything else about this plan is valid — pairs link, distances are in
  // range, meals are open. The rejection is the virtual card alone.
  const plan = virtualPillarPlan();
  assert.ok(
    makeNewsletterPlan(
      { ...plan, cards: pairedPlanCards() },
      "2026-08-05",
      { validEventIds: new Set(), virtualEventIds: new Set() },
    ),
    "control: the same plan shape passes when no card is virtual",
  );
  assert.equal(
    makeNewsletterPlan(plan, "2026-08-05", {
      validEventIds: new Set(["event:sjsu-d0c9e71e4aec161b"]),
      virtualEventIds: new Set(["event:sjsu-d0c9e71e4aec161b"]),
    }),
    null,
  );
});

test("newsletter rejects a virtual pillar from card text when the feed lookup is unavailable", () => {
  // Second line of defense: a plan built before the flag pipeline existed, or
  // a card whose event has aged out of the feed.
  const cards = pairedPlanCards();
  const afternoon = cards.find((card) => card.bucket === "afternoon");
  afternoon.id = "event:online-talk";
  afternoon.name = "Online: Author Talk with Ann Patchett";
  afternoon.source = "event";
  cards.find((card) => card.bucket === "lunch").pairedWithId = afternoon.id;
  assert.equal(
    makeNewsletterPlan({ selectionModel: "pillar-pairs-v1", cards }, "2026-08-05"),
    null,
  );
});

test("newsletter renders each activity pick before its nearby meal", () => {
  const { html } = renderEmail({
    date: "2026-07-18",
    longDate: "Saturday, July 18, 2026",
    weather: null,
    dayPlan: { selectionModel: "pillar-pairs-v1", cards: pairedPlanCards() },
    dayPlanBlurb: "Three strong pairings.",
    tonightPick: null,
    tonightPickBlurb: "",
    todayEvents: [], featuredEvents: [], recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  });
  assert.ok(html.indexOf("Morning pick") < html.indexOf("Breakfast nearby"));
  assert.ok(html.indexOf("Afternoon pick") < html.indexOf("Lunch nearby"));
  assert.match(html, /Three standout picks for today/);
});

test("a virtual event in the calendar list is labelled Virtual and loses its city", () => {
  // Virtual events stay eligible for "Also on the calendar" — they're real and
  // attendable — but the meta line must not read as a place to go.
  const { html } = renderEmail({
    date: "2026-08-05",
    longDate: "Wednesday, August 5, 2026",
    weather: null,
    dayPlan: null,
    dayPlanBlurb: "",
    tonightPick: null,
    tonightPickBlurb: "",
    todayEvents: [],
    featuredEvents: [
      {
        id: "sjsu-d0c9e71e4aec161b",
        title: "Collegiate Recovery Community (CRC) All Recovery Meeting",
        time: "3:30 PM",
        venue: "San Jose State University",
        city: "san-jose",
        cost: "free",
        virtual: true,
        url: "https://events.sjsu.edu/event/collegiate-recovery-community-crc-all-recovery-meeting",
      },
    ],
    recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  });
  assert.match(html, /3:30 PM · Virtual · San Jose State University · Free/);
  assert.ok(
    !/San Jose State University · San Jose/.test(html),
    "must not print a city next to the venue for an online-only event",
  );
});

test("current-day newsletters reject a stale event feed", () => {
  const now = new Date("2026-07-16T13:00:00Z");
  assert.equal(
    isEventFeedFreshForNewsletter({ generatedAt: "2026-07-16T03:11:03Z" }, "2026-07-16", now),
    true,
  );
  assert.equal(
    isEventFeedFreshForNewsletter({ generatedAt: "2026-07-15T03:11:03Z" }, "2026-07-16", now),
    false,
  );
  assert.equal(isEventFeedFreshForNewsletter({}, "2026-07-16", now), false);
});

test("newsletter drops a plan event missing from the current event feed", () => {
  const plan = makeNewsletterPlan({
    cards: [
      { id: "place:open-place", name: "Open Place", source: "place" },
      { id: "event:stale", name: "Stale Event", source: "event" },
      { id: "event:confirmed", name: "Confirmed Event", source: "event" },
    ],
  }, "2026-07-16", { validEventIds: new Set(["event:confirmed"]) });

  assert.deepEqual(plan.cards.map((card) => card.id), ["place:open-place", "event:confirmed"]);
});

test("newsletter selects the exact dated default plan for future previews", () => {
  const adults = { planDate: "2026-07-17", cards: [{ id: "event:today" }] };
  const tomorrow = { planDate: "2026-07-18", cards: [{ id: "event:tomorrow" }] };
  const plans = { adults, "adults:tomorrow": tomorrow };

  assert.equal(selectDefaultPlan(plans, "2026-07-17"), adults);
  assert.equal(selectDefaultPlan(plans, "2026-07-18"), tomorrow);
  assert.equal(selectDefaultPlan(plans, "2026-07-19"), null);
});

test("newsletter drops a temporarily unavailable venue event from a stale plan", () => {
  const plan = makeNewsletterPlan({
    cards: [
      {
        id: "event:museum-exhibition",
        name: "Museum Exhibition",
        source: "event",
        url: "https://events.scu.edu/de-saisset/event/1234-example",
      },
      { id: "event:confirmed", name: "Confirmed Event", source: "event" },
    ],
  }, "2026-07-16", {
    validEventIds: new Set(["event:museum-exhibition", "event:confirmed"]),
  });

  assert.deepEqual(plan.cards.map((card) => card.id), ["event:confirmed"]);
});

test("newsletter lead image renders before the opening briefing and is not duplicated in the field guide", () => {
  const hero = "https://cdn.example.com/sbt-hero.jpg";
  const briefing = "Happy Fourth. The morning belongs to parades, and after dark you have options.";
  const { html } = renderEmail({
    date: "2026-07-04",
    longDate: "Saturday, July 4, 2026",
    weather: null,
    dayPlan: {
      planUrl: "https://southbaytoday.org/plan/fourth",
      cards: [
        { bucket: "morning", name: "Rose, White & Blue Parade", city: "san-jose", timeBlock: "Morning" },
      ],
    },
    dayPlanBlurb: "A flexible holiday field guide.",
    tonightPick: null,
    tonightPickBlurb: "",
    todayEvents: [],
    featuredEvents: [],
    recentOpenings: [],
    civicMeetings: [],
    todayHistory: [],
    redditPosts: [],
    visuals: {
      dayPlanImage: hero,
      dayPlanImageAlt: "South Bay Today holiday field guide",
    },
    editorial: {
      briefing,
      dayPlanHeadline: "Holiday field guide",
    },
  });

  const visibleBriefingIdx = html.indexOf(`font-size:16px;line-height:1.6;color:#1a1a2e;">${briefing}`);
  assert.ok(html.includes("https://southbaytoday.org/images/sbt-newsletter-avatar.png"));
  assert.ok(html.indexOf(hero) < visibleBriefingIdx);
  assert.ok(visibleBriefingIdx < html.indexOf("Today's field guide"));
  assert.equal(html.split(hero).length - 1, 1);
});

test("newsletter footer uses Stephen's first-person signoff and closed-up em dashes", () => {
  const { html } = renderEmail({
    date: "2026-07-20",
    longDate: "Monday, July 20, 2026",
    weather: null,
    dayPlan: null,
    dayPlanBlurb: "",
    tonightPick: null,
    tonightPickBlurb: "",
    todayEvents: [],
    featuredEvents: [],
    recentOpenings: [],
    civicMeetings: [],
    todayHistory: [],
    redditPosts: [],
    visuals: {},
    editorial: null,
  });

  assert.ok(html.includes("If you spot something we missed—a new restaurant, a great event, a story worth telling—just hit reply. I read everything."));
  assert.ok(html.includes("- Stephen Stanwood"));
  assert.equal(html.includes("We read everything."), false);
  assert.equal(html.includes("missed — a new restaurant"), false);
  assert.equal(html.includes("telling — just hit reply"), false);
});

test("newsletter renders also-calendar events chronologically and hides stale/blocked assets", () => {
  const { html } = renderEmail({
    date: "2026-05-28",
    longDate: "Thursday, May 28, 2026",
    weather: null,
    dayPlan: null,
    dayPlanBlurb: "",
    tonightPick: {
      title: "Story Is the Thing",
      time: "6:00 PM",
      venue: "Kepler's Books",
      city: "palo-alto",
      cost: "paid",
      url: "https://example.com/story",
      image: BLOCKED_UNSPLASH,
    },
    tonightPickBlurb: "Local authors gather at Kepler's Books for an evening reading.",
    todayEvents: [{}, {}, {}],
    featuredEvents: [
      { title: "Late Event", time: "7:00 PM", venue: "Late Hall", city: "palo-alto", url: "https://example.com/late" },
      { title: "Early Event", time: "9:00 AM", venue: "Early Hall", city: "campbell", url: "https://example.com/early", image: BLOCKED_UNSPLASH },
    ],
    recentOpenings: [
      { name: "Old Cafe", date: "2026-05-20", cityName: "Campbell", address: "1 Main St" },
    ],
    civicMeetings: [],
    todayHistory: [],
    redditPosts: [],
    visuals: { tonightPickImage: BLOCKED_UNSPLASH },
    editorial: {
      eventsHeading: "On the calendar",
      eventsNote: "A few useful things are happening today.",
      openingsHeading: "Newly open",
      openingsNote: "Fresh food openings.",
    },
  });

  assert.match(html, /Also on the calendar/);
  assert.equal(html.includes("Also also on the calendar"), false);
  assert.equal(html.includes(BLOCKED_UNSPLASH), false);
  assert.ok(html.indexOf("Early Event") < html.indexOf("Late Event"));
  assert.equal(html.includes("Old Cafe"), false);
  assert.equal(html.includes("Newly open"), false);
});

test("newsletter renders a border venue's public locality instead of its eligibility city", () => {
  const { html } = renderEmail({
    date: "2026-07-20",
    longDate: "Monday, July 20, 2026",
    weather: null,
    dayPlan: null,
    dayPlanBlurb: "",
    tonightPick: null,
    tonightPickBlurb: "",
    todayEvents: [{}],
    featuredEvents: [{
      title: "This Is Now with Angie Coiro: Rebecca Solnit",
      time: "6:30 PM",
      venue: "Kepler's Books",
      city: "palo-alto",
      locality: "Menlo Park",
      url: "https://www.keplers.org/upcoming-events-internal/rebecca-solnit",
    }],
    recentOpenings: [],
    civicMeetings: [],
    todayHistory: [],
    redditPosts: [],
    visuals: {},
    editorial: null,
  });

  assert.ok(html.includes("Menlo Park"));
  assert.equal(html.includes("Palo Alto"), false);
});

test("newsletter never renders a final inspection date as an opening date", () => {
  const { html } = renderEmail({
    date: "2026-07-17",
    longDate: "Friday, July 17, 2026",
    weather: null,
    dayPlan: null,
    dayPlanBlurb: "",
    tonightPick: null,
    tonightPickBlurb: "",
    todayEvents: [],
    featuredEvents: [],
    recentOpenings: [
      {
        name: "Fugetsu Market & Goods",
        status: "inspection-complete",
        inspectionDate: "2026-07-13",
        date: "2026-07-13", // legacy bad shape must still fail closed
      },
      {
        name: "Verified Cafe",
        status: "opened",
        date: "2026-07-13",
        openingEvidence: {
          date: "2026-07-13",
          url: "https://verified.example.com/opening-announcement",
          source: "Verified Cafe",
        },
      },
    ],
    civicMeetings: [],
    todayHistory: [],
    redditPosts: [],
    visuals: {},
    editorial: null,
  });

  assert.equal(html.includes("Fugetsu Market &amp; Goods"), false);
  assert.ok(html.includes("Verified Cafe"));
  assert.ok(html.includes("Opened 4 days ago"));
});

test("Tonight's Pick credits a rendered image with a direct event-page link", () => {
  const eventUrl = "https://improv.com/sanjose/event/chinedu+unaka/14808323/";
  const { html } = renderEmail({
    date: "2026-07-15",
    longDate: "Wednesday, July 15, 2026",
    weather: null,
    dayPlan: null,
    dayPlanBlurb: "",
    tonightPick: {
      title: "Chinedu Unaka comedy show",
      time: "8:00 PM",
      venue: "San Jose Improv",
      city: "san-jose",
      url: eventUrl,
      image: "https://i.ticketweb.com/chinedu.jpg",
      imageAlt: "Chinedu Unaka",
      imageSourceUrl: eventUrl,
    },
    tonightPickBlurb: "Chinedu Unaka headlines the San Jose Improv.",
    todayEvents: [],
    featuredEvents: [],
    recentOpenings: [],
    civicMeetings: [],
    todayHistory: [],
    redditPosts: [],
    visuals: {},
    editorial: null,
  });

  assert.match(html, new RegExp(`Image source: <a href="${eventUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>San Jose Improv event page</a>`));
  assert.ok(html.indexOf("Image source:") < html.indexOf("Tonight's pick"));
});

test("Tonight's Pick strips a dangling leading event-metadata fragment", () => {
  const pick = {
    title: "The Music of James Bond",
    time: "7:30 PM",
    venue: "Frost Amphitheater",
    city: "palo-alto",
  };
  const acceptedEditorialCopy = "at 7:30 PM at Frost Amphitheater in Palo Alto. Hear the San Francisco Symphony perform 60 years of James Bond themes.";

  assert.equal(
    sanitizeTonightPickBlurb(acceptedEditorialCopy, pick),
    "Hear the San Francisco Symphony perform 60 years of James Bond themes.",
  );

  const { html } = renderEmail({
    date: "2026-07-24",
    longDate: "Friday, July 24, 2026",
    weather: null,
    dayPlan: null,
    dayPlanBlurb: "",
    tonightPick: pick,
    tonightPickBlurb: acceptedEditorialCopy,
    todayEvents: [],
    featuredEvents: [],
    recentOpenings: [],
    civicMeetings: [],
    todayHistory: [],
    redditPosts: [],
    visuals: {},
    editorial: null,
  });

  assert.equal(html.includes("at 7:30 PM at Frost Amphitheater in Palo Alto."), false);
  assert.ok(html.includes("Hear the San Francisco Symphony perform 60 years of James Bond themes."));
});

test("Tonight's Pick never presents a venue photo as event art", () => {
  const genericUrl = "https://www.mountainwinery.com/concert-series";
  const placePhoto = "https://southbaytoday.org/api/place-photo?ref=venue-photo&w=800&h=600";
  const { html } = renderEmail({
    date: "2026-07-22",
    longDate: "Wednesday, July 22, 2026",
    weather: null,
    dayPlan: null,
    dayPlanBlurb: "",
    tonightPick: {
      title: "Gladys Knight with Patrick McDermott",
      venue: "The Mountain Winery",
      url: genericUrl,
      photoRef: "places/venue-photo",
    },
    tonightPickBlurb: "Gladys Knight headlines tonight.",
    todayEvents: [], featuredEvents: [], recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
    visuals: { tonightPickImage: placePhoto, tonightPickImageAlt: "Gladys Knight with Patrick McDermott" },
    editorial: null,
  });

  assert.equal(html.includes(placePhoto), false);
  assert.equal(html.includes("Image source:"), false);
});

test("Tonight's Pick uses source-provided event alt text with exact occurrence art", () => {
  const eventUrl = "https://www.mountainwinery.com/events/detail?event_id=1350103";
  const eventImage = "https://images.discovery-prod.axs.com/2026/03/uploadedimage_69cb07b32dcb7.jpg";
  const { html } = renderEmail({
    date: "2026-07-22",
    longDate: "Wednesday, July 22, 2026",
    weather: null, dayPlan: null, dayPlanBlurb: "",
    tonightPick: {
      title: "Gladys Knight with Patrick McDermott",
      venue: "The Mountain Winery",
      url: eventUrl,
      image: eventImage,
      imageAlt: "Gladys Knight",
      imageSourceUrl: eventUrl,
    },
    tonightPickBlurb: "Gladys Knight headlines tonight.",
    todayEvents: [], featuredEvents: [], recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  });

  assert.match(html, new RegExp(`<img src="${eventImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" alt="Gladys Knight"`));
  assert.ok(html.includes(`href="${eventUrl}"`));
});

test("Tonight's Pick suppresses art without matching occurrence provenance and semantic alt text", () => {
  const eventUrl = "https://www.mountainwinery.com/events/detail?event_id=1350103";
  const eventImage = "https://images.discovery-prod.axs.com/2026/03/uploadedimage_69cb07b32dcb7.jpg";
  const base = {
    date: "2026-07-22",
    longDate: "Wednesday, July 22, 2026",
    weather: null, dayPlan: null, dayPlanBlurb: "",
    tonightPickBlurb: "Gladys Knight headlines tonight.",
    todayEvents: [], featuredEvents: [], recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  };
  const withoutProvenance = renderEmail({
    ...base,
    tonightPick: {
      title: "Gladys Knight with Patrick McDermott",
      venue: "The Mountain Winery",
      url: eventUrl,
      image: eventImage,
      imageAlt: "Gladys Knight",
    },
  }).html;
  const wrongAlt = renderEmail({
    ...base,
    tonightPick: {
      title: "Gladys Knight with Patrick McDermott",
      venue: "The Mountain Winery",
      url: eventUrl,
      image: eventImage,
      imageAlt: "Empty amphitheater",
      imageSourceUrl: eventUrl,
    },
  }).html;

  assert.equal(withoutProvenance.includes(eventImage), false);
  assert.equal(withoutProvenance.includes("Image source:"), false);
  assert.equal(wrongAlt.includes(eventImage), false);
  assert.equal(wrongAlt.includes("Image source:"), false);
});

test("multi-city field guides strip false one-city framing", () => {
  const cards = pairedPlanCards();
  for (const card of cards) {
    if (["morning", "breakfast"].includes(card.bucket)) card.city = "san-jose";
    if (["afternoon", "lunch"].includes(card.bucket)) card.city = "campbell";
    if (["evening", "dinner"].includes(card.bucket)) card.city = "santa-clara";
  }
  const briefing = "The field guide keeps the day close to downtown San Jose. A concert closes the night.";
  assert.equal(sanitizeGeographicBriefing(briefing, { cards }), "A concert closes the night.");
});

test("also-calendar events without an image span the full width (colspan), not the 72px image gutter", () => {
  // Regression: the events list is ONE shared table. Rows with an image emit two cells
  // (<td width=72>img</td><td>text</td>); rows without an image must span BOTH columns,
  // or their lone cell lands in the 72px image column and the text gets crammed into a
  // narrow strip with the right half blank. (Flagged repeatedly — keep this locked.)
  const { html } = renderEmail({
    date: "2026-05-28",
    longDate: "Thursday, May 28, 2026",
    weather: null, dayPlan: null, dayPlanBlurb: "",
    tonightPick: null, tonightPickBlurb: "",
    todayEvents: [{}, {}, {}],
    featuredEvents: [
      // No image → must carry colspan="2".
      { title: "Book Club Night", time: "7:00 PM", venue: "Campbell Library", city: "campbell", url: "https://example.com/book" },
      // With image → keeps the [thumb][text] two-cell layout.
      { title: "Morning Walk", time: "9:00 AM", venue: "Creek Trail", city: "campbell", url: "https://example.com/walk", image: "https://southbaytoday.org/img/walk.jpg" },
    ],
    recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  });

  // The no-image event's content cell spans both columns.
  const bookIdx = html.indexOf("Book Club Night");
  assert.ok(bookIdx > -1, "no-image event should render");
  const rowSlice = html.slice(html.lastIndexOf("<tr>", bookIdx), bookIdx);
  assert.match(rowSlice, /colspan="2"/);

  // The image event keeps its 72px thumb cell and does NOT colspan its text.
  const walkIdx = html.indexOf("Morning Walk");
  const walkRow = html.slice(html.lastIndexOf("<tr>", walkIdx), walkIdx);
  assert.match(walkRow, /width="72"/);
  assert.equal(walkRow.includes("colspan"), false);
});

test("events expose their image via photoRef (Places proxy), not just a full image URL", () => {
  // Root cause of the recurring "no image" bug: ~54% of events store their image
  // as a Google Places `photoRef` (rendered through /api/place-photo), NOT as a
  // full `image` URL. The newsletter must resolve photoRef to an ABSOLUTE proxy
  // URL or those events render imageless in the inbox.
  const { html } = renderEmail({
    date: "2026-05-28",
    longDate: "Thursday, May 28, 2026",
    weather: null, dayPlan: null, dayPlanBlurb: "",
    tonightPick: null, tonightPickBlurb: "",
    todayEvents: [{}, {}, {}],
    featuredEvents: [
      // photoRef only — the common case. Must still get an <img>.
      { title: "Museum Talk", time: "10:00 AM", venue: "Los Altos History Museum", city: "los-altos", url: "https://example.com/museum", photoRef: "places/ChIJabc123/photos/xyz789" },
    ],
    recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  });

  const idx = html.indexOf("Museum Talk");
  const row = html.slice(html.lastIndexOf("<tr>", idx), idx);
  // Renders an absolute place-photo proxy URL (email needs absolute, not /api/...).
  assert.match(row, /<img [^>]*src="https:\/\/southbaytoday\.org\/api\/place-photo\?ref=places%2FChIJabc123%2Fphotos%2Fxyz789/);
  // And therefore does NOT fall back to the no-image colspan layout.
  assert.equal(row.includes("colspan"), false);
});

test("finalizeNewsletterImages drops events whose photoRef is dead (no broken tile in inbox)", async () => {
  // Underlying cause of the recurring broken-image bug: Google Places photoRefs
  // expire and /api/place-photo then 404s every one. Email can't onError-fallback
  // like the React tab, so the dead ones must be dropped at build time and the row
  // falls back to the full-width (colspan) text layout.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/place-photo")) {
      return new Response("Photo not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return new Response(new Uint8Array([0]), { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  try {
    const data = {
      date: "2026-05-29",
      longDate: "Friday, May 29, 2026",
      weather: null, dayPlan: null, dayPlanBlurb: "",
      tonightPick: null, tonightPickBlurb: "",
      todayEvents: [{}, {}],
      featuredEvents: [
        { title: "Dead Ref Event", time: "10:00 AM", venue: "Some Museum", city: "campbell", url: "https://example.com/dead", photoRef: "places/ChIJdeadref/photos/expired99" },
        { title: "Live Image Event", time: "2:00 PM", venue: "Live Hall", city: "campbell", url: "https://example.com/live", image: "https://cdn.example.com/live-photo.jpg" },
      ],
      recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
      visuals: {}, editorial: null,
    };
    await finalizeNewsletterImages(data);
    const { html } = renderEmail(data);

    // Dead ref → no place-photo <img>, row falls back to colspan text layout.
    assert.equal(html.includes("places%2FChIJdeadref"), false);
    const deadIdx = html.indexOf("Dead Ref Event");
    const deadRow = html.slice(html.lastIndexOf("<tr>", deadIdx), deadIdx);
    assert.ok(deadRow.includes("colspan"), "dead-photoRef row should span both columns");

    // Live direct image → still rendered with its <img>.
    assert.match(html, /<img [^>]*src="https:\/\/cdn\.example\.com\/live-photo\.jpg"/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a closed-registration listing renders its honest label, never Reserve ahead", () => {
  // The Sept 1 2026 issue printed "5:15 PM · Reserve ahead · Alviso Library"
  // for a class whose registration had ended Aug 17. The pickers now exclude
  // closed listings, but any path that still renders one (an editorial pick,
  // a future section) must print the truth.
  const { html } = renderEmail({
    date: "2026-09-01",
    longDate: "Tuesday, September 1, 2026",
    weather: null, dayPlan: null, dayPlanBlurb: "",
    tonightPick: null, tonightPickBlurb: "",
    todayEvents: [{}],
    featuredEvents: [
      {
        title: "Intro to Ukulele for Adults",
        time: "5:15 PM",
        venue: "Alviso Library",
        city: "san-jose",
        cost: "free",
        registration: "closed",
        url: "https://sjpl.bibliocommons.com/events/6a7a2993b44674e2601d024d",
      },
    ],
    recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  });
  assert.match(html, /Registration closed/);
  assert.equal(html.includes("Reserve ahead"), false);
});

test("finalizeNewsletterImages keeps images when the probe errors (transient), never blanks everything", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const data = {
      date: "2026-05-30",
      longDate: "Saturday, May 30, 2026",
      weather: null, dayPlan: null, dayPlanBlurb: "",
      tonightPick: null, tonightPickBlurb: "",
      todayEvents: [{}],
      featuredEvents: [
        { title: "Maybe Event", time: "11:00 AM", venue: "Maybe Hall", city: "campbell", url: "https://example.com/maybe", photoRef: "places/ChIJmaybe/photos/transient1" },
      ],
      recentOpenings: [], civicMeetings: [], todayHistory: [], redditPosts: [],
      visuals: {}, editorial: null,
    };
    await finalizeNewsletterImages(data);
    const { html } = renderEmail(data);
    // Probe threw → unknown → image kept (we don't punish a build-time network blip).
    assert.match(html, /<img [^>]*src="https:\/\/southbaytoday\.org\/api\/place-photo\?ref=places%2FChIJmaybe/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Date helpers (PT-safe formatting — the timezone-drift bug class) ──────────

test("todayPT returns a YYYY-MM-DD string in Pacific Time", () => {
  const t = todayPT();
  assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
  const expected = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  assert.equal(t, expected);
});

test("formatLongDate renders a full weekday/month/day/year string", () => {
  assert.match(formatLongDate("2026-05-06"), /^[A-Z][a-z]+, [A-Z][a-z]+ \d{1,2}, \d{4}$/);
  assert.ok(formatLongDate("2026-05-06").includes("May 6, 2026"));
});

test("formatLongDate does NOT drift across the year boundary (PT, not UTC)", () => {
  // A naive new Date('2026-01-01') formatted in PT renders as Dec 31, 2025.
  // The helper pins noon-UTC + PT to avoid exactly that — lock it in.
  assert.ok(formatLongDate("2026-01-01").includes("January 1, 2026"));
  assert.ok(!formatLongDate("2026-01-01").includes("2025"));
});

// ── Dark-mode email ──────────────────────────────────────────────────────────

test("email head carries dark-mode overrides, keeps light styles, spares accents", () => {
  const { html } = renderEmail({
    date: "2026-05-28",
    longDate: "Thursday, May 28, 2026",
    weather: null, dayPlan: null, dayPlanBlurb: "",
    tonightPick: null, tonightPickBlurb: "",
    todayEvents: [], featuredEvents: [], recentOpenings: [],
    civicMeetings: [], todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  });
  // Color-scheme signal + media query are present.
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  // Structural ink color gets a dark override; the light inline value still ships.
  assert.ok(html.includes('[style*="color:#1a1a2e"]'));
  // Accent hexes must NOT appear inside the dark block (left vibrant, not flattened).
  const darkBlock = html.slice(
    html.indexOf("@media (prefers-color-scheme: dark)"),
    html.indexOf("</style>"),
  );
  assert.equal(darkBlock.includes("#7c3aed"), false);
  assert.equal(darkBlock.includes("#3b4ef0"), false);
});

// --- Editorial data-defect ledger (D194 follow-up) ---------------------------
// The editorial pass has always spotted ingest defects, but every finding was
// stored as `guidance` — a note telling tomorrow's editor to work around it —
// so the pipeline never heard and the defect shipped again. These pin the
// split: defects accumulate with a recurrence count and escalate on repeat.

test("the same defect recurring bumps a count instead of adding a row", () => {
  const day1 = mergeDataDefects([], [
    { area: "url", detail: "Primary link is a bare forms.gle registration form, not an event page", example: "Texturescape opening" },
  ], "2026-08-04");
  assert.equal(day1.length, 1);
  assert.equal(day1[0].count, 1);
  assert.equal(day1[0].firstSeen, "2026-08-04");

  // Same complaint, reworded slightly the next morning.
  const day2 = mergeDataDefects(day1, [
    { area: "url", detail: "Primary link is a bare forms.gle registration form, not an event page", example: "Another opening" },
  ], "2026-08-05");
  assert.equal(day2.length, 1, "a reworded repeat must not create a second row");
  assert.equal(day2[0].count, 2);
  assert.equal(day2[0].firstSeen, "2026-08-04", "firstSeen pins how long this has been broken");
  assert.equal(day2[0].lastSeen, "2026-08-05");
});

test("distinct areas stay distinct even with similar wording", () => {
  const merged = mergeDataDefects([], [
    { area: "url", detail: "link is wrong on the evening pick" },
    { area: "time", detail: "link is wrong on the evening pick" },
  ], "2026-08-04");
  assert.equal(merged.length, 2);
});

test("an unknown area is kept as 'other' rather than dropped", () => {
  const merged = mergeDataDefects([], [
    { area: "wingdings", detail: "Same event ingested twice under different titles" },
  ], "2026-08-04");
  assert.equal(merged.length, 1);
  assert.equal(merged[0].area, "other", "a mislabelled real defect is still worth surfacing");
});

test("malformed reflections never corrupt the ledger", () => {
  const seed = mergeDataDefects([], [{ area: "cost", detail: "Ticketed events carry no price signal" }], "2026-08-04");
  for (const junk of [null, undefined, "nope", [null, {}, { area: "url" }, { detail: "   " }]]) {
    const merged = mergeDataDefects(seed, junk, "2026-08-05");
    assert.equal(merged.length, 1, `junk input ${JSON.stringify(junk)} must leave the ledger intact`);
    assert.equal(merged[0].count, 1, "entries with no detail must not bump a count");
  }
});

test("escalation names recurring defects separately from one-offs", () => {
  const defects = [
    { key: "url:a", area: "url", detail: "Bare forms.gle as primary link", example: "Texturescape", firstSeen: "2026-08-01", lastSeen: "2026-08-04", count: 4 },
    { key: "cost:b", area: "cost", detail: "Ticketed events carry no price signal", example: "Bay FC", firstSeen: "2026-08-04", lastSeen: "2026-08-04", count: 1 },
  ];
  const report = formatDataDefectEscalation(defects, { today: "2026-08-04" });
  assert.match(report, /2 open, 1 recurring/);
  assert.match(report, /RECURRING/);
  assert.match(report, /\[url\] ×4 since 2026-08-01/);
  assert.match(report, /New\/one-off \(1\)/);
});

test("escalation stays quiet when there is nothing open or everything is stale", () => {
  assert.equal(formatDataDefectEscalation([], { today: "2026-08-04" }), "");
  assert.equal(formatDataDefectEscalation(null, { today: "2026-08-04" }), "");
  const old = [{ key: "url:a", area: "url", detail: "Fixed long ago", firstSeen: "2026-06-01", lastSeen: "2026-06-02", count: 9 }];
  assert.equal(
    formatDataDefectEscalation(old, { today: "2026-08-04" }),
    "",
    "a defect nobody has seen in two weeks is presumed fixed and must not nag",
  );
});

test("a reworded repeat bumps the original row rather than opening a second", () => {
  // The editor re-derives findings from scratch each morning, so the same
  // defect comes back phrased differently. If that opened a new row, every
  // recurrence would look like a fresh one-off — destroying the signal.
  const day1 = mergeDataDefects([], [
    { area: "duplicate", detail: "Same event ingested twice under different titles, once from the ticketing feed" },
  ], "2026-08-04");
  const day2 = mergeDataDefects(day1, [
    { area: "duplicate", detail: "Same event ingested twice under different titles — the venue calendar and a ticket vendor" },
  ], "2026-08-05");

  assert.equal(day2.length, 1);
  assert.equal(day2[0].count, 2);
  assert.equal(day2[0].firstSeen, "2026-08-04");
  assert.match(day2[0].detail, /venue calendar/, "latest phrasing wins");

  // A genuinely different defect in the same area still gets its own row.
  const day3 = mergeDataDefects(day2, [
    { area: "duplicate", detail: "Three separate National Night Out entries for one city" },
  ], "2026-08-06");
  assert.equal(day3.length, 2);
  assert.equal(dataDefectKey({ area: "duplicate", detail: "x y z" }).startsWith("duplicate:"), true);
});

// ── Civic meetings: the "tonight" promise and closed sessions ───────────────
//
// Regressions from the 2026-08-11 issue, which ran "Civic Meetings Tonight"
// over San José's 1:30 PM council meeting, Milpitas's 4:00 PM special meeting,
// and Cupertino's non-televised closed session.

const AUG_11_MEETINGS = [
  { city: "san-jose", date: "2026-08-11", startTime: "13:30", bodyName: "City Council", location: "Council Chambers", closedSession: false, url: "https://sanjose.legistar.com/MeetingDetail.aspx?LEGID=8109" },
  { city: "sunnyvale", date: "2026-08-11", startTime: "17:30", bodyName: "City Council", location: "Online and Council Chambers, City Hall", closedSession: false, url: "https://sunnyvaleca.legistar.com/Calendar.aspx" },
  { city: "cupertino", date: "2026-08-11", startTime: "17:00", bodyName: "City Council", location: "Conference Room C", closedSession: true, url: "https://cupertino.legistar.com/MeetingDetail.aspx?LEGID=5368" },
  { city: "milpitas", date: "2026-08-11", startTime: "16:00", bodyName: "City Council Special Meeting", location: "Milpitas City Hall", closedSession: false, url: "https://www.milpitas.gov/129/Agendas-Minutes" },
];

function meetingsEmail(civicMeetings) {
  return renderEmail({
    date: "2026-08-11",
    longDate: "Tuesday, August 11, 2026",
    weather: null,
    dayPlan: null,
    dayPlanBlurb: "",
    tonightPick: null,
    tonightPickBlurb: "",
    todayEvents: [], featuredEvents: [], recentOpenings: [],
    civicMeetings,
    todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  }).html;
}

test("an afternoon council meeting is kept but never called tonight", () => {
  const html = meetingsEmail(AUG_11_MEETINGS);

  assert.match(html, /Civic meetings today/);
  assert.ok(!/Civic meetings tonight/i.test(html), "1:30 PM and 4:00 PM sittings cannot claim tonight");
  // Honest heading, not a smaller section: every meeting still ships.
  assert.match(html, /San Jose<\/strong> — <a[^>]*>City Council<\/a> <span[^>]*>· 1:30 PM · Council Chambers/);
  assert.match(html, /Milpitas<\/strong>[\s\S]{0,220}?· 4:00 PM · Milpitas City Hall/);
});

test("a closed session says so instead of posing as a meeting readers can attend", () => {
  const html = meetingsEmail(AUG_11_MEETINGS);

  assert.match(
    html,
    /Cupertino<\/strong> — <a[^>]*>City Council<\/a> <span[^>]*>· 5:00 PM · Conference Room C · Closed session, not open to the public/,
  );
  // The televised evening meeting alongside it carries no such label.
  assert.match(html, /Sunnyvale<\/strong>[\s\S]{0,240}?· 5:30 PM · Online and Council Chambers, City Hall<\/span>/);
});

test("an all-evening civic calendar still earns the word tonight", () => {
  const evening = AUG_11_MEETINGS.filter((m) => m.city === "sunnyvale" || m.city === "cupertino");
  assert.equal(civicMeetingsHeading(evening), "Civic meetings tonight");
  assert.match(meetingsEmail(evening), /Civic meetings tonight/);

  assert.equal(civicMeetingsHeading(AUG_11_MEETINGS), "Civic meetings today");
  assert.equal(civicMeetingsHeading([]), "");
});

test("a meeting with no posted start time cannot vouch for tonight", () => {
  // Saratoga's Agenda Center and Los Gatos's MuniCode page publish dates only.
  const undated = [{ city: "saratoga", date: "2026-08-11", startTime: null, bodyName: "City Council", location: null, closedSession: false, url: "https://www.saratoga.ca.us/AgendaCenter/City-Council-13" }];
  assert.equal(civicMeetingsHeading(undated), "Civic meetings today");

  const html = meetingsEmail(undated);
  assert.match(html, /Civic meetings today/);
  // No clock invented to fill the gap.
  assert.ok(!/· \d{1,2}:\d{2} [AP]M/.test(html), "must not print a start time it never received");
});

// ── Civic meetings: a posted start that is really the closed session ───────
//
// The 2026-08-25 issue opened "Council chambers are busy today: San Jose meets
// at 1:30 PM, Sunnyvale at 4:30, and Mountain View at 5, so if you have a civic
// itch this is the afternoon to scratch it." Sunnyvale's 4:30 was true against
// the calendar and useless to a reader: it is the closed session. Its public
// blocks are 6 PM (presentation) and 7 PM (regular). generate-upcoming-meetings
// now resolves the start to 18:00 and records closedSessionStart 16:30 — these
// hold the email to naming both.

const AUG_25_SUNNYVALE = {
  city: "sunnyvale",
  date: "2026-08-25",
  startTime: "18:00",
  closedSessionStart: "16:30",
  bodyName: "City Council",
  location: "Online and Council Chambers, City Hall",
  closedSession: false,
  url: "https://sunnyvaleca.legistar.com/MeetingDetail.aspx?LEGID=4522",
};

test("a meeting whose posted hour was closed prints the public start and names the closed one", () => {
  const html = renderEmail({
    date: "2026-08-25",
    longDate: "Tuesday, August 25, 2026",
    weather: null, dayPlan: null, dayPlanBlurb: "", tonightPick: null, tonightPickBlurb: "",
    todayEvents: [], featuredEvents: [], recentOpenings: [],
    civicMeetings: [AUG_25_SUNNYVALE],
    todayHistory: [], redditPosts: [], visuals: {}, editorial: null,
  }).html;

  assert.match(
    html,
    /Sunnyvale<\/strong> — <a[^>]*>City Council<\/a> <span[^>]*>· 6:00 PM · Online and Council Chambers, City Hall · Closed session from 4:30 PM/,
  );
  assert.ok(!/· 4:30 PM ·/.test(html), "4:30 may be named as the closed hour, never printed as the start");
  // Not the same claim as a wholly closed sitting — there is public business here.
  assert.ok(!/not open to the public/.test(html));
});

test("the editor packet tells the intro which hour readers can actually show up", () => {
  const packet = buildEditorialPacket({
    longDate: "Tuesday, August 25, 2026",
    weather: null, dayPlan: null, todayHistory: [],
    civicMeetings: [AUG_25_SUNNYVALE],
  }, { eventCandidates: [], openingCandidates: [], redditCandidates: [] });

  assert.deepEqual(packet.meetings, [{
    idx: 0,
    city: "Sunnyvale",
    body: "City Council",
    time: "6:00 PM",
    location: "Online and Council Chambers, City Hall",
    note: "Closed session from 4:30 PM (not open to the public); the public session starts at 6:00 PM",
  }]);
});

test("an ordinary meeting gains no closed-session note", () => {
  const packet = buildEditorialPacket({
    longDate: "Tuesday, August 25, 2026",
    weather: null, dayPlan: null, todayHistory: [],
    // San José 2026-08-25: a genuinely public 1:30 PM sitting whose Legistar
    // comment mentions a separate 9:30 a.m. closed session.
    civicMeetings: [{ city: "san-jose", date: "2026-08-25", startTime: "13:30", bodyName: "City Council", location: "Hybrid Meeting - Council Chambers", closedSession: false, url: "https://sanjose.legistar.com/MeetingDetail.aspx?LEGID=8101" }],
  }, { eventCandidates: [], openingCandidates: [], redditCandidates: [] });

  assert.deepEqual(packet.meetings, [{
    idx: 0,
    city: "San Jose",
    body: "City Council",
    time: "1:30 PM",
    location: "Hybrid Meeting - Council Chambers",
  }]);
});

// ── Day plan: a paired meal's price band ───────────────────────────────────

function planEmail(cards) {
  return renderEmail({
    date: "2026-08-11",
    longDate: "Tuesday, August 11, 2026",
    weather: null,
    dayPlan: { selectionModel: "pillar-pairs-v1", cards },
    dayPlanBlurb: "Three strong pairings.",
    tonightPick: null,
    tonightPickBlurb: "",
    todayEvents: [], featuredEvents: [], recentOpenings: [], civicMeetings: [],
    todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  }).html;
}

test("a paired meal prints its price band, never the food hall's free door", () => {
  // The 2026-08-11 dinner card verbatim: San Pedro Square Market is free to
  // walk into and $15–30 to eat in. The issue printed "Dinner · San Jose · Free".
  const html = planEmail([
    { id: "event:beths", name: "The Beths & Beach Bunny", bucket: "evening", timeBlock: "Evening", role: "pillar", pairedWithId: "place:spsm", city: "san-jose", category: "events", cost: "paid" },
    { id: "place:spsm", name: "San Pedro Square Market", bucket: "dinner", timeBlock: "Dinner", role: "paired-meal", pairedWithId: "event:beths", city: "san-jose", category: "food", cost: "free", costNote: "$15–30/person" },
  ]);

  assert.match(html, /Dinner · San Jose · \$15–30\/person/);
  assert.ok(!/San Pedro Square Market[\s\S]{0,200}?· Free/.test(html), "a paid dinner must not be advertised as Free");
});

test("a free pillar keeps saying Free — only the meal slot loses the door price", () => {
  const html = planEmail([
    { id: "place:market", name: "Campbell Farmers Market", bucket: "morning", timeBlock: "Morning", role: "pillar", pairedWithId: "place:stans", city: "campbell", category: "food", cost: "free" },
    { id: "place:stans", name: "Stan's Donut Shop", bucket: "breakfast", timeBlock: "Breakfast", role: "paired-meal", pairedWithId: "place:market", city: "santa-clara", category: "food", cost: "free", costNote: "Under $15/person" },
  ]);

  assert.match(html, /Morning · Campbell · Free/);
  assert.match(html, /Breakfast · Santa Clara · Under \$15\/person/);
});

test("a meal with no known price band omits the segment rather than guessing", () => {
  const html = planEmail([
    { id: "place:pillar", name: "Afternoon Pillar", bucket: "afternoon", timeBlock: "Afternoon", role: "pillar", pairedWithId: "place:lunch", city: "san-jose", category: "arts", cost: "free" },
    { id: "place:lunch", name: "Unpriced Lunch Spot", bucket: "lunch", timeBlock: "Lunch", role: "paired-meal", pairedWithId: "place:pillar", city: "san-jose", category: "food", cost: "free" },
  ]);

  assert.match(html, /Lunch · San Jose<\/div>/);
  assert.ok(!/Unpriced Lunch Spot[\s\S]{0,200}?· Free/.test(html), "an unknown bill is not a free meal");

  assert.equal(planCardPriceBand({ bucket: "dinner", cost: "free" }), null);
  assert.equal(planCardPriceBand({ bucket: "dinner", cost: "free", costNote: "$60+/person" }), "$60+/person");
  assert.equal(planCardPriceBand({ bucket: "dinner", role: "paired-meal", cost: "low", kidsCostNote: "Under $20" }), "Under $20");
  assert.equal(planCardPriceBand({ bucket: "evening", role: "pillar", cost: "free" }), "Free");
  assert.equal(planCardPriceBand({ bucket: "evening", role: "pillar", cost: "paid" }), null);
});

// ---------------------------------------------------------------------------
// Advance registration must never reach a walk-up recommendation slot
// ---------------------------------------------------------------------------
// Guards the Aug 12 2026 regression: Palo Alto's appointment-only "Vintage
// Media Lab" ran as the afternoon field-guide pick, presented as a walk-up
// ("spend the afternoon digitizing family cassettes", 1:00 PM, Free).

test("a registration-gated event cannot be Tonight's Pick", () => {
  const base = {
    id: "paloalto-6a4bffddc52cdc3600ef3342",
    title: "Vintage Media Lab",
    url: "https://paloalto.bibliocommons.com/events/6a4bffddc52cdc3600ef3342",
    venue: "Mitchell Park Library",
    city: "palo-alto",
    time: "6:00 PM",
    cost: "free",
  };
  // Identical event, gate removed → eligible. The gate is what excludes it,
  // not some incidental property of the fixture.
  assert.equal(isTonightPickCandidate(base), true);
  for (const registration of ["required", "appointment-only", "full"]) {
    assert.equal(isTonightPickCandidate({ ...base, registration }), false, registration);
  }
  assert.equal(isTonightPickCandidate({ ...base, registration: "none" }), true);
});

test("a registration-gated pillar rejects the whole pillar-pairs plan", () => {
  const cards = [
    { id: "event:paloalto-vml", name: "Vintage Media Lab", source: "event", role: "pillar", bucket: "afternoon", timeBlock: "afternoon", pairedWithId: "place:lunch" },
    { id: "place:lunch", name: "Bevri", role: "paired-meal", bucket: "lunch", timeBlock: "afternoon", pairedWithId: "event:paloalto-vml" },
  ];
  const validEventIds = new Set(["event:paloalto-vml"]);

  // Ungated, the same plan survives card filtering (it may still fail later
  // pair validation, but it is not rejected as a bad card).
  const gated = makeNewsletterPlan(
    { selectionModel: "pillar-pairs-v1", cards },
    "2026-08-12",
    { validEventIds, registrationGatedEventIds: new Set(["event:paloalto-vml"]) },
  );
  assert.equal(gated, null, "a gated pillar must reject the plan outright, never drop one card of a pair");
});

test("the registration gate leaves ordinary drop-in plans alone", () => {
  const cards = [
    { id: "event:sjpl-storytime", name: "Family Storytime", source: "event", role: "pillar", bucket: "morning", timeBlock: "morning", pairedWithId: "place:breakfast" },
    { id: "place:breakfast", name: "Zombie Runner", role: "paired-meal", bucket: "breakfast", timeBlock: "morning", pairedWithId: "event:sjpl-storytime" },
  ];
  const withEmptyGate = makeNewsletterPlan(
    { selectionModel: "pillar-pairs-v1", cards },
    "2026-08-12",
    { validEventIds: new Set(["event:sjpl-storytime"]), registrationGatedEventIds: new Set() },
  );
  const withoutGateArg = makeNewsletterPlan(
    { selectionModel: "pillar-pairs-v1", cards },
    "2026-08-12",
    { validEventIds: new Set(["event:sjpl-storytime"]) },
  );
  // An absent gate set must behave exactly like an empty one — the parameter
  // is optional and callers that predate it must not change behaviour.
  assert.deepEqual(withEmptyGate, withoutGateArg);
});

// ── Proper names in generated prose (the Aug 13 2026 "Mistah F. A. B." bug) ──

function mistahIssue(prose) {
  return {
    date: "2026-08-13",
    longDate: "Thursday, August 13, 2026",
    weather: null,
    dayPlan: {
      city: "san-jose",
      cards: [
        {
          id: "event:back-2-the-bay", name: "Back 2 The Bay: SOB X RBE Live", bucket: "evening",
          role: "pillar", pairedWithId: "place:dinner", venue: "The Habbas Law Epicenter at PayPal Park",
          city: "san-jose",
          blurb: "Hip-hop group SOB X RBE returns to the stage with a new song, joined by P-Lo, 310Babii, and Mistah F.A.B. as part of the Epicenter Music Series.",
        },
        {
          id: "place:dinner", name: "Back A Yard", bucket: "dinner", role: "paired-meal",
          pairedWithId: "event:back-2-the-bay", city: "san-jose",
        },
      ],
    },
    dayPlanBlurb: prose.dayPlanBlurb || "",
    tonightPick: {
      id: "event:back-2-the-bay", title: "Back 2 The Bay: SOB X RBE Live",
      venue: "The Habbas Law Epicenter at PayPal Park", city: "san-jose", time: "6:00 PM",
      description: "Hip hop and hyphy music festival featuring SOBxRBE, P-Lo, 310Babii, and Mistah F.A.B. VIP tickets available with exclusive perks.",
    },
    tonightPickBlurb: prose.tonightPickBlurb || "",
    todayEvents: [], featuredEvents: [], recentOpenings: [],
    civicMeetings: [], todayHistory: [], redditPosts: [], visuals: {},
    editorial: { briefing: prose.briefing || "", dayPlanHeadline: prose.dayPlanHeadline || "" },
  };
}

test("editorial prose cannot respell a name the issue's own source data spells correctly", () => {
  // Every rendered surface that shipped the Aug 13 2026 corruption at once: the
  // intro lede (which also feeds the preheader), the field guide, and the
  // tonight-pick blurb, against a deterministic card that was always right.
  const data = repairNewsletterProperNames(mistahIssue({
    briefing: "Two stadiums switch on at 6 tonight, with Mistah F. A. B. at PayPal Park.",
    dayPlanHeadline: "Free classes by day, hyphy by night with Mistah F. A. B.",
    dayPlanBlurb: "The evening belongs to Mistah FAB and a stacked undercard.",
    tonightPickBlurb: "Mistah F.A.B. joins SOB X RBE for the Epicenter Music Series.",
  }));

  assert.equal(data.editorial.briefing, "Two stadiums switch on at 6 tonight, with Mistah F.A.B. at PayPal Park.");
  assert.equal(data.editorial.dayPlanHeadline, "Free classes by day, hyphy by night with Mistah F.A.B.");
  assert.equal(data.dayPlanBlurb, "The evening belongs to Mistah F.A.B. and a stacked undercard.");
  // Already correct → untouched.
  assert.equal(data.tonightPickBlurb, "Mistah F.A.B. joins SOB X RBE for the Epicenter Music Series.");
});

test("the name guard leaves an ordinary sentence boundary alone", () => {
  const prose = "Doors at 6 P.M. A new mural goes up next door. Mistah F.A.B. headlines.";
  const data = repairNewsletterProperNames(mistahIssue({ briefing: prose, tonightPickBlurb: prose }));
  assert.equal(data.editorial.briefing, prose);
  assert.equal(data.tonightPickBlurb, prose);
});

test("the name guard repairs an editor-supplied title override, not the source event", () => {
  const data = mistahIssue({});
  const sourceEvent = {
    id: "event:pete-soundhouse", title: "PETE'S SOUNDHOUSE \\- San Jose",
    venue: "Pete BE Center", city: "san-jose",
    blurb: "Hear live hip-hop performances from P-Lo, Kamaiyah, Mistah F.A.B., and more.",
  };
  // An override copy carries rawTitle; the untouched source event does not.
  data.featuredEvents = [
    { ...sourceEvent, title: "Pete's Soundhouse with Mistah F. A. B.", rawTitle: sourceEvent.title },
    { ...sourceEvent, id: "event:untouched" },
  ];
  repairNewsletterProperNames(data);

  assert.equal(data.featuredEvents[0].title, "Pete's Soundhouse with Mistah F.A.B.");
  assert.equal(data.featuredEvents[1].title, "PETE'S SOUNDHOUSE \\- San Jose", "a source title with no override is never rewritten");
});

test("the name guard is idempotent and no-ops on an issue with no initialism names", () => {
  const prose = "Two stadiums switch on at 6 tonight.";
  const once = repairNewsletterProperNames(mistahIssue({ briefing: prose }));
  const twice = repairNewsletterProperNames(once);
  assert.equal(twice.editorial.briefing, prose);

  const plain = {
    date: "2026-08-13", dayPlan: null, dayPlanBlurb: "Ride the Guadalupe River Trail, then eat at Back A Yard.",
    tonightPick: null, tonightPickBlurb: "", featuredEvents: [], todayEvents: [], recentOpenings: [],
    editorial: { briefing: "A clear, hot Thursday across the valley." },
  };
  assert.deepEqual(repairNewsletterProperNames(plain), plain);
  assert.equal(repairNewsletterProperNames(null), null);
});

test("a cached card blurb cannot ship a respelled name either", () => {
  // event-blurb-cache.json is LLM-written off each event's description and
  // renders verbatim on the card — it is where the third live spelling of
  // "Mistah F.A.B." was sitting.
  const data = mistahIssue({});
  data.featuredEvents = [{
    id: "event:pete-soundhouse", title: "Pete's Soundhouse", venue: "Pete BE Center", city: "san-jose",
    blurb: "Hear live hip-hop performances from P-Lo, Kamaiyah, Mistah FAB, and more.",
    description: "Hear live hip-hop performances from P-Lo, Kamaiyah, Mistah F.A.B., and more.",
  }];
  data.recentOpenings = [{ name: "Epicenter Bar", blurb: "Opening night features Mistah F. A. B." }];
  repairNewsletterProperNames(data);

  assert.equal(
    data.featuredEvents[0].blurb,
    "Hear live hip-hop performances from P-Lo, Kamaiyah, Mistah F.A.B., and more.",
  );
  assert.equal(data.recentOpenings[0].blurb, "Opening night features Mistah F.A.B.");
  // The description is the source the canonical spelling is read from, so it is
  // never rewritten.
  assert.equal(
    data.featuredEvents[0].description,
    "Hear live hip-hop performances from P-Lo, Kamaiyah, Mistah F.A.B., and more.",
  );
  // Day-plan card blurbs are on the same footing.
  assert.match(data.dayPlan.cards[0].blurb, /Mistah F\.A\.B\./);
});
