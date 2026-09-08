import test from "node:test";
import assert from "node:assert/strict";

import { isTechEvent } from "./techEventFilter";

test("keeps real talks, workshops, and meetups", () => {
  const keep = [
    "Learning to Use Motion Capture with AI",
    "Bay Area AI Artists Group Monthly Meetup",
    "AI Scams & Misinformation: How to Spot What's Real",
    "Simple Steps for Starting Your Business: Startup Basics",
    "Cultivating AI Literacy in the Classroom",
  ];
  for (const title of keep) {
    assert.equal(isTechEvent({ title }), true, title);
  }
});

test("drops library one-on-one tech-help appointments under every name they use", () => {
  // All five were live on the Tech tab's five-slot upcoming list on 2026-09-08,
  // crowding out the actual talks. "1-on-1" and "one-on-one" were already
  // excluded; the colon, spaced, and bare-name forms were not.
  const drop = [
    "1:1 Tech Mentor",
    "1 on 1 Tech Assistance / Asistencia Tecnología",
    "Tech Mentor",
    "1-on-1 Tech Help",
    "One-on-One Tech Coach",
  ];
  for (const title of drop) {
    assert.equal(isTechEvent({ title }), false, title);
  }
});

test("qualifies Computer History Museum programming on venue alone", () => {
  assert.equal(
    isTechEvent({ title: "Fellow Awards Ceremony", venue: "Computer History Museum" }),
    true,
  );
});

test("ignores events with no tech signal at all", () => {
  assert.equal(isTechEvent({ title: "Toddler Story Time" }), false);
  assert.equal(isTechEvent({ title: "Farmers Market" }), false);
});
