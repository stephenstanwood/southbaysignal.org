// ---------------------------------------------------------------------------
// canonicalizeCard — normalize a shared-plan card to the shape the renderer
// at src/pages/plan/[id].ts expects.
//
// Every writer to shared-plans.json should run every card through this before
// persisting, and the renderer re-runs it at read time as belt-and-suspenders.
// Prevents /plan/XXX 500s when upstream writers drift from the canonical shape.
// ---------------------------------------------------------------------------

function str(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string") return v;
  return String(v);
}

function nullableStr(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "string") return v;
  return String(v);
}

/**
 * Coerce a raw card-ish object into the canonical shape.
 * Unknown extra fields (kidsCostNote, locked, type, neighborhood, featuredPlace,
 * eventId, placeId, rationale) are preserved so callers can keep their metadata.
 */
export function canonicalizeCard(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      id: "",
      name: "",
      category: "other",
      city: "",
      address: "",
      timeBlock: "",
      blurb: "",
      why: "",
      url: "",
      mapsUrl: null,
      cost: null,
      costNote: null,
      photoRef: null,
      venue: "",
      source: "event",
    };
  }

  const canonical = {
    id: str(raw.id),
    name: str(raw.name || raw.title),
    category: str(raw.category, "other"),
    city: str(raw.city || raw.neighborhood),
    address: str(raw.address),
    timeBlock: str(raw.timeBlock),
    blurb: str(raw.blurb),
    why: str(raw.why),
    url: str(raw.url),
    mapsUrl: nullableStr(raw.mapsUrl),
    cost: nullableStr(raw.cost),
    costNote: nullableStr(raw.costNote),
    photoRef: nullableStr(raw.photoRef),
    venue: str(raw.venue || raw.name || raw.title),
    source: str(raw.source || (raw.type === "place" ? "place" : "event"), "event"),
  };

  // Preserve optional fields that exist on some cards (don't drop them).
  const passthrough = ["kidsCostNote", "locked", "type", "neighborhood", "featuredPlace", "eventId", "placeId", "rationale"];
  for (const key of passthrough) {
    if (raw[key] !== undefined) canonical[key] = raw[key];
  }

  return canonical;
}

/**
 * A card is considered renderable if it has at minimum a name and a timeBlock.
 * Without those the /plan/ renderer has nothing visual to show for the slot.
 */
export function isRenderableCard(card) {
  if (!card || typeof card !== "object") return false;
  return Boolean(str(card.name).trim()) && Boolean(str(card.timeBlock).trim());
}

/**
 * Canonicalize an entire plan's cards array; drops unrenderable cards entirely
 * so the renderer never has to defensively skip them.
 */
export function canonicalizePlanCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.map(canonicalizeCard).filter(isRenderableCard);
}
