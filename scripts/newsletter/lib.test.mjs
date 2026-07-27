import test from "node:test";
import assert from "node:assert/strict";
import {
  renderEmail,
  finalizeNewsletterImages,
  formatLongDate,
  isEventFeedFreshForNewsletter,
  makeNewsletterPlan,
  sanitizeGeographicBriefing,
  sanitizeTonightPickBlurb,
  selectDefaultPlan,
  todayPT,
  truncateNewsletterCopy,
} from "./lib.mjs";

const BLOCKED_UNSPLASH = "https://images.unsplash.com/photo-1585899873671-ade0aa28a821?crop=entropy&w=400";

test("newsletter copy truncation never cuts a word in half", () => {
  const note = "Civic stakes lead the week, plus practical threads on car-free VTA life and getting through a heatwave without central AC.";
  const truncated = truncateNewsletterCopy(note, 90);

  assert.equal(truncated, "Civic stakes lead the week, plus practical threads on car-free VTA life and getting…");
  assert.ok(truncated.length <= 90);
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

test("newsletter renders each activity pick before its nearby meal", () => {
  const { html } = renderEmail({
    date: "2026-07-18",
    longDate: "Saturday, July 18, 2026",
    weather: null,
    dayPlan: { selectionModel: "pillar-pairs-v1", cards: pairedPlanCards() },
    dayPlanBlurb: "Three strong pairings.",
    tonightPick: null,
    tonightPickBlurb: "",
    todayEvents: [], featuredEvents: [], recentOpenings: [], tonightMeetings: [], todayHistory: [], redditPosts: [],
    visuals: {}, editorial: null,
  });
  assert.ok(html.indexOf("Morning pick") < html.indexOf("Breakfast nearby"));
  assert.ok(html.indexOf("Afternoon pick") < html.indexOf("Lunch nearby"));
  assert.match(html, /Three standout picks for today/);
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
    tonightMeetings: [],
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
    tonightMeetings: [],
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
    tonightMeetings: [],
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
    tonightMeetings: [],
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
    tonightMeetings: [],
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
    tonightMeetings: [],
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
    tonightMeetings: [],
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
    todayEvents: [], featuredEvents: [], recentOpenings: [], tonightMeetings: [], todayHistory: [], redditPosts: [],
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
    todayEvents: [], featuredEvents: [], recentOpenings: [], tonightMeetings: [], todayHistory: [], redditPosts: [],
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
    todayEvents: [], featuredEvents: [], recentOpenings: [], tonightMeetings: [], todayHistory: [], redditPosts: [],
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
    recentOpenings: [], tonightMeetings: [], todayHistory: [], redditPosts: [],
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
    recentOpenings: [], tonightMeetings: [], todayHistory: [], redditPosts: [],
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
      recentOpenings: [], tonightMeetings: [], todayHistory: [], redditPosts: [],
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
      recentOpenings: [], tonightMeetings: [], todayHistory: [], redditPosts: [],
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
    tonightMeetings: [], todayHistory: [], redditPosts: [],
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
