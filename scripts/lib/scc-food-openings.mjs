const STREET_TYPE_FAMILIES = [
  ["st", "street"],
  ["av", "ave", "avenue"],
  ["rd", "road"],
  ["bl", "blv", "blvd", "boulevard"],
  ["dr", "drive"],
  ["ct", "court"],
  ["ln", "lane"],
  ["ci", "cir", "circle"],
  ["pl", "place"],
  ["pk", "pkwy", "py", "parkway"],
  ["hwy", "highway"],
  ["wy", "way"],
  ["ex", "expwy", "expressway"],
  ["ter", "terrace"],
  ["sq", "square"],
];

const STREET_TYPE_BY_TOKEN = new Map();
for (const aliases of STREET_TYPE_FAMILIES) {
  const fragments = new Set();
  for (const alias of aliases) {
    STREET_TYPE_BY_TOKEN.set(alias, fragments);
    for (let length = 1; length <= alias.length; length += 1) {
      fragments.add(alias.slice(0, length));
    }
  }
}

function words(value) {
  return String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Classify a county final-inspection record without turning the inspection date
 * into an opening claim. A real opening date exists only when a separate,
 * attributable source explicitly establishes it.
 */
export function classifyFinalInspection(record, openingEvidence = null) {
  const sourceId = record?.sourceId || null;
  const inspectionDate = isIsoDate(record?.inspectionDate) ? record.inspectionDate : null;
  const hasOpeningEvidence = isIsoDate(openingEvidence?.date)
    && isHttpUrl(openingEvidence?.url)
    && typeof openingEvidence?.source === "string"
    && openingEvidence.source.trim().length > 0;

  if (hasOpeningEvidence) {
    return {
      ...record,
      id: `opened-${sourceId || record?.id || "unknown"}`,
      status: "opened",
      date: openingEvidence.date,
      inspectionDate,
      openingEvidence: {
        date: openingEvidence.date,
        url: openingEvidence.url,
        source: openingEvidence.source.trim(),
      },
    };
  }

  const classified = {
    ...record,
    id: `inspection-${sourceId || record?.id || "unknown"}`,
    status: "inspection-complete",
    inspectionDate,
  };
  delete classified.date;
  delete classified.openingEvidence;
  return classified;
}

/** Defense-in-depth for every surface that labels a record as opened. */
export function isVerifiedOpeningRecord(record) {
  return record?.status === "opened"
    && isIsoDate(record?.date)
    && record.date === record?.openingEvidence?.date
    && isHttpUrl(record?.openingEvidence?.url)
    && typeof record?.openingEvidence?.source === "string"
    && record.openingEvidence.source.trim().length > 0;
}

/** Normalize recurring South Bay street-name variants from SCC permit data. */
export function normalizeSouthBayAddress(value) {
  return String(value ?? "")
    .replace(/\bDeanza\b/gi, "De Anza")
    // SCC permit rows sometimes repeat the street number where the source form
    // concatenated a house number field with an already-complete street line,
    // shipping "1026 1026 W Evelyn Ave" (Spice Fusion, Sunnyvale, 2026-08-12).
    // Collapse the duplicate — only when the two numbers are identical and lead
    // the string, so a genuine range ("82-96") or "1 1st St" is untouched.
    .replace(/^(\s*)(\d+[a-z]?)\s+\2\b/i, "$1$2");
}

/**
 * Detect permit placeholder names derived from the site's street address.
 *
 * SCC sometimes turns one address into multiple food-facility records, such as
 * "E-4988 GREAT AMERICAN P CAFE" and "... COFFEE BAR". Checking only whether
 * the cleaned display name ends in a street type misses both records, and the
 * later same-address dedupe then recreates "4988 Great American P" as their
 * shared prefix. Match the name to the actual site address instead: the same
 * street number + street-name tokens + any full/truncated form of that address's
 * street type is an address placeholder, even when facility words follow it.
 */
export function isAddressDerivedBusinessName(businessName, siteLocation) {
  const nameTokens = words(String(businessName ?? "").replace(/^e-\s*/i, ""));
  const addressTokens = words(String(siteLocation ?? "").split(",", 1)[0]);

  if (!/^\d+[a-z]?$/.test(nameTokens[0] ?? "") || nameTokens[0] !== addressTokens[0]) {
    return false;
  }

  const streetTypeIndex = addressTokens.findIndex(
    (token, index) => index > 1 && STREET_TYPE_BY_TOKEN.has(token),
  );
  if (streetTypeIndex < 2) return false;

  const streetNameTokens = addressTokens.slice(1, streetTypeIndex);
  const nameStreetTokens = nameTokens.slice(1, streetTypeIndex);
  if (
    nameStreetTokens.length !== streetNameTokens.length
    || nameStreetTokens.some((token, index) => token !== streetNameTokens[index])
  ) {
    return false;
  }

  // A name ending at the street name (before the type) is also just an address.
  const possibleStreetType = nameTokens[streetTypeIndex];
  if (!possibleStreetType) return true;

  return STREET_TYPE_BY_TOKEN.get(addressTokens[streetTypeIndex]).has(possibleStreetType);
}
