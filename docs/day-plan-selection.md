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
