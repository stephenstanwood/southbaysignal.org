// ---------------------------------------------------------------------------
// biblio-location — resolve where a BiblioCommons event actually happens.
//
// BiblioCommons events carry TWO location pointers, and the ingest only ever
// read one of them:
//
//   definition.branchLocationId     → entities.locations — a library branch
//   definition.nonBranchLocationId  → entities.places    — anywhere else
//   definition.locationDetails      → the room within either
//
// When a program is held outside the library, `branchLocationId` is null and
// the real venue sits in `nonBranchLocationId`. fetchBiblioEvents resolved the
// branch, found nothing, and fell back to the library's own name with an empty
// address — so the event shipped under the building it had explicitly moved
// out of. On 2026-09-03 that reached readers as:
//
//   "LOCATION CHANGE: Line Dancing with Sandy and Kent" (68faec5706078d3600744ca3)
//   branchLocationId: null
//   nonBranchLocationId: 59f90ac2544fb02f009aef14 → Mitchell Park Community Center
//   locationDetails: "El Palo Alto Room"
//
// …shipped as "Palo Alto City Library", and the newsletter told readers the
// class had "moved indoors" while naming the building it moved out of.
//
// Nothing here guesses. Every field comes from the feed's own entity stores;
// the library name is used only when the feed itself offers no location, which
// is the one case where the host library is the only thing known.
// ---------------------------------------------------------------------------

/** BiblioCommons address objects arrive with stray padding on `street`
 *  (" Harriet Street "). Same component order the feed has always rendered —
 *  number, street, city — just without the doubled spaces. */
export function formatBiblioAddress(addr) {
  if (!addr || typeof addr !== "object") return "";
  return [addr.number, addr.street, addr.city]
    .map((part) => String(part ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

/** A branch's public name. BiblioCommons stores "Downtown", "Mitchell Park"
 *  and "King" without the word readers expect on a library card. */
export function branchVenueName(branchName) {
  const name = String(branchName ?? "").trim();
  if (!name) return "";
  return name.toLowerCase().endsWith("library") ? name : `${name} Library`;
}

/**
 * Resolve one event's venue + address from the feed's own entity stores.
 *
 * @param {object} args
 * @param {object} args.event      an entities.events entry
 * @param {object} args.entities   that page's entity stores (locations, places)
 * @param {string} args.libraryName the system name, e.g. "Palo Alto City Library"
 * @returns {{venue: string, address: string, kind: "branch"|"non-branch"|"library-fallback",
 *   locationDetails: string, placeName: string}}
 */
export function resolveBiblioLocation({ event = {}, entities = {}, libraryName = "" } = {}) {
  const definition = event.definition || {};
  const locationDetails = String(definition.locationDetails ?? "").replace(/\s+/g, " ").trim();

  const branchId = event.branchId || definition.branchLocationId;
  const branchStore = entities.locations || entities.branches || {};
  const branch = branchId ? branchStore[branchId] : null;

  if (branch) {
    return {
      venue: branchVenueName(branch.name) || libraryName,
      address: formatBiblioAddress(branch.address),
      kind: "branch",
      locationDetails,
      placeName: "",
    };
  }

  // Not at a branch. `places` is where BiblioCommons files community centers,
  // parks, schools and partner venues — the answer the old code never asked for.
  const placeId = definition.nonBranchLocationId;
  const place = placeId ? (entities.places || {})[placeId] : null;

  if (place && String(place.name ?? "").trim()) {
    const name = String(place.name).replace(/\s+/g, " ").trim();
    // "Mitchell Park Community Center (El Palo Alto Room)" — the room only
    // when it adds something the venue name doesn't already say.
    const withRoom = locationDetails && !name.toLowerCase().includes(locationDetails.toLowerCase())
      ? `${name} (${locationDetails})`
      : name;
    return {
      venue: withRoom,
      address: formatBiblioAddress(place.address),
      kind: "non-branch",
      locationDetails,
      placeName: name,
    };
  }

  // The feed named no location at all. The host library is the only thing
  // known — and, unlike the two branches above, this is the ONLY path allowed
  // to answer with it.
  return {
    venue: libraryName,
    address: "",
    kind: "library-fallback",
    locationDetails,
    placeName: "",
  };
}
