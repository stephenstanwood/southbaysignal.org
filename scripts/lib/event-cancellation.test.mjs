import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isBiblioEventCancelled, looksCancelled } from "../generate-events.mjs";

const KNIT_ALONGS_CANCELLED_AUG_7 =
  "Cupertino Knit Alongs Cancelled August 7 and August 14. Dear Cupertino Knitters and Crocheters, There will be no Knit Alongs On Friday August 7 and Friday, August 14.";

const KNIT_ALONGS_CANCELLED_AUG_14 =
  "Dear Cupertino Knitters and Crocheters, There will be no Knit Alongs On Friday August 7 and Friday, August 14. We will resume on our normal schedule on Friday, August 21st.";

test("SCCL Knit Alongs cancellation notices match body patterns", () => {
  assert.equal(looksCancelled(KNIT_ALONGS_CANCELLED_AUG_7, null), true);
  assert.equal(looksCancelled(KNIT_ALONGS_CANCELLED_AUG_14, null), true);
});

test("Ticketmaster-style cancellation copy still matches", () => {
  assert.equal(
    looksCancelled("Unfortunately, the Event Organizer has had to cancel your event.", null),
    true,
  );
  assert.equal(looksCancelled("This show has been cancelled. Refunds will be issued.", null), true);
});

test("registration boilerplate does not look cancelled", () => {
  assert.equal(
    looksCancelled("No registration or sign up required. There will be no charge for this event.", null),
    false,
  );
});

test("BiblioCommons isCancelled flag marks inactive occurrences", () => {
  assert.equal(isBiblioEventCancelled({ definition: { isCancelled: true } }), true);
  assert.equal(isBiblioEventCancelled({ definition: { isCancelled: false } }), false);
  assert.equal(isBiblioEventCancelled({ definition: {} }), false);
  assert.equal(isBiblioEventCancelled(null), false);
});

test("canonical upcoming data omits cancelled Cupertino Knit Alongs dates", () => {
  const upcoming = JSON.parse(readFileSync(
    new URL("../../src/data/south-bay/upcoming-events.json", import.meta.url),
    "utf8",
  ));
  const cancelledKnitAlongIds = new Set([
    "sccl-69309193caa2e62f001e8bb7",
    "sccl-69309193caa2e62f001e8bb8",
  ]);
  const hits = (upcoming.events || []).filter((event) => cancelledKnitAlongIds.has(event.id));
  assert.deepEqual(hits, []);
});
