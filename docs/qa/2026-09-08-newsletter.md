# September 8 issue QA — Family Night, an appointment service, and a stale craft blurb

Scope: the September 8, 2026 daily issue's evening pick, afternoon plan card,
and "Also on the calendar" craft listing. Read the sent issue at
`southbaytoday.org/newsletters/2026-09-08` and verified every listed event and
recommended venue against its first-party source. No sent issue or archive was
rewritten; corrections land in current and future source data only.

## Official evidence

Verified September 8, 2026, approximately 4 AM Pacific.

- **Disney's Beauty and the Beast**, occurrence `inbound-b60351612d66d165`:
  [Broadway San Jose show page](https://www.broadwaysanjose.com/events/disneys-beauty-and-the-beast/).
  The run is September 8–13 at the San Jose Center for the Performing Arts and
  the Tuesday, September 8 curtain is 7:30 PM, both as published. The page also
  states: "Join us for Family Night on Broadway on Wednesday, September 9 at
  7:30 PM. All ticketholders for this performance will be invited to free
  pre-show activities from 6:00 PM to 7:15 PM." Family Night is the September 9
  performance only.
- The same page's schedule table carries per-performance accessibility icons,
  resolved against its own legend: September 9 closed caption, September 12
  matinee ASL interpreted, September 13 matinee audio described, September 13
  evening open caption. The existing blurbs on those four occurrences match the
  schedule and were left alone.
- **Community Preservation Lab Scanning Service**, occurrence `d610aa488850`:
  [Mountain View LibCal event](https://mountainview.libcal.com/event/17319757).
  "Registration is required to use this service... Appointments are limited to
  one per household per week. Register below for a 90-minute session for
  scanning services in the History Center." The page offers two September 8
  slots, 1:00–2:30 PM and 3:00–4:30 PM, each behind its own registration link.
- **Craft Tuesdays & Thursdays**, occurrences `sjpl-6a945a62be148200298b2cfb`
  and `sjpl-6a945a62be148200298b2cfc`:
  [SJPL event](https://sjpl.bibliocommons.com/events/6a945a62be148200298b2cfb).
  The library publishes the full series schedule on every occurrence: September
  8 is washi tape bookmarks and September 10 is bug headbands. Cactus characters
  (September 1) and beaded insects (September 3) had already happened.
- **Recommended venues**, all confirmed open and trading on a Tuesday:
  [Stan's Donut Shop](https://www.stansdonutshop.com/) (its posted holiday
  closures list Labor Day, September 7, not September 8),
  [Oren's Hummus Mountain View](https://orenshummus.com/pages/mountain-view)
  (daily 11 AM–11 PM), and [Smoking Pig BBQ](https://www.smokingpigbbq.net/).
- The issue's opening claim that the Cambrian Library sewing workshop makes
  heart plushies distributed to hospitalized children through The Giving Pine
  is supported verbatim by the SJPL description. No correction needed.

## Loss and correction

- **Family Night was advertised a day early.** The inbound City Newsletter
  record for opening night carried the Family Night sentence in its
  description, and the cached blurb turned it into a promise for September 8:
  "with pre-show activities for Family Night." The issue's field guide repeated
  it as "with Family Night pre-show activities if you're bringing kids." A
  reader who brought children to opening night for a 6 PM pre-show would have
  found none. The September 8 record now describes the run and its opening
  curtain, and the Family Night fact moves to the September 9 occurrence where
  it belongs, alongside that performance's closed captioning.
- **An appointment-only service was promoted as a walk-up plan card.** The
  LibCal ingest path sets no `registration` state, so a record whose own
  description says registration is required read as a walk-up. That made the
  scanning service eligible for the afternoon plan card, and the field guide
  told readers to "bring the shoebox of old family photos... and let library
  staff help you digitize them." The occurrence now carries
  `REGISTRATION_APPOINTMENT` plus a reader-facing attendance note, which
  re-engages the existing advance-registration gate in
  `scripts/newsletter/lib.mjs`: appointment-gated events are excluded from plan
  cards and Tonight's Pick and instead print an "Appointment required" tag in
  the listing sections.
- **A series blurb advertised crafts that were already over.** The cached blurb
  summarised the whole series rather than the session in front of the reader.
  Both remaining September occurrences now name their own craft.

## Known gap, not fixed here

The registration defect is systemic, not specific to this occurrence. Every
LibCal-sourced event lacks a `registration` state because that inference runs
only on the BiblioCommons path (`deriveBiblioRegistration` in
`scripts/generate-events.mjs`), even though `eventFilters.mjs` already has the
free-text `APPOINTMENT_PATTERNS` and `REGISTER_PATTERNS` needed to derive it.
All eight upcoming Community Preservation Lab occurrences and Mountain View's
"Landscape Design for Beginners" (whose description opens "Registration is
required") are affected today. Only the September 8 occurrence is corrected
here; the ingest-level fix and its tests are handed to a separate task.
