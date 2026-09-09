# September 9 issue QA — the playdate sentence was right, the guard was not

Scope: the September 9, 2026 daily issue's "Also on the calendar" intro
(`editorial.eventsNote`). The sentence was reported as a hallucination:

> Only the Palo Alto opera preview asks for advance registration; the downtown
> market and the Seven Trees playdate run every Wednesday, and this week's
> playdate is the superhero obstacle course for ages 3 to 8.

No sent issue or archive was rewritten. The finding below changed the fix, not
the issue.

## The sentence is source-grounded

Verified September 9, 2026 against the first-party listing.

- **Playdates for Children and Their Caregivers**, occurrence
  `sjpl-6a347d087550c8bf9f5e649a`, Seven Trees Library, 11:00 AM:
  [SJPL BiblioCommons](https://sjpl.bibliocommons.com/events/6a347d087550c8bf9f5e649a).
  Its description — served in `og:description`, and byte-identical in every
  committed copy of `upcoming-events.json` back through `e77a9d6c` — publishes
  the series rotation in full:

  > 1st Wednesday: Cars  2nd Wednesday: Superhero Obstacle Course (ages 3-8)
  > 3rd Wednesday: LEGO® DUPLO® Blocks  4th Wednesday: Cars  5th Wednesday:
  > LEGO® DUPLO® Blocks   Recommended for children ages 2 – 6 years old.

- September 2026's Wednesdays are the 2nd, 9th, 16th, 23rd and 30th, so
  **September 9 is the 2nd Wednesday** and its activity is the superhero
  obstacle course, gated at ages 3-8 by the source's own parenthetical. The
  issue did that ordinal arithmetic and got it right.

The strings are absent from `southbaytoday.org/events/2026-09-09` because the
rendered card shows the short `blurb`, not the `description` the generator
reads. Absence from the page is not evidence of invention: the guard runs on
the event record. The library's audience tag ("Young Children, ages 0-5") and
its recommended span ("ages 2 – 6") disagree with the per-session gate, which
is SJPL's own looseness, not the newsletter's.

## The real defect: two gaps in the guard

Both in `src/lib/south-bay/eventSourceFacts.mjs`, reached from
`repairNewsletterEventFacts()` in `scripts/newsletter/lib.mjs`.

1. **`copyMentionsEvent` never matched.** It required the copy to contain the
   whole comparable title ("playdates for children and their caregivers") or a
   colon-prefixed suffix. The intro said "the Seven Trees playdate" — venue
   plus head noun, no colon in the title — so the event was skipped, and with
   it every guard hanging off that match: attendance confirmation, closed
   registration, and the existing fact conflicts. The sentence happened to be
   true; nothing in the pipeline was checking.

2. **`eventCopyFactConflict` had no age or per-session activity checks.** It
   detected three hard-coded music-identity patterns only. A wrong-week or
   invented age claim was invisible.

## What changed

- `copyMentionsEvent` gained a venue-core plus title-head-noun path, requiring
  **both** halves. A venue alone matches every event at that address; a head
  noun alone matches every playdate in the county.
- `eventCopyFactConflict` gained two source-grounded checks:
  - an **age range** in the copy outside the widest span the event's own
    title, description, attendance note or audience tags vouch for;
  - a **per-session activity** that is absent from the source, or that belongs
    to a different session of a published rotation. Both schedule shapes are
    parsed: ordinal weekday ("2nd Wednesday: …") and calendar date ("Thursday,
    September 10: …").
- Claims are attributed by sentence, so a range that is right about one event
  is not validated against another the same sentence mentions.

This subsumes the wrong-week class that the `CORRECTIONS` table carries by
hand. The Craft Tuesdays & Thursdays entries exist because a cached blurb
advertised the previous session's craft; that is now derivable from the source,
so future occurrences of the same failure need no hand-entry. The existing
entries were left in place — they also supply blurbs the source does not.

## Regression coverage

`src/lib/south-bay/eventSourceFacts.test.mjs` pins the shipped sentence as copy
that must **not** be blanked, alongside wrong-week, invented-age and
invented-activity variants that must be. The whole live feed is a fixture: no
blurb in `upcoming-events.json` trips the new guards.

## Verified clean, unchanged

Beauty and the Beast Family Night (7:30 PM, free pre-show 6:00–7:15, closed
captioned), Bollywood Dance walk-ins, the Downtown Farmer's Market at 1:00 PM,
September 12 as a Saturday for both Around Town items, the advance-registration
count, Daybreak Donuts and Smoking Pig BBQ hours.
