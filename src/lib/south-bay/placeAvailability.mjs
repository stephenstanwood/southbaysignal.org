// Editorial corrections that Google Places cannot reliably express. Keep this
// list deliberately small and source every temporary suppression. A review date
// is a prompt to recheck the source, not an automatic expiry: the place stays
// unavailable until a human confirms that it has reopened and removes the flag.
export const PLACE_EDITORIAL_OVERRIDES = Object.freeze({
  ChIJWzt9SsAxjoARxdjosLm4AjE: Object.freeze({
    canonicalName: "MiMi's Kitchen",
    canonicalUrl: "https://order.online/store/mimi-s-kitchen-blossom-hill-rd-25105409",
    aliases: Object.freeze(["mimi's kitchen"]),
    source: "https://order.online/store/mimi-s-kitchen-blossom-hill-rd-25105409",
  }),
  ChIJuZpNGzXLj4ARIrlguZcNUOc: Object.freeze({
    canonicalName: "Rose Garden Farmers' Market",
    canonicalUrl: "https://www.wcfma.org/rose-garden/",
    aliases: Object.freeze(["rose garden farmer's market", "rose garden farmers' market"]),
    source: "https://www.wcfma.org/rose-garden/",
  }),
  ChIJUVuaM6zLj4ARoQSjNyb1ebQ: Object.freeze({
    canonicalName: "de Saisset Museum",
    canonicalUrl: "https://www.scu.edu/desaisset/",
    aliases: Object.freeze(["de saisset museum"]),
    urlIncludes: Object.freeze(["/de-saisset/", "/desaisset/"]),
    temporarilyUnavailable: true,
    reviewOn: "2026-09-01",
    reason: "The museum's official site says its galleries are closed and will reopen in September 2026.",
    source: "https://www.scu.edu/desaisset/",
  }),
});

function barePlaceId(value) {
  const raw = typeof value === "object" && value ? value.id : value;
  return String(raw || "").replace(/^place:/, "");
}

export function getPlaceEditorialOverride(value) {
  return PLACE_EDITORIAL_OVERRIDES[barePlaceId(value)] || null;
}

export function applyPlaceEditorialOverride(place) {
  const override = getPlaceEditorialOverride(place);
  if (!override) return place;
  return {
    ...place,
    ...(override.canonicalName ? { name: override.canonicalName } : {}),
    ...(override.canonicalUrl ? { url: override.canonicalUrl } : {}),
  };
}

export function isPlaceTemporarilyUnavailable(value) {
  const direct = getPlaceEditorialOverride(value);
  if (direct?.temporarilyUnavailable === true) return true;
  if (!value || typeof value !== "object") return false;

  const names = [value.name, value.venue]
    .filter(Boolean)
    .map((candidate) => String(candidate).trim().toLowerCase());
  const urls = [value.url, value.mapsUrl]
    .filter(Boolean)
    .map((candidate) => String(candidate).toLowerCase());

  return Object.values(PLACE_EDITORIAL_OVERRIDES).some((override) => {
    if (override.temporarilyUnavailable !== true) return false;
    if (override.aliases?.some((alias) => names.includes(alias))) return true;
    return override.urlIncludes?.some((fragment) =>
      urls.some((candidate) => candidate.includes(fragment)),
    ) === true;
  });
}
