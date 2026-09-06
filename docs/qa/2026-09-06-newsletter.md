# September 6 library attendance corrections

Scope: the Balloon Car Derby and Narcan Training records, library ingest, and
downstream newsletter/planner use. Started from fetched `origin/main` at
`d54329c6` in an isolated MacBook worktree. No Gmail access, sending, or archive
publishing occurred.

## Official evidence

Verified again on September 6, 2026, approximately 5 AM Pacific:

- **STEM: Balloon Car Derby**, occurrence `sjpl-6a7bc1324cb69d003e203e28`:
  [SJPL event](https://sjpl.bibliocommons.com/events/6a7bc1324cb69d003e203e28)
  and [official API](https://gateway.bibliocommons.com/v2/libraries/sjpl/events?ids=6a7bc1324cb69d003e203e28).
  September 6, 2–3:30 PM, Berryessa Library Community Room, not cancelled.
  `definition.audienceIds` resolves through `entities.eventAudiences` to
  `Kids, ages 5-10`; the description recommends elementary students ages 5–10.
  The description limits admission to 12 first-come, first-served tickets.
  **Unresolved source conflict:** its pickup instruction says both
  “30 minutes before the program” and “at 12:30 p.m.” while the structured
  occurrence starts at 2 PM. Neither 12:30 PM nor a calculated 1:30 PM is
  published as the pickup time. The event keeps its 2 PM start, a reader-facing
  confirmation note, and `attendanceStatus: needs-confirmation`.
- **Narcan Training at the Library**, occurrence `cbdd438d7fbe`:
  [official event](https://losgatosca.libcal.com/event/17096186) and
  [public calendar feed](https://losgatosca.libcal.com/ajax/calendar/list?c=-1&date=&perpage=100&page=1&audience=&cats=&camps=&inc=0).
  September 6, 4–5 PM, Los Gatos Library Lobby. The page and feed both label
  the audience `Adults`; the record now classifies as `adult`.

The compact fixture at
`scripts/lib/fixtures/library-attendance-2026-09-06.json` retains the relevant
official payload fields and original conflicting description. Contact details
and unrelated events are omitted. Raw captures and QA artifacts remain in the
ignored `.snapshots/newsletter-2026-09-06/` directory in this worktree.

## Loss and correction

- BiblioCommons shortened the description to its opening paragraph, read the
  wrong audience shape (`ev.audiences`), and omitted description-based ticket
  instructions. Both BiblioCommons adapters now preserve full source prose,
  resolve the actual audience entities, and extract attendance paragraphs.
- LibCal used audience labels only for a kids boolean and discarded the actual
  labels and description. The snapshot normalizer omitted those fields too.
  They now survive the scraper, snapshot normalization, and final ingest.
- The final audience classifier uses structured source audiences before prose
  heuristics. Verified occurrence facts apply before classification and blurb
  resolution. Only the two affected live rows, the Narcan source snapshot row,
  and their blurb-cache entries were corrected; refresh timestamps were not
  advanced to imply a full source refresh.
- The derby is excluded from planner candidates, newsletter selections and
  editor candidates. Cached newsletter pair plans are rejected as a whole if
  they contain an occurrence awaiting attendance confirmation. The render
  guard also catches an intro that omits the `STEM:` title prefix.
- Attendance notes render independently of generated blurbs. Listings remain
  available with their source-backed age and attendance information. Same-day
  tickets remain distinct from advance registration; Town Cats retains its
  previously verified Information Desk pickup instruction.

## Verification

- `npm test`: **925 passed**, zero failures. A final focused run of source-fact
  and newsletter tests passed **72/72** after the abbreviated-title guard.
- `npm run build`: passed both existing prebuild gates and the Astro/Vercel
  build. Local Node 26 produces the existing Vercel Node 24 runtime notice.
- Fixture-backed integration runs the actual BiblioCommons and LibCal
  adapters, snapshot normalizer and audience classifier. Sparse-ingest/blurb
  regressions prove refreshes retain the exact correction while later
  occurrences do not inherit its hold or ticket timing. A full 20+ source
  network refresh was not needed for this two-occurrence correction.
- The real planner pool excludes the derby in adult and kids modes, and
  excludes the adult Narcan program from kids mode.
- A newly assembled deterministic September 6 newsletter excludes the derby.
  A separate listing preview verifies both age labels and the ticket note.
  These previews are local QA artifacts, not replacement sent issues.
- **10 browser checks**: event detail pages and the Events date-view card at
  1440/390 px; current/listing newsletter previews at 600/390 px. Every
  document fits its viewport. Mobile event and newsletter copy was visually
  reviewed; no guessed pickup clock time appears. The derby card has no
  `Plan day` action while attendance needs confirmation.
- An additional search attempt exposed an existing `EventsView.matchesFilters`
  crash when a different event's `venue` is null. The null records are present
  in untouched `origin/main` (for example `c6365d20a15a`, Pumpkin Pool-ooza).
  That unrelated search defect was not changed. Card verification used the
  normal date view, which renders the corrected listing successfully.

Frozen archive SHA-256 before shipping, identical to MILO's earlier capture:
`47e056092f0fddf08c8c845bec7bb9f9e34cb7e5f31ebe87f591b2228fb9f2ee`.
The already-sent issue and its frozen archive remain untouched.
