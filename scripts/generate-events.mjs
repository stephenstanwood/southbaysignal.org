#!/usr/bin/env node
/**
 * generate-events.mjs
 *
 * Scrapes upcoming events from all available South Bay feeds and writes
 * them to src/data/south-bay/upcoming-events.json.
 *
 * Sources (23 active):
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
 *   - Mountain View Public Library (BiblioCommons API) — site ID: "librarypoint"
 *   - Sunnyvale Public Library (BiblioCommons API) — Events feature disabled (403)
 *   - Palo Alto City Library (BiblioCommons API)
 *   - Computer History Museum Events (RSS + title-based date extraction)
 *   - Montalvo Arts Center (RSS)
 *   - San Jose Jazz (RSS)
 *   - Silicon Valley Leadership Group (RSS)
 *   - Happy Hollow Park & Zoo (RSS)
 *   - LibCal (Los Gatos, Milpitas) — BLOCKED: API requires OAuth (see note below)
 *   - Santa Clara County Fire Department (Eventbrite — hardcoded; /v3/events/search/ removed)
 *
 * NOTE: Mountain View/Sunnyvale/SJ city/Cupertino CivicPlus iCal feeds return 403/404.
 * Those cities' library systems are covered via BiblioCommons instead.
 * The Tech Interactive has no standard RSS feed — needs Eventbrite or direct calendar.
 *
 * Usage:
 *   node scripts/generate-events.mjs
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, createSign } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-load .env.local if present (for local development without manual env injection)
const envLocalPath = join(__dirname, "..", ".env.local");
if (existsSync(envLocalPath)) {
  const lines = readFileSync(envLocalPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
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
  // Use PT to stay consistent with displayDate — avoids UTC-midnight off-by-one
  const parts = d.toLocaleDateString("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit",
    timeZone: "America/Los_Angeles",
  }).split("/");
  // Format: MM/DD/YYYY → YYYY-MM-DD
  return `${parts[2]}-${parts[0]}-${parts[1]}`;
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

// ── Event title blocklist — skip private/internal/irrelevant events ──────────
const TITLE_BLOCKLIST = [
  /\bpractice\b/i,        // team practices
  /\brehearsal\b/i,       // rehearsals
  /\bboard meeting\b/i,   // internal board meetings
  /\bstaff meeting\b/i,   // internal staff meetings
  /\bcommittee meeting\b/i, // internal committee meetings
  /\bclosed\s+(for|—|–|-)/i, // closure notices
  /\bcancelled?\b/i,      // cancelled events
];

function isBlockedEvent(title) {
  return TITLE_BLOCKLIST.some((re) => re.test(title));
}

function stripHtml(html) {
  if (!html) return "";
  return html
    // Decode entities first so entity-encoded tags like &lt;strong&gt; become <strong> before stripping
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#x2019;/gi, "\u2019").replace(/&#x2018;/gi, "\u2018")
    .replace(/&#x201C;/gi, "\u201C").replace(/&#x201D;/gi, "\u201D")
    .replace(/&#x2013;/gi, "\u2013").replace(/&#x2014;/gi, "\u2014")
    .replace(/&#\d+;/g, "").replace(/&[a-z]+;/g, "")
    // Then strip all HTML tags
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim();
}

// Skip internal university admin events that aren't open to the general public
const INTERNAL_EVENT_PATTERNS = [
  /\bregistration\b/i,
  /\badd\s*[&\/]\s*drop\b/i,
  /\broom\s+closed\b/i,
  /\bclosed\b.*\b(day|holiday|weekend)\b/i,
  /^closed\s*[-–]/i, // campus closed announcements like "Closed - Good Friday"
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
  /\bquarter\s+planning\b/i,
  /\bopens?\s+for\s+enrollment\b/i,
  /\bgsb\s+instruction\b/i,
  /\bholiday\s+observance\b/i,
  /\buniversity\s+holiday\b/i,
  /\badministrative\s+and\s+academic\s+holiday\b/i,
  /\bacademic\s+and\s+administrative\s+holiday\b/i,
  /\badmin(istrative)?\s+holiday\b/i,
  /\bhousing\s+move[\s-]?in\b/i,
  /\bhousing\s+move[\s-]?out\b/i,
  /\bhousing\s+opens?\b/i,
  /\bresidential?\s+(check[\s-]?in|check[\s-]?out)\b/i,
  /\bdorm(itory)?\s+(open|close|move)\b/i,
  /\btuition\s+(due|payment|deadline)\b/i,
  // Medical research recruitment (not community events)
  /\bclinical\s+(research|study|trial)\b/i,
  /\bresearch\s+study\s+program\b/i,
  /\bparticipants?\s+needed\b/i,
  /\beligibility\s+criteria\b/i,
  /\b(MDD|ADHD|PTSD)\s+study\b/i,
  // HR / payroll / admin (internal university operations)
  /\bfinancial\s+counseling\b/i,
  /\bby\s+appointment\s+only\b/i,
  /\btimesheets?\b/i,
  /\bapprove\s+timesheets?\b/i,
  /\bpay\s+period\b/i,
  /\bpayroll\b/i,
  /\bpay\s+date\b/i,
  /\bw[\-\s]?2\b/i,
  /\bofficer\s+application\b/i,
  /\bapply\s+to\s+be\s+(an?\s+)?officer\b/i,
  /\bclub\s+(officer|exec|election)\b/i,
  /\bapplication\s+(closes?|deadline|due)\b/i,
  /\bvolunteer\s+(sign[\s-]?up|application)\b/i,
  /\bposition\s+(open|available|posting)\b/i,
  /\bjob\s+(fair|posting|application)\b/i,
  /\brecruiting\b/i,
  /\bopen\s+position\b/i,
  /\binternship\s+application\b/i,
  /\bscholarship\s+(application|nomination)\b/i,
  /\bnomination\s+application\b/i,
  /\bgrant\s+application\b/i,
  /\bfundraiser\b/i,
  /\bdonation\s+(drive|deadline)\b/i,
  /\bsurvey\b/i,
  /\bfeedback\s+(form|survey)\b/i,
  /\bcommencement\s+rehearsal\b/i,
  /\bprocessing\s+deadline\b/i,
  /\badmission\s+(deadline|decision)\b/i,
  // Graduate program info sessions / recruitment webinars (not open public events)
  /\binfo(rmation)?\s+sessions?\b/i,
  /\binfo\s+sessions?\b/i,
  /\boffice\s+hours?\b/i,
  /\bwebinar\s+series\b/i,
  /\bprogram\s+webinar\b/i,
  /\badmissions?\s+webinar\b/i,
  /\bvirtual\s+information\b/i,
  /\bms\s+in\s+(is|cs|business|data|finance)\b/i,
  /\b(ms|mba|phd|master'?s?)\s+.{0,40}\s+(information\s+sessions?|info\s+sessions?|open\s+house)\b/i,
  /\bmba\s+(webinar|info|information)\b/i,
  /\blearn\s+more\s+about\s+the\s+(ms|mba|phd|master)\b/i,
  /\bgraduate\s+program\s+(info|webinar|session)\b/i,
  /\bspring\s+webinar\s+series\b/i,
  /\bfall\s+webinar\s+series\b/i,
  /\bsupport\s+office\s+hour\b/i,
  /\btech\s+support\s+hour\b/i,
  // Degree program advertising / school recruitment
  /\b(degree|program)\s+(open\s+house|info\s+night|interest\s+session)\b/i,
  /\bprospective\s+(student|applicant)\b/i,
  // Internal university committee / admin meetings (acronym + "Meeting")
  /^[A-Z]{2,5}\s+Meeting$/,
  /\b(faculty|staff|senate|curriculum|advisory|steering|executive)\s+(committee|council|board)\s+meeting\b/i,
  /\bcommittee\s+meeting\b/i,
  /\btown\s+hall\s+meeting\b/i,
  /\bboard\s+of\s+trustees\b/i,
  /\bdepartment\s+meeting\b/i,
  /\bfaculty\s+meeting\b/i,
  /\bstaff\s+meeting\b/i,
  // Ticketmaster resale / secondary market listings
  /^BuyBack:/i,
  /^Resale:/i,
  /\bVIP\s+Package\b/i,
  /\bMeet\s*[&+]\s*Greet\b/i,
  /\bFloor\s+Package\b/i,
  // SCU course-based / enrolled-student-only events
  /^IN-PERSON ONLY:/i,
  /^ONLINE ONLY:/i,
  /^HYBRID:/i,
  /^OSHER\s+ONLINE/i,
  /\bcourse\s+lecture\b/i,
  /\bclass\s+session\b/i,
  /\bclasses\s+begin\b/i,
  /\bclasses\s+end\b/i,
  /\breading\s+room\s+open\b/i,
  /\bstudy\s+abroad\s+advising\b/i,
  /\badvising\s+hours?\b/i,
  /\bnoon\s+mass\b/i,
  /\bsacrament\s+of\b/i,
  /\bpalm\s+sunday\b/i,
  /\bresume\s+(refresh|workshop|review)\b/i,
  /\bcoffee\s+chat\s+with\b/i,
  /\bvirtual\s+coffee\s+chat\b/i,
  /\btenure\s*[&+]\s*promotion\b/i,
  /\bsearch\s+training\b/i,
  /\brecruitment\s+training\b/i,
  /\b(plan\s+your\s+(2l|3l|1l))\b/i,
  /^Week\s+\d+$/i,
  /^Program\s+Start$/i,
  /^(Classes?|Quarter|Semester)\s+(Begin|Start|End)\b/i,
  /\bfarm\s+stand\b/i,
  /\btabling\b/i,
  /\bintro\s+to\s+(wave|hpc|canvas|banner)\b/i,
  /\bgetting\s+started\s+with\b/i,
  /\blabor\s+(management|relations)\s+meeting\b/i,
  /\bcareer\s+fair\s+ready\b/i,
  /\bget\s+career\s+fair\b/i,
  /\bwcag\b/i,
  /\baccessibility\s+compliance\b/i,
  /\bcreating\s+accessible\b/i,
  /\bworkday\s+(financials?|training|procurement|hr)\b/i,
  /\bpeer\s+advisor\s+hours?\b/i,
  /\bcoffee\s+and\s+donuts?\b/i,
  /\bdonuts?\s+and\s+coffee\b/i,
  /\bcommunity\s+liturgy\b/i,
  /\bnoon\s+day\s+zen\b/i,
  /\bcareer\s+advice\s+support\b/i,
  /\b(drop[\s-]?in\s+)?lsb\s+career\b/i,
  /\bglean\s+team\b/i,
  /\bmaking\s+meaning\s+with\s+scu\b/i,
  /\bweekday\s+liturgy\b/i,
  /\bevening\s+zen\b/i,
  /\bexamen\b/i,
  // Collaboration/classroom tool training (not public events)
  /\blucidspark\b/i,
  /\blucidchart\b/i,
  /\biclicker\b/i,
  /\bpoll\s+everywhere\b/i,
  /\bpodcasting\s+with\s+ai\b/i,
  /\bpopular\s+tips\s+and\s+tricks\b/i,
  /\bget\s+your\s+students\s+to\b/i,
  /\bhybrid\s+meetings\s+and\s+classes\b/i,
  /\bpolling\s+for\s+student\s+engagement\b/i,
  /\bcanvas\s+(overview|training|session|workshop)\b/i,
  /\bdigital\s+whiteboards?\b/i,
  /\badobe\s+acrobat\b.*\btips?\b/i,
  // Career services workshops (enrolled students / internal)
  /\b(negotiat\w+)\s+(workshop|confidence|salary)\b/i,
  /\bnetworking\s+(workshop|success|power)\b/i,
  /\binterview\s+workshop\b/i,
  /\bmaster\s+(your\s+)?(job|internship|connection)\b/i,
  /\bunlock\s+the\s+power\s+of\s+connections\b/i,
  /\bfrom\s+awkward\s+to\s+awesome\b/i,
  /\bcraft(ing)?\s+cover\s+letters?\b/i,
  /\bcover\s+letter\s+workshop\b/i,
  /\bjob\s+(search|fair|internship)\s+workshop\b/i,
  /\binternship\s+search\s+workshop\b/i,
  /\bace\s+your\s+(next\s+)?interview\b/i,
  /\bnetworking\s+success\b/i,
  // Academic writing / research workshops (internal university)
  /\brevising\s+for\s+clarity\b/i,
  /\bscientific\s+abstracts?\b/i,
  /\bnavigating\s+literature\s+reviews?\b/i,
  /\bgraduate\s+writer\b/i,
  /\bcommon\s+grammar\s+and\s+punctuation\b/i,
  /\btransitions\s+for\s+coherence\b/i,
  /\bsearching\s+for\s+research\s+articles?\b/i,
  /\bnavigating\s+(literature|ai\s+resources)\b/i,
  // Student wellness / counseling workshops (internal)
  /\btest\s+anxiety\b/i,
  /\bglobal\s+connections:/i,
  /\bacademic\s+stress\b/i,
  /\bhealthy\s+boundaries\b/i,
  /\bovercoming\s+the\s+fear\s+of\b/i,
  /\btime\s+management\b.*\bworkshop\b/i,
  // Immigration / visa services (enrolled students only)
  /\bpost[\s-]?(completion\s+)?opt\b/i,
  /\bopt\s+(workshop|application|packet|prep)\b/i,
  /\bI-765\b/i,
  // Internal admin / recognition events
  /\bbudget\s+town\s+hall\b/i,
  /\bofficial\s+syllabus\s+workshop\b/i,
  /\bchat\s+with\s+the\s+(chair|dean|provost|president)\b/i,
  /\bdonuts?\s+with\s+the\s+(dean|chair|provost)\b/i,
  /\bhonoring\s+faculty\s+and\s+staff\b/i,
  /\badmitted\s+(spartans?|students?)\s+day\b/i,
  /\bfinance\s+what'?s?\s+up\b/i,
  /\bspring\s+budget\b/i,
  /\bchhs\b.*\bjournal\s+club\b/i,
  // Internal seminar series / recurring workshop codes (not public events)
  /\bBRICS\s+Session\b/i,
  /^[A-Z]{3,5}\s+Session$/,
  // Ticketmaster merchandise / add-ons (not events)
  /\bsouvenir\s+ticket\b/i,
  /\bcommemorative\s+(magnet|pin|coin|lanyard)\b/i,
  // Cancelled events (anywhere in title, not just start)
  /\bcancell?ed\b/i,
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

const CANCELLED_PATTERN = /\bcancell?ed\b/i;
const VIRTUAL_PATTERNS = [
  /\bvirtual\b/i,
  /\bvia zoom\b/i,
  /\bon zoom\b/i,
  /\bzoom link\b/i,
  /\bonline only\b/i,
  /\bwebinar\b/i,
];

function isVirtualEvent(title, description, venue) {
  const fields = [title, description, venue].filter(Boolean).join(' ');
  return VIRTUAL_PATTERNS.some(p => p.test(fields));
}

// Events that aren't a good fit regardless of source
const GLOBAL_EXCLUSIONS = [
  /\balcoholics\s+anonymous\b/i,
  /\b(?:AA|NA|Al-Anon)\s+meeting\b/i,
];

function isPublicEvent(title, source, description, venue) {
  // Always filter cancelled events regardless of source
  if (CANCELLED_PATTERN.test(title)) return false;
  // Filter virtual/online-only events
  if (isVirtualEvent(title, description, venue)) return false;
  // Global exclusions — not a fit for a local news site
  if (GLOBAL_EXCLUSIONS.some(p => p.test(title))) return false;
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
// Known recurring scraper typos — keyed by the bad string, value is the fix.
// Add entries here when a source consistently sends bad data.
const TITLE_FIXES = {
  "Fun Runa": "Fun Run",
};

function cleanTitle(title) {
  if (!title) return title;
  let t = title
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
  // Downcase ALL-CAPS words that aren't acronyms (5+ letters, e.g. SPECIAL → Special)
  const KEEP_UPPER = new Set(["ICYMI", "LGBTQ", "LGBTQIA", "BIPOC", "STEAM", "LEGO"]);
  t = t.replace(/\b[A-Z]{5,}\b/g, (w) => KEEP_UPPER.has(w) ? w : w[0] + w.slice(1).toLowerCase());
  // Fix pipes without surrounding spaces: "Foo |Bar" → "Foo | Bar"
  t = t.replace(/\s*\|\s*/g, " | ");
  // Strip non-Latin (CJK, etc.) prefix before English content:
  // "中/英文雙語說故事時間 Mandarin/English…" → "Mandarin/English…"
  if (/^[\u2E80-\u9FFF\uF900-\uFAFF]/.test(t)) {
    t = t.replace(/^.*?(?=[A-Za-z])/, "");
  }
  // Strip non-Latin bilingual suffix after " / ":
  // "Bilingual Family Storytime / 中英雙語故事時間" → "Bilingual Family Storytime"
  t = t.replace(/\s*\/\s*[\s\S]*[\u2E80-\u9FFF\uF900-\uFAFF][\s\S]*$/, "");
  // Strip trailing time annotations: "Good Friday Liturgy 3 PM" → "Good Friday Liturgy"
  t = t.replace(/\s+\d{1,2}(?::\d{2})?\s*(?:AM|PM)\s*$/i, "");
  // Apply known recurring fixes from source data
  for (const [bad, fix] of Object.entries(TITLE_FIXES)) {
    t = t.replaceAll(bad, fix);
  }
  return t;
}

function truncate(text, len = 200) {
  if (!text || text.length <= len) return text || "";
  return text.substring(0, len).replace(/\s+\S*$/, "") + "…";
}

/**
 * Clean a raw iCal LOCATION field into a display-friendly venue name.
 * iCal LOCATION blobs often contain "- Venue Name  City CA 95000" or similar.
 * Strips leading dashes, trailing city/state/zip, and HTML tags.
 */
function cleanVenue(raw) {
  if (!raw) return raw;
  let v = raw.replace(/<[^>]+>/g, "").trim();
  // Remove leading "- " dash artifact from CivicPlus iCal
  v = v.replace(/^-\s+/, "");
  // Remove trailing "  City ST zip" pattern (double-space before city)
  v = v.replace(/\s{2,}[A-Za-z][A-Za-z\s]+[A-Z]{2}\s+\d{5}.*$/, "");
  // Remove trailing ", City, CA 9xxxx" or " City CA 9xxxx" pattern (handles commas too)
  v = v.replace(/[,\s]+[A-Za-z][a-zA-Z\s,]+CA[,\s]+9\d{4}.*$/, "");
  // Remove inline address blob: "Name  123 Street..." or "Name 123 Street..." with double-space
  v = v.replace(/\s{2,}\d+\s+.*$/, "");
  // Strip trailing " - " or lone dash at end
  v = v.replace(/\s*-\s*$/, "");
  // Strip " - <address>" suffix where address starts with a number (e.g. "Council Chambers - 110 E. Main St")
  v = v.replace(/\s+-\s+\d+\s+.*$/, "");
  // If the entire string is just a raw address (starts with a number), return empty so caller can use fallback
  if (/^\d+\s/.test(v)) return "";
  return v.trim();
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

function inferCategory(title, desc, type, venue = "") {
  const t = `${title} ${desc} ${type} ${venue}`.toLowerCase();
  if (t.includes("story time") || t.includes("storytime") || t.includes("toddler") || t.includes("baby") || t.includes("preschool") || t.includes("kids") || t.includes("children")) return "family";
  if (t.includes("concert") || t.includes("music") || t.includes("jazz") || t.includes("symphony") || t.includes("band") || t.includes("orchestra") || t.includes("choir")) return "music";
  if (t.includes("comedy") || t.includes("stand-up") || t.includes("standup") || t.includes("improv show") || t.includes("comedian")) return "arts";
  // Use word-boundary match for "art/arts/artist/artwork" to avoid false positives from
  // words like "department" (dep-ART-ment), "participants" (p-ART-icipants), "party", "earth", etc.
  const isArtWord = /\barts?\b|\bartist|\bartwork|\bartistry/.test(t);
  if (t.includes("exhibit") || t.includes("gallery") || t.includes("theater") || t.includes("theatre") || t.includes("film") || t.includes("cinema") || t.includes("dance") || t.includes("performance") || t.includes("museum") || (isArtWord && !t.includes("martial art"))) return "arts";
  // Book clubs and discussions are arts/reading events, not formal education
  if (/\bbook\s+(club|discussion|group)\b/.test(t)) return "arts";
  // Nature / wildlife events — check BEFORE sports to avoid false positives
  if (/\b(wildlife|bird watching|birdwatching|birding|egret|heron|pelican|raptor|owl|hawk|falcon|butterfly|dragonfly|wildflower|tide pool|tidepool|nature walk|nature tour)\b/.test(t)) return "outdoor";
  // Volunteering (farm, park, trail) is community, not sports — check before sports rules
  if (/\b(volunteer|volunteering)\b/.test(t) && /\b(farm|garden|trail|park|nature)\b/.test(t)) return "community";
  // School/fundraiser fun runs are community events, not sports
  // Also covers programs like "Girls on the Run" which use "run" or "5K" but are community/empowerment programs
  const isSchoolFundraiser = /\b(school|middle school|elementary|fundrais|walk-a-thon|walkathon|girls on the run|charity run|fun run program)\b/.test(t);
  // Board games, card games, tabletop games and D&D are community, not sports
  const isBoardGame = /\b(board game|card game|tabletop|dungeons.{0,5}dragons|d&d|rpg club|wargame)\b/.test(t);
  if (!isBoardGame && (t.includes("game") || t.includes("sport") || t.includes("athletic") || t.includes("golf") || t.includes("tennis") || t.includes("soccer") || t.includes("basketball") || t.includes("baseball") || t.includes("softball") || t.includes("volleyball") || t.includes("swimming") || t.includes("swim meet") || t.includes("track") || t.includes("cross country") || t.includes("lacrosse") || t.includes("football") || t.includes("gymnastics") || t.includes("wrestling") || t.includes("water polo") || t.includes("polo") || t.includes("hockey") || t.includes("rugby") || /\browing\b/.test(t) || t.includes("crew") || t.includes("diving") || t.includes("fencing") || t.includes("skiing") || t.includes("snowboard") || t.includes("cycling") || t.includes("equestrian") || t.includes("vs.") || t.includes("vs ") || (!isSchoolFundraiser && /\b(fun run|road run|trail run|color run)\b/.test(t)) || (!isSchoolFundraiser && /\b(5k|10k|half marathon|marathon|triathlon)\b/.test(t)) || (!isSchoolFundraiser && t.includes("race")))) return "sports";
  // Government/civic commission and committee meetings are always community events.
  // Must run BEFORE the sports check because "transportation" contains "sport" as substring.
  if (/\b(commission|committee|council|board)\s+(meeting|hearing|session)\b/i.test(title) ||
      /\b(city council|town council|planning commission|city manager|public works)\b/i.test(title)) return "community";
  // Government/civic events at markets are still community events
  if (/\b(office hours|mayor|city council|council member|supervisor)\b/.test(t) && t.includes("market")) return "community";
  // "craft" alone is too broad — "well-crafted resume", "refine your craft" → require craft market context
  const isCraftMarket = /\bcraft\s*(fair|market|show|sale|night|bazaar|booth|vendor)\b/.test(t);
  // "fair" alone is too broad — only match community/arts fairs, not job/health/resource/housing fairs
  const isFairEvent = /\b(craft|art|artisan|maker|vendor|street|holiday|county|state|flea|antique|swap|harvest|spring|summer|fall|winter) fair\b/.test(t);
  if (t.includes("market") || isFairEvent || t.includes("vendor") || isCraftMarket) return "market";
  // Workshops/classes/lectures in the TITLE are educational — check before outdoor to avoid false positives
  const titleLower = title.toLowerCase();
  if (/\b(workshop|webinar|seminar|lecture|class|tutorial|training|course)\b/.test(titleLower)) return "education";
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
      // CivicPlus-specific (various field names used across city deployments)
      startDate: get("calendarEvent:startDate") || get("startDate"),
      eventDates: get("calendarEvent:EventDates") || get("calendarEvent:eventDates") || "",
      eventTimes: get("calendarEvent:EventTimes") || get("calendarEvent:eventTimes") || "",
      location: get("calendarEvent:location") || get("calendarEvent:Location") || get("location"),
      // Localist-specific
      georss_point: get("georss:point"),
      s_localtime: get("s:localtime"),
      // MEC (Modern Events Calendar) WordPress plugin
      mecStartDate: get("mec:startDate"),
      mecEndDate: get("mec:endDate"),
      mecStartTime: get("mec:startTime"),
      mecEndTime: get("mec:endTime"),
    });
  }
  return items;
}

// ── iCal Parser ──

function parseIcalEvents(ical) {
  const events = [];
  // RFC 5545 §3.1: long lines are folded with CRLF + whitespace. Unfold before parsing.
  const unfolded = ical.replace(/\r?\n[ \t]/g, "");
  const eventBlocks = unfolded.split("BEGIN:VEVENT");
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
      let isOngoing = false;
      if (start < now) {
        if (end && end >= now) {
          eventDate = now; // currently running → anchor to today
          isOngoing = true; // multi-day exhibit/series — show in Ongoing section, not Today
        } else {
          return null; // fully in the past
        }
      }
      return {
        id: `stanford-${ev.id}`,
        title: ev.title,
        date: isoDate(eventDate),
        displayDate: displayDate(eventDate),
        time: isOngoing ? null : displayTime(start),   // no time for ongoing exhibits
        endTime: isOngoing ? null : (end ? displayTime(end) : null),
        ongoing: isOngoing,
        venue: ev.location_name || "Stanford University",
        address: ev.address || "",
        city: "palo-alto",
        category: inferCategory(ev.title, ev.description_text || "", ""),
        cost: (ev.free || /\balcoholics anonymous\b/i.test(ev.title)) ? "free" : "paid",
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

// Filter out student-internal events from university feeds.
// These are org meetings, advising sessions, career fairs for enrolled students, etc.
// Public-facing events (exhibits, performances, athletics, lectures) should pass through.
const STUDENT_ONLY_URL_PATHS = /\/(school-of-law|career-center|global-engagement|registrar|financial-aid|residence-life|housing|student-life|orientation|commencement)\//i;
const STUDENT_ONLY_TITLE = /\b(board meeting|drop-in advising|office hours|spartan safe|wellness and recovery meeting|register now on handshake)\b/i;
const STUDENT_ONLY_DESC = /\b(for international students|requesting classroom|register now on handshake)\b/i;

function isStudentOnlyEvent(item) {
  if (STUDENT_ONLY_URL_PATHS.test(item.link || "")) return true;
  if (STUDENT_ONLY_TITLE.test(item.title || "")) return true;
  const desc = stripHtml(item.description || "");
  if (STUDENT_ONLY_DESC.test(desc)) return true;
  return false;
}

async function fetchSjsuEvents() {
  console.log("  ⏳ SJSU Events...");
  try {
    const xml = await fetchText("https://events.sjsu.edu/calendar.xml", 45_000); // large feed ~1.4MB
    const items = parseRssItems(xml);
    let skipped = 0;
    const events = items.map((item) => {
      if (isStudentOnlyEvent(item)) { skipped++; return null; }
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
    console.log(`  ✅ SJSU: ${events.length} events (${skipped} student-only filtered)`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SJSU: ${err.message}`);
    return [];
  }
}

// SCU-specific category inference: use inferCategory as a base but reclassify
// "sports" events that are actually talks, speaker series, or community events.
const SCU_SPORTS_PATTERNS = /\b(game|match|tournament|championship|athletics|swim meet|track meet|vs\.?|invitational|regatta|scrimmage)\b/i;

function inferScuCategory(title, desc) {
  const base = inferCategory(title, desc, "");
  if (base === "sports" && !SCU_SPORTS_PATTERNS.test(title)) {
    return "community";
  }
  return base;
}

async function fetchScuEvents() {
  console.log("  ⏳ Santa Clara University Events...");
  try {
    const xml = await fetchText("https://events.scu.edu/live/rss/events");
    const items = parseRssItems(xml);
    let skippedScu = 0;
    const events = items.map((item) => {
      if (isStudentOnlyEvent(item)) { skippedScu++; return null; }
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
        category: inferScuCategory(item.title, item.description),
        cost: "free",
        description: truncate(stripHtml(item.description)),
        url: item.link,
        source: "Santa Clara University",
        kidFriendly: false,
      };
    }).filter(Boolean);
    console.log(`  ✅ SCU: ${events.length} events (${skippedScu} student-only filtered)`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SCU: ${err.message}`);
    return [];
  }
}

// ── CivicPlus EventDates parser ──
// Parses strings like "March 28, 2026" or "April 6, 2026 - April 10, 2026"
function parseCivicPlusEventDates(eventDatesStr) {
  if (!eventDatesStr) return null;
  // Strip trailing date range (take the start date only)
  const start = eventDatesStr.split(/\s*[-–]\s*/)[0].trim();
  const d = new Date(start);
  if (!isNaN(d.getTime())) return d;
  return null;
}

// Parses CivicPlus EventTimes like "07:00 PM - 09:00 PM" into displayable time string
function parseCivicPlusEventTime(eventTimesStr) {
  if (!eventTimesStr) return null;
  // Take just the start time
  const parts = eventTimesStr.split(/\s*[-–]\s*/);
  const startTime = parts[0].trim();
  const endTime = parts[1]?.trim();
  // Skip all-day markers (midnight to midnight)
  if (startTime === "12:00 AM" && (!endTime || endTime === "11:59 PM")) return null;
  // Format as "7:00 PM" or "7:00 PM – 9:00 PM"
  const fmt = (t) => {
    const m = t.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
    if (!m) return t;
    const h = parseInt(m[1]);
    const min = m[2];
    const ampm = m[3].toUpperCase();
    return min === "00" ? `${h}${ampm.toLowerCase()}` : `${h}:${min}${ampm.toLowerCase()}`;
  };
  if (endTime && endTime !== "11:59 PM") return `${fmt(startTime)} – ${fmt(endTime)}`;
  return fmt(startTime);
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
        category: inferCategory(item.title, item.description, "", "Computer History Museum"),
        cost: "paid",
        ongoing: true, // CHM items are running exhibits, not time-specific events
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
  const events = [];
  const currentYear = new Date().getFullYear();

  try {
    // Scrape paginated HTML calendar (5 events/page, ~4 pages)
    for (let page = 1; page <= 6; page++) {
      const url = page === 1
        ? "https://www.sanjosejazz.org/events/"
        : `https://sanjosejazz.org/events/page/${page}/`;
      // SJZ blocks non-browser UAs — use a browser-like UA
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) break;
      const html = await res.text();
      if (!html || html.length < 500) break;

      // Parse each .sjz-event container block (split on "sjz-event is-" to avoid
      // matching sub-classes like sjz-event-name, sjz-event-date, etc.)
      const eventBlocks = html.split(/class="sjz-event is-/).slice(1);
      if (eventBlocks.length === 0) break;

      for (const block of eventBlocks) {
        const nameMatch = block.match(/class="sjz-event-name">\s*([\s\S]*?)\s*<\/p>/);
        const dateMatch = block.match(/class="sjz-event-date">\s*([\s\S]*?)\s*<\/p>/);
        const hourMatch = block.match(/class="sjz-event-hour">\s*([\s\S]*?)\s*<\/p>/);
        const excerptMatch = block.match(/class="sjz-event-excerpt">\s*([\s\S]*?)\s*<\/p>/);
        const linkMatch = block.match(/href="(https?:\/\/[^"]*sanjosejazz\.org\/events\/[^"]+)"[^>]*>READ MORE/);
        const isFree = /FREE ADMISSION/i.test(block);

        const title = nameMatch?.[1]?.trim();
        const dateStr = dateMatch?.[1]?.trim(); // e.g. "Fri, Apr 3"
        if (!title || !dateStr) continue;

        // Parse time from hour field (e.g. "7pm Pacific / <span>SJZ Break Room</span>")
        const rawHour = hourMatch?.[1] || "";
        const timeMatch = rawHour.match(/(\d+(?::\d+)?(?:am|pm))/i);
        const time = timeMatch?.[1] || null;

        // Extract venue from <span class="event-place">
        const venueMatch = rawHour.match(/event-place[^>]*>[\s\S]*?(?:-->)?\s*([\w\s]+?)\s*(?:<!--)?<\/span>/);
        const venue = venueMatch?.[1]?.trim() || "SJZ Break Room";

        // Parse date — "Fri, Apr 3" → full ISO date
        const dmMatch = dateStr.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)/);
        if (!dmMatch) continue;
        const monthNames = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
        const month = monthNames[dmMatch[1]];
        const day = parseInt(dmMatch[2]);
        let year = currentYear;
        // If the month is before now and more than 2 months ago, it's next year
        const now = new Date();
        const candidate = new Date(year, month, day);
        if (candidate < new Date(now.getTime() - 60 * 86400000)) year++;
        const isoDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

        // Clean description
        const desc = excerptMatch?.[1]?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || "";
        const shortDesc = desc.length > 200 ? desc.slice(0, 197) + "…" : desc;

        // Format time for display
        let displayTime = null;
        if (time) {
          const h = parseInt(time);
          const isPm = /pm/i.test(time);
          const minMatch = time.match(/:(\d+)/);
          const mins = minMatch ? `:${minMatch[1]}` : ":00";
          const hour24 = isPm && h !== 12 ? h + 12 : !isPm && h === 12 ? 0 : h;
          displayTime = `${hour24}${mins.replace(":00", "")}:00`.replace(/^(\d):/, "0$1:");
          // Format as "7:00 PM"
          const displayH = hour24 > 12 ? hour24 - 12 : hour24 === 0 ? 12 : hour24;
          displayTime = `${displayH}:${minMatch?.[1] || "00"} ${isPm ? "PM" : "AM"}`;
        }

        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "").slice(0, 40);
        events.push({
          id: `sjz-${slug}-${isoDate}`,
          title: title.includes("SJZ") || title.includes("San Jose Jazz") ? title : `${title} — San Jose Jazz`,
          date: isoDate,
          displayDate: dateStr,
          time: displayTime,
          endTime: null,
          venue: venue,
          address: "310 South First St, San Jose",
          city: "san-jose",
          category: "music",
          cost: isFree ? "free" : "paid",
          description: shortDesc,
          url: linkMatch?.[1] || "https://www.sanjosejazz.org/events/",
          source: "San Jose Jazz",
          kidFriendly: isFree,
        });
      }

      // Check for next page link
      if (!html.includes(`/events/page/${page + 1}/`)) break;
      await new Promise((r) => setTimeout(r, 500)); // polite delay
    }

    console.log(`  ✅ San Jose Jazz: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  San Jose Jazz: ${err.message}`);
    return events;
  }
}

async function fetchMontalvoEvents() {
  console.log("  ⏳ Montalvo Arts Center...");
  try {
    const xml = await fetchText("https://montalvoarts.org/feed/");
    // Montalvo RSS is a blog/news feed — articles are about past performances,
    // artist residencies, and internal announcements (not upcoming events with dates/times).
    // Skip for now; Montalvo is covered in the recurring events data (events-data.ts).
    const items = parseRssItems(xml);
    console.log(`  ✅ Montalvo Arts Center: 0 events (blog feed — no upcoming event dates)`);
    return [];
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
    const now = new Date();
    const events = items.map((item) => {
      // Campbell uses calendarEvent:EventDates ("March 28, 2026" or "April 6, 2026 - April 10, 2026")
      // not calendarEvent:startDate. Fall back to pubDate only if EventDates is missing.
      if (isBlockedEvent(item.title)) return null;
      const start = parseCivicPlusEventDates(item.eventDates)
        || parseDate(item.startDate)
        || parseDate(item.pubDate);
      if (!start || start < now) return null;
      const timeStr = parseCivicPlusEventTime(item.eventTimes);
      return {
        id: h("campbell", item.link || item.title, item.eventDates || item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: timeStr,
        endTime: null,
        venue: (item.location || "Campbell").replace(/Campbell,?\s*CA\s*\d*/i, "").trim() || "Campbell",
        address: "",
        city: "campbell",
        category: inferCategory(item.title, item.description, ""),
        cost: "free",
        description: truncate(stripHtml(item.description)),
        url: item.link,
        source: "City of Campbell",
        kidFriendly: item.title.toLowerCase().includes("kid") || item.title.toLowerCase().includes("family") || item.title.toLowerCase().includes("story") || item.title.toLowerCase().includes("youth"),
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
        if (isBlockedEvent(ev.summary)) return null;
        const start = parseIcalDate(ev.dtstart);
        if (!start || start < now || start > thirtyDaysOut) return null;
        const end = parseIcalDate(ev.dtend);
        const city = inferCity(ev.location, "") || defaultCity;
        const rawDesc = (ev.description || "").replace(/\\n/g, "\n").replace(/\\,/g, ",");
        const descText = truncate(stripHtml(rawDesc));
        // If the DESCRIPTION field is just a URL, use it as the event URL instead
        const descIsUrl = /^https?:\/\/\S+$/.test(descText.trim());
        // Relative iCal feed URLs (e.g. /common/modules/iCalendar/...) are not useful links
        const rawUrl = ev.url || null;
        const urlIsRelativeIcal = rawUrl && rawUrl.startsWith("/common/modules/iCalendar/");
        const eventUrl = descIsUrl ? descText.trim() : (!urlIsRelativeIcal ? rawUrl : null);
        const cleanedVenue = cleanVenue((ev.location || name).replace(/\\,/g, ","));
        return {
          id: h(defaultCity, ev.uid || ev.summary, ev.dtstart),
          title: ev.summary.replace(/\\,/g, ",").replace(/\\n/g, " "),
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: end ? displayTime(end) : null,
          venue: cleanedVenue || name,
          address: "",
          city,
          category: inferCategory(ev.summary, ev.description || "", ""),
          cost: "free",
          description: descIsUrl ? "" : descText,
          url: eventUrl,
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
      `https://gateway.bibliocommons.com/v2/libraries/${libraryId}/events?limit=150`,
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
          category: inferCategory(title, stripHtml(desc), ev.type || ""),
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

function scclCityMapper(branch, addr, locationCode) {
  if (locationCode && SCCL_LOCATION_MAP[locationCode]) return SCCL_LOCATION_MAP[locationCode];
  const text = `${branch} ${addr}`.toLowerCase();
  if (text.includes("campbell")) return "campbell";
  if (text.includes("cupertino")) return "cupertino";
  if (text.includes("los altos")) return "los-altos";
  if (text.includes("los gatos")) return "los-gatos";
  if (text.includes("milpitas")) return "milpitas";
  if (text.includes("saratoga")) return "saratoga";
  if (text.includes("santa clara")) return "santa-clara";
  return null;
}

async function fetchScclEvents() {
  // SCCL has 2500+ events spread across 50+ pages — paginate to catch all branches (e.g. Campbell)
  console.log("  ⏳ Santa Clara County Library (paginating all branches)...");
  const libraryId = "sccl";
  const libraryName = "Santa Clara County Library";
  const now = new Date();
  const allEvents = [];
  const seenIds = new Set();

  try {
    for (let page = 1; page <= 60; page++) {
      const data = await fetchJson(
        `https://gateway.bibliocommons.com/v2/libraries/${libraryId}/events?limit=50&page=${page}`,
      );
      if (data.error) break;
      const eventList = data.entities?.events ? Object.values(data.entities.events) : [];
      if (eventList.length === 0) break;

      for (const ev of eventList) {
        if (seenIds.has(ev.id)) continue;
        seenIds.add(ev.id);

        const locationCode = ev.definition?.branchLocationId || "";
        const city = scclCityMapper("", "", locationCode);
        if (!city) continue; // skip Morgan Hill, Gilroy, etc.

        const startStr = ev.start || ev.definition?.start;
        const endStr = ev.end || ev.definition?.end;
        const start = parseDate(startStr);
        if (!start || start < now) continue;

        const end = parseDate(endStr);
        const title = ev.title || ev.definition?.title || "";
        const desc = ev.description || ev.definition?.description || "";

        allEvents.push({
          id: `${libraryId}-${ev.id}`,
          title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: end ? displayTime(end) : null,
          venue: libraryName,
          address: "",
          city,
          category: inferCategory(title, stripHtml(desc), ev.type || ""),
          cost: "free",
          description: truncate(stripHtml(desc)),
          url: ev.registrationUrl || `https://${libraryId}.bibliocommons.com/events/${ev.id}`,
          source: libraryName,
          kidFriendly: (ev.audiences || []).some((a) => {
            const name = typeof a === "string" ? a : a?.name || "";
            return /child|teen|family|baby|toddler/i.test(name);
          }),
        });
      }
    }
    console.log(`  ✅ ${libraryName}: ${allEvents.length} events`);
    return allEvents;
  } catch (err) {
    console.log(`  ⚠️  ${libraryName}: ${err.message}`);
    return allEvents; // return whatever we got before the error
  }
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

function mapTicketmasterEvent(e) {
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
}

async function fetchTicketmasterEvents() {
  console.log("  ⏳ Ticketmaster...");
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) { console.log("  ⚠️  Ticketmaster: no API key"); return []; }

  try {
    const now = new Date();
    const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days out
    const startStr = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const endStr = future.toISOString().replace(/\.\d{3}Z$/, "Z");

    const baseParams = {
      apikey: apiKey,
      radius: "25",
      unit: "miles",
      startDateTime: startStr,
      endDateTime: endStr,
      size: "200",
      sort: "date,asc",
    };

    // Fetch from two center points to ensure Shoreline Amphitheatre (Mountain View)
    // and SAP Center (San Jose) are both covered without relying on page depth.
    const centers = [
      "37.3382,-121.8863", // San Jose center
      "37.4266,-122.0804", // Mountain View / Shoreline Amphitheatre
    ];

    const allRaw = [];
    const seenIds = new Set();

    for (const latlong of centers) {
      let page = 0;
      while (true) {
        const url = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
        for (const [k, v] of Object.entries(baseParams)) url.searchParams.set(k, v);
        url.searchParams.set("latlong", latlong);
        url.searchParams.set("page", String(page));

        const res = await fetch(url.toString(), {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();

        const raw = data?._embedded?.events || [];
        for (const e of raw) {
          if (!seenIds.has(e.id)) {
            seenIds.add(e.id);
            allRaw.push(e);
          }
        }

        const totalPages = data.page?.totalPages ?? 1;
        if (page + 1 >= totalPages || raw.length === 0) break;
        page++;
        // Respect Ticketmaster rate limit (5 req/sec)
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    const events = allRaw.map(mapTicketmasterEvent).filter(Boolean);

    console.log(`  ✅ Ticketmaster: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Ticketmaster: ${err.message}`);
    return [];
  }
}

// ── Ticketmaster: Shoreline Amphitheatre (Mountain View) ──
// Targeted fetch for Shoreline — ensures Mountain View concert events always appear
// regardless of the general TM query's source cap.

async function fetchShorelineEvents() {
  console.log("  ⏳ Ticketmaster (Shoreline Amphitheatre)...");
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) { console.log("  ⚠️  Shoreline: no Ticketmaster API key"); return []; }

  try {
    const now = new Date();
    const future = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000); // 180 days out
    const startStr = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const endStr = future.toISOString().replace(/\.\d{3}Z$/, "Z");

    const url = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("keyword", "Shoreline Amphitheatre");
    url.searchParams.set("stateCode", "CA");
    url.searchParams.set("startDateTime", startStr);
    url.searchParams.set("endDateTime", endStr);
    url.searchParams.set("size", "100");
    url.searchParams.set("sort", "date,asc");

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();

    const rawEvents = data?._embedded?.events || [];
    const events = rawEvents
      .map(mapTicketmasterEvent)
      .filter((e) => e && e.city === "mountain-view")
      .map((e) => ({ ...e, source: "Shoreline Amphitheatre" }));

    console.log(`  ✅ Shoreline: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Shoreline: ${err.message}`);
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
  console.log("  ⏳ Earthquakes (ESPN scoreboard)...");
  try {
    const season = new Date().getFullYear();
    const endYear = season + 1;
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard?dates=${season}0101-${endYear}0101&limit=300`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const today = new Date().toISOString().split("T")[0];
    const events = (data.events || []).map((e) => {
      const comp = e.competitions?.[0];
      if (!comp) return null;
      const start = new Date(e.date);
      const dateStr = isoDate(start);
      if (!dateStr || dateStr < today) return null;
      const homeTeam = comp.competitors?.find((c) => c.homeAway === "home");
      if (!homeTeam?.team?.displayName?.toLowerCase().includes("san jose")) return null;
      const awayTeam = comp.competitors?.find((c) => c.homeAway === "away");
      const opponent = awayTeam?.team?.displayName || "Opponent";
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
        url: "https://www.sjearthquakes.com/schedule",
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

// ── MiLB: San Jose Giants ──

async function fetchSJGiantsSchedule() {
  console.log("  ⏳ SJ Giants (MiLB Stats API)...");
  try {
    const today = new Date().toISOString().split("T")[0];
    const season = new Date().getFullYear();
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=14&teamId=476&startDate=${today}&endDate=${season}-09-30&gameType=R`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const events = [];
    for (const dateRec of data.dates || []) {
      for (const game of dateRec.games || []) {
        const homeTeam = game.teams?.home?.team?.name || "";
        if (!homeTeam.toLowerCase().includes("san jose")) continue; // home games only
        const awayTeam = game.teams?.away?.team?.name || "Opponent";
        const gameDate = dateRec.date;
        const startUtc = game.gameDate ? new Date(game.gameDate) : null;
        events.push({
          id: h("sjgiants", String(game.gamePk)),
          title: `San Jose Giants vs. ${awayTeam}`,
          date: gameDate,
          displayDate: displayDate(startUtc || new Date(gameDate + "T19:00:00")),
          time: startUtc ? displayTime(startUtc) : "7:00pm",
          endTime: null,
          venue: "Excite Ballpark",
          address: "588 E Alma Ave, San Jose",
          city: "san-jose",
          category: "sports",
          cost: "paid",
          costNote: "From $14",
          description: `San Jose Giants home game vs. ${awayTeam} at Excite Ballpark.`,
          url: "https://www.milb.com/san-jose",
          source: "MiLB",
          kidFriendly: true,
        });
      }
    }
    console.log(`  ✅ SJ Giants: ${events.length} home games`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SJ Giants: ${err.message}`);
    return [];
  }
}

// ── NWSL: Bay FC ──

async function fetchBayFCSchedule() {
  console.log("  ⏳ Bay FC (ESPN scoreboard)...");
  try {
    const season = new Date().getFullYear();
    const endYear = season + 1;
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard?dates=${season}0101-${endYear}0101&limit=300`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const today = new Date().toISOString().split("T")[0];
    const events = (data.events || []).map((e) => {
      const comp = e.competitions?.[0];
      if (!comp) return null;
      const start = new Date(e.date);
      const dateStr = isoDate(start);
      if (!dateStr || dateStr < today) return null;
      const homeTeam = comp.competitors?.find((c) => c.homeAway === "home");
      if (!homeTeam?.team?.displayName?.toLowerCase().includes("bay")) return null;
      const awayTeam = comp.competitors?.find((c) => c.homeAway === "away");
      const opponent = awayTeam?.team?.displayName || "Opponent";
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
  // BiblioCommons site ID for Mountain View Public Library is "librarypoint"
  // (not "mountainview" — confirmed from login page HTML)
  return fetchBiblioEvents("librarypoint", "Mountain View Public Library", () => "mountain-view");
}

async function fetchSunnyvaleLibraryEvents() {
  // Sunnyvale library site ID is correct ("sunnyvale") but their BiblioCommons
  // instance has the Events feature disabled (returns 403). Will return [].
  return fetchBiblioEvents("sunnyvale", "Sunnyvale Public Library", () => "sunnyvale");
}

async function fetchPaloAltoLibraryEvents() {
  return fetchBiblioEvents("paloalto", "Palo Alto City Library", () => "palo-alto");
}

// NOTE: LibCal (Springshare) API v1/v2 require OAuth tokens — not publicly accessible.
// Los Gatos (losgatosca.libcal.com) and Milpitas library calendars use LibCal but
// the API endpoints return 403/offline. Their events are partially covered via SCCL
// BiblioCommons (which includes Los Gatos and Milpitas branch programming).
// If OAuth credentials become available, implement fetchLibCalEvents(slug, name, city).

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

// ── MACLA (Movimiento de Arte y Cultura Latino Americana) ──
// San Jose arts center — uses MEC WordPress plugin with mec:startDate in RSS

async function fetchMaclaEvents() {
  console.log("  ⏳ MACLA...");
  try {
    const xml = await fetchText("https://maclaarte.org/events/feed/");
    const items = parseRssItems(xml);
    const now = new Date();
    const events = items
      .map((item) => {
        const start = parseDate(item.mecStartDate || item.startDate || item.pubDate);
        if (!start || start < now) return null;
        const end = item.mecEndDate ? parseDate(item.mecEndDate) : null;
        return {
          id: h("macla", item.link || item.title, item.mecStartDate || item.pubDate),
          title: item.title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: item.mecStartTime ? displayTime(new Date(`${item.mecStartDate}T${item.mecStartTime}`)) : null,
          endTime: (item.mecEndTime && item.mecEndDate) ? displayTime(new Date(`${item.mecEndDate}T${item.mecEndTime}`)) : null,
          venue: "MACLA",
          address: "510 S 1st St, San Jose, CA 95113",
          city: "san-jose",
          category: inferCategory(item.title, item.description || "", ""),
          cost: "free",
          description: truncate(stripHtml(item.description || item.content || "")),
          url: item.link,
          source: "MACLA",
          kidFriendly: false,
        };
      })
      .filter(Boolean);
    console.log(`  ✅ MACLA: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  MACLA: ${err.message}`);
    return [];
  }
}

// ── Heritage Theatre Campbell (Ticketmaster venue) ──

async function fetchHeritageTheatreEvents() {
  console.log("  ⏳ Heritage Theatre Campbell...");
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) { console.log("  ⚠️  Heritage Theatre: no API key"); return []; }
  try {
    const now = new Date();
    const future = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
    const startStr = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const endStr = future.toISOString().replace(/\.\d{3}Z$/, "Z");
    const url = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("venueId", "KovZpZAAnItA"); // Heritage Theatre Campbell
    url.searchParams.set("startDateTime", startStr);
    url.searchParams.set("endDateTime", endStr);
    url.searchParams.set("size", "50");
    url.searchParams.set("sort", "date,asc");
    const res = await fetch(url.toString(), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const rawEvents = data?._embedded?.events || [];
    const events = rawEvents.map((e) => {
      const dateInfo = e.dates?.start;
      const dateStr = dateInfo?.localDate;
      const timeStr = dateInfo?.localTime;
      if (!dateStr) return null;
      const start = new Date(`${dateStr}T${timeStr || "00:00:00"}-07:00`);
      const priceRange = e.priceRanges?.[0];
      const minPrice = priceRange?.min;
      const cost = minPrice === 0 ? "free" : minPrice && minPrice < 25 ? "low" : "paid";
      return {
        id: `heritage-${e.id}`,
        title: e.name,
        date: dateStr,
        displayDate: displayDate(start),
        time: timeStr ? displayTime(start) : null,
        endTime: null,
        venue: "Heritage Theatre",
        address: "1 W Campbell Ave, Campbell, CA 95008",
        city: "campbell",
        category: inferCategory(e.name, "", e.classifications?.[0]?.genre?.name || ""),
        cost,
        description: "",
        url: e.url || "",
        source: "Heritage Theatre",
        kidFriendly: false,
      };
    }).filter(Boolean);
    console.log(`  ✅ Heritage Theatre: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Heritage Theatre: ${err.message}`);
    return [];
  }
}

// ── Santa Clara County Fire Department (hardcoded Eventbrite events) ──
// Source: https://www.eventbrite.com/o/santa-clara-county-fire-department
// Eventbrite's /v3/events/search/ API is removed; events are hardcoded here.
// Update annually or when the organizer posts new events.

function fetchScccfdEvents() {
  console.log("  ⏳ SC County Fire Dept events...");
  const raw = [
    {
      title: "Be Ready: Be Prepared for Disasters",
      date: "2026-04-09", time: "2:00 PM",
      venue: "Online", address: "", city: "san-jose",
      cost: "free", costNote: null,
      url: "https://www.eventbrite.com/e/online-be-ready-be-prepared-for-disasters-tickets-1983654287372",
    },
    {
      title: "Wildfire Preparedness Workshop",
      date: "2026-04-23", time: "6:00 PM",
      venue: "The Pavilion at Redwood Estates", address: "Redwood Estates, Los Gatos", city: "los-gatos",
      cost: "free", costNote: null,
      url: "https://www.eventbrite.com/e/wildfire-preparedness-workshop-redwood-estates-los-gatos-2026-tickets-1979749409778",
    },
    {
      title: "Wildfire Preparedness Workshop",
      date: "2026-05-02", time: "10:00 AM",
      venue: "San Martín Lions Club", address: "San Martín", city: "san-jose",
      cost: "free", costNote: null,
      url: "https://www.eventbrite.com/e/wildfire-preparedness-workshop-san-martin-2026-tickets-1979750790909",
    },
    {
      title: "Hands-Only CPR and AED Class",
      date: "2026-05-28", time: "10:00 AM",
      venue: "SC County Fire Dept HQ", address: "Campbell", city: "campbell",
      cost: "low", costNote: "From $18",
      url: "https://www.eventbrite.com/e/hands-only-cpr-and-aed-class-campbell-15-hrs-2026-tickets-1983653961397",
    },
    {
      title: "Wildfire Preparedness Workshop",
      date: "2026-06-02", time: "6:00 PM",
      venue: "Joan Pisani Community Center", address: "19655 Allendale Ave, Saratoga", city: "saratoga",
      cost: "free", costNote: null,
      url: "https://www.eventbrite.com/e/wildfire-preparedness-workshop-saratoga-2026-tickets-1979749695633",
    },
    {
      title: "Wildfire Preparedness Workshop",
      date: "2026-07-15", time: "6:00 PM",
      venue: "Cupertino Community Hall", address: "Cupertino", city: "cupertino",
      cost: "free", costNote: null,
      url: "https://www.eventbrite.com/e/wildfire-preparedness-workshop-cupertino-2026-tickets-1979749785903",
    },
    {
      title: "Crime Prevention & Home Fire Safety",
      date: "2026-07-23", time: "11:00 AM",
      venue: "Saratoga Friendship Hall", address: "Saratoga", city: "saratoga",
      cost: "free", costNote: null,
      url: "https://www.eventbrite.com/e/crime-prevention-home-fire-safety-saratoga-2026-tickets-1982205688574",
    },
    {
      title: "CERT Academy",
      date: "2026-08-04", time: "6:00 PM",
      venue: "Joan Pisani Community Center", address: "19655 Allendale Ave, Saratoga", city: "saratoga",
      cost: "low", costNote: "From $40",
      url: "https://www.eventbrite.com/e/community-emergency-response-team-cert-academy-summer-2026-tickets-1975869945195",
    },
    {
      title: "Wildfire Preparedness Workshop",
      date: "2026-08-27", time: "6:00 PM",
      venue: "Los Altos Community Center", address: "Los Altos", city: "los-altos",
      cost: "free", costNote: null,
      url: "https://www.eventbrite.com/e/wildfire-preparedness-workshop-los-altos-community-center-2026-tickets-1979749851098",
    },
  ];
  const today = new Date().toISOString().split("T")[0];
  const events = raw
    .filter((e) => e.date >= today)
    .map((e) => {
      const d = new Date(`${e.date}T12:00:00-07:00`);
      return {
        id: h("scccfd", e.date, e.title, e.venue),
        title: e.title,
        date: e.date,
        displayDate: displayDate(d),
        time: e.time,
        endTime: null,
        venue: e.venue,
        address: e.address,
        city: e.city,
        category: "community",
        cost: e.cost,
        ...(e.costNote ? { costNote: e.costNote } : {}),
        description: "Santa Clara County Fire Department community safety program. Registration required.",
        url: e.url,
        source: "SC County Fire Dept",
        kidFriendly: false,
      };
    });
  console.log(`  ✅ SC County Fire Dept: ${events.length} events`);
  return events;
}

function fetchMiscHardcodedEvents() {
  console.log("  ⏳ Misc hardcoded events...");
  const raw = [
    {
      title: "46th Annual Eggstravaganza Easter Egg Hunt",
      date: "2026-04-04", time: "9:00 AM",
      venue: "Downtown Campbell", address: "Campbell Ave, Campbell", city: "campbell",
      cost: "free", costNote: null,
      category: "community",
      url: "https://www.downtowncampbell.com",
      description: "Annual community Easter egg hunt in Downtown Campbell. Families and kids search for eggs throughout the downtown area.",
      kidFriendly: true,
    },
    {
      title: "Bunnies & Bonnets Easter Parade",
      date: "2026-04-04", time: "12:00 PM",
      venue: "Downtown Campbell", address: "Campbell Ave, Campbell", city: "campbell",
      cost: "free", costNote: null,
      category: "community",
      url: "https://www.downtowncampbell.com",
      description: "Annual Easter parade through Downtown Campbell featuring marching bands, dancers, animals, and community groups. Starts at the east end of Downtown by the VTA Light Rail tracks and runs along Campbell Avenue to Third Street.",
      kidFriendly: true,
    },
    {
      title: "Spring Wine Walk in Downtown Campbell",
      date: "2026-04-23", time: "6:00 PM",
      venue: "Downtown Campbell", address: "Campbell Ave, Campbell", city: "campbell",
      cost: "paid", costNote: null,
      category: "community",
      url: "https://www.downtowncampbell.com",
      description: "Seasonal wine walk through Downtown Campbell. Participants visit participating merchants and restaurants for wine tastings.",
      kidFriendly: false,
    },
    {
      title: "Stanford Water Polo Senior Day vs Cal",
      date: "2026-04-04", time: "1:00 PM",
      venue: "Avery Aquatic Center", address: "Stanford University, Stanford", city: "palo-alto",
      cost: "free", costNote: null,
      category: "sports",
      url: "https://gostanford.com",
      description: "#2 Stanford hosts rival #4 Cal in the Big Splash. Senior Day — free admission.",
    },
  ];
  const today = new Date().toISOString().split("T")[0];
  const events = raw
    .filter((e) => e.date >= today)
    .map((e) => {
      const d = new Date(`${e.date}T12:00:00-07:00`);
      return {
        id: h("misc", e.date, e.title, e.venue),
        title: e.title,
        date: e.date,
        displayDate: displayDate(d),
        time: e.time,
        endTime: null,
        venue: e.venue,
        address: e.address,
        city: e.city,
        category: e.category ?? "community",
        cost: e.cost,
        ...(e.costNote ? { costNote: e.costNote } : {}),
        description: e.description ?? "",
        url: e.url,
        source: "South Bay Signal",
        kidFriendly: false,
      };
    });
  console.log(`  ✅ Misc hardcoded: ${events.length} events`);
  return events;
}

function fetchLgChamberEvents() {
  console.log("  ⏳ LG Chamber of Commerce events...");
  const raw = [
    {
      title: "Networking Mixer at Coup de Thai",
      date: "2026-04-14", time: "5:30 PM",
      venue: "Coup de Thai", address: "Los Gatos", city: "los-gatos",
      cost: "free", costNote: null,
      url: "https://www.losgatoschamber.com",
    },
    {
      title: "Chamber U-Pick at Artist's Garden Oasis",
      date: "2026-04-18", time: null,
      venue: "Artist's Garden Oasis", address: "Los Gatos", city: "los-gatos",
      cost: "free", costNote: null,
      url: "https://www.losgatoschamber.com",
    },
    {
      title: "Multi-Chamber Morning Mixer",
      date: "2026-04-30", time: "7:30 AM",
      venue: "Downtown Los Gatos", address: "Los Gatos", city: "los-gatos",
      cost: "free", costNote: null,
      url: "https://www.losgatoschamber.com",
    },
    {
      title: "GOLD Thursdays",
      date: "2026-05-07", time: "5:00 PM",
      venue: "Downtown Los Gatos", address: "Los Gatos", city: "los-gatos",
      cost: "free", costNote: null,
      url: "https://www.losgatoschamber.com",
    },
    {
      title: "GOLD Thursdays",
      date: "2026-06-04", time: "5:00 PM",
      venue: "Downtown Los Gatos", address: "Los Gatos", city: "los-gatos",
      cost: "free", costNote: null,
      url: "https://www.losgatoschamber.com",
    },
    {
      title: "GOLD Thursdays",
      date: "2026-07-02", time: "5:00 PM",
      venue: "Downtown Los Gatos", address: "Los Gatos", city: "los-gatos",
      cost: "free", costNote: null,
      url: "https://www.losgatoschamber.com",
    },
    {
      title: "GOLD Thursdays",
      date: "2026-08-06", time: "5:00 PM",
      venue: "Downtown Los Gatos", address: "Los Gatos", city: "los-gatos",
      cost: "free", costNote: null,
      url: "https://www.losgatoschamber.com",
    },
    {
      title: "GOLD Thursdays",
      date: "2026-09-03", time: "5:00 PM",
      venue: "Downtown Los Gatos", address: "Los Gatos", city: "los-gatos",
      cost: "free", costNote: null,
      url: "https://www.losgatoschamber.com",
    },
    {
      title: "GOLD Thursdays",
      date: "2026-10-01", time: "5:00 PM",
      venue: "Downtown Los Gatos", address: "Los Gatos", city: "los-gatos",
      cost: "free", costNote: null,
      url: "https://www.losgatoschamber.com",
    },
  ];
  const today = new Date().toISOString().split("T")[0];
  const events = raw
    .filter((e) => e.date >= today)
    .map((e) => {
      const d = new Date(`${e.date}T12:00:00-07:00`);
      return {
        id: h("lgchamber", e.date, e.title, e.venue),
        title: e.title,
        date: e.date,
        displayDate: displayDate(d),
        time: e.time,
        endTime: null,
        venue: e.venue,
        address: e.address,
        city: e.city,
        category: "community",
        cost: e.cost,
        ...(e.costNote ? { costNote: e.costNote } : {}),
        description: "Los Gatos Chamber of Commerce event.",
        url: e.url,
        source: "LG Chamber of Commerce",
        kidFriendly: false,
      };
    });
  console.log(`  ✅ LG Chamber of Commerce: ${events.length} events`);
  return events;
}

// ── Meetup ──────────────────────────────────────────────────────────────────

const MEETUP_JUNK = [
  /\bsingles?\b/i,
  /\bdating\b/i,
  /\bspeed\s+dat/i,
  /\bsoulmate\b/i,
  /\bnetwork\s+market/i,
  /\bmlm\b/i,
  /\bbusiness\s+opportunity\b/i,
  /\bmake\s+money\b/i,
  /\bincome\s+opportunity\b/i,
  /\bpyramid\b/i,
  /\bforex\b/i,
  /\bcrypto\s+trading\b/i,
  /\bget\s+rich\b/i,
  /\bpaid\s+course\b/i,
  /\bfree\s+trial\b/i,     // usually sales funnels
];

// Map Meetup city name → slug used in this codebase
function meetupCitySlug(city) {
  if (!city) return null;
  const c = city.toLowerCase().trim();
  const MAP = {
    "san jose": "san-jose",
    "mountain view": "mountain-view",
    "sunnyvale": "sunnyvale",
    "campbell": "campbell",
    "los gatos": "los-gatos",
    "saratoga": "saratoga",
    "los altos": "los-altos",
    "milpitas": "milpitas",
    "santa clara": "santa-clara",
    "cupertino": "cupertino",
    "morgan hill": "morgan-hill",
    "gilroy": "gilroy",
    "palo alto": "palo-alto",
    "menlo park": "menlo-park",
    "redwood city": "redwood-city",
    "san mateo": "san-mateo",
    "fremont": "fremont",
    "oakland": "oakland",
    "berkeley": "berkeley",
    "san francisco": "san-francisco",
    "south san francisco": "south-san-francisco",
  };
  return MAP[c] ?? c.replace(/\s+/g, "-");
}

// South Bay / Silicon Valley cities we accept (exclude events too far out)
const MEETUP_ACCEPTED_CITIES = new Set([
  "san-jose", "mountain-view", "sunnyvale", "campbell", "los-gatos",
  "saratoga", "los-altos", "milpitas", "santa-clara", "cupertino",
  "morgan-hill", "gilroy", "palo-alto", "menlo-park",
]);

async function fetchMeetupEvents() {
  const CLIENT_ID = process.env.MEETUP_CLIENT_ID;
  const MEMBER_ID = process.env.MEETUP_MEMBER_ID;
  const KID = process.env.MEETUP_KID;
  const PRIVATE_KEY = process.env.MEETUP_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!CLIENT_ID || !MEMBER_ID || !KID || !PRIVATE_KEY) {
    console.log("  ⚠️  Meetup: credentials not set, skipping");
    return [];
  }

  // JWT bearer token
  function base64url(str) {
    return Buffer.from(str).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const jwtPayload = base64url(JSON.stringify({
    iss: CLIENT_ID, sub: MEMBER_ID, aud: "api.meetup.com",
    iat: now, exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${jwtHeader}.${jwtPayload}`);
  const sig = signer.sign(PRIVATE_KEY, "base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const jwt = `${jwtHeader}.${jwtPayload}.${sig}`;

  const tokenRes = await fetch("https://secure.meetup.com/oauth2/access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.log("  ⚠️  Meetup: auth failed", JSON.stringify(tokenData));
    return [];
  }
  const token = tokenData.access_token;

  async function meetupGql(query) {
    const res = await fetch("https://api.meetup.com/gql-ext", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(20_000),
    });
    return res.json();
  }

  const today = new Date();
  const endDate = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
  const startStr = today.toISOString().replace("Z", "") + "-07:00";
  const endStr = endDate.toISOString().replace("Z", "") + "-07:00";

  // Run multiple keyword queries to get broad coverage; deduplicate by event ID
  const QUERIES = ["tech", "community", "startup", "arts", "music", "food", "outdoor", "networking"];
  const seenIds = new Set();
  const rawEvents = [];

  for (const kw of QUERIES) {
    try {
      const data = await meetupGql(`{
        eventSearch(
          filter: {
            query: "${kw}",
            lat: 37.3382, lon: -121.8863, radius: 25,
            startDateRange: "${startStr}",
            endDateRange: "${endStr}",
            eventType: PHYSICAL
          }
          first: 50
        ) {
          edges {
            node {
              id title dateTime endTime eventUrl eventType status
              venue { name address city lat lon }
              group { name urlname stats { memberCounts { all } } }
              rsvps { totalCount yesCount }
            }
          }
        }
      }`);
      const edges = data?.data?.eventSearch?.edges ?? [];
      for (const { node } of edges) {
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id);
          rawEvents.push(node);
        }
      }
    } catch (err) {
      console.log(`  ⚠️  Meetup query "${kw}" failed:`, err.message);
    }
  }

  // Apply quality filters
  const MIN_MEMBERS = 50;
  const MIN_RSVP = 3;

  // Blocked Meetup group urlnames — add when a group consistently produces off-brand content
  const BLOCKED_MEETUP_GROUPS = new Set([
    "bay-area-childfree-connections", // childfree social group — not a fit for SBS audience
  ]);

  const events = [];
  for (const node of rawEvents) {
    if (node.status !== "ACTIVE") continue;
    if (node.eventType !== "PHYSICAL") continue;

    const groupUrlname = node.group?.urlname ?? "";
    if (BLOCKED_MEETUP_GROUPS.has(groupUrlname)) continue;

    const memberCount = node.group?.stats?.memberCounts?.all ?? 0;
    if (memberCount < MIN_MEMBERS) continue;

    const rsvpCount = node.rsvps?.yesCount ?? node.rsvps?.totalCount ?? 0;
    if (rsvpCount < MIN_RSVP) continue;

    const title = node.title?.trim();
    if (!title) continue;
    if (MEETUP_JUNK.some((p) => p.test(title))) continue;

    const city = node.venue?.city;
    const citySlug = meetupCitySlug(city);
    if (!citySlug || !MEETUP_ACCEPTED_CITIES.has(citySlug)) continue;

    const start = parseDate(node.dateTime);
    if (!start) continue;

    const venue = node.venue?.name?.trim() || node.group?.name || "TBD";
    const address = node.venue?.address?.trim() || null;

    events.push({
      id: h("meetup", node.id),
      title,
      date: isoDate(start),
      displayDate: displayDate(start),
      time: displayTime(start),
      endTime: node.endTime ? displayTime(parseDate(node.endTime)) : null,
      venue,
      address,
      city: citySlug,
      category: "community",
      cost: null,
      description: `Meetup event by ${node.group?.name ?? "local group"}.`,
      url: node.eventUrl,
      source: "Meetup",
      kidFriendly: false,
    });
  }

  console.log(`  ✅ Meetup: ${events.length} events (from ${rawEvents.length} raw across ${QUERIES.length} queries)`);
  return events;
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
    // fetchMountainViewEvents,  — 403 blocked since 2026-03
    // fetchSunnyvaleEvents,     — 403 blocked since 2026-03
    // fetchCupertinoEvents,     — 404/timeout since 2026-03; covered by SCCL BiblioCommons
    // fetchSanJoseCityEvents,   — 403 blocked since 2026-03
    // fetchTheTechEvents,       — no /feed/ endpoint as of 2026-03
    fetchSjplEvents,
    fetchScclEvents,
    fetchSvlgEvents,
    fetchSjJazzEvents,
    fetchMontalvoEvents,
    // fetchEventbriteEvents, — deprecated: /v3/events/search/ removed by Eventbrite
    fetchEarthquakesSchedule,
    fetchBayFCSchedule,
    fetchSJGiantsSchedule,
    fetchTicketmasterEvents,
    fetchSharksSchedule,
    fetchMvplEvents,
    // fetchSunnyvaleLibraryEvents, — 403 (Events feature disabled on their BiblioCommons); covered by SCCL
    fetchPaloAltoLibraryEvents,
    fetchHappyHollowEvents,
    fetchMaclaEvents,
    fetchHeritageTheatreEvents,
    fetchShorelineEvents,
    fetchScccfdEvents,
    fetchLgChamberEvents,
    fetchMiscHardcodedEvents,
    fetchMeetupEvents,
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
  // Cap non-sports events to 180 days out; sports schedules can go further
  const maxFuture = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const valid = allEvents.filter(
    (e) =>
      e.date &&
      e.date >= today &&
      (e.category === "sports" || e.date <= maxFuture) &&
      e.city &&
      e.title &&
      !(uniSources.has(e.source) && e.time && e.endTime && e.time === e.endTime) &&
      isPublicEvent(e.title, e.source, e.description, e.venue),
  );

  // Sort by date ascending
  valid.sort((a, b) => a.date.localeCompare(b.date));

  // Per-source cap — university feeds are high-volume; cap them so community events aren't buried
  const SOURCE_CAPS = {
    "Santa Clara University": 25,
    "SJSU Events": 30,
    "Stanford Events": 30,
  };
  const DEFAULT_CAP = 200;
  const sourceCounts = {};
  const capped = valid.filter((e) => {
    const cap = SOURCE_CAPS[e.source] ?? DEFAULT_CAP;
    sourceCounts[e.source] = (sourceCounts[e.source] || 0) + 1;
    return sourceCounts[e.source] <= cap;
  });

  // Deduplicate by normalized title + date
  // Sports events: also deduplicate by date+venue (same game, different listing titles)
  // Same-source events: also deduplicate by date+venue+time (same event, different title variants)
  const seen = new Set();
  const sportsByDateVenue = new Set();
  const sameSourceByDVT = new Set();
  const deduped = capped.filter((e) => {
    // Same-source dedup: catches title variants like "SJSU X" vs "X at SJSU"
    if (e.venue && e.date && e.time) {
      const venueNorm = e.venue.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 20);
      const dvtKey = `${e.date}|${venueNorm}|${e.time}`;
      if (sameSourceByDVT.has(dvtKey)) return false;
      sameSourceByDVT.add(dvtKey);
    }
    // Sports dedup: one listing per date+venue (catches "Sharks vs Blues" + "San Jose Sharks vs St Louis Blues")
    if (e.category === "sports" && e.venue && e.date) {
      // Normalize venue: strip trailing " at <city>" / " in <city>" so "SAP Center at San Jose" == "SAP Center"
      const venueNorm = e.venue.toLowerCase().replace(/\s+(at|in)\s+\w[\w\s]*$/, "").replace(/[^a-z0-9]/g, "").substring(0, 20);
      const svKey = `${e.date}|${venueNorm}`;
      if (sportsByDateVenue.has(svKey)) return false;
      sportsByDateVenue.add(svKey);
    }
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

  // Collapse multi-branch library closures: when the same source posts 2+ "closed" events
  // on the same date, collapse into one "All [Source] Locations Closed" entry.
  const closureKey = (e) => {
    const isClosureTitle = /\bclosed\b/i.test(e.title);
    return isClosureTitle ? `${e.source}|${e.date}` : null;
  };
  const closureGroups = {};
  for (const e of finalEvents) {
    const k = closureKey(e);
    if (!k) continue;
    if (!closureGroups[k]) closureGroups[k] = [];
    closureGroups[k].push(e);
  }
  const idsToRemove = new Set();
  const extraEntries = [];
  for (const [key, evs] of Object.entries(closureGroups)) {
    if (evs.length < 2) continue; // single-branch closure: keep as-is
    // Extract holiday/reason from title, e.g. "Cupertino Library Closed for Easter" → "Easter"
    const reasonMatch = evs[0].title.match(/closed\s+(?:for\s+)?(.+)/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : "";
    const collapsed = {
      ...evs[0],
      id: `${evs[0].source.toLowerCase().replace(/[^a-z0-9]/g, "-")}-closed-${evs[0].date}`,
      title: reason ? `All ${evs[0].source} Locations Closed for ${reason}` : `All ${evs[0].source} Locations Closed`,
      city: evs[0].city, // use first branch city as representative
      venue: evs[0].source,
      description: `All ${evs[0].source} branch locations are closed${reason ? ` for ${reason}` : ""}.`,
    };
    for (const e of evs) idsToRemove.add(e.id);
    extraEntries.push(collapsed);
    console.log(`  📚 Collapsed ${evs.length} closures → "${collapsed.title}"`);
  }
  const collapsedEvents = [
    ...finalEvents.filter((e) => !idsToRemove.has(e.id)),
    ...extraEntries,
  ];

  // Normalize whitespace in all string fields — sources often have double spaces,
  // leading/trailing whitespace in titles and venue names
  for (const e of collapsedEvents) {
    if (e.title) e.title = e.title.replace(/\s+/g, " ").trim();
    if (e.venue) e.venue = e.venue.replace(/\s+/g, " ").trim();
  }

  const ongoingCount = collapsedEvents.filter((e) => e.ongoing).length;

  const output = {
    generatedAt: new Date().toISOString(),
    eventCount: collapsedEvents.length,
    sources: sourceNames,
    events: collapsedEvents,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ Done — ${collapsedEvents.length} events (${ongoingCount} ongoing) from ${sourceNames.length} sources → ${OUT_PATH}`);

  // Summary by city
  const byCity = {};
  collapsedEvents.forEach((e) => { byCity[e.city] = (byCity[e.city] || 0) + 1; });
  console.log("\nBy city:", byCity);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
