const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function decodeHtml(value = "") {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&rsquo;/gi, "’")
    .replace(/&ldquo;/gi, "“")
    .replace(/&rdquo;/gi, "”")
    .replace(/&thinsp;/gi, " ");
}

function plainText(value = "") {
  return decodeHtml(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractAddressLocality(value) {
  const parts = plainText(value).split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return "";
  const candidate = /^\d/.test(parts[0]) ? parts[1] : parts[0];
  if (!candidate || /^(?:CA|California|\d{5}(?:-\d{4})?)$/i.test(candidate)) return "";
  return candidate;
}

export function normalizeMidpenOccurrenceUrl(value) {
  try {
    const url = new URL(String(value || ""), "https://www.openspace.org");
    if (url.protocol !== "https:" || !/^(?:www\.)?openspace\.org$/i.test(url.hostname)) return null;
    if (!/^\/events\/(?:guided-activities|volunteer-projects)\/[a-z0-9-]+\/?$/i.test(url.pathname)) return null;
    url.hostname = "www.openspace.org";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeMountainWineryCard(raw = {}) {
  const headliner = plainText(raw.title || "");
  const supporting = plainText(raw.supporting || "");
  if (!headliner || !raw.date) return null;

  let link;
  try {
    link = new URL(String(raw.link || ""), "https://www.mountainwinery.com");
    if (link.protocol !== "https:" || link.hostname !== "www.mountainwinery.com") return null;
    if (!/^\/events\/detail\/?$/i.test(link.pathname) || !/^\d+$/.test(link.searchParams.get("event_id") || "")) return null;
  } catch {
    return null;
  }

  let image = null;
  try {
    const candidate = new URL(String(raw.image || ""), link);
    if (candidate.protocol === "https:" && candidate.hostname === "images.discovery-prod.axs.com") {
      image = candidate.href;
    }
  } catch {
    // An exact occurrence without art is still useful; the newsletter will
    // simply omit the Tonight's Pick image and attribution.
  }

  // The card's supporting-act line sometimes ships its own connector already
  // attached ("with Anberlin", "w/ Ragged Glory", "special guest Cydeways"),
  // so joining it with a bare "with" produced "Switchfoot with with Anberlin"
  // on five live listings. Strip a leading connector before the join and let
  // the template supply the single one. "special guest(s)" is deliberately NOT
  // stripped — it reads correctly after "with" and carries real billing info.
  // Deliberately excludes "and"/"&": those open real band names ("And So I
  // Watch You From Afar") far more often than they act as a stray connector,
  // and "with" is the only form the feed has actually shipped.
  const billing = supporting.replace(/^(?:with|w\/|feat\.?|featuring)(?:\s+|$)/i, "").trim();
  const title = billing && !headliner.toLowerCase().includes(billing.toLowerCase())
    ? `${headliner} with ${billing}`
    : headliner;
  return {
    title,
    date: plainText(raw.date),
    time: plainText(raw.time || "") || null,
    link: link.href,
    image,
    imageAlt: plainText(raw.imageAlt || headliner) || headliner,
    imageSourceUrl: image ? link.href : null,
  };
}

function isoDate(year, monthName, day) {
  const month = MONTHS[String(monthName).toLowerCase()];
  if (!month || !Number.isInteger(year) || !Number.isInteger(day)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeClock(value) {
  const match = String(value || "").match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i);
  if (!match) return null;
  return `${Number(match[1])}:${match[2] || "00"} ${match[3].toUpperCase()}M`;
}

export function extractVboSession(html) {
  return String(html || "").match(
    /(?:events(?:\/showevents)?|event\.asp)?\?[^"']*\bs=([0-9a-f-]{36})/i,
  )?.[1] || String(html || "").match(/\bs=([0-9a-f-]{36})/i)?.[1] || null;
}

export function parseMusicInParkSchedule(html) {
  const year = Number(String(html).match(/\b(20\d{2})\s+Concert\s+Schedul/i)?.[1]);
  if (!year) return [];

  const entries = [];
  const re = /<p\b[^>]*>\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?\s*[-–—]\s*([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = re.exec(String(html))) !== null) {
    const performer = plainText(match[3]);
    const date = isoDate(year, match[1], Number(match[2]));
    if (!date || !performer) continue;
    entries.push({ date, performer });
  }
  return entries;
}

export function parseJazzOnThePlazzSchedule(html) {
  const source = String(html || "");
  const year = Number(source.match(/Summer\s+Concerts\s+(20\d{2})/i)?.[1]);
  if (!year) return [];

  const entries = [];
  const re = /<h[34]\b[^>]*>\s*(January|February|March|April|May|June|July|August|Aug)\s+(\d{1,2})(?:st|nd|rd|th)?\s*<\/h[34]>\s*<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h[34]\b[^>]*>\s*(?:January|February|March|April|May|June|July|August|Aug)\s+\d{1,2}|$)/gi;
  let match;
  while ((match = re.exec(source)) !== null) {
    const performer = plainText(match[3]).replace(/\s+Season Finale\s*$/i, "").trim();
    const date = isoDate(year, match[1], Number(match[2]));
    const description = plainText(match[4].match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "");
    if (!date || !performer) continue;
    entries.push({ date, performer, description });
  }
  return entries;
}

export function parseSanJoseJazzLineup(html) {
  const source = String(html || "");
  const year = Number(
    source.match(/San Jose Jazz Summer Fest\s*(20\d{2})/i)?.[1]
      || source.match(/Summer Fest\s*(20\d{2})/i)?.[1]
      || source.match(/(?:©|&copy;)\s*(20\d{2})\s+San Jose Jazz/i)?.[1],
  );
  if (!year) return [];

  const entries = [];
  const seen = new Set();
  const blocks = source.split(/<div class="artist\s+col[^">]*">/i).slice(1);
  for (const block of blocks) {
    const url = decodeHtml(
      block.match(/<h3\b[^>]*>\s*<a\b[^>]*href="([^"]*\/artists\/[^"]+)"/i)?.[1]
        || block.match(/href="([^"]*\/artists\/[^"]+)"/i)?.[1]
        || "",
    );
    const title = plainText(
      block.match(/<h3\b[^>]*>\s*<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "",
    );
    const dateMatch = block.match(/class="month-date"[^>]*>\s*(January|February|March|April|May|June|July|August|Jan|Feb|Mar|Apr|Jun|Jul|Aug)\s+(\d{1,2})/i);
    const date = dateMatch ? isoDate(year, dateMatch[1], Number(dateMatch[2])) : null;
    const time = normalizeClock(
      block.match(/class="time[^"]*"[^>]*>\s*(?:<span\b[^>]*>)?\s*([^<]+)/i)?.[1]
        || block.match(/class="twelfth-hour"[^>]*>\s*([^<]+)/i)?.[1]
        || "",
    );
    const stage = plainText(block.match(/class="stage-name[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
    const image = decodeHtml(block.match(/<img\b[^>]*src="([^"]+)"/i)?.[1] || "");
    const description = plainText(block.match(/class="quicklook-text"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
    if (!url || !title || !date || !time || !stage) continue;

    const key = `${url}|${date}|${time}|${stage}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ title, date, time, stage, url, image, description });
  }
  return entries;
}

export function extractSanJoseJazzDayUrls(html) {
  const origin = "https://summerfest.sanjosejazz.org";
  const urls = [];
  const seen = new Set();
  const hrefPattern = /href\s*=\s*(["'])([^"']*\/filters\/chronological\/[^"']+)\1/gi;
  let match;

  while ((match = hrefPattern.exec(String(html || ""))) !== null) {
    try {
      const url = new URL(decodeHtml(match[2]), origin);
      if (url.protocol !== "https:" || url.origin !== origin) continue;
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/+$/, "");
      const normalized = url.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
    } catch {
      // Ignore malformed menu links; the strict caller still blocks if no
      // complete official schedule can be recovered.
    }
  }

  return urls;
}

export function parseCivicPlusCalendarPage(html) {
  const entries = [];
  const blocks = String(html || "").match(/<li>\s*<h3>[\s\S]*?itemtype="http:\/\/schema\.org\/Event"[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    const id = block.match(/id="eventTitle_(\d+)"/i)?.[1];
    const title = plainText(block.match(/itemprop="name">([\s\S]*?)<\/span>/i)?.[1] || "");
    const startsAt = block.match(/itemprop="startDate"[^>]*>(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/i)?.[1];
    if (!id || !title || !startsAt) continue;

    const description = plainText(block.match(/itemprop="description">([\s\S]*?)<\/p>/i)?.[1] || "");
    const locationBlock = block.match(/itemprop="location"[\s\S]*?<\/span><\/span><\/div>/i)?.[0] || "";
    const venue = plainText(locationBlock.match(/itemprop="name">([\s\S]*?)<\/span>/i)?.[1] || "");
    const street = plainText(locationBlock.match(/itemprop="streetAddress">([\s\S]*?)<\/span>/i)?.[1] || "");
    const locality = plainText(locationBlock.match(/itemprop="addressLocality">([\s\S]*?)<\/span>/i)?.[1] || "");
    const region = plainText(locationBlock.match(/itemprop="addressRegion">([\s\S]*?)<\/span>/i)?.[1] || "");
    const postal = plainText(locationBlock.match(/itemprop="postalCode">([\s\S]*?)<\/span>/i)?.[1] || "");
    // Some CivicPlus calendars put the whole address in streetAddress AND
    // repeat it in the locality/region/postal spans, which concatenated into
    // "13 S San Antonio Rd, Los Altos, CA 94022, Los Altos, CA 94022" (and
    // worse, a second, conflicting ZIP on the Main St & State St entry). If
    // street already reads as a complete address — names the locality and
    // carries a state or ZIP — use it on its own.
    const streetIsComplete =
      Boolean(street && locality) &&
      street.toLowerCase().includes(locality.toLowerCase()) &&
      (Boolean(region) && new RegExp(`\\b${region}\\b`, "i").test(street)) === true;
    const addressParts = streetIsComplete ? [street] : [street, locality, region, postal];
    const address = addressParts.filter(Boolean).join(", ").replace(/, ([A-Z]{2}), (\d{5})$/, ", $1 $2");
    const dateHeader = plainText(block.match(/class="date">([\s\S]*?)<\/div>/i)?.[1] || "");
    const clocks = [...dateHeader.matchAll(/\b\d{1,2}(?::\d{2})?\s*[AP]M\b/gi)].map((match) => normalizeClock(match[0]));
    const href = decodeHtml(block.match(/id="eventTitle_\d+"\s+href="([^"]+)"/i)?.[1] || "");

    entries.push({
      id,
      title,
      startsAt,
      time: clocks[0] || null,
      endTime: clocks[1] || null,
      description,
      venue,
      address,
      href,
    });
  }
  return entries;
}

/**
 * CivicPlus publishes start/end clocks in one field, for example
 * `07:30 PM - 09:30 PM`. Keep them as separate canonical fields: putting the
 * whole range in `time` makes the global clock validator reject it and forces
 * a later URL backfill to recover only the start.
 */
export function parseCivicPlusEventTimes(value) {
  const text = plainText(value);
  if (!text) return { time: null, endTime: null };

  const [startRaw = "", endRaw = ""] = text.split(/\s*[-–—]\s*/, 2);
  const time = normalizeClock(startRaw);
  const parsedEnd = normalizeClock(endRaw);
  if (time === "12:00 AM" && (!parsedEnd || parsedEnd === "11:59 PM")) {
    return { time: null, endTime: null };
  }
  return {
    time,
    endTime: parsedEnd === "11:59 PM" ? null : parsedEnd,
  };
}

/** Dedicated CivicPlus Cost field -> conservative event price metadata. */
export function parseCivicPlusEventCost(value) {
  const text = plainText(value);
  if (!text) return { cost: null, costNote: null };

  // Only call an event free when the dedicated cost field does not also list
  // a ticket price ("children free" on a paid event is not a free event).
  if (!/\$\s*\d/.test(text) && /\b(?:free|no charge)\b/i.test(text)) {
    return { cost: "free", costNote: null };
  }

  // The first published ticket amount is the base/floor. Later dollar values
  // are often facility or online-processing fees and must not become a fake
  // $4 ticket when the source says "$30.50/$43.50/$55.50 + $4 FF".
  const price = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/)?.[1];
  const dollars = Number(price);
  if (!Number.isFinite(dollars) || dollars <= 0) {
    return { cost: null, costNote: null };
  }
  const formatted = Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
  return {
    cost: dollars < 25 ? "low" : "paid",
    costNote: `From $${formatted}`,
  };
}

/**
 * Parse the microdata-backed facts from a CivicPlus event detail page.
 * Listing RSS is intentionally sparse; the detail page owns venue and cost.
 */
export function parseCivicPlusEventDetail(html) {
  const source = String(html || "");
  const startsAt = plainText(
    source.match(/itemprop="startDate"[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || "",
  );
  const timeBlock = source.match(
    /class="specificDetailHeader">\s*Time:\s*<\/div>\s*<div[^>]*class="specificDetailItem"[^>]*>([\s\S]*?)<\/div>/i,
  )?.[1] || "";
  const venue = plainText(
    source.match(/id="[^"]*_location_name"[\s\S]*?<div[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "",
  );
  const street = plainText(source.match(/itemprop="streetAddress"[^>]*>([\s\S]*?)<\//i)?.[1] || "");
  const locality = plainText(source.match(/itemprop="addressLocality"[^>]*>([\s\S]*?)<\//i)?.[1] || "");
  const region = plainText(source.match(/itemprop="addressRegion"[^>]*>([\s\S]*?)<\//i)?.[1] || "");
  const postal = plainText(source.match(/itemprop="postalCode"[^>]*>([\s\S]*?)<\//i)?.[1] || "");
  const address = [street, locality, region && postal ? `${region} ${postal}` : region || postal]
    .filter(Boolean)
    .join(", ");
  const costText = plainText(
    source.match(/itemprop="price"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "",
  );

  return {
    startsAt: startsAt || null,
    ...parseCivicPlusEventTimes(timeBlock),
    venue: venue || null,
    address,
    costText,
    ...parseCivicPlusEventCost(costText),
  };
}

/** Source-specific facts carried in Los Altos History Museum's iCal copy. */
export function parseLosAltosHistoryEventFacts(value) {
  const text = plainText(
    String(value || "")
      .replace(/\\n/g, " ")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";"),
  );
  const unavailable = /\b(?:this (?:session|tour|event) is closed|registration (?:is |has )?closed|sold out)\b/i.test(text);
  if (unavailable) return { unavailable: true, cost: null, costNote: null };

  const memberPricing = text.match(
    /\$\s*(\d+(?:\.\d{1,2})?)\s*per person\s*;\s*\$\s*(\d+(?:\.\d{1,2})?)\s*for (?:museum )?members?/i,
  );
  if (memberPricing) {
    const publicPrice = Number(memberPricing[1]);
    return {
      unavailable: false,
      cost: publicPrice < 25 ? "low" : "paid",
      costNote: `$${memberPricing[1]}; $${memberPricing[2]} members`,
    };
  }

  return { unavailable: false, ...parseCivicPlusEventCost(text) };
}

function nthWeekdayOfMonth(year, month, weekday, occurrence) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = 1 + ((weekday - first.getUTCDay() + 7) % 7) + (occurrence - 1) * 7;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseHappyHollowSchedules({ seniorHtml = "", hoorayHtml = "" } = {}) {
  const entries = [];
  const seniorText = plainText(seniorHtml);
  const senior = seniorText.match(
    /The\s+(20\d{2})\s+season[\s\S]*?fourth Thursday of the month from May through October from\s+9\s*-\s*10\s+a\.?m\.?/i,
  );
  if (senior) {
    const year = Number(senior[1]);
    for (let month = 5; month <= 10; month += 1) {
      entries.push({
        kind: "senior-safari",
        date: nthWeekdayOfMonth(year, month, 4, 4),
        title: "Senior Safari",
        time: "9:00 AM",
        endTime: "10:00 AM",
      });
    }
  }

  const hoorayText = plainText(hoorayHtml);
  const hooray = hoorayText.match(
    /Hooray for Happy Hollow benefit event is\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June|July|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),\s+(20\d{2})/i,
  );
  if (hooray) {
    entries.push({
      kind: "hooray",
      date: isoDate(Number(hooray[3]), hooray[1], Number(hooray[2])),
      title: "Hooray for Happy Hollow",
      time: null,
      endTime: null,
    });
  }

  return entries.filter((entry) => entry.date);
}
