// Tests for audienceAge classifier — pinned to lock in the cycle-174 fix
// where /\b21\s*\+\b/ silently matched nothing because \b after a non-word
// "+" only fires when followed by a word char (and real "21+" copy is
// followed by space/punct/EOL). Pattern lost its trailing \b in the fix.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyAudienceAge } from "./audienceAge.mjs";

const ev = (title, description = "") => ({ title, description });

test("library audience labels survive sparse or misleading descriptions", () => {
  assert.equal(classifyAudienceAge({ title: "STEM: Balloon Car Derby", sourceAudiences: ["Kids, ages 5-10"] }), "kids");
  assert.equal(classifyAudienceAge({ title: "Narcan Training at the Library", description: "Families across the country…", sourceAudiences: ["Adults"] }), "adult");
  assert.equal(classifyAudienceAge({ title: "A library program", sourceAudiences: ["Children", "Adults"] }), "all");
  assert.equal(classifyAudienceAge({ title: "A library program", sourceAudiences: ["All Ages"] }), "all");
  assert.equal(classifyAudienceAge({ title: "A library program", sourceAudiences: ["Ages 5–10"] }), "kids");
  assert.equal(classifyAudienceAge({ title: "A library program", sourceAudiences: ["Unknown label"] }), "all");
});

test("21+ trailing-context variants all classify as adult", () => {
  // These all need to fire — they're what real Ticketmaster blurbs look like.
  // The pre-fix regex required a word char after "+", which made all of
  // these miss and tag as "all".
  assert.equal(
    classifyAudienceAge(ev("The Emo Night Tour", "Coming to The Ritz! *21+..... Doors 8pm.")),
    "adult",
  );
  assert.equal(
    classifyAudienceAge(ev("Reggaeton Fiesta", "🍑 21+ Dame Ms Gasolina")),
    "adult",
  );
  assert.equal(classifyAudienceAge(ev("Late Night Comedy", "21+ event tonight.")), "adult");
  assert.equal(classifyAudienceAge(ev("Whiskey Pour", "18+ only, ID required.")), "adult");
});

test("21 and over / adults only still classify as adult", () => {
  assert.equal(classifyAudienceAge(ev("Wine Walk", "21 and over.")), "adult");
  assert.equal(classifyAudienceAge(ev("Speakeasy Night", "Adults only.")), "adult");
});

test("kids signals still win on kids-only events", () => {
  assert.equal(classifyAudienceAge(ev("Toddler Story Time", "Ages 2-4.")), "kids");
  assert.equal(classifyAudienceAge(ev("Kindergarten Craft Hour", "")), "kids");
});

test("ambiguous / default cases stay 'all'", () => {
  assert.equal(classifyAudienceAge(ev("Saturday at the Park", "Family friendly afternoon.")), "all");
  assert.equal(classifyAudienceAge(ev("Live Music at the Brewery", "Beer garden open, food trucks.")), "all");
});

test("childcare-for-ages phrase does not classify the parent event as kids", () => {
  // "Community Equity Assessment Forum" leaked into kids plans because the
  // description mentioned "childcare available for ages 4+" — the forum is
  // for adults, the childcare is a service for their kids. Strip the phrase.
  assert.equal(
    classifyAudienceAge(
      ev("Community Equity Assessment Forum", "Share feedback on city programs. Light refreshments provided; childcare available for ages 4+."),
    ),
    "all",
  );
  assert.equal(
    classifyAudienceAge(ev("Town Hall", "Childcare provided for ages 3+ during the meeting.")),
    "all",
  );
  // Real kids event still classifies as kids
  assert.equal(
    classifyAudienceAge(ev("Storytime", "Ages 4+ welcome to listen and read along.")),
    "kids",
  );
});

test("senior age phrases do NOT classify as kids", () => {
  // Before the digit-bound fix, /\bages?\s+\d{1,2}\+?\b/ matched "ages 50+",
  // "ages 55+", and "ages 65+" — silently tagging senior programs as kids.
  // Caught real misfires: "Rodent Prevention 101" (ages 55+), "Next Gen
  // Seniors - Google Search Skills" (ages 50+), "Trees and Wellness" (ages 55+).
  assert.equal(
    classifyAudienceAge(ev("Rodent Prevention 101", "Workshop for ages 55+ on rodent prevention.")),
    "all",
  );
  assert.equal(
    classifyAudienceAge(ev("Senior Tech Help", "Free for ages 50+; pre-registration required.")),
    "all",
  );
  assert.equal(
    classifyAudienceAge(ev("Community Forum", "Open to ages 18-65.")),
    "all",
  );
  // Kid ages still classify as kids
  assert.equal(classifyAudienceAge(ev("Kids Yoga", "Ages 5+ welcome.")), "kids");
  assert.equal(classifyAudienceAge(ev("Tween Hangout", "Ages 10-13.")), "kids");
  // "Teen Lounge ages 13 and up" — "ages 13 and up" no longer fires the open
  // pattern (capped at 12), but the new teen-lounge signal catches the title.
  assert.equal(classifyAudienceAge(ev("Teen Lounge", "Ages 13 and up.")), "kids");
});

test("open-ended teen+ phrases stay 'all' when no kid context", () => {
  // "ages 13+" / "ages 13 and up" are semantically open-ended and often
  // describe events where adults are welcome too — capping the open-ended
  // forms at age 12 keeps these out of the kids pool.
  //
  // Real misfire: SCC Library "Open Mic" with "all levels and ages 13+"
  // tagged kids because /\bages?\s+\d+\+?\b/ matched "ages 13+", which
  // filtered the event out of every adult plan.
  assert.equal(
    classifyAudienceAge(
      ev("Open Mic", "Share your musical talents in a safe, inviting community of players of all levels and ages 13+."),
    ),
    "all",
  );
  assert.equal(
    classifyAudienceAge(ev("Community Open Mic", "All skill levels welcome, ages 14 and up.")),
    "all",
  );
  // True teen-only programs still classify via the teen-program signal
  // (lounge/club/hangout/meetup/program), not the age phrase alone.
  assert.equal(classifyAudienceAge(ev("Teen Hangout", "Open to teens.")), "kids");
});

test("'X for Kids' titles classify as kids (end-of-title anchor)", () => {
  // Real misfires: "Knitting Club for Kids", "Origami for School Age Kids",
  // "Zumba Class for Kids", "Voices of Pasifika: Ukulele for Kids" all
  // tagged "all" because the existing KIDS_SIGNALS regex matches "Kids
  // Knitting" / "Kids Club" but not the trailing-audience form. Title-only
  // pattern catches the trailing form without false-positiving on
  // descriptions like "great for kids and adults".
  assert.equal(classifyAudienceAge(ev("Knitting Club for Kids", "")), "kids");
  assert.equal(classifyAudienceAge(ev("Zumba Class for Kids", "")), "kids");
  assert.equal(classifyAudienceAge(ev("Origami for School Age Kids", "")), "kids");
  assert.equal(classifyAudienceAge(ev("Voices of Pasifika: Ukulele for Kids", "")), "kids");
  assert.equal(classifyAudienceAge(ev("Storytime for Toddlers", "")), "kids");
  assert.equal(classifyAudienceAge(ev("Craft Hour for Preschoolers!", "")), "kids");

  // Description-only "for kids" stays "all" — mixed-audience copy shouldn't
  // hard-flip to kids-only.
  assert.equal(
    classifyAudienceAge(ev("Summer Concert Series", "Family event — great for kids and adults alike.")),
    "all",
  );
  // "For Kids in Need" donation/charity title isn't actually a kid program.
  // The trailing-audience anchor requires "kids" at the end (allowing a few
  // closing punctuation chars), so "for Kids in Need" doesn't match.
  assert.equal(
    classifyAudienceAge(ev("Coat Drive for Kids in Need", "Volunteer to sort donations.")),
    "all",
  );
});

test("'ages 12 to 25' young-adult ranges do NOT classify as kids", () => {
  // Real misfire: "allcove x PACL Book Club" "open to young people ages 12
  // to 25" tagged kids because the bare "ages 12" regex matched the lower
  // bound while the upper bound (25) escaped the range pattern.
  //
  // Anti-range lookahead on the bare "ages X" regex now refuses to fire
  // when the age is followed by a range separator (- or "to"), so the
  // young-adult upper bound isn't ignored.
  assert.equal(
    classifyAudienceAge(
      ev("allcove x PACL Book Club", "This program is open to young people ages 12 to 25. Read any Jane Austen novel."),
    ),
    "all",
  );
  assert.equal(
    classifyAudienceAge(ev("Pottery for Beginners", "Open to ages 10 to 30.")),
    "all",
  );
  // Pure kid ranges still classify (upper bound ≤18 — the new range cap)
  assert.equal(
    classifyAudienceAge(ev("Teen Leadership Group", "For teens ages 13 to 18.")),
    "kids",
  );
  // Kid range with hyphen separator
  assert.equal(
    classifyAudienceAge(ev("Story Club", "For kids ages 6-10.")),
    "kids",
  );
});
