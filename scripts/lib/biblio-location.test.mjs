import assert from "node:assert/strict";
import test from "node:test";

import {
  branchVenueName,
  formatBiblioAddress,
  resolveBiblioLocation,
} from "./biblio-location.mjs";

const PALO_ALTO = "Palo Alto City Library";

// Real entity stores, copied from
// gateway.bibliocommons.com/v2/libraries/paloalto/events.
const ENTITIES = {
  locations: {
    M: {
      name: "Mitchell Park",
      address: { country: "US", zip: "94303", state: "CA", city: "Palo Alto", street: "Middlefield Rd", number: "3700" },
    },
    C: {
      name: "Children's Library",
      // Note the padding the feed really ships on `street`.
      address: { country: "US", zip: "94301", state: "CA", city: "Palo Alto", street: " Harriet Street ", number: "1276" },
    },
  },
  places: {
    "59f90ac2544fb02f009aef14": {
      id: "59f90ac2544fb02f009aef14",
      name: "Mitchell Park Community Center",
      address: { country: "US", zip: "94303", state: "CA", city: "Palo Alto", street: "Middlefield Road", number: "3700" },
    },
    bowl: {
      id: "bowl",
      name: "Mitchell Park",
      address: { country: "US", zip: "94303", state: "CA", city: "Palo Alto", street: "East Meadow Drive", number: "600" },
    },
  },
};

// ── 2026-09-03: the record that reached readers ────────────────────────────
//
// paloalto/events/68faec5706078d3600744ca3 shipped as "Palo Alto City Library"
// with an empty address, and the newsletter told readers the class had "moved
// indoors" while naming the building it had moved OUT of.

test("paloalto/68faec5706078d3600744ca3 — a non-branch location resolves to the real venue", () => {
  const got = resolveBiblioLocation({
    event: {
      id: "68faec5706078d3600744ca3",
      definition: {
        title: "LOCATION CHANGE: Line Dancing with Sandy and Kent",
        branchLocationId: null,
        nonBranchLocationId: "59f90ac2544fb02f009aef14",
        locationDetails: "El Palo Alto Room",
      },
    },
    entities: ENTITIES,
    libraryName: PALO_ALTO,
  });

  assert.equal(got.kind, "non-branch");
  assert.notEqual(got.venue, PALO_ALTO, "must never name the library it moved out of");
  assert.equal(got.venue, "Mitchell Park Community Center (El Palo Alto Room)");
  assert.equal(got.address, "3700 Middlefield Road Palo Alto");
});

test("the rest of the series keeps its own venue — no blanket rewrite", () => {
  // Only the Sep 3 occurrence moved indoors. Its siblings are at the park.
  const sibling = resolveBiblioLocation({
    event: { id: "68faec5706078d3600744ca4", definition: { branchLocationId: null, nonBranchLocationId: "bowl", locationDetails: "Mitchell Park Bowl" } },
    entities: ENTITIES,
    libraryName: PALO_ALTO,
  });
  assert.equal(sibling.venue, "Mitchell Park (Mitchell Park Bowl)");
  assert.equal(sibling.address, "600 East Meadow Drive Palo Alto");
});

test("a null branch id must not fall through to the library when a place exists", () => {
  const got = resolveBiblioLocation({
    event: { definition: { branchLocationId: null, nonBranchLocationId: "59f90ac2544fb02f009aef14" } },
    entities: ENTITIES,
    libraryName: PALO_ALTO,
  });
  assert.notEqual(got.venue, PALO_ALTO);
  assert.equal(got.venue, "Mitchell Park Community Center");
  assert.notEqual(got.address, "", "the feed published an address — it must survive");
});

// ── branches still behave exactly as before ────────────────────────────────

test("a branch event still resolves to its branch", () => {
  const got = resolveBiblioLocation({
    event: { definition: { branchLocationId: "M" } },
    entities: ENTITIES,
    libraryName: PALO_ALTO,
  });
  assert.equal(got.kind, "branch");
  assert.equal(got.venue, "Mitchell Park Library");
  assert.equal(got.address, "3700 Middlefield Rd Palo Alto");
});

test("a branch already ending in Library is not doubled", () => {
  const got = resolveBiblioLocation({
    event: { definition: { branchLocationId: "C" } },
    entities: ENTITIES,
    libraryName: PALO_ALTO,
  });
  assert.equal(got.venue, "Children's Library");
  assert.equal(got.address, "1276 Harriet Street Palo Alto", "feed padding is collapsed");
});

test("the branch wins when an event somehow carries both pointers", () => {
  const got = resolveBiblioLocation({
    event: { definition: { branchLocationId: "M", nonBranchLocationId: "59f90ac2544fb02f009aef14" } },
    entities: ENTITIES,
    libraryName: PALO_ALTO,
  });
  assert.equal(got.kind, "branch");
  assert.equal(got.venue, "Mitchell Park Library");
});

// ── the one path allowed to answer with the library ────────────────────────

test("only a feed that names no location at all falls back to the library", () => {
  const got = resolveBiblioLocation({
    event: { definition: { branchLocationId: null, nonBranchLocationId: null } },
    entities: ENTITIES,
    libraryName: PALO_ALTO,
  });
  assert.equal(got.kind, "library-fallback");
  assert.equal(got.venue, PALO_ALTO);
  assert.equal(got.address, "", "a fallback venue must never carry a street address");
});

test("a dangling place id does not invent a venue", () => {
  const got = resolveBiblioLocation({
    event: { definition: { branchLocationId: null, nonBranchLocationId: "missing" } },
    entities: ENTITIES,
    libraryName: PALO_ALTO,
  });
  assert.equal(got.kind, "library-fallback");
  assert.equal(got.address, "");
});

// ── helpers ────────────────────────────────────────────────────────────────

test("locationDetails is not repeated when the place name already says it", () => {
  const got = resolveBiblioLocation({
    event: { definition: { nonBranchLocationId: "bowl", locationDetails: "Mitchell Park" } },
    entities: ENTITIES,
    libraryName: PALO_ALTO,
  });
  assert.equal(got.venue, "Mitchell Park");
});

test("formatBiblioAddress collapses feed padding and skips empties", () => {
  assert.equal(formatBiblioAddress({ number: "1276", street: " Harriet Street ", city: "Palo Alto" }), "1276 Harriet Street Palo Alto");
  assert.equal(formatBiblioAddress({ city: "Palo Alto" }), "Palo Alto");
  assert.equal(formatBiblioAddress(null), "");
  assert.equal(formatBiblioAddress("3700 Middlefield"), "");
});

test("branchVenueName appends Library only when it is missing", () => {
  assert.equal(branchVenueName("Mitchell Park"), "Mitchell Park Library");
  assert.equal(branchVenueName("Children's Library"), "Children's Library");
  assert.equal(branchVenueName(""), "");
});
