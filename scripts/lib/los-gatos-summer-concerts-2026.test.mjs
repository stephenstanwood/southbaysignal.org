import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LOS_GATOS_SUMMER_CONCERTS_2026,
  getLosGatosSummerConcerts,
  mergeLosGatosSummerConcerts,
} from "./los-gatos-summer-concerts-2026.mjs";

test("stores every first-party 2026 Los Gatos summer concert", () => {
  const music = LOS_GATOS_SUMMER_CONCERTS_2026.filter(
    (event) => event.series === "music-in-the-park",
  );
  const jazz = LOS_GATOS_SUMMER_CONCERTS_2026.filter(
    (event) => event.series === "jazz-on-the-plazz",
  );

  assert.equal(music.length, 6);
  assert.deepEqual(
    music.map((event) => [event.date, event.performer]),
    [
      ["2026-07-19", "The Houserockers"],
      ["2026-07-26", "Estero"],
      ["2026-08-02", "The BentPeter Band"],
      ["2026-08-09", "Lindsay and the Cheeks"],
      ["2026-08-16", "Miko Marks"],
      ["2026-08-23", "Harry and the Hitmen"],
    ],
  );

  assert.equal(jazz.length, 8);
  assert.deepEqual(
    jazz.map((event) => [event.date, event.performer]),
    [
      ["2026-07-08", "The Jazz Sophisticates Dance Orchestra"],
      ["2026-07-15", "Pacific Mambo Orchestra"],
      ["2026-07-22", "Tony Lindsay & The Soul Soldiers"],
      ["2026-07-29", "Jessica Johnson"],
      ["2026-08-05", "Full Spectrum Big Band"],
      ["2026-08-12", "Smoked Out Soul"],
      ["2026-08-19", "Pamela Parker's Fantastic Machine"],
      ["2026-08-26", "Gunhild Carling"],
    ],
  );
});

test("builds the remaining season with exact times, venues, and first-party links", () => {
  const events = getLosGatosSummerConcerts({ fromDate: "2026-07-19" });

  assert.equal(events.length, 12);
  assert.equal(new Set(events.map((event) => event.id)).size, 12);
  assert.ok(events.every((event) => event.city === "los-gatos"));
  assert.ok(events.every((event) => event.category === "music"));
  assert.ok(events.every((event) => event.cost === "free"));
  assert.ok(events.every((event) => event.endTime === "7:00 PM" || event.endTime === "8:30 PM"));
  assert.ok(events.every((event) => event.url.startsWith("https://")));
  assert.ok(events.every((event) => event.image.startsWith("https://")));

  const july29 = events.find((event) => event.id.endsWith("2026-07-29"));
  assert.equal(july29.time, "6:00 PM");
  assert.match(july29.description, /opening set/i);

  const august26 = events.find((event) => event.id.endsWith("2026-08-26"));
  assert.equal(august26.title, "Jazz on the Plazz - Gunhild Carling");
});

test("replaces wrong and duplicate series rows without touching unrelated events", () => {
  const unrelated = {
    id: "other",
    title: "Farmers Market",
    date: "2026-07-19",
    city: "los-gatos",
  };
  const input = [
    unrelated,
    {
      id: "bad-newsletter-row",
      title: "Music in the Park",
      date: "2026-07-19",
      time: "6:00 PM",
      city: "los-gatos",
      firstSeenAt: "2026-06-21T19:11:04.441Z",
    },
    {
      id: "generic-town-row",
      title: "Los Gatos Music in the Park",
      date: "2026-07-19",
      time: "5:00 PM",
      city: "los-gatos",
    },
    {
      id: "generic-jazz-row",
      title: "Jazz on the Plazz",
      date: "2026-07-22",
      time: "6:30 PM",
      city: "los-gatos",
    },
  ];

  const result = mergeLosGatosSummerConcerts(input, {
    fromDate: "2026-07-19",
    throughDate: "2026-07-22",
  });

  assert.equal(result.replacedCount, 3);
  assert.equal(result.addedCount, 0);
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0], unrelated);

  const music = result.events.find((event) => event.id.endsWith("2026-07-19"));
  assert.equal(music.title, "Music in the Park - The Houserockers");
  assert.equal(music.time, "5:00 PM");
  assert.equal(music.firstSeenAt, "2026-06-21T19:11:04.441Z");

  const jazz = result.events.find((event) => event.id.endsWith("2026-07-22"));
  assert.equal(jazz.title, "Jazz on the Plazz - Tony Lindsay & The Soul Soldiers");
  assert.equal(jazz.time, "6:30 PM");
});

test("keeps the committed event database aligned with the verified schedule", () => {
  const upcomingDocument = JSON.parse(
    readFileSync(
      new URL("../../src/data/south-bay/upcoming-events.json", import.meta.url),
      "utf8",
    ),
  );
  const archiveDocument = JSON.parse(
    readFileSync(
      new URL("../../src/data/south-bay/events-archive.json", import.meta.url),
      "utf8",
    ),
  );
  const upcoming = upcomingDocument.events;
  const archive = archiveDocument.events;

  // The event archive intentionally retains only 30 days. Anchor the expected
  // slice to this committed refresh instead of wall-clock time so the test stays
  // deterministic as older concerts age out of the database.
  const refreshedAt = new Date(archiveDocument.updatedAt || upcomingDocument.generatedAt);
  const archiveCutoff = new Date(refreshedAt);
  archiveCutoff.setDate(archiveCutoff.getDate() - 30);
  const archiveCutoffPt = archiveCutoff.toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
  const allExpected = getLosGatosSummerConcerts().filter(
    (event) => event.date >= archiveCutoffPt,
  );

  const scheduleRows = [...upcoming, ...archive].filter((event) =>
    event.id?.startsWith("los-gatos-music-in-the-park-") ||
    event.id?.startsWith("los-gatos-jazz-on-the-plazz-"),
  );

  assert.equal(scheduleRows.length, allExpected.length);
  assert.deepEqual(
    new Set(scheduleRows.map((event) => event.id)),
    new Set(allExpected.map((event) => event.id)),
  );

  for (const expected of allExpected) {
    const actual = scheduleRows.find((event) => event.id === expected.id);
    assert.ok(actual, `missing committed event ${expected.id}`);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(actual[key], value, `${expected.id}.${key}`);
    }
  }
});
