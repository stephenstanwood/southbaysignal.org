# September 5 newsletter source corrections

Scope: four source records and the paths that turn them into event blurbs and
newsletter recommendations. The sent email and frozen archive are historical
records and were not edited. No Gmail access or sending was involved.

## First-party evidence

| Event | Source and observation | Correction |
| --- | --- | --- |
| Grupo Duelo | [San Jose Theaters](https://sanjosetheaters.org/event/grupo-duelo-gravedad-tour-2026/), fetched 2026-09-05 at 12:14:58 UTC: September 5, 8 PM, San Jose Civic; norteño. | Restore the sourced genre in description and blurb. Reject unsupported banda claims in generated copy. |
| Lost 80s Live | [Tour organizer](https://lost80slive.com/event/mwc09052026/) and [AXS](https://www.axs.com/events/1339897/lost-80s-live-tickets), checked during the 12:10–12:15 UTC source pass: September 5 at Mountain Winery; show 6 PM, doors 4 PM. The bill includes Oingo Boingo Former Members, The Vapors, China Crisis, Big Country, B-Movie, Katrina, Icicle Works and Musical Youth. | Use the organizer occurrence URL, preserve 6 PM, and remove the invented cover-band identity. An inaccessible Ticketmaster fetch was not treated as a dead link. |
| Midpen Thistle Removal | [Occurrence page](https://www.openspace.org/events/volunteer-projects/habitat-restoration-thistle-removal-25) redirects to [project 1294116](https://volunteer.openspace.org/need/detail/?need_id=1294116). The normal application fetch at **12:16:53.995 UTC / 5:16:53 AM PT** returned **3 open spots**, September 5, 9:30 AM–1:30 PM, advance registration required. Earlier MILO and web-extractor observations showed zero. | Keep the freshest observed state as `required`; parse the actual capacity section on every refresh and newsletter check. Zero becomes `full`, positive counts become `required`, and missing capacity preserves a previous full state. Do not infer availability when the email was sent. |
| Town Cats | [SJPL event API](https://gateway.bibliocommons.com/v2/libraries/sjpl/events?ids=6a5280ebe564853d00fd6ea4), fetched at 12:14:57 UTC: September 5, 2–3 PM, not cancelled; recommended ages 5+, limited space, Information Desk ticket pickup from 1 PM. Capacity is 20, but no registration provider is set. | Put the pickup time and location in the blurb and editor packet. Retain the distinction between same-day in-person tickets and advance registration. |

The small live Midpen capacity fragment is retained at
`scripts/lib/fixtures/midpen-volunteer-spots.html`. Tests derive the zero-spots
variant from it and separately cover generic conditional waitlist instructions,
unknown markup, HTTP failure, reopening, and unaffected guided activities.

## Implementation and verification

- Exact-date source corrections run before ingest blurb resolution and newsletter
  assembly. Old sparse-description cache keys are removed rather than attaching
  this occurrence's lineup or ticket-pickup time to future occurrences.
- The newsletter checks today's gated pool before selection, supplies source
  descriptions and attendance information to its editor, and excludes full
  events from editorial recommendations. A final check removes stale intro
  recommendations if a selected listing fills or closes while editing runs.
- Cached and new blurbs, editorial output, and the HTML render boundary reject
  the unsupported performer claims exercised by the regression tests.
- `npm test`: 919 tests passed. Focused source, cache, registration, and newsletter
  tests also passed after the final review adjustments.
- `npm run build`: passed, including both existing prebuild gates.
- A new deterministic September 5 newsletter plus focused available/full
  previews were rendered at 600 and 390 pixels. All six browser checks had
  document width equal to viewport width. Mobile copy and labels were visually
  reviewed. These are QA previews, not a replacement sent issue.

Local raw captures, full test/build logs, preview HTML and screenshots are in
`.snapshots/newsletter-2026-09-05/` in the retained task worktree. That directory
is intentionally ignored. The checked-in fixture and this note retain the
useful source evidence without committing third-party pages or frozen mail.

Initial archive SHA-256, fetched at 12:14:58 UTC:
`2c8dbb21fb9fb9e975bcd8a369d226c32373a835740d1bad12fc46d96b1a66c2`.

Work began from freshly fetched `origin/main` at `e66f5a88`, in an isolated
worktree inside the SBT repository. The documented shared `repo-lock.sh` is
Mini-local; this MacBook worktree does not mutate the Mini checkout or its lock.
