#!/usr/bin/env node
/**
 * generate-events.mjs
 *
 * Scrapes upcoming events from all available South Bay feeds and writes
 * them to src/data/south-bay/upcoming-events.json.
 *
 * Sources (22 active):
 *   - Stanford Events (Localist JSON API) — 60-day window
 *   - SJSU Events (RSS)
 *   - Santa Clara University Events (RSS)
 *   - Campbell Community Calendar (CivicPlus RSS)
 *   - Los Gatos Town Calendar (CivicPlus iCal)
 *   - Saratoga Community Events (CivicPlus iCal)
 *   - Los Altos Parks & Rec (CivicPlus iCal)
 *   - City of Mountain View (CivicPlus iCal) — 403 blocked as of 2026-03
 *   - City of Sunnyvale (CivicPlus iCal) — 403 blocked as of 2026-03
 *   - City of Cupertino (CivicPlus iCal) — 404 as of 2026-03
 *   - City of San Jose (CivicPlus iCal) — 403 blocked as of 2026-03
 *   - The Tech Interactive (RSS) — 404 as of 2026-03 (no /feed/ endpoint)
 *   - San Jose Public Library (BiblioCommons API)
 *   - Santa Clara County Library (BiblioCommons API)
 *   - Mountain View Public Library (BiblioCommons API)
 *   - Sunnyvale Public Library (BiblioCommons API)
 *   - Palo Alto City Library (BiblioCommons API)
 *   - Computer History Museum Events (RSS + title-based date extraction)
 *   - Montalvo Arts Center (RSS)
 *   - San Jose Jazz (RSS)
 *   - Silicon Valley Leadership Group (RSS)
 *   - Happy Hollow Park & Zoo (RSS)
 *
 * NOTE: Mountain View/Sunnyvale/SJ city/Cupertino CivicPlus iCal feeds return 403/404.
 * Those cities' library systems are covered via BiblioCommons instead.
 * The Tech Interactive has no standard RSS feed — needs Eventbrite or direct calendar.
 *
 * Usage:
 *   node scripts/generate-events.mjs
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");

const UA = "SouthBaySignal/1.0 (stanwood.dev; public event aggregator)";

function h(prefix, ...parts) {
  return `${prefix}-${createHash("sha1").update(parts.join("|")).digest("hex").substring(0, 16)}`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function fetchText(url, timeout = 20_000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

// ── Helpers ──

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d;
}

function isoDate(d) {
  if (!d) return null;
  return d.toISOString().split("T")[0];
}

function displayDate(d) {
  if (!d) return "";
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    timeZone: "America/Los_Angeles",
  });
}

function displayTime(d) {
  if (!d) return null;
  const h = d.getHours();
  const m = d.getMinutes();
  if (h === 0 && m === 0) return null; // midnight = probably no time set
  return d.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#x2019;/gi, "\u2019").replace(/&#x2018;/gi, "\u2018")
    .replace(/&#x201C;/gi, "\u201C").replace(/&#x201D;/gi, "\u201D")
    .replace(/&#x2013;/gi, "\u2013").replace(/&#x2014;/gi, "\u2014")
    .replace(/&#\d+;/g, "").replace(/&\w+;/g, "")
    .replace(/\s+/g, " ").trim();
}

// Skip internal university admin events that aren't open to the general public
const INTERNAL_EVENT_PATTERNS = [
  /\bregistration\b/i,
  /\badd\s*[&\/]\s*drop\b/i,
  /\broom\s+closed\b/i,
  /\bclosed\b.*\b(day|holiday|weekend)\b/i,
  /\bdeadline\b/i,
  /\bno\s+class(es)?\b/i,
  /\bfinals?\s+(week|exam)\b/i,
  /\bspring\s+break\b/i,
  /\bwinter\s+break\b/i,
  /\bfall\s+break\b/i,
  /\borientation\b/i,
  /\bcommencement\b/i,
  /\bconvocation\b/i,
  /\bfaculty\s+(meeting|senate|assembly)\b/i,
  /\bstaff\s+(meeting|development|recognition)\b/i,
  /\bacademic\s+calendar\b/i,
  /\bconferral\s+of\s+degrees?\b/i,
  /\binstruction\s+begins?\b/i,
  /\binstruction\s+ends?\b/i,
  /\blast\s+day\s+of\s+instruction\b/i,
  /\breading\s+period\b/i,
  /\bgrades?\s+due\b/i,
  /\bquarter\s*:\s*(gsb|instruction|exams?|begins?|ends?)\b/i,
  /\b(spring|fall|winter|summer)\s+quarter\s*:/i,
  /\bgsb\s+instruction\b/i,
  /\bholiday\s+observance\b/i,
  /\buniversity\s+holiday\b/i,
  /\bhousing\s+move[\s-]?in\b/i,
  /\bhousing\s+move[\s-]?out\b/i,
  /\bhousing\s+opens?\b/i,
  /\bresidential?\s+(check[\s-]?in|check[\s-]?out)\b/i,
  /\bdorm(itory)?\s+(open|close|move)\b/i,
  /\btuition\s+(due|payment|deadline)\b/i,
];

// Detect away games: "[School] at [Away Opponent/Location]"
// Home game format: "[Opponent] at [School]" — school name is LAST
// Away game format: "[School] at [Opponent]" — school name is FIRST
const UNI_HOME_NAMES = [
  "san jose state", "sjsu",
  "santa clara", "santa clara university", "scu",
  "stanford",
];
function isAwayGame(title) {
  const t = title.toLowerCase();
  // If any of our school names appear before " at " → away game
  for (const name of UNI_HOME_NAMES) {
    const idx = t.indexOf(name);
    if (idx === -1) continue;
    const afterSchool = t.slice(idx + name.length).trimStart();
    if (afterSchool.startsWith("at ")) return true;
  }
  return false;
}

function isPublicEvent(title, source) {
  const uniSources = ["Santa Clara University", "SJSU Events", "Stanford Events"];
  if (uniSources.includes(source)) {
    for (const pat of INTERNAL_EVENT_PATTERNS) {
      if (pat.test(title)) return false;
    }
    // Filter away athletic events — games played outside the South Bay
    if (isAwayGame(title)) return false;
  }
  return true;
}

// Strip calendar-artifact date prefixes like "Apr 1, 2026: " or "March 28: "
// Also decodes HTML entities that may survive title extraction
function cleanTitle(title) {
  if (!title) return title;
  return title
    // Decode common HTML entities first
    .replace(/&#x2019;/gi, "\u2019").replace(/&#x2018;/gi, "\u2018")
    .replace(/&#x201C;/gi, "\u201C").replace(/&#x201D;/gi, "\u201D")
    .replace(/&#x2013;/gi, "\u2013").replace(/&#x2014;/gi, "\u2014")
    .replace(/&#x26;/gi, "&").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "").replace(/&\w+;/g, "")
    // Strip calendar-artifact date prefixes
    .replace(
      /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\s*:\s*/i,
      "",
    )
    .trim();
}

function truncate(text, len = 200) {
  if (!text || text.length <= len) return text || "";
  return text.substring(0, len).replace(/\s+\S*$/, "") + "…";
}

function inferCity(location, address) {
  const text = `${location} ${address}`.toLowerCase();
  if (text.includes("campbell")) return "campbell";
  if (text.includes("cupertino")) return "cupertino";
  if (text.includes("los gatos")) return "los-gatos";
  if (text.includes("mountain view") || text.includes("moffett")) return "mountain-view";
  if (text.includes("saratoga")) return "saratoga";
  if (text.includes("sunnyvale")) return "sunnyvale";
  if (text.includes("san jose") || text.includes("san josé") || text.includes("sj ")) return "san-jose";
  if (text.includes("santa clara") && !text.includes("county")) return "santa-clara";
  if (text.includes("los altos")) return "los-altos";
  if (text.includes("palo alto") || text.includes("stanford")) return "palo-alto";
  if (text.includes("milpitas")) return "milpitas";
  return null;
}

function inferCategory(title, desc, type) {
  const t = `${title} ${desc} ${type}`.toLowerCase();
  if (t.includes("story time") || t.includes("storytime") || t.includes("toddler") || t.includes("baby") || t.includes("preschool") || t.includes("kids") || t.includes("children")) return "family";
  if (t.includes("concert") || t.includes("music") || t.includes("jazz") || t.includes("symphony") || t.includes("band") || t.includes("orchestra") || t.includes("choir")) return "music";
  // sports before arts to avoid false positives (e.g. "golf" → "community" not "arts")
  if (t.includes("game") || t.includes("sport") || t.includes("athletic") || t.includes("golf") || t.includes("tennis") || t.includes("soccer") || t.includes("basketball") || t.includes("baseball") || t.includes("softball") || t.includes("volleyball") || t.includes("swimming") || t.includes("swim meet") || t.includes("track") || t.includes("cross country") || t.includes("lacrosse") || t.includes("football") || t.includes("gymnastics") || t.includes("wrestling") || t.includes("water polo") || t.includes("polo") || t.includes("hockey") || t.includes("rugby") || t.includes("rowing") || t.includes("crew") || t.includes("diving") || t.includes("fencing") || t.includes("skiing") || t.includes("snowboard") || t.includes("cycling") || t.includes("equestrian") || t.includes("vs.") || t.includes("vs ") || t.includes("run") || t.includes("race") || t.includes("marathon") || t.includes("5k") || t.includes("triathlon")) return "sports";
  if (t.includes("exhibit") || t.includes("gallery") || t.includes("theater") || t.includes("theatre") || t.includes("film") || t.includes("cinema") || t.includes("dance") || t.includes("performance") || t.includes("museum") || (t.includes("art") && !t.includes("martial art") && !t.includes("start"))) return "arts";
  if (t.includes("market") || t.includes("fair") || t.includes("vendor") || t.includes("craft")) return "market";
  if (t.includes("hike") || t.includes("hiking") || t.includes("outdoor") || t.includes("garden") || t.includes("nature") || t.includes("trail") || t.includes("park")) return "outdoor";
  if (t.includes("book") || t.includes("reading") || t.includes("lecture") || t.includes("workshop") || t.includes("class") || t.includes("learn") || t.includes("seminar") || t.includes("talk") || t.includes("stem") || t.includes("science") || t.includes("coding") || t.includes("tech")) return "education";
  if (t.includes("food") || t.includes("cooking") || t.includes("taste") || t.includes("chef") || t.includes("wine") || t.includes("beer") || t.includes("culinary")) return "food";
  return "community";
}

// ── RSS Parser (regex-based, no dependencies) ──

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const x = match[1];
    const get = (tag) => {
      const m = x.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? m[1].trim().replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") : "";
    };
    items.push({
      title: get("title"),
      link: get("link"),
      description: get("description"),
      pubDate: get("pubDate"),
      content: get("content:encoded"),
      // CivicPlus-specific
      startDate: get("calendarEvent:startDate") || get("startDate"),
      location: get("calendarEvent:location") || get("location"),
      // Localist-specific
      georss_point: get("georss:point"),
      s_localtime: get("s:localtime"),
    });
  }
  return items;
}

// ── iCal Parser ──

function parseIcalEvents(ical) {
  const events = [];
  const eventBlocks = ical.split("BEGIN:VEVENT");
  for (let i = 1; i < eventBlocks.length; i++) {
    const block = eventBlocks[i].split("END:VEVENT")[0];
    const get = (prop) => {
      // Handle folded lines and various property formats
      const regex = new RegExp(`^${prop}[;:](.*)`, "mi");
      const m = block.match(regex);
      if (!m) return "";
      let val = m[1];
      // Handle value after parameters (e.g., DTSTART;TZID=America/Los_Angeles:20260401T180000)
      const colonIdx = val.indexOf(":");
      if (colonIdx > 0 && val.substring(0, colonIdx).includes("=")) {
        val = val.substring(colonIdx + 1);
      }
      return val.trim();
    };
    const summary = get("SUMMARY");
    const dtstart = get("DTSTART");
    const dtend = get("DTEND");
    const location = get("LOCATION");
    const description = get("DESCRIPTION");
    const url = get("URL");
    const uid = get("UID");

    if (!summary) continue;

    events.push({ summary, dtstart, dtend, location, description, url, uid });
  }
  return events;
}

function parseIcalDate(dtStr) {
  if (!dtStr) return null;
  // Format: 20260401T180000 or 20260401
  const clean = dtStr.replace(/[^0-9T]/g, "");
  if (clean.length >= 8) {
    const y = clean.substring(0, 4);
    const m = clean.substring(4, 6);
    const d = clean.substring(6, 8);
    const h = clean.length >= 11 ? clean.substring(9, 11) : "00";
    const min = clean.length >= 13 ? clean.substring(11, 13) : "00";
    return new Date(`${y}-${m}-${d}T${h}:${min}:00-07:00`); // PDT
  }
  return parseDate(dtStr);
}

// ── Sources ──

async function fetchStanfordEvents() {
  console.log("  ⏳ Stanford Events...");
  try {
    const data = await fetchJson("https://events.stanford.edu/api/2/events?days=60&pp=200");
    const now = new Date();
    const events = (data.events || []).map((e) => {
      const ev = e.event;
      const start = parseDate(ev.first_date);
      const end = parseDate(ev.last_date);
      if (!start) return null;
      // Stanford Localist returns series events: first_date = series start, last_date = series end.
      // Many recurring events started weeks ago but are still ongoing.
      // Use today as the event date for ongoing events (started in past, ends in future).
      let eventDate = start;
      if (start < now) {
        if (end && end >= now) {
          eventDate = now; // currently running → anchor to today
        } else {
          return null; // fully in the past
        }
      }
      return {
        id: `stanford-${ev.id}`,
        title: ev.title,
        date: isoDate(eventDate),
        displayDate: displayDate(eventDate),
        time: displayTime(start),
        endTime: end ? displayTime(end) : null,
        venue: ev.location_name || "Stanford University",
        address: ev.address || "",
        city: "palo-alto",
        category: inferCategory(ev.title, ev.description_text || "", ""),
        cost: ev.free ? "free" : "paid",
        description: truncate(stripHtml(ev.description_text || ev.description || "")),
        url: ev.localist_url || `https://events.stanford.edu/event/${ev.id}`,
        source: "Stanford Events",
        kidFriendly: false,
      };
    }).filter(Boolean);
    console.log(`  ✅ Stanford: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Stanford: ${err.message}`);
    return [];
  }
}

async function fetchSjsuEvents() {
  console.log("  ⏳ SJSU Events...");
  try {
    const xml = await fetchText("https://events.sjsu.edu/calendar.xml", 45_000); // large feed ~1.4MB
    const items = parseRssItems(xml);
    const events = items.map((item) => {
      const start = parseDate(item.pubDate);
      if (!start) return null;
      return {
        id: h("sjsu", item.link || item.title, item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: null,
        venue: item.location || "San Jose State University",
        address: "",
        city: "san-jose",
        category: inferCategory(item.title, item.description, ""),
        cost: "free",
        description: truncate(stripHtml(item.description)),
        url: item.link,
        source: "SJSU Events",
        kidFriendly: false,
      };
    }).filter(Boolean);
    console.log(`  ✅ SJSU: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SJSU: ${err.message}`);
    return [];
  }
}

async function fetchScuEvents() {
  console.log("  ⏳ Santa Clara University Events...");
  try {
    const xml = await fetchText("https://events.scu.edu/live/rss/events");
    const items = parseRssItems(xml);
    const events = items.map((item) => {
      const start = parseDate(item.pubDate);
      if (!start) return null;
      return {
        id: h("scu", item.link || item.title, item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: null,
        venue: item.location || "Santa Clara University",
        address: "",
        city: "santa-clara",
        category: inferCategory(item.title, item.description, ""),
        cost: "free",
        description: truncate(stripHtml(item.description)),
        url: item.link,
        source: "Santa Clara University",
        kidFriendly: false,
      };
    }).filter(Boolean);
    console.log(`  ✅ SCU: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SCU: ${err.message}`);
    return [];
  }
}

// ── CHM-specific date extraction ──
// CHM's WordPress feed uses pubDate = article publish date, not event date.
// Event dates are embedded in the title, e.g. "April 15: Maker Camp" or "Sat, April 12 — Talk".
function parseChmDate(title, pubDateStr) {
  const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const m = title.match(new RegExp(`(${MONTH})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, "i"));
  if (m) {
    const year = m[3] || String(new Date().getFullYear());
    const base = new Date(`${m[1]} ${m[2]}, ${year}`);
    if (!isNaN(base.getTime())) {
      // If no explicit year and date is in the past, roll to next year
      if (!m[3] && base < new Date()) base.setFullYear(base.getFullYear() + 1);
      return base;
    }
  }
  return parseDate(pubDateStr);
}

async function fetchChmEvents() {
  console.log("  ⏳ Computer History Museum...");
  try {
    const xml = await fetchText("https://computerhistory.org/events/feed/");
    const items = parseRssItems(xml);
    const now = new Date();
    // CHM titles don't embed dates. pubDate = article publish date (not event date).
    // Their RSS is an exhibit/event announcement feed; items published in the last
    // 6 months are likely still running. We use today as the event date so they
    // appear in "happening now" sections and are refreshed on each scrape.
    const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    const events = items.map((item) => {
      const pubDt = parseDate(item.pubDate);
      if (!pubDt || pubDt < sixMonthsAgo) return null; // skip very stale items
      return {
        id: h("chm", item.link || item.title, item.pubDate),
        title: item.title,
        date: isoDate(now), // exhibit running today
        displayDate: displayDate(now),
        time: null, // all-day exhibit
        endTime: null,
        venue: "Computer History Museum",
        address: "1401 N Shoreline Blvd, Mountain View",
        city: "mountain-view",
        category: inferCategory(item.title, item.description, ""),
        cost: "paid",
        description: truncate(stripHtml(item.description || item.content)),
        url: item.link,
        source: "Computer History Museum",
        kidFriendly: true,
      };
    }).filter(Boolean);
    console.log(`  ✅ CHM: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  CHM: ${err.message}`);
    return [];
  }
}

async function fetchSjJazzEvents() {
  console.log("  ⏳ San Jose Jazz...");
  try {
    const xml = await fetchText("https://www.sanjosejazz.org/feed/");
    const items = parseRssItems(xml);
    const events = items
      .map((item) => {
        const start = parseDate(item.pubDate);
        if (!start) return null;
        return {
          id: h("sjjazz", item.link || item.title, item.pubDate),
          title: item.title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: null,
          venue: item.location || "San Jose Jazz",
          address: "",
          city: "san-jose",
          category: "music",
          cost: inferCategory(item.title, item.description, "") === "music" ? "paid" : "free",
          description: truncate(stripHtml(item.description || item.content)),
          url: item.link,
          source: "San Jose Jazz",
          kidFriendly: false,
        };
      })
      .filter(Boolean);
    console.log(`  ✅ San Jose Jazz: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  San Jose Jazz: ${err.message}`);
    return [];
  }
}

async function fetchMontalvoEvents() {
  console.log("  ⏳ Montalvo Arts Center...");
  try {
    const xml = await fetchText("https://montalvoarts.org/feed/");
    const items = parseRssItems(xml);
    const events = items
      .map((item) => {
        const start = parseDate(item.pubDate);
        if (!start) return null;
        return {
          id: h("montalvo", item.link || item.title, item.pubDate),
          title: item.title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: null,
          venue: "Montalvo Arts Center",
          address: "15400 Montalvo Rd, Saratoga",
          city: "saratoga",
          category: inferCategory(item.title, item.description || "", "arts"),
          cost: "paid",
          description: truncate(stripHtml(item.description || item.content)),
          url: item.link,
          source: "Montalvo Arts Center",
          kidFriendly: false,
        };
      })
      .filter(Boolean);
    console.log(`  ✅ Montalvo Arts Center: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Montalvo Arts Center: ${err.message}`);
    return [];
  }
}

async function fetchSvlgEvents() {
  console.log("  ⏳ Silicon Valley Leadership Group...");
  try {
    const xml = await fetchText("https://www.svlg.org/events/feed/");
    const items = parseRssItems(xml);
    const events = items.map((item) => {
      const start = parseDate(item.pubDate);
      if (!start) return null;
      const city = inferCity(item.title + " " + item.description, "");
      return {
        id: h("svlg", item.link || item.title, item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: null,
        venue: item.location || "Silicon Valley",
        address: "",
        city: city || "san-jose",
        category: "community",
        cost: "paid",
        description: truncate(stripHtml(item.description)),
        url: item.link,
        source: "SVLG",
        kidFriendly: false,
      };
    }).filter(Boolean);
    console.log(`  ✅ SVLG: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SVLG: ${err.message}`);
    return [];
  }
}

// ── CivicPlus RSS ──

async function fetchCampbellEvents() {
  console.log("  ⏳ Campbell Community Calendar...");
  try {
    const xml = await fetchText(
      "https://www.campbellca.gov/RSSFeed.aspx?ModID=58&CID=14-Community-Event-Calendar",
    );
    const items = parseRssItems(xml);
    const events = items.map((item) => {
      const start = parseDate(item.startDate || item.pubDate);
      if (!start) return null;
      return {
        id: h("campbell", item.link || item.title, item.startDate || item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: null,
        venue: item.location || "Campbell",
        address: "",
        city: "campbell",
        category: inferCategory(item.title, item.description, ""),
        cost: "free",
        description: truncate(stripHtml(item.description)),
        url: item.link,
        source: "City of Campbell",
        kidFriendly: item.title.toLowerCase().includes("kid") || item.title.toLowerCase().includes("family") || item.title.toLowerCase().includes("story"),
      };
    }).filter(Boolean);
    console.log(`  ✅ Campbell: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Campbell: ${err.message}`);
    return [];
  }
}

// ── CivicPlus iCal feeds ──

async function fetchCivicPlusIcal(name, url, defaultCity) {
  console.log(`  ⏳ ${name}...`);
  try {
    const ical = await fetchText(url);
    const rawEvents = parseIcalEvents(ical);
    const now = new Date();
    const thirtyDaysOut = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

    const events = rawEvents
      .map((ev) => {
        const start = parseIcalDate(ev.dtstart);
        if (!start || start < now || start > thirtyDaysOut) return null;
        const end = parseIcalDate(ev.dtend);
        const city = inferCity(ev.location, "") || defaultCity;
        return {
          id: h(defaultCity, ev.uid || ev.summary, ev.dtstart),
          title: ev.summary.replace(/\\,/g, ",").replace(/\\n/g, " "),
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: end ? displayTime(end) : null,
          venue: (ev.location || name).replace(/\\,/g, ","),
          address: "",
          city,
          category: inferCategory(ev.summary, ev.description || "", ""),
          cost: "free",
          description: truncate(stripHtml((ev.description || "").replace(/\\n/g, "\n").replace(/\\,/g, ","))),
          url: ev.url || null,
          source: name,
          kidFriendly: ev.summary.toLowerCase().includes("kid") || ev.summary.toLowerCase().includes("family"),
        };
      })
      .filter(Boolean);

    console.log(`  ✅ ${name}: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  ${name}: ${err.message}`);
    return [];
  }
}

async function fetchLosGatosEvents() {
  return fetchCivicPlusIcal(
    "Town of Los Gatos",
    "https://www.losgatosca.gov/common/modules/iCalendar/iCalendar.aspx?catID=16&feed=calendar",
    "los-gatos",
  );
}

async function fetchSaratogaEvents() {
  return fetchCivicPlusIcal(
    "City of Saratoga",
    "https://www.saratoga.ca.us/common/modules/iCalendar/iCalendar.aspx?catID=35&feed=calendar",
    "saratoga",
  );
}

async function fetchLosAltosEvents() {
  return fetchCivicPlusIcal(
    "City of Los Altos",
    "https://www.losaltosca.gov/common/modules/iCalendar/iCalendar.aspx?catID=37&feed=calendar",
    "los-altos",
  );
}

async function fetchMountainViewEvents() {
  return fetchCivicPlusIcal(
    "City of Mountain View",
    "https://www.mountainview.gov/common/modules/iCalendar/iCalendar.aspx?feed=calendar",
    "mountain-view",
  );
}

async function fetchSunnyvaleEvents() {
  return fetchCivicPlusIcal(
    "City of Sunnyvale",
    "https://www.sunnyvale.ca.gov/common/modules/iCalendar/iCalendar.aspx?feed=calendar",
    "sunnyvale",
  );
}

async function fetchCupertinoEvents() {
  return fetchCivicPlusIcal(
    "City of Cupertino",
    "https://www.cupertino.org/common/modules/iCalendar/iCalendar.aspx?feed=calendar",
    "cupertino",
  );
}

async function fetchTheTechEvents() {
  console.log("  ⏳ The Tech Interactive...");
  try {
    const xml = await fetchText("https://thetech.org/feed/");
    const items = parseRssItems(xml);
    const now = new Date();
    const events = items
      .map((item) => {
        const start = parseDate(item.startDate || item.pubDate);
        if (!start || start < now) return null;
        return {
          id: h("thetech", item.link || item.title, item.pubDate),
          title: item.title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: null,
          venue: "The Tech Interactive",
          address: "201 S Market St, San Jose",
          city: "san-jose",
          category: inferCategory(item.title, item.description || "", ""),
          cost: "paid",
          description: truncate(stripHtml(item.description || item.content)),
          url: item.link,
          source: "The Tech Interactive",
          kidFriendly: true,
        };
      })
      .filter(Boolean);
    console.log(`  ✅ The Tech Interactive: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  The Tech Interactive: ${err.message}`);
    return [];
  }
}

async function fetchSanJoseCityEvents() {
  return fetchCivicPlusIcal(
    "City of San Jose",
    "https://www.sanjoseca.gov/common/modules/iCalendar/iCalendar.aspx?feed=calendar",
    "san-jose",
  );
}

// ── BiblioCommons Library Events ──

async function fetchBiblioEvents(libraryId, libraryName, cityMapper) {
  console.log(`  ⏳ ${libraryName}...`);
  try {
    const data = await fetchJson(
      `https://gateway.bibliocommons.com/v2/libraries/${libraryId}/events?limit=200`,
    );

    const entities = data.entities || {};
    const eventList = entities.events ? Object.values(entities.events) : [];

    const now = new Date();
    const results = eventList
      .map((ev) => {
        const startStr = ev.start || ev.definition?.start;
        const endStr = ev.end || ev.definition?.end;
        const start = parseDate(startStr);
        if (!start || start < now) return null;

        const end = parseDate(endStr);
        const branchId = ev.branchId || ev.definition?.branchId;
        const branch = branchId && entities.branches ? entities.branches[branchId] : null;
        const branchName = branch?.name || "";
        const branchAddr = branch?.address || "";
        const locationCode = ev.definition?.branchLocationId || "";
        const city = cityMapper(branchName, branchAddr, locationCode);
        if (!city) return null;

        const title = ev.title || ev.definition?.title || "";
        const desc = ev.description || ev.definition?.description || "";

        return {
          id: `${libraryId}-${ev.id}`,
          title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: end ? displayTime(end) : null,
          venue: branchName || libraryName,
          address: branchAddr,
          city,
          category: inferCategory(title, desc, ev.type || ""),
          cost: "free",
          description: truncate(stripHtml(desc)),
          url: ev.registrationUrl || `https://${libraryId}.bibliocommons.com/events/${ev.id}`,
          source: libraryName,
          kidFriendly: (ev.audiences || []).some((a) => {
            const name = typeof a === "string" ? a : a?.name || "";
            return /child|teen|family|baby|toddler/i.test(name);
          }),
        };
      })
      .filter(Boolean);

    console.log(`  ✅ ${libraryName}: ${results.length} events`);
    return results;
  } catch (err) {
    console.log(`  ⚠️  ${libraryName}: ${err.message}`);
    return [];
  }
}

async function fetchSjplEvents() {
  return fetchBiblioEvents("sjpl", "San Jose Public Library", () => "san-jose");
}

// SCCL branch location codes (branchLocationId from BiblioCommons)
const SCCL_LOCATION_MAP = {
  CA: "campbell",
  CU: "cupertino",
  LA: "los-altos",
  WO: "los-altos",   // Woodland branch, Los Altos Hills
  LG: "los-gatos",
  MI: "milpitas",
  SA: "saratoga",
  SC: "santa-clara",
  // MH = Morgan Hill, GI = Gilroy — outside South Bay, omit
};

async function fetchScclEvents() {
  return fetchBiblioEvents("sccl", "Santa Clara County Library", (branch, addr, locationCode) => {
    // Prefer location code lookup (reliable short code)
    if (locationCode && SCCL_LOCATION_MAP[locationCode]) return SCCL_LOCATION_MAP[locationCode];
    // Fallback: text match on branch name/address
    const text = `${branch} ${addr}`.toLowerCase();
    if (text.includes("campbell")) return "campbell";
    if (text.includes("cupertino")) return "cupertino";
    if (text.includes("los altos")) return "los-altos";
    if (text.includes("los gatos")) return "los-gatos";
    if (text.includes("milpitas")) return "milpitas";
    if (text.includes("saratoga")) return "saratoga";
    if (text.includes("santa clara")) return "santa-clara";
    return null;
  });
}

// ── Eventbrite geo-search ──
// 25-mile radius around San Jose (37.3382, -121.8863)

async function fetchEventbriteEvents() {
  console.log("  ⏳ Eventbrite...");
  const apiKey = process.env.EVENTBRITE_API_KEY;
  if (!apiKey) { console.log("  ⚠️  Eventbrite: no API key"); return []; }

  try {
    const now = new Date();
    const future = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days out
    const startFloor = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const endCeil = future.toISOString().replace(/\.\d{3}Z$/, "Z");

    const url = new URL("https://www.eventbriteapi.com/v3/events/search/");
    url.searchParams.set("location.latitude", "37.3382");
    url.searchParams.set("location.longitude", "-121.8863");
    url.searchParams.set("location.within", "25mi");
    url.searchParams.set("start_date.range_start", startFloor);
    url.searchParams.set("start_date.range_end", endCeil);
    url.searchParams.set("expand", "venue,organizer");
    url.searchParams.set("page_size", "200");
    url.searchParams.set("sort_by", "date");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();

    const events = (data.events || []).map((e) => {
      const start = parseDate(e.start?.local);
      if (!start) return null;
      const end = e.end?.local ? parseDate(e.end.local) : null;

      const venueName = e.venue?.name || "";
      const address = e.venue?.address?.localized_address_display || "";
      const city = inferCity(venueName, address);
      if (!city) return null;

      const isFree = e.is_free || false;
      const priceStr = e.ticket_availability?.minimum_ticket_price?.display || null;

      return {
        id: `eb-${e.id}`,
        title: stripHtml(e.name?.text || e.name?.html || ""),
        date: isoDate(start),
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: end ? displayTime(end) : null,
        venue: venueName,
        address,
        city,
        category: inferCategory(e.name?.text || "", stripHtml(e.description?.html || ""), e.category?.name || ""),
        cost: isFree ? "free" : priceStr ? "paid" : "paid",
        costNote: priceStr ? `${priceStr}+` : undefined,
        description: truncate(stripHtml(e.description?.html || e.summary || "")),
        url: e.url,
        source: "Eventbrite",
        kidFriendly: /family|kid|child|toddler|baby/i.test((e.name?.text || "") + (e.description?.html || "")),
      };
    }).filter(Boolean);

    console.log(`  ✅ Eventbrite: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Eventbrite: ${err.message}`);
    return [];
  }
}

// ── Ticketmaster Discovery API ──
// Covers SAP Center (Sharks), Shoreline, SJ Civic Auditorium, etc.

async function fetchTicketmasterEvents() {
  console.log("  ⏳ Ticketmaster...");
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) { console.log("  ⚠️  Ticketmaster: no API key"); return []; }

  try {
    const now = new Date();
    const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days out
    const startStr = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const endStr = future.toISOString().replace(/\.\d{3}Z$/, "Z");

    const url = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("latlong", "37.3382,-121.8863");
    url.searchParams.set("radius", "25");
    url.searchParams.set("unit", "miles");
    url.searchParams.set("startDateTime", startStr);
    url.searchParams.set("endDateTime", endStr);
    url.searchParams.set("size", "200");
    url.searchParams.set("sort", "date,asc");

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();

    const rawEvents = data?._embedded?.events || [];
    const events = rawEvents.map((e) => {
      const dateInfo = e.dates?.start;
      const dateStr = dateInfo?.localDate;
      const timeStr = dateInfo?.localTime; // "20:00:00"
      if (!dateStr) return null;

      const start = new Date(`${dateStr}T${timeStr || "00:00:00"}-07:00`);
      const venue = e._embedded?.venues?.[0];
      const venueName = venue?.name || "";
      const city = inferCity(venueName, `${venue?.city?.name || ""} ${venue?.address?.line1 || ""}`);
      if (!city) return null;

      const priceRange = e.priceRanges?.[0];
      const minPrice = priceRange?.min;
      const cost = minPrice === 0 ? "free" : minPrice && minPrice < 25 ? "low" : "paid";

      const classification = e.classifications?.[0];
      const genre = classification?.genre?.name || "";
      const segment = classification?.segment?.name || "";

      return {
        id: `tm-${e.id}`,
        title: e.name,
        date: dateStr,
        displayDate: displayDate(start),
        time: timeStr ? displayTime(start) : null,
        endTime: null,
        venue: venueName,
        address: venue?.address?.line1 || "",
        city,
        category: inferCategory(e.name, genre, segment),
        cost,
        costNote: minPrice ? `From $${Math.round(minPrice)}` : undefined,
        description: truncate(e.info || e.pleaseNote || ""),
        url: e.url,
        source: "Ticketmaster",
        kidFriendly: /family|kid|child|disney|cirque/i.test(e.name + genre),
      };
    }).filter(Boolean);

    console.log(`  ✅ Ticketmaster: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Ticketmaster: ${err.message}`);
    return [];
  }
}

// ── NHL: San Jose Sharks ──

async function fetchSharksSchedule() {
  console.log("  ⏳ Sharks (NHL API)...");
  try {
    const res = await fetch("https://api-web.nhle.com/v1/club-schedule-season/SJS/now", {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const today = new Date().toISOString().split("T")[0];
    const events = (data.games || [])
      .filter((g) => g.gameType === 2) // regular season only
      .map((g) => {
        const dateStr = g.gameDate; // YYYY-MM-DD in local time
        if (!dateStr || dateStr < today) return null;
        const isHome = g.homeTeam?.abbrev === "SJS";
        if (!isHome) return null; // away games excluded
        const opponent = g.awayTeam?.commonName?.default || g.awayTeam?.abbrev || "Opponent";
        const timeUtc = g.startTimeUTC ? new Date(g.startTimeUTC) : null;
        return {
          id: h("sharks", String(g.id)),
          title: `Sharks vs. ${opponent}`,
          date: dateStr,
          displayDate: displayDate(new Date(dateStr + "T12:00:00")),
          time: timeUtc ? displayTime(timeUtc) : "7:00 PM",
          endTime: null,
          venue: "SAP Center",
          address: "525 W Santa Clara St, San Jose",
          city: "san-jose",
          category: "sports",
          cost: "paid",
          costNote: "From $30",
          description: `San Jose Sharks home game vs. ${opponent} at SAP Center.`,
          url: `https://www.nhl.com/sharks/schedule`,
          source: "NHL",
          kidFriendly: true,
        };
      }).filter(Boolean);
    console.log(`  ✅ Sharks: ${events.length} home games`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Sharks: ${err.message}`);
    return [];
  }
}

// ── MLS: San Jose Earthquakes ──

async function fetchEarthquakesSchedule() {
  console.log("  ⏳ Earthquakes (ESPN API)...");
  try {
    const res = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams/17/schedule",
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const today = new Date().toISOString().split("T")[0];
    const events = (data.events || []).map((e) => {
      const comp = e.competitions?.[0];
      if (!comp) return null;
      const dateStr = e.date?.split("T")[0];
      if (!dateStr || dateStr < today) return null;
      const homeTeam = comp.competitors?.find((c) => c.homeAway === "home");
      if (homeTeam?.team?.abbreviation !== "SJ") return null; // home only
      const awayTeam = comp.competitors?.find((c) => c.homeAway === "away");
      const opponent = awayTeam?.team?.displayName || "Opponent";
      const start = new Date(e.date);
      return {
        id: h("earthquakes", String(e.id)),
        title: `San Jose Earthquakes vs. ${opponent}`,
        date: dateStr,
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: null,
        venue: "PayPal Park",
        address: "1123 Coleman Ave, San Jose",
        city: "san-jose",
        category: "sports",
        cost: "paid",
        costNote: "From $20",
        description: `San Jose Earthquakes home game vs. ${opponent} at PayPal Park.`,
        url: `https://www.sjearthquakes.com/schedule`,
        source: "MLS",
        kidFriendly: true,
      };
    }).filter(Boolean);
    console.log(`  ✅ Earthquakes: ${events.length} home games`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Earthquakes: ${err.message}`);
    return [];
  }
}

// ── NWSL: Bay FC ──

async function fetchBayFCSchedule() {
  console.log("  ⏳ Bay FC (ESPN API)...");
  try {
    const res = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/soccer/nwsl.1/teams/bay-fc/schedule",
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const today = new Date().toISOString().split("T")[0];
    const events = (data.events || []).map((e) => {
      const comp = e.competitions?.[0];
      if (!comp) return null;
      const dateStr = e.date?.split("T")[0];
      if (!dateStr || dateStr < today) return null;
      const homeTeam = comp.competitors?.find((c) => c.homeAway === "home");
      if (!homeTeam?.team?.displayName?.toLowerCase().includes("bay")) return null;
      const awayTeam = comp.competitors?.find((c) => c.homeAway === "away");
      const opponent = awayTeam?.team?.displayName || "Opponent";
      const start = new Date(e.date);
      return {
        id: h("bayfc", String(e.id)),
        title: `Bay FC vs. ${opponent}`,
        date: dateStr,
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: null,
        venue: "PayPal Park",
        address: "1123 Coleman Ave, San Jose",
        city: "san-jose",
        category: "sports",
        cost: "paid",
        costNote: "From $20",
        description: `Bay FC home game vs. ${opponent} at PayPal Park.`,
        url: `https://www.bayfc.com/schedule`,
        source: "NWSL",
        kidFriendly: true,
      };
    }).filter(Boolean);
    console.log(`  ✅ Bay FC: ${events.length} home games`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Bay FC: ${err.message}`);
    return [];
  }
}

// ── City-specific BiblioCommons libraries ──
// Mountain View, Sunnyvale, and Palo Alto each have independent city library systems
// (not part of SCCL) that are likely on the BiblioCommons platform.

async function fetchMvplEvents() {
  return fetchBiblioEvents("mountainview", "Mountain View Public Library", () => "mountain-view");
}

async function fetchSunnyvaleLibraryEvents() {
  return fetchBiblioEvents("sunnyvale", "Sunnyvale Public Library", () => "sunnyvale");
}

async function fetchPaloAltoLibraryEvents() {
  return fetchBiblioEvents("paloalto", "Palo Alto City Library", () => "palo-alto");
}

// ── Happy Hollow Park & Zoo ──

async function fetchHappyHollowEvents() {
  console.log("  ⏳ Happy Hollow Park & Zoo...");
  try {
    const xml = await fetchText("https://www.happyhollow.org/events/feed/");
    const items = parseRssItems(xml);
    const now = new Date();
    const events = items
      .map((item) => {
        const start = parseDate(item.startDate || item.pubDate);
        if (!start || start < now) return null;
        return {
          id: h("happyhollow", item.link || item.title, item.pubDate),
          title: item.title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: null,
          venue: "Happy Hollow Park & Zoo",
          address: "748 Story Rd, San Jose",
          city: "san-jose",
          category: inferCategory(item.title, item.description || "", ""),
          cost: "paid",
          description: truncate(stripHtml(item.description || item.content)),
          url: item.link,
          source: "Happy Hollow Park & Zoo",
          kidFriendly: true,
        };
      })
      .filter(Boolean);
    console.log(`  ✅ Happy Hollow: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Happy Hollow Park & Zoo: ${err.message}`);
    return [];
  }
}

// ── Main ──

async function main() {
  console.log("Scraping upcoming South Bay events...\n");

  const sources = [
    fetchStanfordEvents,
    fetchSjsuEvents,
    fetchScuEvents,
    fetchChmEvents,
    fetchCampbellEvents,
    fetchLosGatosEvents,
    fetchSaratogaEvents,
    fetchLosAltosEvents,
    fetchMountainViewEvents,
    fetchSunnyvaleEvents,
    fetchCupertinoEvents,
    fetchSanJoseCityEvents,
    fetchTheTechEvents,
    fetchSjplEvents,
    fetchScclEvents,
    fetchSvlgEvents,
    fetchSjJazzEvents,
    fetchMontalvoEvents,
    // fetchEventbriteEvents, — deprecated: /v3/events/search/ removed by Eventbrite
    // fetchEarthquakesSchedule, — ESPN MLS API has no 2026 schedule data yet; Ticketmaster covers PayPal Park
    // fetchBayFCSchedule, — ESPN NWSL has no Bay FC data; Ticketmaster covers PayPal Park
    fetchTicketmasterEvents,
    fetchSharksSchedule,
    fetchMvplEvents,
    fetchSunnyvaleLibraryEvents,
    fetchPaloAltoLibraryEvents,
    fetchHappyHollowEvents,
  ];

  const results = await Promise.allSettled(sources.map((fn) => fn()));

  const allEvents = [];
  const sourceNames = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.length > 0) {
      allEvents.push(...result.value);
      const src = result.value[0]?.source;
      if (src && !sourceNames.includes(src)) sourceNames.push(src);
    }
  }

  // Clean titles: strip calendar-artifact date prefixes, apply to all events
  allEvents.forEach((e) => { e.title = cleanTitle(e.title); });

  // Filter: must have date and city and title, must be today or future, must be public, not cancelled
  // Also skip zero-duration university calendar markers (e.g. "5:00 PM – 5:00 PM")
  const uniSources = new Set(["Stanford Events", "Santa Clara University", "SJSU Events"]);
  const today = new Date().toISOString().split("T")[0];
  const valid = allEvents.filter(
    (e) =>
      e.date &&
      e.date >= today &&
      e.city &&
      e.title &&
      !/^cancell?ed/i.test(e.title) &&
      !(uniSources.has(e.source) && e.time && e.endTime && e.time === e.endTime) &&
      isPublicEvent(e.title, e.source),
  );

  // Sort by date ascending
  valid.sort((a, b) => a.date.localeCompare(b.date));

  // Per-source cap — prevent large sources (SJSU, SCU) from drowning community events
  const MAX_PER_SOURCE = 200;
  const sourceCounts = {};
  const capped = valid.filter((e) => {
    sourceCounts[e.source] = (sourceCounts[e.source] || 0) + 1;
    return sourceCounts[e.source] <= MAX_PER_SOURCE;
  });

  // Deduplicate by normalized title + date
  const seen = new Set();
  const deduped = capped.filter((e) => {
    const key = `${e.title.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 30)}|${e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Detect multi-day events (same title on 3+ distinct dates = ongoing exhibit/show)
  // Collapse to first occurrence only; mark ongoing: true so the UI can separate them
  const titleDates = {};
  deduped.forEach((e) => {
    const key = e.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim().substring(0, 50);
    if (!titleDates[key]) titleDates[key] = new Set();
    titleDates[key].add(e.date);
  });
  const multiDayKeys = new Set(
    Object.entries(titleDates)
      .filter(([, dates]) => dates.size >= 3)
      .map(([key]) => key),
  );
  const seenMultiDay = new Set();
  const finalEvents = deduped.filter((e) => {
    const key = e.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim().substring(0, 50);
    if (multiDayKeys.has(key)) {
      if (seenMultiDay.has(key)) return false;
      seenMultiDay.add(key);
      e.ongoing = true; // flag for UI — show in "Ongoing" section, not day-by-day feed
    }
    return true;
  });

  const ongoingCount = finalEvents.filter((e) => e.ongoing).length;

  const output = {
    generatedAt: new Date().toISOString(),
    eventCount: finalEvents.length,
    sources: sourceNames,
    events: finalEvents,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ Done — ${finalEvents.length} events (${ongoingCount} ongoing) from ${sourceNames.length} sources → ${OUT_PATH}`);

  // Summary by city
  const byCity = {};
  finalEvents.forEach((e) => { byCity[e.city] = (byCity[e.city] || 0) + 1; });
  console.log("\nBy city:", byCity);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
