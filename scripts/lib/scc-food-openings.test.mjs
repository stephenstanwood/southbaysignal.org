import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyFinalInspection,
  isAddressDerivedBusinessName,
  isVerifiedOpeningRecord,
  normalizeSouthBayAddress,
} from "./scc-food-openings.mjs";

test("normalizes De Anza street names from SCC permit spelling", () => {
  assert.equal(normalizeSouthBayAddress("1655 S Deanza Blvd"), "1655 S De Anza Blvd");
  assert.equal(normalizeSouthBayAddress("South Deanza Boulevard"), "South De Anza Boulevard");
});

test("collapses a street number SCC repeated at the front of the address", () => {
  // Spice Fusion, Sunnyvale, 2026-08-12 shipped as "1026 1026 W Evelyn Ave".
  assert.equal(normalizeSouthBayAddress("1026 1026 W Evelyn Ave"), "1026 W Evelyn Ave");
  assert.equal(normalizeSouthBayAddress("1205 1205 Camino Ramon"), "1205 Camino Ramon");
});

test("leaves address numbers that only look duplicated alone", () => {
  assert.equal(normalizeSouthBayAddress("1 1st St"), "1 1st St");
  assert.equal(normalizeSouthBayAddress("82-96 E Santa Clara St."), "82-96 E Santa Clara St.");
  assert.equal(normalizeSouthBayAddress("1205 Camino Ramon"), "1205 Camino Ramon");
  // A repeat that isn't at the front is real data, not a concatenation artifact.
  assert.equal(normalizeSouthBayAddress("100 W 100 Ave"), "100 W 100 Ave");
});

test("rejects the two SCC records whose deduped prefix recreated Great American P", () => {
  const siteLocation = "4988 GREAT AMERICAN PY., SANTA CLARA, CA 95054";

  assert.equal(
    isAddressDerivedBusinessName("E-4988 GREAT AMERICAN P CAFE", siteLocation),
    true,
  );
  assert.equal(
    isAddressDerivedBusinessName("E-4988 GREAT AMERICAN P COFFEE BAR", siteLocation),
    true,
  );
});

test("rejects both full and truncated address-only display names", () => {
  assert.equal(
    isAddressDerivedBusinessName("14612 Big Basin Wy", "14612 BIG BASIN WY., SARATOGA, CA"),
    true,
  );
  assert.equal(
    isAddressDerivedBusinessName("4988 Great American P", "4988 Great American Pkwy"),
    true,
  );
});

test("keeps numeric restaurant brands that do not encode their site address", () => {
  assert.equal(
    isAddressDerivedBusinessName("7 Leaves Cafe", "7 Leaves Ln, San Jose, CA"),
    false,
  );
  assert.equal(
    isAddressDerivedBusinessName("99 Ranch Market", "925 Blossom Hill Rd, San Jose, CA"),
    false,
  );
  assert.equal(
    isAddressDerivedBusinessName("10 Butchers Korean BBQ", "10 E Hamilton Ave, Campbell, CA"),
    false,
  );
});

test("a county final inspection alone is not an opening", () => {
  const record = classifyFinalInspection({
    sourceId: "SR0884792",
    name: "Fugetsu Market & Goods",
    inspectionDate: "2026-07-13",
  });

  assert.equal(record.status, "inspection-complete");
  assert.equal(record.inspectionDate, "2026-07-13");
  assert.equal(record.date, undefined);
  assert.equal(record.openingEvidence, undefined);
  assert.equal(isVerifiedOpeningRecord(record), false);
});

test("a separate first-party source establishes the true opening date", () => {
  const record = classifyFinalInspection(
    {
      sourceId: "SR0884792",
      name: "Fugetsu Market & Goods",
      inspectionDate: "2026-07-13",
    },
    {
      date: "2026-03-15",
      url: "https://www.instagram.com/p/DVz2HnDlNAJ/",
      source: "Fugetsu Market",
    },
  );

  assert.equal(record.status, "opened");
  assert.equal(record.date, "2026-03-15");
  assert.equal(record.inspectionDate, "2026-07-13");
  assert.equal(isVerifiedOpeningRecord(record), true);
  assert.notEqual(record.date, record.inspectionDate);
});

test("canonical food data keeps inspections out of the verified openings feed", () => {
  const data = JSON.parse(readFileSync(
    new URL("../../src/data/south-bay/scc-food-openings.json", import.meta.url),
    "utf8",
  ));

  assert.equal((data.opened || []).every(isVerifiedOpeningRecord), true);
  assert.equal((data.inspections || []).every((record) => (
    record.status === "inspection-complete"
    && record.date === undefined
    && /^\d{4}-\d{2}-\d{2}$/.test(record.inspectionDate)
  )), true);
  assert.equal((data.opened || []).some((record) => record.sourceId === "SR0884792"), false);
});
