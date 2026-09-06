import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { libraryEventDetails } from "./library-event-details.mjs";
import { classifyAudienceAge } from "../../src/lib/south-bay/audienceAge.mjs";
import { applyVerifiedEventFacts } from "../../src/lib/south-bay/eventSourceFacts.mjs";
import { requiresAdvanceRegistration, requiresAttendanceConfirmation } from "../../src/lib/south-bay/eventFilters.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/library-attendance-2026-09-06.json", import.meta.url)));

test("normal library adapters preserve late attendance paragraphs and structured audiences", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-06T12:00:00Z") });
  const { fetchBiblioEvents } = await import("../generate-events.mjs");
  const { scrapeLibCal, normalizePlaywrightEvent } = await import("../playwright-scrapers.mjs");
  t.mock.method(globalThis, "fetch", async (url) => {
    const data = String(url).includes("bibliocommons") ? fixture.bibliocommons : fixture.libcal;
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  });

  const [rawDerby] = await fetchBiblioEvents("sjpl", "San Jose Public Library", () => "san-jose");
  assert.equal(rawDerby.time, "2:00 PM");
  assert.match(rawDerby.description, /Elementary School Students 5 to 10/);
  assert.match(rawDerby.attendanceNote, /12 tickets.*30 minutes.*12:30 p\.m\./);
  assert.equal(classifyAudienceAge(rawDerby), "kids");
  const derby = applyVerifiedEventFacts(rawDerby);
  assert.equal(requiresAdvanceRegistration(derby), false);
  assert.equal(requiresAttendanceConfirmation(derby), true);
  assert.match(derby.attendanceNote, /confirm pickup timing/);
  assert.doesNotMatch(derby.description + derby.attendanceNote, /12:30|1:30/);

  const [scrapedNarcan] = await scrapeLibCal(null, {
    name: "Los Gatos Library", city: "los-gatos", address: "110 E Main St, Los Gatos, CA 95030",
    urls: ["https://losgatosca.libcal.com"], onsiteLocations: [],
  });
  const narcan = normalizePlaywrightEvent(scrapedNarcan);
  assert.equal(narcan.id, "cbdd438d7fbe", "the occurrence ID must remain stable");
  assert.equal(narcan.time, "4:00 PM");
  assert.equal(narcan.endTime, "5:00 PM");
  assert.deepEqual(narcan.sourceAudiences, ["Adults"]);
  assert.equal(classifyAudienceAge(narcan), "adult");
  assert.match(narcan.description, /how to use Narcan/);
  assert.doesNotMatch(narcan.description, /<p>|&nbsp;/);
  // The audience fix belongs to the adapter, not just the September 6 override.
  assert.equal(classifyAudienceAge({ ...narcan, id: "next-occurrence", date: "2026-10-04" }), "adult");
});

test("same-day tickets stay distinct from advance registration and ordinary drop-ins", () => {
  const details = libraryEventDetails({ definition: {
    description: "<p>Learn about cats.</p><p>Limited space; tickets at the Information Desk starting at 1 PM.</p>",
  } });
  assert.equal(details.attendanceNote, "Limited space; tickets at the Information Desk starting at 1 PM.");
  assert.equal(requiresAdvanceRegistration(details), false);
  assert.equal(requiresAttendanceConfirmation(details), false);
  assert.equal(libraryEventDetails({ description: "<p>Drop in for board games.</p>" }).attendanceNote, undefined);
});
