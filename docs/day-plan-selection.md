# Day-plan selection contract

South Bay Today day plans use the `pillar-pairs-v1` model. A plan is not a
six-stop route. It is three independent recommendations:

1. the best morning activity, paired with breakfast nearby;
2. the best afternoon activity, paired with lunch nearby;
3. the best evening activity, paired with dinner nearby.

## Selection order

Activity quality is decided before meal quality or geography. The planner
scores the full eligible event/place pool, keeps separate finalist lanes for
dated events and evergreen places, and asks the editorial model to choose one
pillar for each part of the day. The three pillars can be in any South Bay
towns; no score rewards clustering them or building a route.

A date is evidence, not automatic quality. Routine recurring programming and
generic titles carry substantial penalties, while marquee and genuinely
specific one-off events retain a strong advantage. The model may exercise
taste among close finalists, but its activity choice is ignored when it falls
more than 10 deterministic score points behind the best available pillar.
Routine listings with a 35-point-or-higher penalty do not enter regional
finalist pools at all unless the reader explicitly locked one; city-scoped
plans keep them available for genuinely thin local inventories.
Audience breadth is also a first-order quality signal. Affiliation-limited
offers such as alumni nights, members-only previews, and institution-specific
ticket sections remain searchable in the Events calendar, but do not enter an
unprompted day plan or newsletter recommendation. An explicit reader lock can
still build a plan around one, because that lock supplies the missing interest
signal.
Likewise, a model-selected meal cannot trail the best available pairing score
by more than 7 points. This keeps editorial judgment without letting a prompt
override a material quality gap. Programs that require a baby or young child
are excluded from adult mode even when a source mislabeled them as all-ages.

The editor compares pillars before considering their attached restaurant
lists. A meal must be a real dine-in venue, open during the relevant service,
and no more than 5 miles from its pillar; 3 miles is preferred. Inside that
ceiling, quality beats small distance differences. Meal quality combines
rating evidence, editorial curation, verified new-opening status, cuisine/type
distinctiveness, and specific source-backed copy. A chain is eligible only
when the specific branch has a verified interest signal: a new opening,
distinctive format/cuisine, standout branch reputation, or a specific
editorial note. Eligible chains still carry an ubiquity penalty, so a familiar
logo does not beat an equivalent independent. Caterers, grocery stores,
food-delivery businesses, home food businesses, and meal-inappropriate venue
types are not eligible.

A restaurant brand may appear only once in a plan. Branch IDs and addresses do
not make repeat locations distinct recommendations: Oren's in Cupertino and
Oren's in Mountain View still count as the same meal brand. Selection enforces
this rule, and the API, scheduled generator, post-generation review, and
newsletter all reject plans that violate it.

The radius must be supported by exact place coordinates or a matched venue.
An event known only to a city centroid stays in the event corpus but cannot be
used for a proximity pair.

Food events, such as a farmers market or festival, may be activity pillars.
Only restaurant/place records can fill meal buckets.

### Virtual events are never pillars

A pillar is a place to go, paired with a meal within five miles of it. An
online-only event has no such place, so it is hard-excluded from every pillar
lane — never merely demoted. It stays eligible for listing surfaces (the
Events tab, "Also on the calendar") where it is labelled `Virtual` and shown
without a city, a map link, or a venue place-photo.

`virtual` is set at ingest from the **source's own location-type field**, not
from title/description text:

| Feed | Endpoint | Field |
| --- | --- | --- |
| SJSU, Stanford (Localist) | `/api/2/events` | `experience` |
| SCU (LiveWhale) | `/live/json/events` | `online_type` / `is_online` |
| Libraries (BiblioCommons) | events API | `definition.isVirtual` |
| Meetup | GraphQL `eventSearch` | `eventType` (non-`PHYSICAL` dropped) |

`hybrid` counts as physically attendable and stays eligible.
`virtualFromSourceSignal()` and `resolveVirtualFlag()` in
`src/lib/south-bay/eventFilters.mjs` normalize these; the text patterns remain
as a fallback, and either signal saying "virtual" is enough.

Text matching alone is not sufficient and must never be the only check. On
2026-08-05 the newsletter ran SJSU's "Collegiate Recovery Community (CRC) All
Recovery Meeting" as its afternoon pick with a lunch paired to it, inside a
lede promising "three self-contained pairings." events.sjsu.edu lists it
VIRTUAL; nothing in its title or blurb says so, SJSU's RSS carries no location
field at all, and the only defense was a `-20` score penalty a good event
outruns. `scripts/audit-events.mjs` now exits non-zero on any hard
`virtual-not-flagged` finding and runs in the nightly refresh before commit.

### Registration-gated events are never pillars

A pillar tells the reader to be somewhere at a stated time. A program that
needs a booking made days earlier cannot honour that, so it is hard-excluded
from every pillar lane and from Tonight's Pick — never merely demoted.

`registration` is set at ingest from the **source's own registration fields**,
not from title/description text:

| Feed | Endpoint | Fields |
| --- | --- | --- |
| Libraries (BiblioCommons) | events API | `definition.registrationInfo.provider` / `.cap` / `.maxSeats` / `.instructions`, plus per-instance `isFull` |

Values are `none`, `required`, `appointment-only`, and `full`;
`requiresAdvanceRegistration()` in `src/lib/south-bay/eventFilters.mjs` is the
gate, and `registrationLabel()` supplies the reader-facing tag. An event with
no `registration` field reads as walk-up, so every non-library source keeps its
existing behaviour.

Gated events stay on listing surfaces (the Events tab, "Also on the calendar"),
where they are labelled "Reserve ahead" / "Appointment required" /
"Registration full" rather than silently dropped. A good program the reader
must book is worth knowing about; the newsletter just must not imply they can
walk in.

Conflicting same-day attendance instructions have their own gate:
`attendanceStatus: "needs-confirmation"` is excluded by
`requiresAttendanceConfirmation()` from planner and newsletter recommendations.
It does not imply advance registration. Listings keep their `attendanceNote`,
rendered independently of generated blurbs. BiblioCommons and LibCal retain
their structured `sourceAudiences` labels for audience classification.
See `docs/qa/2026-09-06-newsletter.md` for the Balloon Car Derby source conflict.

Two properties of the source data are load-bearing, and both produced the bug
when ignored:

- **`isFull` is not a sold-out signal on its own.** When `provider` is
  `EXTERNAL` with `cap` and `maxSeats` both null, BiblioCommons does no seat
  accounting, so `isFull` carries no information — Vintage Media Lab reports
  `isFull: true` on instances the library's own page advertises as available.
  `full` therefore requires real seat accounting; without it the event stays
  labelled rather than suppressed.
- **A non-null `cap` does not imply registration.** Palo Alto's Open Sewing
  Studio, Photography Meetup and Meditation with Sara all carry a capacity with
  no registrar and nobody registered — a noted room size on a drop-in. Gating
  on `cap` would wrongly suppress genuine walk-up events.

On 2026-08-12 the newsletter ran Palo Alto's "Vintage Media Lab" as its
afternoon pick — "spend the afternoon digitizing family cassettes and photos",
1:00 PM, Mitchell Park Library, Free. The lab takes one pre-booked two-hour
appointment per person per week. The ingest was reading `definition.title`,
`.start` and `.end` and dropping `registrationInfo` entirely, so every
registration-gated library event reached the planner indistinguishable from a
drop-in storytime. `makeNewsletterPlan` now re-checks the live feed and rejects
a gated pillar outright, the same defense-in-depth the virtual flag has.

## Scopes

- `scope: "regional"` is the homepage, newsletter, graphics, scheduled hero,
  and event "Make it a day" default. The request's `city` is only a stable
  Campbell weather context.
- `scope: "city"` is used by `/city/<slug>` and hard-filters every pillar and
  meal to that city while retaining the same quality-first method.

## Durable card shape

Every new plan returns six cards and `selectionModel: "pillar-pairs-v1"`.
Activity cards have `role: "pillar"`; meal cards have
`role: "paired-meal"`. Both carry reciprocal `pairedWithId` values. Meal cards
also carry `pairDistanceMiles` and `pairLocationPrecision`. The latter records
whether the radius used exact place coordinates or a matched venue.

The contract is atomic. Newsletter filtering, homepage time-based aging,
shared-plan canonicalization, schedule review, and manual review tooling must
never remove or swap one card from a pair. A bad or stale card removes its
partner too, or rejects/regenerates the whole plan at generation boundaries.

## Main implementation points

- `src/pages/api/plan-day.ts`: regional/city pools, scoring, finalist lanes,
  editorial selection, lock handling, and pair construction.
- `src/lib/south-bay/dayPlanPairs.ts`: distance, meal quality, pair constants,
  and structural validation.
- `src/lib/south-bay/editorialQuality.mjs`: shared marquee, title-quality, and
  routine-event and audience-breadth signals.
- `src/lib/south-bay/eventFilters.mjs`: virtual and registration normalization,
  shared by the ingest and the runtime safety net.
- `scripts/social/generate-schedule.mjs`: nightly adults/kids today/tomorrow
  hero generation; never rotates an anchor city.
- `scripts/newsletter/lib.mjs`: atomic validation and pillar-first rendering.
- `scripts/social/lib/poster-styles.mjs`: three paired graphic modules with
  activity-first hierarchy.

## Verification

Run `npm run test:plan-day`, the newsletter/post-generation/poster tests, and
`npm run build`. For a live check, POST to `/api/plan-day` in both regional and
city scopes and confirm all three reciprocal pairs, meal distances at or below
5 miles, and exact-city output for city scope.
