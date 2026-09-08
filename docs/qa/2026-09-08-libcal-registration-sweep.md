# LibCal registration sweep — the ingest fix behind the September 8 issue

Scope: the ingest-level defect left open by `docs/qa/2026-09-08-newsletter.md`.
LibCal-sourced events never carried a `registration` state, so every event from
Mountain View Public Library and Los Gatos Library reached the planner
indistinguishable from a drop-in storytime. Swept the full live feed from both
libraries and spot-checked the result against first-party event pages.

## What was wrong

`deriveBiblioRegistration` in `scripts/generate-events.mjs` derives registration
from BiblioCommons' structured `registrationInfo`, and `registrationFromMeetup`
does the same for Meetup's `rsvpState`. Nothing did it for LibCal. The guard in
`scripts/newsletter/lib.mjs` was already correct and already cited the Aug 12
2026 incident — it simply had nothing to gate, because
`requiresAdvanceRegistration()` reads a field the LibCal path never set.

The classifier is now `registrationFromLibCal` in
`src/lib/south-bay/eventFilters.mjs`, next to the BiblioCommons and Meetup ones
and reusing the same `APPOINTMENT_PATTERNS` / `REGISTER_PATTERNS` /
`DROP_IN_PATTERNS`. `scrapeLibCal` calls it.

Two other holes on the same path were closed while the field was being wired:

- `normalizePlaywrightEvent` is an allow-list, and it named neither
  `registration` nor `virtual`. `scrapeLibCal` has set `virtual` from LibCal's
  own `online_event` flag since it was written and **every one of those flags
  was discarded**; the nine online events in today's feed stayed out of plans
  only because their titles happen to say "Online" or "ONLINE". Both fields now
  survive, at the same position BiblioCommons events use.
- `stripHtml` removed `<style>` tags but not their contents, so all eight
  Community Preservation Lab descriptions carried a CSS rule set
  (`#s_lc_event_16714527 { background: #228B22; ... }`) into
  `playwright-events.json`. Readers were spared only by a later truncation.

## Evidence

Verified September 8, 2026, from `/ajax/calendar/list` on
[mountainview.libcal.com](https://mountainview.libcal.com/calendar) (244 events)
and [losgatosca.libcal.com](https://losgatosca.libcal.com/calendar) (225), 469
in total, honoring the `Crawl-delay: 10` in each host's robots.txt.

LibCal publishes `registration_enabled`, `online_registration` and
`in_person_registration` on that endpoint. Two things about that flag decided
the design:

1. **It is a reliable positive and a worthless negative.** All eight upcoming
   Community Preservation Lab occurrences report `registration_enabled: false`
   while [their own page](https://mountainview.libcal.com/event/17319757) says
   "Registration is required to use this service... Appointments are limited to
   one per household per week" and links two separately-booked 90-minute slots.
   The booking lives in the body copy, not in a LibCal form. Pages and Paws
   reports `true` on its October date and `false` on November and December —
   the flag tracks whether registration has *opened*, not whether it is needed.
2. **Text must be allowed to override it downward**, which is the opposite of
   the BiblioCommons rule, where `provider` names an actual registrar and text
   may not downgrade it. Seven Mountain View events carry the form *and* say
   "Registration is recommended. Seating is limited. Walk-ins are also
   welcome." — Ukulele Jam (3), Dogbotic Sound Petting Zoo, two estate-planning
   talks and a vegetable-gardening class. LibCal's form widget prints a stock
   "Registration is required. There are 21 seats available." banner on those
   same pages; the library's own sentence is the one that describes the door.

So `DROP_IN_PATTERNS` run first and beat every other signal. That also covers
Los Gatos' [Drop-In Tech Help](https://losgatosca.libcal.com/event/16035527) —
17 occurrences whose copy reads "No appointment is needed, we help patrons on a
first come first served basis", matching `APPOINTMENT_PATTERNS` on the very
word that says it is not one. Same discipline as the "Open Lab Hours" qualifier
on the admin-hours rule in `generate-events.mjs`: a false positive here quietly
removes a good event from the plan, which is the opposite failure and just as
bad.

### The one qualifier this needed

Unlike the other two classifiers, this one has no dedicated instructions field
to read — only the whole event description, which also carries prose that has
nothing to do with attending. Four Los Gatos book clubs invite readers to "sign
up for our Cookbook Club newsletter" / "Sign up for our newsletter here" /
"Subscribe to our Mystery News newsletter", and Monday Morning Book Club adds
"new members are welcome at any time". Matching a mailing-list plug as event
registration would have gated four genuine drop-in book clubs. The clause is
redacted before matching rather than the event skipped, so a description
carrying both a plug and a real instruction still gates on the instruction.

## Result

| State | Events | Label |
| --- | ---: | --- |
| `none` | 381 | — |
| `required` | 77 | Reserve ahead |
| `appointment-only` | 11 | Appointment required |
| `full` | 0 | — |
| `closed` | 0 | — |

88 of 469 (19%) across 43 distinct programs. LibCal publishes no registration
deadline on this endpoint, so no `registrationClosesBy` is derived and neither
`full` nor `closed` is reachable from this path.

The eight Community Preservation Lab occurrences land `appointment-only`
(`d610aa488850`, `beafbf0a38b7`, `b7c1ea7f055a`, `22a65f59e0b7`,
`a0b6ae3454e6`, `dbf05ae12f85`, `c5f16f14946d`, `f61d141f208b`) and
[Landscape Design for Beginners](https://mountainview.libcal.com/event/14959849)
(`ecadbadee33e`) lands `required`, as specified.

Largest movers: Girls Who Code (14, Los Gatos — "Email:
signup@gwc-losgatos.org to register"), ESL Conversation Club in-person and
online (12 each, Mountain View — "Registration is required. There are 12 seats
available"), Community Preservation Lab (8), Pages and Paws (3 —
"Registration is required. There are 7 seats available", with a confirmed
time-slot). The remaining 39 programs are 1–2 occurrences each: author talks,
maker classes, workshops.

## Spot checks against first-party pages

Ten events fetched individually and read against their live LibCal page.

| Event | Derived | Page says |
| --- | --- | --- |
| [Community Preservation Lab](https://mountainview.libcal.com/event/17319757) | `appointment-only` | "Registration is required… Click Here to Register for 1:00pm to 2:30pm / 3:00pm to 4:30pm" ✓ |
| [Landscape Design for Beginners](https://mountainview.libcal.com/event/14959849) | `required` | "Registration is required" + Begin Registration ✓ |
| [ESL Conversation Club — in person](https://mountainview.libcal.com/event/15895389) | `required` | "Registration is required. There are 12 seats available" ✓ |
| [Sci-Fi Trivia Night](https://mountainview.libcal.com/event/17211493) | `required` | "Registration is required" + Begin Registration ✓ |
| [Bug Power with Beetlelady!](https://losgatosca.libcal.com/event/17088146) | `required` | "registration is required (registration opens 3 weeks prior)" ✓ |
| [Girls Who Code](https://losgatosca.libcal.com/event/17444935) | `required` | no LibCal form; "Email: signup@gwc-losgatos.org to register" ✓ |
| [Ukulele Jam](https://mountainview.libcal.com/event/17028027) | `none` | "Registration is recommended… Walk-ins are also welcome" ✓ |
| [Drop-In Tech Help](https://losgatosca.libcal.com/event/16035527) | `none` | "No appointment is needed… first come first served" ✓ |
| [Outdoor Storytime](https://mountainview.libcal.com/event/17142482) | `none` | "All ages welcome, no registration required" ✓ |
| [Cookbook Club](https://losgatosca.libcal.com/event/17376577) | `none` | no registration of any kind; two newsletter plugs ✓ |

One knowingly-accepted imprecision: Pages and Paws is labelled "Appointment
required" rather than "Reserve ahead", because `APPOINTMENT_PATTERNS` matches
"one-on-one reading time with a therapy dog" — prose about the experience, not
the booking. The gate is identical either way and the page does assign a
confirmed time-slot, so the label is defensible; loosening the shared pattern
to satisfy one event would cost real appointment detection elsewhere.

## Data

`playwright-events.json` and `upcoming-events.json` were backfilled in place
from the same live rows, so the fix applies to the next issue rather than
waiting on a Mini re-scrape: 84 gated events in the scrape snapshot, 61 of them
surviving into the published feed (the rest are online-only, off-horizon, or
deduped away). The eight CSS-contaminated descriptions were repaired at the
same time. No sent newsletter or archive was touched.
