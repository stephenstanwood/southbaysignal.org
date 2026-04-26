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
import { VIRTUAL_EVENT_PATTERNS } from "../src/lib/south-bay/eventFilters.mjs";
import { loadEnvLocal } from "./lib/env.mjs";
import { fetchJson, fetchText, UA } from "./lib/http.mjs";
import { parseDate, parseDatePT, isoDate, todayPT, displayDate, displayTime } from "./lib/dates.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnvLocal();
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");
const BLACKLIST_PATH = join(__dirname, "..", "src", "data", "south-bay", "social-blacklist.json");
const PLAYWRIGHT_EVENTS_PATH = join(__dirname, "..", "src", "data", "south-bay", "playwright-events.json");
const INBOUND_EVENTS_PATH = join(__dirname, "..", "src", "data", "south-bay", "inbound-events.json");
const TIME_BACKFILL_CACHE_PATH = join(__dirname, "..", "src", "data", "south-bay", "event-time-backfill-cache.json");

// Load dynamic blacklist from social review pipeline (venues, sources, titles)
let _blacklist;
function loadBlacklist() {
  if (_blacklist) return _blacklist;
  try {
    _blacklist = JSON.parse(readFileSync(BLACKLIST_PATH, "utf8"));
  } catch {
    _blacklist = { venues: [], sources: [], titles: [] };
  }
  return _blacklist;
}

function h(prefix, ...parts) {
  return `${prefix}-${createHash("sha1").update(parts.join("|")).digest("hex").substring(0, 16)}`;
}

// ── Event title blocklist — skip private/internal/irrelevant events ──────────
const TITLE_BLOCKLIST = [
  /\bpractice\b/i,        // team practices
  /\brehearsal\b/i,       // rehearsals
  /\bboard meeting\b/i,   // internal board meetings
  /\bstaff meeting\b/i,   // internal staff meetings
  /\bcommittee meeting\b/i, // internal committee meetings
  /\bcommission\b.*\bmeeting\b/i, // city commission meetings (Planning, Arts, Science/Tech, etc.)
  /\bregular meeting\b/i, // generic "Regular Meeting" (council/commission/board)
  /\bspecial meeting\b/i, // generic "Special Meeting"
  /\bsubcommittee\b/i,    // internal subcommittees
  /\bstudy session\b/i,   // council study sessions
  /\bclosed\s*(for|—|–|-|:)/i, // closure notices ("Closed for", "Closed: Independence Day", etc.)
  /\bcancelled?\b/i,      // cancelled events
  /\bIndustry Insights with Alumni\b/i, // Stanford affiliates only
  /\bnetworking mixer\b/i, // internal student/professional mixers
  /\bimpact of ICE\b/i,    // political
  /\bTerminalFour\b/i,     // internal CMS staff training
  /\bTree Trackers\b/i,    // on-campus student activity
  /\bFidelity One on One\b/i, // internal HR appointments
  /\bPay Day\b/i,          // internal HR payroll notices
  /\bResearch Week Braintrust\b/i, // internal student workshop
];

function isBlockedEvent(title) {
  if (TITLE_BLOCKLIST.some((re) => re.test(title))) return true;
  // Dynamic title blocks from social review feedback
  const bl = loadBlacklist();
  if (bl.titles?.length) {
    const tLower = title.toLowerCase();
    if (bl.titles.some((t) => tLower.includes(t.toLowerCase()))) return true;
  }
  return false;
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
  /\blast\s+day\s+to\s+add\s+a\s+class\b/i,
  /\bopens?\s+for\s+\w+\s+enrollment\b/i,
  /\bcourse\s+enrollment\b/i,
  /\baxess\b/i,
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
  /\bstaff\s+(meeting|development|recognition|affairs)\b/i,
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
  /\bpresidential\s+reception\b/i,
  /\balumni\s+reception\b/i,
  /\balumni\s+for\s+others\b/i,
  /\badmitted\s+students?\s+(day|reception|event)\b/i,
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
  // Virtual / online / livestream / webinar patterns are sourced from the
  // SHARED filter module (src/lib/south-bay/eventFilters.mjs) so plan-day.ts
  // uses the exact same patterns at runtime.
  ...VIRTUAL_EVENT_PATTERNS,
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
  // Campus religious services (SCU-specific, not public community events)
  /^\d+(am|pm)\s+mass$/i,
  /\bstudent\s+mass\b/i,
  /\bprayer\s+service\b/i,
  /\b11th\s+hour\s+(prayer|calling)\b/i,
  // Collaboration/classroom tool training (not public events)
  /\bgrackle\b/i,
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
  // Academic administrative deadlines (not resident-facing)
  /^last\s+day\s+to\s+(petition|submit|remove|add|drop|withdraw|file|declare|change|elect)\b/i,
  /\bpetition\s+for\s+degrees?\s+to\s+be\s+conferred\b/i,
  /\bremove\s+(winter|spring|summer|fall)\s+\d{4}\s+incompletes?\b/i,
  /\bp\/np\s+grading\b/i,
  /\bgrading\s+option\b/i,
  /\bpeer\s+advising\s+session\b/i,
  /\bapplication\s+workshop\b/i,
  /\bmandatory\s+(peer\s+)?advising\b/i,
  /\bstudent\s+recognition\s+program\b/i,
  /\brecognition\s+(ceremony|reception|program)\b/i,
  /\bdean'?s\s+(reception|address|brunch)\b/i,
  /\bclub\s+sport\s+practice\b/i,
  /\bclass\s+meeting\s+for\s+/i,
  // Private class visits (faculty-arranged, not public)
  /\bclass\s+visit\b/i,
  // Internal seminar series / recurring workshop codes (not public events)
  /\bBRICS\s+Session\b/i,
  /^[A-Z]{3,5}\s+Session$/,
  // Ticketmaster merchandise / add-ons (not events)
  /\bsouvenir\s+ticket\b/i,
  /\bcommemorative\s+(magnet|pin|coin|lanyard)\b/i,
  // Cancelled events (anywhere in title, not just start)
  /\bcancell?ed\b/i,
  // Web page navigation elements accidentally scraped (not events)
  /^skip\s+to\s+(main\s+)?content$/i,
  /^back\s+to\s+top$/i,
  /^(main\s+)?navigation$/i,
  /^breadcrumb/i,
  /^close\s+(menu|modal|dialog)$/i,
  /^(view|see)\s+all\s+events?$/i,
  /^load\s+more$/i,
  /^show\s+more$/i,
  /^read\s+more$/i,
  /^(next|previous)\s+page$/i,
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
  // Title blocklist — applies to ALL sources (not just university feeds)
  if (isBlockedEvent(title)) return false;
  // Always filter cancelled events regardless of source
  if (CANCELLED_PATTERN.test(title)) return false;
  // Filter virtual/online-only events
  if (isVirtualEvent(title, description, venue)) return false;
  // Global exclusions — not a fit for a local news site
  if (GLOBAL_EXCLUSIONS.some(p => p.test(title))) return false;
  // Dynamic blacklist from social review feedback
  const bl = loadBlacklist();
  if (venue && bl.venues?.length) {
    const vLower = venue.toLowerCase();
    if (bl.venues.some((v) => vLower.includes(v.toLowerCase()))) return false;
  }
  if (source && bl.sources?.length) {
    const sLower = source.toLowerCase();
    if (bl.sources.some((s) => sLower.includes(s.toLowerCase()))) return false;
  }
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
  // These match AFTER the all-caps regex runs (NITE→Nite, JOSE→Jose via 4+ regex, but HIP/HOP/IN/SAN survive)
  "HIP HOP NITE": "Hip Hop Nite",   // pre-regex fallback
  "HIP HOP Nite": "Hip Hop Nite",   // post-regex: NITE→Nite but HIP/HOP (3-letter) survive
  " IN SAN JOSE": " in San Jose",   // pre-regex fallback
  " IN SAN Jose": " in San Jose",   // post-regex: JOSE→Jose but IN/SAN (2-3 letter) survive
  " IN SAN JOSE,": " in San Jose,",
  " IN SAN Jose,": " in San Jose,",
  // Local brand names with embedded Mixed Case
  "Sjmade": "SJMade",
  "Sjma ": "SJMA ",
  "Macla ": "MACLA ",
  "Sjda ": "SJDA ",
  "Svlg ": "SVLG ",
  "Sjz ": "SJZ ",
  "Bayfc": "Bay FC",
  "Rock EN ": "Rock en ",
  "Latinaje EN ": "Latinaje en ",
  // Source-side title-cased acronyms (regex won't catch — input wasn't ALL-CAPS)
  " Pacl ": " PACL ",
  " Pacl,": " PACL,",
  "Pacl Book": "PACL Book",
  "Sjdt ": "SJDT ",
  "Lgpns ": "LGPNS ",
  "Fopal": "FOPAL",     // Friends of Palo Alto Library — biblio API title-cases it
  "Aanhpi": "AANHPI",   // Asian American/Native Hawaiian/Pacific Islander
};

function cleanTitle(title) {
  if (!title) return title;
  let t = title
    // Decode HTML entities
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&\w+;/g, "")
    // Strip BiblioCommons "External Event:" prefix (Palo Alto Library tags
    // events organized by outside groups — venue + source already convey
    // that, the prefix is just visible noise in display titles).
    .replace(/^External Event:\s*/i, "")
    // Strip BiblioCommons asterisk-wrapped format markers like "*In Person*",
    // "*Virtual*", "*Online*" (San Jose Public Library prefixes some titles
    // with these — format is shown elsewhere via venue/url).
    .replace(/^\*[^*]{1,20}\*\s*/, "")
    // Strip calendar-artifact date prefixes
    .replace(
      /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\s*:\s*/i,
      "",
    )
    .trim();
  // Downcase ALL-CAPS words that aren't known acronyms (4+ letters, e.g. SPECIAL → Special, TOUR → Tour)
  // 4-letter threshold also catches common stylistic-caps words: LIVE, TOUR, NITE, FEST, JAZZ, etc.
  const KEEP_UPPER = new Set([
    "ICYMI", "LGBTQ", "LGBTQIA", "BIPOC", "STEAM", "LEGO",
    // 4-letter acronyms to preserve
    "SJSU", "SJPD", "SJFD", "FIFA", "UEFA", "ESPN", "STEM", "AAPI", "ACLU",
    "NASA", "IEEE", "YMCA", "YWCA", "ROTC", "FEMA", "NOAA", "WWII", "UCLA",
    // South Bay venues / institutions
    "SJMA", "MACLA", "SVLG", "SJDA", "SCCC", "MOFAD",
    "USPS", "USPTO", "USDA", "UCSF", "UCSC", "UCSD", "UCSB",
    // South Bay org/agency acronyms
    "SJMADE", "SCCFD", "SCVMC", "PACL", "SJDT", "LGPNS",
  ]);
  t = t.replace(/\b[A-Z]{4,}\b/g, (w) => KEEP_UPPER.has(w) ? w : w[0] + w.slice(1).toLowerCase());
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

// Strip bare URLs and common scraper artifacts from description text.
// CivicPlus iCal and some RSS feeds append calendar URLs and UI text to descriptions.
function stripBareUrls(text) {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\bView on site\b\s*\|?\s*/gi, "")
    .replace(/\bEmail this event\b\s*/gi, "")
    .replace(/^\*This event \w+ (organized|hosted) by [^.]+\.?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Sentences that are pure boilerplate/warnings/promo and should be dropped from
// description text. Each pattern matches a sentence (text ending in . ! or ?).
const BOILERPLATE_SENTENCE_PATTERNS = [
  /\bdo not (purchase|buy) tickets\b/i,
  /\bonly (purchase|buy) tickets\b/i,
  /\btickets? (are )?only available (online|from)\b/i,
  /\bticket delivery delay\b/i,
  /\btickets? will not be (emailed|delivered|sent)\b/i,
  /\bverify the (web)?site\b/i,
  /\bbeware of (scams?|counterfeit|third[\s-]?party)/i,
  /\b(scalpers?|counterfeit tickets?)\b/i,
  /\bno ticket purchase necessary\b/i,
  /\bno (purchase|registration|tickets?) necessary\b/i,
  /\bregister (here|now|online|today|in advance)\b/i,
  /\bclick (here|the link)\b/i,
  /\bvisit (our|the) website\b/i,
  /\bsee (our|the) website\b/i,
  /\bfor more (info|information|details)\b.*\bvisit\b/i,
];

/**
 * Polish description text for display:
 * - downcase ALL-CAPS shouting (4+ word runs)
 * - drop promotional/boilerplate sentences
 * - capitalize sentence-start words ("free performance" → "Free performance")
 * - tidy whitespace
 */
// Common scraper-introduced typos. Replacement preserves the original case of
// the matched word (lowercase → lowercase, Capitalized → Capitalized).
const DESC_TYPO_FIXES = [
  [/\bpreformance(s?)\b/gi, "performance"],
  [/\battendence\b/gi, "attendance"],
  [/\boccured\b/gi, "occurred"],
  [/\brecieve\b/gi, "receive"],
  [/\bsepearate\b/gi, "separate"],
];

// Common abbreviations whose internal periods would otherwise be mistaken
// for sentence boundaries by the [.!?] sentence splitter below — splitting
// "p.m." into ["p.", "m."] then joining with space + capitalizing yields
// the visible regression "p. M.". Replace with placeholders before splitting,
// restore after.
const ABBR_MASK_PAIRS = [
  [/\bp\.m\./gi, "PMABBR"],
  [/\ba\.m\./gi, "AMABBR"],
  [/\be\.g\./gi, "EGABBR"],
  [/\bi\.e\./gi, "IEABBR"],
  [/\betc\./gi, "ETCABBR"],
];
const ABBR_RESTORE_PAIRS = [
  [/PMABBR/g, "p.m."],
  [/AMABBR/g, "a.m."],
  [/EGABBR/g, "e.g."],
  [/IEABBR/g, "i.e."],
  [/ETCABBR/g, "etc."],
];

function polishDescription(text) {
  if (!text) return "";
  let t = text;

  // Fix common typos before sentence-level processing.
  for (const [pat, fix] of DESC_TYPO_FIXES) {
    t = t.replace(pat, (m, ...rest) => {
      // Preserve original case of the first letter; for "preformance(s)" pattern,
      // append the trailing 's' if present.
      const trailingS = typeof rest[0] === "string" ? rest[0] : "";
      const replacement = fix + trailingS;
      if (m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1);
      }
      return replacement;
    });
  }

  // Mask abbreviations so their internal periods don't trip the sentence splitter.
  for (const [pat, sub] of ABBR_MASK_PAIRS) t = t.replace(pat, sub);

  // Downcase ALL-CAPS runs of 4+ uppercase letters (preserve common acronyms).
  // Same logic as cleanTitle but applied to body text.
  const KEEP_UPPER = new Set([
    "ICYMI", "LGBTQ", "LGBTQIA", "BIPOC", "STEAM", "LEGO",
    "SJSU", "SJPD", "SJFD", "FIFA", "UEFA", "ESPN", "STEM", "AAPI", "ACLU",
    "NASA", "IEEE", "YMCA", "YWCA", "ROTC", "FEMA", "NOAA", "WWII", "UCLA",
    "AAVE", "ADHD", "PTSD",
    // South Bay / arts venues
    "SJMA", "MACLA", "SJZ", "SVLG", "SJDA", "SCCC", "MOFAD", "VTAA", "VTAS",
    "SJMADE", "SCCFD", "SCVMC", "PACL", "SJDT", "LGPNS",
    // Misc
    "USPS", "USPTO", "WIPO", "USDA", "FBI", "CIA", "NSA", "EPA", "FDA",
    "MIT", "UCSF", "UCSC", "UCLA", "UCSD", "UCSB", "UCD",
    "AAPI", "AAJA", "NAHJ", "NABJ", "GLAAD", "ACLU",
  ]);
  t = t.replace(/\b[A-Z]{4,}\b/g, (w) => KEEP_UPPER.has(w) ? w : w[0] + w.slice(1).toLowerCase());

  // Insert space between concatenated words ("NIGHTSat" → "NIGHTS at", "USAMex" → "USA Mex")
  // — split all-caps run before a Cap+lowercase WORD prefix. Requires 2+
  // trailing lowercase letters so pluralized acronyms ("DVDs", "CDs", "URLs")
  // stay intact instead of becoming "DV Ds".
  t = t.replace(/([A-Z]{2,})([A-Z][a-z]{2,})/g, "$1 $2");
  // — split lowercase + uppercase boundary ("nightSat" → "night Sat").
  t = t.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Normalize 1-2 letter all-caps fragments left over from prior step ("EN" preserved if before all-caps)
  // Only rewrites words wedged between mixed-case neighbors — keeps "EN" in "Rock EN Espanol" lowercased.
  t = t.replace(/(?<=[A-Z][a-z]+ )([A-Z]{2,3})(?= [A-Z][a-z])/g, (w) => w[0] + w.slice(1).toLowerCase());

  // Split into sentences and drop boilerplate
  const sentences = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [t];
  const kept = sentences.filter((s) => {
    const trimmed = s.trim();
    if (!trimmed) return false;
    return !BOILERPLATE_SENTENCE_PATTERNS.some((re) => re.test(trimmed));
  });
  t = kept.join(" ").replace(/\s+/g, " ").trim();

  // Capitalize first letter of each sentence
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());

  // Restore masked abbreviations (must run after capitalization so an "a.m."
  // at the start of a sentence isn't accidentally re-cased to "A.m.")
  for (const [pat, sub] of ABBR_RESTORE_PAIRS) t = t.replace(pat, sub);

  return t;
}

/**
 * Clean a raw iCal LOCATION field into a display-friendly venue name.
 * iCal LOCATION blobs often contain "- Venue Name  City CA 95000" or similar.
 * Strips leading dashes, trailing city/state/zip, and HTML tags.
 */
function cleanVenue(raw) {
  if (!raw) return raw;
  // Strip iCal backslash-escaping (\; and \,) before HTML entity decoding so
  // entities like "&nbsp\;" survive as "&nbsp;" and get cleaned by the regex below.
  let v = raw.replace(/\\;/g, ";").replace(/\\,/g, ",");
  v = v.replace(/<[^>]+>/g, "").replace(/&[a-zA-Z]+;|&#\d+;/g, " ").replace(/\s+/g, " ").trim();
  // Remove leading "- " dash artifact from CivicPlus iCal
  v = v.replace(/^-\s+/, "");
  // If the string is meeting directions ("Meet at...", "Check in at..."), not a venue name
  if (/^(meet|check\s+in)\s+(at|in)\s+/i.test(v)) return "";
  // If the entire string is just "City, CA Zip" or "City CA Zip" (no venue name), return empty
  if (/^[A-Za-z][a-zA-Z\s]+,?\s+CA\s+\d{5}/.test(v) && v.split(",").length <= 3) return "";
  // Remove trailing "  City ST zip" pattern (double-space before city)
  v = v.replace(/\s{2,}[A-Za-z][A-Za-z\s]+[A-Z]{2}\s+\d{5}.*$/, "");
  // Remove trailing ", City, CA 9xxxx" or " City CA 9xxxx" pattern (handles commas too)
  v = v.replace(/[,\s]+[A-Za-z][a-zA-Z\s,]+CA[,\s]+9\d{4}.*$/, "");
  // Remove inline address blob: "Name  123 Street..." or "Name 123 Street..." with double-space
  v = v.replace(/\s{2,}\d+\s+.*$/, "");
  // Remove single-space inline address blob: "Vasona Park 233 Blossom Hill Rd." → "Vasona Park"
  // Trigger only when the trailing chunk starts with a number and ends with a street suffix
  // so we don't chop legitimate venue names that contain numbers (e.g. "Building 5").
  v = v.replace(/[,\s]+\d+\s+[A-Z][a-zA-Z\.\s]*?\b(St|Ave|Avenue|Blvd|Boulevard|Rd|Road|Way|Ln|Lane|Dr|Drive|Ct|Court|Pl|Place|Hwy|Highway|Pkwy|Parkway|Cir|Circle|Ter|Terrace)\b\.?\s*$/, "");
  // Strip trailing ", <truncated dir>" e.g. "Los Altos History Museum, 51 So." (truncated address)
  v = v.replace(/,\s+\d+\s+(N|S|E|W|N\.|S\.|E\.|W\.|No|So|Ea|We)\.?\s*$/i, "");
  // Strip trailing " - " or lone dash at end
  v = v.replace(/\s*-\s*$/, "");
  // Strip " - <address>" suffix where address starts with a number, e.g.
  // "Council Chambers - 110 E. Main St" or just a partial street number
  // "Saratoga Senior Center - 19655" (CivicPlus often appends only the number).
  v = v.replace(/\s+-\s+\d+(\s+.*)?$/, "");
  // Source-typo fixes (sources occasionally publish misspelled venue names)
  v = v.replace(/\bNursey\b/g, "Nursery");
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
  const titleLower = title.toLowerCase();
  // Bookstores host author talks and book launches — even when the description
  // mentions sports (e.g. a runner discussing a memoir), it's an arts/literary
  // event, not a sports event. Check before the sports/education rules below.
  const venueLower = venue.toLowerCase();
  const isBookstoreVenue = /\b(books?|bookshop|bookstore)\b/.test(venueLower);
  if (isBookstoreVenue) return "arts";
  // "baby" check: only match when it's not a proper name (e.g. "Baby Bash" the rapper)
  const hasBaby = /\bbaby\b/.test(t) && !/\bbaby\s+bash\b/i.test(t);
  if (t.includes("story time") || t.includes("storytime") || t.includes("toddler") || hasBaby || t.includes("preschool") || t.includes("kids") || t.includes("children") || /\bbedtime\b/.test(titleLower) || /\bpuppet\s+show\b/.test(t)) return "family";
  // Medical/clinical procedure courses are always education, never arts — even if descriptions
  // contain "performance" (as in "procedural performance") or the venue has "theater" (OR).
  const isMedicalProcedureEvent = /\b(bronchoscopy|endoscopy|radiology|biopsy|anesthesia|cone beam ct|cbct imaging|surgical technique|clinical training|colonoscopy|laparoscopy|bronchoscop)\b/.test(t);
  if (isMedicalProcedureEvent) return "education";
  // Startup pitch events hosted in campus theaters should be community, not arts.
  const isStartupPitch = /\b(pitch\s+jam|incubator\s+pitch|startup\s+pitch|pitch\s+competition|pitch\s+night)\b/.test(t);
  if (isStartupPitch) return "community";
  // Academic/professional conferences in the title are always education — must run BEFORE
  // the arts check so medical/health conference descriptions containing "performance" (clinical
  // context) don't get misclassified as arts.
  if (/\bconference\b/.test(titleLower)) return "education";
  // Exhibits, galleries, and book discussions must be checked BEFORE music — descriptions can
  // mention "music" incidentally (e.g. a printed-books exhibit about a collector who liked music)
  // but the primary category is "arts" when these visual/literary cues are present.
  // Use word-boundary match for "art/arts/artist/artwork" to avoid false positives from
  // words like "department" (dep-ART-ment), "participants" (p-ART-icipants), "party", "earth", etc.
  // Farmers markets must be categorized as "market" before music/arts checks —
  // descriptions often mention "live music" incidentally, which would otherwise win.
  if (/\bfarmers?\s+market\b/.test(titleLower)) return "market";
  const isArtWord = /\barts?\b|\bartist|\bartwork|\bartistry/.test(t);
  if (t.includes("exhibit") || t.includes("gallery") || t.includes("theater") || t.includes("theatre") || t.includes("film") || t.includes("cinema") || t.includes("dance") || t.includes("performance") || t.includes("museum") || (isArtWord && !t.includes("martial art"))) return "arts";
  // Book clubs and discussions are arts/reading events, not formal education
  if (/\bbook\s+(club|discussion|group)\b/.test(t)) return "arts";
  if (t.includes("concert") || t.includes("music") || t.includes("jazz") || t.includes("symphony") || t.includes("band") || t.includes("orchestra") || t.includes("choir")) return "music";
  if (t.includes("comedy") || t.includes("stand-up") || t.includes("standup") || t.includes("improv show") || t.includes("comedian")) return "arts";
  // Nature / wildlife events — check BEFORE sports to avoid false positives
  if (/\b(wildlife|bird watching|birdwatching|birding|egret|heron|pelican|raptor|owl|hawk|falcon|butterfly|dragonfly|wildflower|tide pool|tidepool|nature walk|nature tour)\b/.test(t)) return "outdoor";
  // Volunteering (farm, park, trail) is community, not sports — check before sports rules
  if (/\b(volunteer|volunteering)\b/.test(t) && /\b(farm|garden|trail|park|nature)\b/.test(t)) return "community";
  // School/fundraiser fun runs are community events, not sports
  // Also covers programs like "Girls on the Run" which use "run" or "5K" but are community/empowerment programs
  const isSchoolFundraiser = /\b(school|middle school|elementary|fundrais|walk-a-thon|walkathon|girls on the run|charity run|fun run program)\b/.test(t);
  // Government/civic commission and committee meetings are always community events.
  // Must run BEFORE the sports check because "transportation" contains "sport" as substring.
  if (/\b(commission|committee|council|board)\s+(meeting|hearing|session)\b/i.test(title) ||
      /\b(city council|town council|planning commission|city manager|public works)\b/i.test(title)) return "community";
  // Yoga, pilates, and wellness classes are community, not sports — check before sports block
  // (event type fields from sources like SJDA can include "Sports & Activities" even for yoga)
  if (/\b(yoga|pilates|meditation|mindfulness|tai chi)\b/.test(t)) return "community";
  // Board games, card games, tabletop games and D&D are community, not sports
  const isBoardGame = /\b(board games?|card games?|tabletop|dungeons.{0,5}dragons|d&d|rpg club|wargame)\b/.test(t);
  // "Games, crafts, and activities" in library/family program descriptions is not sports.
  // Protects against events like "Fabulous Friday: games, crafts, activities" being misclassified.
  const isLibraryActivityGames = /\bgames[,;]?\s*(crafts?|activities|bubbles|more)/i.test(t) ||
    /\b(crafts?|activities)\s+(?:and\s+)?games\b/i.test(t) ||
    /\bgames\s+and\s+activities\b/i.test(t);
  // "vs." and "vs " as sports indicators should only be checked in the TITLE, not descriptions —
  // descriptions can use "vs." for technical comparisons ("DataFrames vs. Series").
  const titleHasVs = titleLower.includes("vs.") || titleLower.includes(" vs ");
  if (!isBoardGame && (!isLibraryActivityGames && t.includes("game") || /\bsports?\b/.test(t) || t.includes("athletic") || t.includes("golf") || t.includes("tennis") || t.includes("soccer") || t.includes("basketball") || t.includes("baseball") || t.includes("softball") || t.includes("volleyball") || t.includes("swimming") || t.includes("swim meet") || t.includes("track") || t.includes("cross country") || t.includes("lacrosse") || t.includes("football") || t.includes("gymnastics") || t.includes("wrestling") || t.includes("water polo") || t.includes("polo") || t.includes("hockey") || t.includes("rugby") || /\browing\b/.test(t) || t.includes("crew") || t.includes("diving") || t.includes("fencing") || t.includes("skiing") || t.includes("snowboard") || /\bcycling\b/.test(t) || t.includes("equestrian") || titleHasVs || (!isSchoolFundraiser && /\b(fun run|road run|trail run|color run)\b/.test(t)) || (!isSchoolFundraiser && /\b(5k|10k|half marathon|marathon|triathlon)\b/.test(t)) || (!isSchoolFundraiser && /\brace\b/.test(t)))) return "sports";
  // Government/civic events at markets are still community events
  if (/\b(office hours|mayor|city council|council member|supervisor)\b/.test(t) && t.includes("market")) return "community";
  // "craft" alone is too broad — "well-crafted resume", "refine your craft" → require craft market context
  const isCraftMarket = /\bcraft\s*(fair|market|show|sale|night|bazaar|booth|vendor)\b/.test(t);
  // "fair" alone is too broad — only match community/arts fairs, not job/health/resource/housing fairs
  const isFairEvent = /\b(craft|art|artisan|maker|vendor|street|holiday|county|state|flea|antique|swap|harvest|spring|summer|fall|winter) fair\b/.test(t);
  if (t.includes("market") || isFairEvent || t.includes("vendor") || isCraftMarket) return "market";
  // Workshops/classes/lectures in the TITLE are educational — check before outdoor to avoid false positives
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
      // MACLA's feed uses mec:startHour / mec:endHour ("7:30 pm"); other MEC
      // deployments use mec:startTime ("19:30:00"). Read both, prefer hour.
      mecStartDate: get("mec:startDate"),
      mecEndDate: get("mec:endDate"),
      mecStartTime: get("mec:startTime"),
      mecEndTime: get("mec:endTime"),
      mecStartHour: get("mec:startHour"),
      mecEndHour: get("mec:endHour"),
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

/** Pull a venue out of a title like "Workshop at King Library" → "King Library".
 *  Used when the source feed doesn't populate <location>; without this, two
 *  unrelated SJSU events fall back to the generic "San Jose State University"
 *  venue and collide in cross-source dedup. */
function extractVenueFromTitle(title) {
  if (!title) return null;
  // Strip the calendar-artifact date prefix first
  const stripped = title.replace(
    /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\s*:\s*/i,
    "",
  );
  const m = stripped.match(/\s+at\s+([A-Z][^,]+?)$/);
  if (!m) return null;
  const venue = m[1].trim();
  // Reject obviously-non-venue tails (events ending with dates, times, etc.)
  if (/^\d|^(noon|midnight)\b/i.test(venue)) return null;
  return venue;
}

async function fetchSjsuEvents() {
  console.log("  ⏳ SJSU Events...");
  try {
    const xml = await fetchText("https://events.sjsu.edu/calendar.xml", { timeout: 45_000 }); // large feed ~1.4MB
    const items = parseRssItems(xml);
    let skipped = 0;
    const events = items.map((item) => {
      if (isStudentOnlyEvent(item)) { skipped++; return null; }
      const start = parseDate(item.pubDate);
      if (!start) return null;
      const category = inferCategory(item.title, item.description, "");
      // SJSU's Localist platform emits a 224x42 wordmark as og:image which
      // crops to "SAN UNI" on a square tile. Pin a real square asset:
      // Spartan helmet for athletics, SJSU monogram for everything else.
      const image = category === "sports" ? "/logos/sjsu-spartan.png" : "/logos/sjsu-monogram.png";
      return {
        id: h("sjsu", item.link || item.title, item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: null,
        venue: item.location || extractVenueFromTitle(item.title) || "San Jose State University",
        address: "",
        city: "san-jose",
        category,
        cost: "free",
        description: truncate(stripBareUrls(stripHtml(item.description))),
        url: item.link,
        source: "SJSU Events",
        image,
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
  // Append noon to avoid UTC-midnight off-by-one: if process runs in UTC,
  // new Date("April 21, 2026") = midnight UTC = April 20 PT after isoDate().
  const d = new Date(start + " 12:00:00");
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
    return min === "00" ? `${h}${ampm}` : `${h}:${min}${ampm}`;
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
    const html = await fetchText("https://montalvoarts.org/experience/events-calendar/");
    // Extract JSON-LD blocks from the page
    const jsonLdMatches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    const now = new Date();
    const events = [];

    for (const match of jsonLdMatches) {
      let data;
      try { data = JSON.parse(match[1]); } catch { continue; }
      const graph = data["@graph"] || (data["@type"] ? [data] : []);
      for (const item of graph) {
        if (!["Event", "EventSeries"].includes(item["@type"])) continue;
        const name = item.name;
        const startDate = item.startDate;
        const url = item.url;
        if (!name || !startDate || !url) continue;
        const start = parseDatePT(startDate);
        if (!start || start < now) continue;
        events.push({
          id: h("montalvo", url, startDate),
          title: name,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: null,
          venue: "Montalvo Arts Center",
          address: "15400 Montalvo Rd, Saratoga",
          city: "saratoga",
          category: inferCategory(name, item.description || "", "", "Montalvo Arts Center"),
          cost: "paid",
          description: (item.description && item.description.trim() !== name.trim()) ? item.description : null,
          url,
          source: "Montalvo Arts Center",
          kidFriendly: false,
        });
      }
    }

    // Dedupe by URL (EventSeries and its nested Event may both appear)
    const seen = new Set();
    const unique = events.filter((e) => {
      if (seen.has(e.url)) return false;
      seen.add(e.url);
      return true;
    });

    console.log(`  ✅ Montalvo Arts Center: ${unique.length} events`);
    return unique;
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
        venue: cleanVenue(item.location || "") || "Campbell",
        address: "",
        city: "campbell",
        category: inferCategory(item.title, item.description, ""),
        cost: "free",
        description: truncate(stripHtml(item.description)),
        url: item.link,
        source: "City of Campbell",
        kidFriendly: /\b(kid|family|story|youth|grade|ages?\s*\d|children|toddler|baby|preschool)\b/i.test(item.title),
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

async function fetchCivicPlusIcal(name, url, defaultCity, defaultCost = "free") {
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
          // Some iCal feeds (e.g. Opera SJ) write dtend == dtstart for events
          // without a published end time. Treat those as "no end time" rather
          // than a zero-duration event.
          endTime: end && end.getTime() !== start.getTime() ? displayTime(end) : null,
          venue: cleanedVenue || name,
          address: "",
          city,
          category: inferCategory(ev.summary, ev.description || "", ""),
          cost: defaultCost,
          description: descIsUrl ? "" : stripBareUrls(descText),
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

// ── CivicPlus RSS for cities that don't expose an iCal (Milpitas) ──
// Same shape as fetchCampbellEvents — they all use calendarEvent:EventDates +
// calendarEvent:EventTimes fields. Refactored into a generic helper so adding
// another CivicPlus city is a one-liner.

async function fetchCivicPlusRssCity(name, url, defaultCity) {
  console.log(`  ⏳ ${name}...`);
  try {
    const xml = await fetchText(url);
    const items = parseRssItems(xml);
    const now = new Date();
    const events = items.map((item) => {
      if (isBlockedEvent(item.title)) return null;
      const start = parseCivicPlusEventDates(item.eventDates)
        || parseDate(item.startDate)
        || parseDate(item.pubDate);
      if (!start || start < now) return null;
      const timeStr = parseCivicPlusEventTime(item.eventTimes);
      const venueLabel = cleanVenue(item.location || "");
      const titleLower = item.title.toLowerCase();
      return {
        id: h(defaultCity, item.link || item.title, item.eventDates || item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: timeStr,
        endTime: null,
        venue: venueLabel || name,
        address: "",
        city: defaultCity,
        category: inferCategory(item.title, item.description, ""),
        cost: "free",
        description: truncate(stripHtml(item.description)),
        url: item.link,
        source: name,
        kidFriendly: /\b(kid|family|story|youth|grade|ages?\s*\d|children|toddler|baby|preschool)\b/i.test(titleLower),
      };
    }).filter(Boolean);
    console.log(`  ✅ ${name}: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  ${name}: ${err.message}`);
    return [];
  }
}

async function fetchMilpitasEvents() {
  return fetchCivicPlusRssCity(
    "City of Milpitas",
    "https://www.milpitas.gov/RSSFeed.aspx?ModID=58&CID=All-calendar.xml",
    "milpitas",
  );
}

async function fetchOperaSanJoseEvents() {
  return fetchCivicPlusIcal(
    "Opera San José",
    "https://www.operasj.org/events/?ical=1",
    "san-jose",
    "paid",
  );
}

async function fetchLosAltosHistoryEvents() {
  return fetchCivicPlusIcal(
    "Los Altos History Museum",
    "https://www.losaltoshistory.org/events/?ical=1",
    "los-altos",
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
        const start = parseDatePT(startStr);
        if (!start || start < now) return null;

        const end = parseDatePT(endStr);
        const branchId = ev.branchId || ev.definition?.branchLocationId;
        const branchStore = entities.locations || entities.branches;
        const branch = branchId && branchStore ? branchStore[branchId] : null;
        const branchName = branch?.name || "";
        const branchAddrObj = branch?.address || {};
        const branchAddr = branch
          ? [branchAddrObj.number, branchAddrObj.street, branchAddrObj.city].filter(Boolean).join(" ")
          : (branch?.address || "");
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
          // BiblioCommons sometimes returns end == start for ongoing exhibits
          // and drop-in programs — surface that as "no end time" rather than a
          // zero-duration block.
          endTime: end && end.getTime() !== start.getTime() ? displayTime(end) : null,
          venue: branchName
            ? (branchName.toLowerCase().endsWith("library") ? branchName : `${branchName} Library`)
            : libraryName,
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
          }) || /\b(ages?\s+\d|children|kids|family|toddler|baby|preschool|puppet show|grade|youth)\b/i.test(title + " " + stripHtml(desc)),
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
        const start = parseDatePT(startStr);
        if (!start || start < now) continue;

        const end = parseDatePT(endStr);
        const title = ev.title || ev.definition?.title || "";
        const desc = ev.description || ev.definition?.description || "";

        allEvents.push({
          id: `${libraryId}-${ev.id}`,
          title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: end && end.getTime() !== start.getTime() ? displayTime(end) : null,
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
          }) || /\b(ages?\s+\d|children|kids|family|toddler|baby|preschool|puppet show|grade|youth)\b/i.test(title + " " + stripHtml(desc)),
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
        endTime: end && end.getTime() !== start.getTime() ? displayTime(end) : null,
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
    url: fixTicketmasterUrl(e.url, e.name, city, dateStr),
    source: "Ticketmaster",
    kidFriendly: /family|kid|child|disney|cirque/i.test(e.name + genre),
  };
}

// The TM Discovery API sometimes returns short-form URLs like
// ticketmaster.com/event/<api-id> that 401 publicly.  Working URLs have a
// slug prefix: ticketmaster.com/<slug>/event/<hex-id>.  We reconstruct the
// proper URL from the event name, city, date, and extracted event ID.
// Pattern observed: /{name-slug}-{city-slug}-california-{MM-DD-YYYY}/event/{id}
function fixTicketmasterUrl(url, eventName, city, dateStr) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (
      u.hostname.endsWith("ticketmaster.com") &&
      /^\/event\/[A-Za-z0-9_-]+$/.test(u.pathname)
    ) {
      const tmId = u.pathname.replace("/event/", "");
      const titleSlug = eventName
        .toLowerCase()
        .replace(/'/g, "")
        .replace(/[.]/g, "")
        .replace(/[^a-z0-9\s-]/g, " ")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-");
      const citySlug = city || "san-jose";
      // Convert YYYY-MM-DD to MM-DD-YYYY for TM URL format
      const dateParts = (dateStr || "").split("-");
      const dateSlug = dateParts.length === 3
        ? `${dateParts[1]}-${dateParts[2]}-${dateParts[0]}`
        : "";
      const pathSlug = dateSlug
        ? `${titleSlug}-${citySlug}-california-${dateSlug}`
        : titleSlug;
      return `https://www.ticketmaster.com/${pathSlug}/event/${tmId}`;
    }
  } catch { /* keep original */ }
  return url;
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

// ── Santa Cruz Picks (hardcoded) ──
// Curated Santa Cruz venues Stephen explicitly voted in (2026-04-15).
// We do NOT cover Santa Cruz broadly — only specific picks. Dated events only;
// Mystery Spot and Henry Cowell Redwoods are always-open destinations, not
// event venues, so they're not represented here (would need POI treatment).
//
// Update cadence: refresh seasonally. Boardwalk Free Friday Night Bands runs
// June–August; Roaring Camp has themed rides around holidays; SC Shakespeare
// runs a summer rep season Jun–Aug plus Monday Night Revels in spring.

function fetchSantaCruzPicks() {
  console.log("  ⏳ Santa Cruz picks (hardcoded)...");
  const raw = [
    // ── Santa Cruz Beach Boardwalk — Free Friday Night Bands 2026 ──
    // 10 weeks starting late June. Specific bands announced ~4 weeks out;
    // update this list once the official lineup drops.
    { title: "Free Friday Night Bands at the Boardwalk", date: "2026-06-19", time: "6:30 PM", venue: "Santa Cruz Beach Boardwalk", address: "400 Beach St, Santa Cruz, CA 95060", url: "https://beachboardwalk.com/Free-Friday-Night-Bands", description: "Free live music on the beach bandstand. Bring a blanket — seating is first-come-first-served. Lineup announced monthly at beachboardwalk.com.", category: "music", cost: "free" },
    { title: "Free Friday Night Bands at the Boardwalk", date: "2026-06-26", time: "6:30 PM", venue: "Santa Cruz Beach Boardwalk", address: "400 Beach St, Santa Cruz, CA 95060", url: "https://beachboardwalk.com/Free-Friday-Night-Bands", description: "Free live music on the beach bandstand.", category: "music", cost: "free" },
    { title: "Free Friday Night Bands at the Boardwalk", date: "2026-07-03", time: "6:30 PM", venue: "Santa Cruz Beach Boardwalk", address: "400 Beach St, Santa Cruz, CA 95060", url: "https://beachboardwalk.com/Free-Friday-Night-Bands", description: "Free live music on the beach bandstand. Stay for the fireworks.", category: "music", cost: "free" },
    { title: "Free Friday Night Bands at the Boardwalk", date: "2026-07-10", time: "6:30 PM", venue: "Santa Cruz Beach Boardwalk", address: "400 Beach St, Santa Cruz, CA 95060", url: "https://beachboardwalk.com/Free-Friday-Night-Bands", description: "Free live music on the beach bandstand.", category: "music", cost: "free" },
    { title: "Free Friday Night Bands at the Boardwalk", date: "2026-07-17", time: "6:30 PM", venue: "Santa Cruz Beach Boardwalk", address: "400 Beach St, Santa Cruz, CA 95060", url: "https://beachboardwalk.com/Free-Friday-Night-Bands", description: "Free live music on the beach bandstand.", category: "music", cost: "free" },
    { title: "Free Friday Night Bands at the Boardwalk", date: "2026-07-24", time: "6:30 PM", venue: "Santa Cruz Beach Boardwalk", address: "400 Beach St, Santa Cruz, CA 95060", url: "https://beachboardwalk.com/Free-Friday-Night-Bands", description: "Free live music on the beach bandstand.", category: "music", cost: "free" },
    { title: "Free Friday Night Bands at the Boardwalk", date: "2026-07-31", time: "6:30 PM", venue: "Santa Cruz Beach Boardwalk", address: "400 Beach St, Santa Cruz, CA 95060", url: "https://beachboardwalk.com/Free-Friday-Night-Bands", description: "Free live music on the beach bandstand.", category: "music", cost: "free" },
    { title: "Free Friday Night Bands at the Boardwalk", date: "2026-08-07", time: "6:30 PM", venue: "Santa Cruz Beach Boardwalk", address: "400 Beach St, Santa Cruz, CA 95060", url: "https://beachboardwalk.com/Free-Friday-Night-Bands", description: "Free live music on the beach bandstand.", category: "music", cost: "free" },
    { title: "Free Friday Night Bands at the Boardwalk", date: "2026-08-14", time: "6:30 PM", venue: "Santa Cruz Beach Boardwalk", address: "400 Beach St, Santa Cruz, CA 95060", url: "https://beachboardwalk.com/Free-Friday-Night-Bands", description: "Free live music on the beach bandstand.", category: "music", cost: "free" },
    { title: "Free Friday Night Bands at the Boardwalk", date: "2026-08-21", time: "6:30 PM", venue: "Santa Cruz Beach Boardwalk", address: "400 Beach St, Santa Cruz, CA 95060", url: "https://beachboardwalk.com/Free-Friday-Night-Bands", description: "Free live music on the beach bandstand.", category: "music", cost: "free" },

    // ── Roaring Camp Railroads — themed seasonal train rides ──
    { title: "Mother's Day Brunch Train", date: "2026-05-10", time: "10:30 AM", venue: "Roaring Camp Railroads", address: "5401 Graham Hill Rd, Felton, CA 95018", url: "https://roaringcamp.com/events/mothers-day-brunch-train", description: "Steam train ride through the redwoods followed by brunch on the grounds of Roaring Camp. Advance tickets required.", costNote: "From $55" },
    { title: "Civil War Memorial Weekend", date: "2026-05-24", time: "10:00 AM", venue: "Roaring Camp Railroads", address: "5401 Graham Hill Rd, Felton, CA 95018", url: "https://roaringcamp.com/events", description: "Civil War living-history weekend at Roaring Camp — battle reenactments, period camps, and train rides through the redwoods." },
    { title: "Father's Day BBQ & Steam Train", date: "2026-06-21", time: "11:00 AM", venue: "Roaring Camp Railroads", address: "5401 Graham Hill Rd, Felton, CA 95018", url: "https://roaringcamp.com/events", description: "BBQ lunch plus steam train ride up Bear Mountain. A signature Roaring Camp family tradition.", costNote: "From $45" },
    { title: "4th of July Fireworks Train", date: "2026-07-04", time: "6:00 PM", venue: "Roaring Camp Railroads", address: "5401 Graham Hill Rd, Felton, CA 95018", url: "https://roaringcamp.com/events", description: "Evening steam train ride ending with fireworks over the redwoods.", costNote: "From $40" },

    // ── Santa Cruz Shakespeare — 2026 summer season ──
    // Summer rep runs in the Grove at DeLaveaga Park (Jun–Aug). Specific plays
    // + show dates update when SCS publishes the 2026 schedule — swap titles
    // in here. Monday Night Revels dates are NOT hardcoded because the SCS
    // 2026 Revels schedule isn't posted yet; guessing dates leads to bad
    // downstream plans (e.g. a "Monday Night" event appearing on a Wednesday).
    { title: "Santa Cruz Shakespeare 2026 Summer Season Opens", date: "2026-06-22", time: "7:30 PM", venue: "The Grove at DeLaveaga Park", address: "501 Upper Park Rd, Santa Cruz, CA 95065", url: "https://santacruzshakespeare.org", description: "Opening night of Santa Cruz Shakespeare's outdoor summer rep season at the Grove at DeLaveaga Park. Season runs through late August." },
  ];
  const today = todayPT();
  const events = raw
    .filter((e) => e.date >= today)
    .map((e) => {
      const d = new Date(`${e.date}T12:00:00-07:00`);
      return {
        id: h("sc-picks", e.date, e.title, e.venue),
        title: e.title,
        date: e.date,
        displayDate: displayDate(d),
        time: e.time,
        endTime: null,
        venue: e.venue,
        address: e.address,
        city: "santa-cruz",
        category: e.category ?? "arts",
        cost: e.cost ?? "paid",
        ...(e.costNote ? { costNote: e.costNote } : {}),
        description: e.description ?? "",
        url: e.url,
        source: "Santa Cruz Picks",
        kidFriendly: true,
      };
    });
  console.log(`  ✅ Santa Cruz Picks: ${events.length} events`);
  return events;
}

// ── G League: Santa Cruz Warriors ──
// Affiliate of Golden State Warriors. Plays at Kaiser Permanente Arena in
// downtown Santa Cruz. Season runs Nov–Apr. Off-season: returns []. ESPN
// doesn't always have venue/address in the team schedule, so they're hardcoded.

async function fetchSantaCruzWarriorsSchedule() {
  console.log("  ⏳ SC Warriors (ESPN G League)...");
  try {
    const res = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba-development/teams/20/schedule",
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const today = todayPT();
    const events = (data.events || []).map((e) => {
      const comp = e.competitions?.[0];
      if (!comp) return null;
      const start = new Date(e.date);
      const dateStr = isoDate(start);
      if (!dateStr || dateStr < today) return null;
      const home = comp.competitors?.find((c) => c.homeAway === "home");
      if (!home?.team?.displayName?.toLowerCase().includes("santa cruz")) return null;
      const away = comp.competitors?.find((c) => c.homeAway === "away");
      const opponent = away?.team?.displayName || "Opponent";
      return {
        id: h("sc-warriors", String(e.id)),
        title: `Santa Cruz Warriors vs. ${opponent}`,
        date: dateStr,
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: displayTime(new Date(start.getTime() + 2 * 60 * 60 * 1000)),
        venue: "Kaiser Permanente Arena",
        address: "140 Front St, Santa Cruz, CA 95060",
        city: "santa-cruz",
        category: "sports",
        cost: "paid",
        costNote: "From $15",
        description: `Santa Cruz Warriors home game vs. ${opponent} at Kaiser Permanente Arena.`,
        url: "https://santacruz.gleague.nba.com/schedule/",
        source: "G League",
        kidFriendly: true,
      };
    }).filter(Boolean);
    console.log(`  ✅ SC Warriors: ${events.length} home games`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SC Warriors: ${err.message}`);
    return [];
  }
}

async function fetchSharksSchedule() {
  console.log("  ⏳ Sharks (NHL API)...");
  try {
    const res = await fetch("https://api-web.nhle.com/v1/club-schedule-season/SJS/now", {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const today = todayPT();
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
          endTime: timeUtc ? displayTime(new Date(timeUtc.getTime() + 2.5 * 60 * 60 * 1000)) : null,
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
    const today = todayPT();
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
        endTime: displayTime(new Date(start.getTime() + 2 * 60 * 60 * 1000)),
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
    const today = todayPT();
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
        // Use locationName + teamName for the canonical opponent name. The
        // top-level `name` field can return Copa de la Diversión promotional
        // identities ("Ontario Tower Buzzers") for theme-night games, which
        // mismatches the description and confuses readers.
        const awayLoc = game.teams?.away?.team?.locationName;
        const awayMascot = game.teams?.away?.team?.teamName;
        const awayTeam = (awayLoc && awayMascot)
          ? `${awayLoc} ${awayMascot}`
          : (game.teams?.away?.team?.name || "Opponent");
        const gameDate = dateRec.date;
        const startUtc = game.gameDate ? new Date(game.gameDate) : null;
        events.push({
          id: h("sjgiants", String(game.gamePk)),
          title: `San Jose Giants vs. ${awayTeam}`,
          date: gameDate,
          displayDate: displayDate(startUtc || new Date(gameDate + "T19:00:00")),
          time: startUtc ? displayTime(startUtc) : "7:00pm",
          endTime: startUtc ? displayTime(new Date(startUtc.getTime() + 3 * 60 * 60 * 1000)) : null,
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
          image: "https://upload.wikimedia.org/wikipedia/commons/4/40/SanJoseGiantsCap.png",
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
    const today = todayPT();
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
        endTime: displayTime(new Date(start.getTime() + 2 * 60 * 60 * 1000)),
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
  // Mountain View Public Library uses LibCal, not BiblioCommons.
  // The "librarypoint" site is Central Rappahannock Regional Library in Virginia
  // — NOT Mountain View. Previous mapping was wrong. Disabled pending LibCal ingest.
  return [];
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
        // Prefer mec:startHour ("7:30 pm" — already in clock format) over mec:startTime ("19:30:00")
        const startTime = item.mecStartHour
          ? formatHourClock(item.mecStartHour)
          : (item.mecStartTime ? displayTime(new Date(`${item.mecStartDate}T${item.mecStartTime}`)) : null);
        const endTime = item.mecEndHour
          ? formatHourClock(item.mecEndHour)
          : ((item.mecEndTime && item.mecEndDate) ? displayTime(new Date(`${item.mecEndDate}T${item.mecEndTime}`)) : null);
        return {
          id: h("macla", item.link || item.title, item.mecStartDate || item.pubDate),
          title: item.title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: startTime,
          endTime,
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
  const today = todayPT();
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

function fetchFarmersMarketEvents() {
  console.log("  ⏳ Farmers markets...");
  const markets = [
    { title: "Mountain View Farmers Market", day: 0, time: "9:00 AM", endTime: "1:00 PM", venue: "Caltrain Station", address: "600 W Evelyn Ave, Mountain View", city: "mountain-view", url: "https://cafarmersmkts.com/mountain-view-market", season: [1, 12] },
    { title: "Los Gatos Farmers Market", day: 0, time: "9:00 AM", endTime: "1:00 PM", venue: "Town Park Plaza", address: "50 University Ave, Los Gatos", city: "los-gatos", url: "https://www.losgatos.ca.gov/1411/Farmers-Market", season: [5, 10] },
    { title: "Saratoga Farmers Market", day: 6, time: "9:00 AM", endTime: "1:00 PM", venue: "West Valley College", address: "14000 Fruitvale Ave, Saratoga", city: "saratoga", url: "https://cafarmersmkts.com/saratoga-market", season: [4, 11] },
    { title: "Santana Row Farmers Market", day: 3, time: "11:00 AM", endTime: "3:00 PM", venue: "Santana Row", address: "377 Santana Row, San Jose", city: "san-jose", url: "https://www.santanarow.com/events", season: [1, 12] },
    { title: "Campbell Farmers Market", day: 0, time: "9:00 AM", endTime: "1:00 PM", venue: "Downtown Campbell", address: "Campbell Ave, Campbell", city: "campbell", url: "https://www.downtowncampbell.com/farmers-market", season: [1, 12] },
    { title: "Sunnyvale Farmers Market", day: 6, time: "9:00 AM", endTime: "1:00 PM", venue: "Murphy Avenue", address: "Murphy Ave, Sunnyvale", city: "sunnyvale", url: "https://urbanvillageonline.com/markets/sunnyvale", season: [1, 12] },
    { title: "Cupertino Farmers Market", day: 5, time: "9:00 AM", endTime: "1:00 PM", venue: "Oaks Shopping Center", address: "21275 Stevens Creek Blvd, Cupertino", city: "cupertino", url: "https://cafarmersmkts.com/cupertino-market", season: [1, 12] },
    { title: "California Ave Farmers Market", day: 0, time: "9:00 AM", endTime: "1:00 PM", venue: "California Avenue", address: "California Ave, Palo Alto", city: "palo-alto", url: "https://www.cityofpaloalto.org/Departments/Community-Services/Arts-Sciences/Farmers-Market", season: [1, 12] },
  ];

  const events = [];
  const now = new Date();
  const today = todayPT();
  // Generate instances for the next 90 days
  for (let offset = 0; offset <= 90; offset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    const dayOfWeek = d.getDay(); // 0=Sun
    const month = d.getMonth() + 1; // 1-indexed
    const dateStr = isoDate(d);
    if (dateStr < today) continue;

    for (const m of markets) {
      if (dayOfWeek !== m.day) continue;
      if (month < m.season[0] || month > m.season[1]) continue;

      const dateObj = new Date(`${dateStr}T12:00:00-07:00`);
      events.push({
        id: h("farmersmarket", m.title, dateStr),
        title: m.title,
        date: dateStr,
        displayDate: displayDate(dateObj),
        time: m.time,
        endTime: m.endTime,
        venue: m.venue,
        address: m.address,
        city: m.city,
        category: "food",
        cost: "free",
        description: "Weekly open-air farmers market featuring local produce, artisan goods, and prepared foods.",
        url: m.url,
        source: "South Bay Signal",
        kidFriendly: true,
      });
    }
  }
  console.log(`  ✅ Farmers markets: ${events.length} events`);
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
    {
      title: "Sunnyvale Art & Wine Festival",
      date: "2026-06-06", time: "11:00 AM",
      venue: "Downtown Sunnyvale", address: "W Washington Ave & S Murphy Ave, Sunnyvale", city: "sunnyvale",
      cost: "free", costNote: null,
      category: "arts",
      url: "https://www.sunnyvaleartandwine.com",
      description: "The 50th annual Sunnyvale Art & Wine Festival returns to downtown Sunnyvale with 200+ artists, live music, local food, and wine. Saturday hours 11 AM–7 PM.",
      kidFriendly: true,
    },
    {
      title: "Sunnyvale Art & Wine Festival",
      date: "2026-06-07", time: "10:00 AM",
      venue: "Downtown Sunnyvale", address: "W Washington Ave & S Murphy Ave, Sunnyvale", city: "sunnyvale",
      cost: "free", costNote: null,
      category: "arts",
      url: "https://www.sunnyvaleartandwine.com",
      description: "The 50th annual Sunnyvale Art & Wine Festival continues in downtown Sunnyvale with 200+ artists, live music, local food, and wine. Sunday hours 10 AM–5 PM.",
      kidFriendly: true,
    },
  ];
  const today = todayPT();
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
        kidFriendly: e.kidFriendly ?? false,
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
  const today = todayPT();
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
// Morgan Hill + Gilroy excluded — outside our geo area as of 2026-04-15.
const MEETUP_ACCEPTED_CITIES = new Set([
  "san-jose", "mountain-view", "sunnyvale", "campbell", "los-gatos",
  "saratoga", "los-altos", "milpitas", "santa-clara", "cupertino",
  "palo-alto", "menlo-park",
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

// ── Bookstores ──

// Shared Squarespace event fetcher — works for any site that exposes ?format=json
async function fetchSquarespaceEvents(pageUrl, source, defaultCity, defaultVenue, defaultAddress) {
  console.log(`  ⏳ ${source}...`);
  try {
    const url = `${pageUrl}?format=json`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const items = data.upcoming || data.items || [];
    const now = new Date();

    const events = items
      .map((item) => {
        if (!item.startDate || !item.title) return null;
        const start = new Date(item.startDate);
        if (start < now) return null;
        const end = item.endDate ? new Date(item.endDate) : null;
        const loc = item.location || {};
        const venue = loc.addressTitle || defaultVenue;
        const addr = loc.addressLine1
          ? `${loc.addressLine1}, ${loc.addressLine2 || ""}`.trim()
          : defaultAddress;
        const desc = item.excerpt
          ? stripHtml(item.excerpt)
          : (item.body ? truncate(stripHtml(item.body)) : "");
        const fullUrl = item.fullUrl
          ? (item.fullUrl.startsWith("http") ? item.fullUrl : pageUrl.replace(/\/[^/]*$/, "") + item.fullUrl)
          : pageUrl;

        return {
          id: h(source.toLowerCase().replace(/[^a-z]/g, ""), fullUrl, isoDate(start)),
          title: item.title.trim(),
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: end && end.getTime() !== start.getTime() ? displayTime(end) : null,
          venue,
          address: addr,
          city: defaultCity,
          category: inferCategory(item.title, desc, "", venue),
          // "Free Admission" or "Free " in the title (e.g. JAMsj's free-admission
          // days) overrides the venue's default "paid" cost.
          cost: /\bfree\s+admission\b/i.test(item.title) || /^free\b/i.test(item.title.trim())
            ? "free"
            : "paid",
          description: desc,
          url: fullUrl,
          source,
          kidFriendly: /\b(kids|children|family|toddler|baby|storytime)\b/i.test(item.title + " " + desc),
        };
      })
      .filter(Boolean);

    console.log(`  ✅ ${source}: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  ${source}: ${err.message}`);
    return [];
  }
}

async function fetchEastWestBookshopEvents() {
  return fetchSquarespaceEvents(
    "https://www.eastwestbooks.org/events",
    "East West Bookshop",
    "mountain-view",
    "East West Bookshop",
    "324 Castro St, Mountain View, CA 94041",
  );
}

async function fetchKeplersEvents() {
  return fetchSquarespaceEvents(
    "https://www.keplers.org/upcoming-events-internal",
    "Kepler's Books",
    "palo-alto",
    "Kepler's Books",
    "1010 El Camino Real, Menlo Park, CA 94025",
  );
}

// Hicklebee's (IndieCommerce / Drupal) — HTML parse
// List page has no times; each event detail page has JSON-LD with startDate.
// We fetch detail pages in parallel with a small concurrency cap.
async function fetchHicklebeesEvents() {
  console.log("  ⏳ Hicklebee's...");
  try {
    const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const res = await fetch("https://hicklebees.com/events", {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const html = await res.text();

    const stubs = [];
    const now = new Date();
    const currentYear = now.getFullYear();

    const blocks = html.split(/class="event-block__first/).slice(1);
    for (const block of blocks) {
      const titleMatch = block.match(/event-block__title[^>]*>(.*?)<\//s);
      const monthMatch = block.match(/event__month event__month--start[^>]*>(.*?)<\//s);
      const dayMatch = block.match(/event__day event__day--start[^>]*>(.*?)<\//s);
      const linkMatch = block.match(/href="(\/event[s]?\/[^"]+)"/);

      const title = titleMatch?.[1]?.replace(/<[^>]+>/g, "").trim();
      const month = monthMatch?.[1]?.trim();
      const day = dayMatch?.[1]?.trim();
      if (!title || !month || !day) continue;

      const monthNames = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
      const monthNum = monthNames[month];
      if (monthNum === undefined) continue;

      let year = currentYear;
      const candidate = new Date(year, monthNum, parseInt(day));
      if (candidate < new Date(now.getTime() - 30 * 86400000)) year++;
      const start = new Date(year, monthNum, parseInt(day), 12, 0);

      const eventUrl = linkMatch
        ? `https://hicklebees.com${linkMatch[1]}`
        : "https://hicklebees.com/events";

      stubs.push({ title, start, eventUrl });
    }

    // Fetch detail pages in parallel (5 at a time) to extract clock time from JSON-LD
    const concurrency = 5;
    const results = [];
    for (let i = 0; i < stubs.length; i += concurrency) {
      const batch = stubs.slice(i, i + concurrency);
      const detailed = await Promise.all(batch.map(async (s) => {
        if (s.eventUrl.endsWith("/events")) return s; // no detail link, leave as-is
        try {
          const r = await fetch(s.eventUrl, {
            headers: { "User-Agent": BROWSER_UA },
            signal: AbortSignal.timeout(10_000),
          });
          if (!r.ok) return s;
          const detailHtml = await r.text();
          const startMatch = detailHtml.match(/"startDate":\s*"([^"]+)"/);
          const endMatch = detailHtml.match(/"endDate":\s*"([^"]+)"/);
          if (startMatch) {
            const time = isoTimeToClockLocal(startMatch[1]);
            const endTime = endMatch ? isoTimeToClockLocal(endMatch[1]) : null;
            return { ...s, time, endTime };
          }
        } catch { /* ignore network errors per-event */ }
        return s;
      }));
      results.push(...detailed);
    }

    const events = results.map((s) => ({
      id: h("hicklebees", s.title, isoDate(s.start)),
      title: s.title,
      date: isoDate(s.start),
      displayDate: displayDate(s.start),
      time: s.time || null,
      endTime: s.endTime || null,
      venue: "Hicklebee's",
      address: "1378 Lincoln Ave, San Jose, CA 95125",
      city: "san-jose",
      category: inferCategory(s.title, "", ""),
      cost: "free",
      description: "",
      url: s.eventUrl,
      source: "Hicklebee's",
      kidFriendly: true,
    }));

    const withTime = events.filter((e) => e.time).length;
    console.log(`  ✅ Hicklebee's: ${events.length} events (${withTime} with time)`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Hicklebee's: ${err.message}`);
    return [];
  }
}

// ── Time backfill ──────────────────────────────────────────────────────────
// For events with no `time` but a `url`, fetch the canonical page and try to
// recover a clock time. Cache results (successes AND failures) so repeat runs
// don't re-fetch the same URLs.

function loadTimeBackfillCache() {
  try {
    if (!existsSync(TIME_BACKFILL_CACHE_PATH)) return {};
    return JSON.parse(readFileSync(TIME_BACKFILL_CACHE_PATH, "utf8"));
  } catch { return {}; }
}

function saveTimeBackfillCache(cache) {
  try {
    writeFileSync(TIME_BACKFILL_CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
  } catch { /* non-fatal */ }
}

/** Try to extract a clock time string from arbitrary HTML.
 *  Strategies (in order):
 *   1. JSON-LD Event with startDate that includes a time component
 *   2. <time datetime="..."> tags
 *   3. Meta tags
 *   4. Visible text patterns near event-related labels ("Doors at 7 PM", "7:30 PM")
 *  Returns "H:MM AM/PM" or null.
 */
function extractTimeFromHtml(html, eventDate) {
  if (!html) return null;

  // 1. JSON-LD Event blocks
  const ldMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ldMatches) {
    const inner = block.replace(/<script[^>]*>|<\/script>/gi, "").trim();
    try {
      const data = JSON.parse(inner);
      const items = Array.isArray(data) ? data : (data["@graph"] ? data["@graph"] : [data]);
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const t = item["@type"];
        const isEvent = t === "Event" || (Array.isArray(t) && t.includes("Event"));
        if (!isEvent) continue;
        const start = item.startDate;
        if (typeof start !== "string") continue;
        // Skip if the JSON-LD date doesn't match the event date (avoids picking up the wrong show in a series)
        if (eventDate && !start.startsWith(eventDate)) continue;
        const time = isoTimeToClockLocal(start);
        if (time) return time;
      }
    } catch { /* ignore */ }
  }

  // 2. <time datetime="..."> elements
  const timeTags = html.match(/<time[^>]+datetime=["']([^"']+)["'][^>]*>/gi) || [];
  for (const tag of timeTags) {
    const m = tag.match(/datetime=["']([^"']+)["']/i);
    if (!m) continue;
    const dt = m[1];
    if (eventDate && !dt.startsWith(eventDate)) continue;
    const time = isoTimeToClockLocal(dt);
    if (time) return time;
  }

  // 3. Meta tags
  const metaPatterns = [
    /<meta[^>]+property=["']event:start_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']event_start_time["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m) {
      const time = isoTimeToClockLocal(m[1]);
      if (time) return time;
    }
  }

  // 4. Visible text patterns. Strip tags first, look at the start of the body.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  // Time patterns prefixed by labels like "doors at", "show", "starts", "@".
  // Two regexes — `@` doesn't sit at a word boundary so it needs its own pattern.
  const labelMatch = text.match(/\b(?:doors|starts?|begins?|opens?|show(?:time)?|curtain)\s*(?:at|:)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
  if (labelMatch) return formatHourClock(labelMatch[1]);
  const atSignMatch = text.match(/@\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
  if (atSignMatch) return formatHourClock(atSignMatch[1]);
  // Fallback: first time mention in the first 2KB of body text
  const head = text.slice(0, 2000);
  const generalMatch = head.match(/\b(\d{1,2}:\d{2}\s*(?:am|pm))\b/i) || head.match(/\b(\d{1,2}\s*(?:am|pm))\b/i);
  if (generalMatch) return formatHourClock(generalMatch[1]);

  return null;
}

async function backfillEventTimes(events) {
  const cache = loadTimeBackfillCache();
  const candidates = events.filter((e) =>
    !e.time && !e.ongoing && e.url && /^https?:/.test(e.url) &&
    // Skip canned "events list" pages — they won't have per-event times
    !/\/events\/?$|\/pages\/events\/?$/.test(e.url)
  );
  if (candidates.length === 0) {
    saveTimeBackfillCache(cache);
    return;
  }

  console.log(`\n🕒 Time backfill: ${candidates.length} events with no time + URL`);
  let cacheHits = 0, fetched = 0, recovered = 0, failed = 0;

  const concurrency = 6;
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    await Promise.all(batch.map(async (e) => {
      const cacheKey = `${e.url}|${e.date}`;
      if (Object.prototype.hasOwnProperty.call(cache, cacheKey)) {
        cacheHits++;
        if (cache[cacheKey]) { e.time = cache[cacheKey]; recovered++; }
        return;
      }
      try {
        const res = await fetch(e.url, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(10_000),
          redirect: "follow",
        });
        if (!res.ok) { cache[cacheKey] = null; failed++; return; }
        const html = await res.text();
        fetched++;
        const time = extractTimeFromHtml(html, e.date);
        cache[cacheKey] = time || null;
        if (time) { e.time = time; recovered++; }
        else { failed++; }
      } catch {
        cache[cacheKey] = null;
        failed++;
      }
    }));
  }

  saveTimeBackfillCache(cache);
  console.log(`   cache hits:    ${cacheHits}`);
  console.log(`   fetched:       ${fetched}`);
  console.log(`   times found:   ${recovered}`);
  console.log(`   no time:       ${failed}`);
}

/** Normalize a time string like "7:30 pm" / "7 PM" / "19:30" to "H:MM AM/PM". */
function formatHourClock(s) {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  // Already 12-hour with am/pm
  let m = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3].toUpperCase();
    return min === 0 ? `${h}:00 ${ampm}` : `${h}:${String(min).padStart(2, "0")} ${ampm}`;
  }
  // 24-hour "HH:MM"
  m = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h24 = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h24 === 0 && min === 0) return null;
    const ampm = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);
    return min === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
  }
  return null;
}

/** Convert an ISO datetime to "H:MM AM/PM". Treats the embedded clock as wall time. */
function isoTimeToClockLocal(iso) {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const h24 = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h24 === 0 && min === 0) return null;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);
  return min === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

// Linden Tree Books (Los Altos) — hand-coded HTML, events in <h3> tags
async function fetchLindenTreeEvents() {
  console.log("  ⏳ Linden Tree Books...");
  try {
    const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const res = await fetch("https://www.lindentreebooks.com/events-calendar", {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const html = await res.text();

    const events = [];
    const now = new Date();
    const currentYear = now.getFullYear();

    // Events are in <h3> tags containing <b> with title + date info
    // Pattern: "Event Title<br/>Day, Month DD, Time"
    const h3Blocks = html.split(/<h3[^>]*>/i).slice(1);
    for (const block of h3Blocks) {
      const content = block.split(/<\/h3>/i)[0] || "";
      const cleaned = content.replace(/<[^>]+>/g, "\n").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
      const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;

      const title = lines[0];
      if (!title || title.length < 5) continue;

      // Look for a date line: "Saturday, April 19, 2:00pm" or "Sunday, April 20"
      const monthNames = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5, July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 };
      let eventDate = null;
      let eventTime = null;
      for (const line of lines.slice(1)) {
        const dateMatch = line.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
        if (dateMatch) {
          const monthNum = monthNames[dateMatch[1]];
          const day = parseInt(dateMatch[2]);
          let year = currentYear;
          const candidate = new Date(year, monthNum, day);
          if (candidate < new Date(now.getTime() - 30 * 86400000)) year++;
          eventDate = new Date(year, monthNum, day, 12, 0);

          // Extract time if present: "2:00pm", "10:30 AM"
          const timeMatch = line.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
          if (timeMatch) {
            eventTime = timeMatch[1].toUpperCase().replace(/\s+/g, " ");
          }
          break;
        }
      }
      if (!eventDate || eventDate < now) continue;

      // Look for a link in the original block
      const linkMatch = block.match(/href="(https?:\/\/[^"]+)"/);
      const url = linkMatch?.[1] || "https://www.lindentreebooks.com/events-calendar";

      events.push({
        id: h("lindentree", title, isoDate(eventDate)),
        title,
        date: isoDate(eventDate),
        displayDate: displayDate(eventDate),
        time: eventTime,
        endTime: null,
        venue: "Linden Tree Books",
        address: "170 State St, Los Altos, CA 94022",
        city: "los-altos",
        category: inferCategory(title, "", ""),
        cost: "free",
        description: lines.slice(1).join(" ").slice(0, 200),
        url,
        source: "Linden Tree Books",
        kidFriendly: true, // children's bookstore
      });
    }

    console.log(`  ✅ Linden Tree Books: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Linden Tree Books: ${err.message}`);
    return [];
  }
}

// ── San Jose Downtown Association (Tribe Events REST API) ──
// Covers City Lights Theater, San Jose Museum of Art events, SoFA district, First Fridays, etc.

async function fetchSjdaEvents() {
  console.log("  ⏳ SJDA (Downtown San Jose)...");
  try {
    const events = [];
    const now = new Date();
    const perPage = 50;
    // Paginate — API has 1000+ events, but we only need the next 180 days
    const maxDate = new Date(now.getTime() + 180 * 86400000);
    const startStr = todayPT();
    const endStr = maxDate.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

    for (let page = 1; page <= 10; page++) {
      const url = `https://sjdowntown.com/wp-json/tribe/events/v1/events?per_page=${perPage}&page=${page}&start_date=${startStr}&end_date=${endStr}`;
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) break;
      const data = await res.json();
      const pageEvents = data.events || [];
      if (pageEvents.length === 0) break;

      for (const e of pageEvents) {
        if (e.hide_from_listings || e.is_virtual) continue;
        const title = (typeof e.title === "string" ? e.title : e.title?.rendered || "").replace(/<[^>]+>/g, "").trim();
        if (!title) continue;

        const start = parseDatePT(e.start_date);
        if (!start || start < now) continue;
        const end = e.end_date ? parseDatePT(e.end_date) : null;

        const rawVenue = typeof e.venue === "object" && e.venue
          ? (e.venue.venue || "").trim()
          : "";
        // SJDA's WP API sometimes returns a raw street address as the venue
        // string. cleanVenue strips out address blobs and returns "" so the
        // fallback ("Downtown San Jose") kicks in.
        const venue = cleanVenue(rawVenue);
        const addr = typeof e.venue === "object" && e.venue
          ? `${e.venue.address || ""}, ${e.venue.city || "San Jose"}`.trim()
          : "";
        const desc = e.excerpt
          ? truncate(stripHtml(typeof e.excerpt === "string" ? e.excerpt : e.excerpt?.rendered || ""))
          : "";
        const cats = (e.categories || []).map((c) => c.name || "").join(" ");
        const cost = e.cost
          ? (/free/i.test(e.cost) ? "free" : "paid")
          : "paid";

        events.push({
          id: h("sjda", e.url || title, isoDate(start)),
          title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: end && end.getTime() !== start.getTime() ? displayTime(end) : null,
          venue: venue || "Downtown San Jose",
          address: addr,
          city: "san-jose",
          category: inferCategory(title, desc, cats, venue),
          cost,
          description: desc,
          url: e.url || "https://sjdowntown.com/dtsj-events/",
          source: "SJDA",
          kidFriendly: /\b(kids|children|family|toddler)\b/i.test(title + " " + desc + " " + cats),
        });
      }

      if (page >= (data.total_pages || 1)) break;
      await new Promise((r) => setTimeout(r, 300)); // polite delay
    }

    console.log(`  ✅ SJDA (Downtown San Jose): ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SJDA: ${err.message}`);
    return [];
  }
}

// ── San Jose Museum of Art (Drupal Views with <time> tags) ──

const SJMA_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// SJMA's listing page only ever stores UTC-noon timestamps for "all-day"
// records, so the calendar widget can't tell us when an event actually
// starts. The detail page, however, embeds the real time inside Drupal
// `field__item` divs (e.g. <div class="field__item">3:30pm</div> or
// "6–9pm" inside the body copy). Fetch the detail page and parse it.
async function fetchSjmaDetailTime(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SJMA_BROWSER_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { time: null, endTime: null };
    const html = await res.text();
    return extractSjmaTimeFromHtml(html);
  } catch {
    return { time: null, endTime: null };
  }
}

// Pulled out so it's testable without network. Looks for a structured
// `field__item` time value first, then falls back to the first time-range
// in the body.
function extractSjmaTimeFromHtml(html) {
  // Strip tags inside structured field items so we can pattern-match cleanly.
  const fieldItems = [...html.matchAll(/<div class="field__item">([\s\S]*?)<\/div>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);

  // Prefer a time-range like "6–9pm", "1-4pm", "10:30am-noon"
  const rangeRe = /\b(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s*([ap]\.?m\.?)\b/i;
  // Single time like "3:30pm" or "6 PM"
  const singleRe = /\b(\d{1,2}(?::\d{2})?)\s*([ap]\.?m\.?)\b/i;

  for (const item of fieldItems) {
    const r = item.match(rangeRe);
    if (r) return { time: normalizeTimeStr(r[1], r[3]), endTime: normalizeTimeStr(r[2], r[3]) };
    const s = item.match(singleRe);
    // Skip obviously-not-event-time field items (e.g. dates with no time).
    if (s && !/\bday|date|monday|tuesday|wednesday|thursday|friday|saturday|sunday\b/i.test(item)) {
      return { time: normalizeTimeStr(s[1], s[2]), endTime: null };
    }
  }

  // Fallback: scan plain body text for a range, then a single time.
  const bodyText = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  const r = bodyText.match(rangeRe);
  if (r) return { time: normalizeTimeStr(r[1], r[3]), endTime: normalizeTimeStr(r[2], r[3]) };
  return { time: null, endTime: null };
}

function normalizeTimeStr(num, ampm) {
  const period = ampm.toLowerCase().replace(/\./g, "").toUpperCase(); // "AM" | "PM"
  const hasMinutes = num.includes(":");
  const hourPart = hasMinutes ? num.split(":")[0] : num;
  const minPart = hasMinutes ? num.split(":")[1] : "00";
  return `${parseInt(hourPart, 10)}:${minPart.padStart(2, "0")} ${period}`;
}

async function fetchSjMuseumOfArtEvents() {
  console.log("  ⏳ San Jose Museum of Art...");
  try {
    const res = await fetch("https://sjmusart.org/calendar", {
      headers: { "User-Agent": SJMA_BROWSER_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const html = await res.text();

    const events = [];
    const now = new Date();
    const detailFetches = [];

    // Also grab links near each pair
    const rows = html.split(/views-row/).slice(1);
    for (const row of rows) {
      const timeMatch = row.match(/<time[^>]*datetime="([^"]*)"/);
      const titleMatch = row.match(/<h[23][^>]*>(.*?)<\/h[23]>/s);
      const linkMatch = row.match(/href="(\/[^"]*(?:event|program|exhibition)[^"]*)"/);
      if (!timeMatch || !titleMatch) continue;

      const dateStr = timeMatch[1]; // "2026-04-11T12:00:00Z"
      const start = new Date(dateStr);
      if (isNaN(start.getTime()) || start < now) continue;

      const rawTitle = titleMatch[1].replace(/<[^>]+>/g, "").trim();
      // Normalize "Sjma" → "SJMA" (Drupal sometimes lowercases the acronym)
      const title = rawTitle.replace(/\bSjma\b/g, "SJMA");
      if (!title || /registration|camp/i.test(title)) continue;

      const url = linkMatch
        ? `https://sjmusart.org${linkMatch[1]}`
        : "https://sjmusart.org/calendar";

      // SJMA Drupal stores all-day events as UTC noon (2026-04-19T12:00:00Z = 5am PDT).
      // Treat any SJMA event before 7am local as "no specific time" rather than 5am.
      const ptHour = parseInt(start.toLocaleTimeString("en-US", { hour: "2-digit", hour12: false, timeZone: "America/Los_Angeles" }));
      const sjmaTime = ptHour < 7 ? null : displayTime(start);
      const evt = {
        id: h("sjma", url, isoDate(start)),
        title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: sjmaTime,
        endTime: null,
        venue: "San Jose Museum of Art",
        address: "110 S Market St, San Jose, CA 95113",
        city: "san-jose",
        category: "arts",
        cost: "paid",
        description: "",
        url,
        source: "San Jose Museum of Art",
        kidFriendly: /\b(kids|children|family|youth|toddler|baby|preschool|grade|ages?\s*\d)\b/i.test(title),
      };
      events.push(evt);

      // Queue a detail-page fetch when the listing tells us nothing useful
      // about the time and we have a real event URL to look it up on.
      if (!evt.time && /\/event\//.test(url)) {
        detailFetches.push(async () => {
          const { time, endTime } = await fetchSjmaDetailTime(url);
          if (time) {
            evt.time = time;
            evt.endTime = endTime;
          }
        });
      }
    }

    if (detailFetches.length > 0) {
      // Concurrency cap of 4 so we stay polite to sjmusart.org.
      const queue = [...detailFetches];
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const job = queue.shift();
          if (job) await job();
        }
      });
      const before = events.filter((e) => !e.time).length;
      await Promise.all(workers);
      const resolved = before - events.filter((e) => !e.time).length;
      console.log(`  ↳ SJMA detail-page time backfill: resolved ${resolved}/${detailFetches.length} no-time entries`);
    }

    console.log(`  ✅ San Jose Museum of Art: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  San Jose Museum of Art: ${err.message}`);
    return [];
  }
}

// ── Japanese American Museum of San Jose (Squarespace) ──

async function fetchJamsjEvents() {
  return fetchSquarespaceEvents(
    "https://www.jamsj.org/upcoming-events",
    "Japanese American Museum SJ",
    "san-jose",
    "Japanese American Museum of San Jose",
    "535 N 5th St, San Jose, CA 95112",
  );
}

// ── Playwright-scraped events (pre-scraped by playwright-scrapers.mjs on Mini) ──
// Covers: CivicPlus cities, LibCal libraries, The Tech, bookstores,
// and robust replacements for fragile HTML scrapers (SJ Jazz, SJMA, etc.)

function fetchPlaywrightEvents() {
  console.log("  ⏳ Playwright-scraped events...");
  try {
    if (!existsSync(PLAYWRIGHT_EVENTS_PATH)) {
      console.log("  ⚠️  Playwright events: no data file (run playwright-scrapers.mjs on Mini)");
      return [];
    }
    const { events } = JSON.parse(readFileSync(PLAYWRIGHT_EVENTS_PATH, "utf8"));
    const today = todayPT();
    const filtered = (events || [])
      .filter((e) => e.date >= today)
      .map((e) => e.time ? { ...e, time: e.time.toUpperCase() } : e);
    console.log(`  ✅ Playwright events: ${filtered.length} events`);
    return filtered;
  } catch (err) {
    console.log(`  ⚠️  Playwright events: ${err.message}`);
    return [];
  }
}

// ── Inbound-email events (extracted from city newsletters by /api/admin/events/intake) ──
// The webhook on Vercel writes to Vercel Blob; pull-inbound-events.mjs on the Mini
// mirrors Blob → inbound-events.json, which this function then merges in.

// Cities we cover. Inbound events outside this set are dropped — second line
// of defense after the extractor's allow-list, in case Claude tags an event
// with a city we don't cover.
const INBOUND_ACCEPTED_CITIES = new Set([
  "san-jose", "mountain-view", "sunnyvale", "campbell", "los-gatos",
  "saratoga", "los-altos", "milpitas", "santa-clara", "cupertino",
  "palo-alto", "monte-sereno",
]);

function fetchInboundEvents() {
  console.log("  ⏳ Inbound-email events...");
  try {
    if (!existsSync(INBOUND_EVENTS_PATH)) {
      console.log("  ⚠️  Inbound events: no data file (run pull-inbound-events.mjs on Mini)");
      return [];
    }
    const { events } = JSON.parse(readFileSync(INBOUND_EVENTS_PATH, "utf8"));
    const today = todayPT();

    const out = [];
    let skipBlocked = 0, skipCity = 0, skipPast = 0;
    for (const e of events || []) {
      if (!e.startsAt || !e.title) continue;
      if (e.status === "rejected") continue;

      // Defense in depth — block list applies to extracted events too
      if (isBlockedEvent(e.title)) { skipBlocked++; continue; }

      const dateKey = e.startsAt.slice(0, 10);
      if (dateKey < today) { skipPast++; continue; }
      if (!e.cityKey) { skipCity++; continue; } // Skip events we couldn't geo-place
      if (!INBOUND_ACCEPTED_CITIES.has(e.cityKey)) { skipCity++; continue; }

      const startDate = new Date(e.startsAt);
      if (isNaN(startDate.getTime())) continue;

      // Extract a human time string from the ISO timestamp in PT.
      // Treat midnight (00:00 local) as "time unknown" — the extractor writes
      // T00:00:00 when no time was found in the newsletter.
      const _ptHour = parseInt(
        startDate.toLocaleTimeString("en-US", {
          hour: "2-digit", hour12: false, timeZone: "America/Los_Angeles",
        })
      );
      const _ptMin = startDate.getMinutes();
      const time = (_ptHour === 0 && _ptMin === 0) ? null : startDate.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/Los_Angeles",
      });

      // Parse end time from endsAt if provided
      let endTime = null;
      if (e.endsAt) {
        const endDate = new Date(e.endsAt);
        if (!isNaN(endDate.getTime())) {
          endTime = endDate.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZone: "America/Los_Angeles",
          });
        }
      }

      // Real category inference instead of hardcoded "community" — this is
      // what makes newsletter events show up on the right tabs (Tech, Sports,
      // Arts, Food, etc) instead of just being lumped into Events.
      // Pass location as venue so school-fundraiser detection works for events
      // like "Leigh Longhorn 5K" hosted at "Leigh High School".
      const category = inferCategory(e.title, e.description ?? "", "", e.location ?? "");
      const titleLower = e.title.toLowerCase();
      const descLower = (e.description ?? "").toLowerCase();
      const kidFriendly = /\b(kid|family|children|child|story\s?time|youth|teen|easter\s?egg|egg\s?hunt|preschool)\b/i.test(titleLower)
        || /\b(kid|family|children|story\s?time)\b/i.test(descLower);

      // Extract venue name from location (first part before the comma).
      // If the leading segment is just a street address ("1680 Foley Avenue",
      // "315-367 S First St"), drop the leading number/range so we display the
      // street name instead of a raw address. The full address still rides
      // along in the address field.
      const location = e.location ?? "";
      let venueName = location.includes(",") ? location.split(",")[0].trim() : location;
      if (/^\d+(-\d+)?\s+/.test(venueName)) {
        venueName = venueName.replace(/^\d+(-\d+)?\s+/, "").trim();
      }

      out.push({
        id: h("inbound", e.id, dateKey, e.title),
        title: e.title,
        date: dateKey,
        displayDate: displayDate(startDate),
        time,
        endTime,
        venue: venueName,
        address: location,
        city: e.cityKey,
        category,
        cost: null,
        description: e.description ?? "",
        url: e.sourceUrl ?? "",
        source: "City Newsletter",
        kidFriendly,
      });
    }
    console.log(`  ✅ Inbound events: ${out.length} events (skipped ${skipBlocked} blocked, ${skipCity} out-of-area, ${skipPast} past)`);
    return out;
  } catch (err) {
    console.log(`  ⚠️  Inbound events: ${err.message}`);
    return [];
  }
}

// ── History San Jose (WordPress HTML scrape) ──

async function fetchHistorySanJoseEvents() {
  console.log("  ⏳ History San Jose...");
  try {
    const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const events = [];
    const now = new Date();

    for (let page = 1; page <= 4; page++) {
      const url = page === 1
        ? "https://historysanjose.org/programs-events/"
        : `https://historysanjose.org/programs-events/page/${page}`;
      const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) break;
      const html = await res.text();

      // Events are in <div class="event-box event_all_box"> blocks
      const blocks = html.split(/event_all_box/).slice(1);
      for (const block of blocks) {
        const titleMatch = block.match(/<h[23][^>]*>(.*?)<\/h[23]>/s);
        if (!titleMatch) continue;

        const title = titleMatch[1].replace(/<[^>]+>/g, "").replace(/\*/g, "").trim();
        if (!title || title.length < 5) continue;

        // Dates are MM/DD/YYYY inside a <p> tag in .event-content
        const dateMatch = block.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (!dateMatch) continue;

        const month = parseInt(dateMatch[1]) - 1; // 0-indexed
        const day = parseInt(dateMatch[2]);
        const year = parseInt(dateMatch[3]);

        // For date ranges (e.g. "11/22/2025 – 12/21/2026"), use the start date
        const start = new Date(year, month, day, 12, 0);
        // Check if there's an end date — skip if the end date is in the past
        const endDateMatch = block.match(/\d{1,2}\/\d{1,2}\/\d{4}[^<]*?(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (endDateMatch) {
          const endDate = new Date(parseInt(endDateMatch[3]), parseInt(endDateMatch[1]) - 1, parseInt(endDateMatch[2]));
          if (endDate < now) continue;
        } else if (start < now) {
          continue;
        }

        // Extract time from <span class="eventtime">
        const timeMatch = block.match(/<span class="eventtime">\s*([\d:]+\s*[ap]m)\s*<\/span>/i);
        const endTimeMatch = block.match(/<span class="eventtime">[\s\S]*?<span class="eventtime">\s*([\d:]+\s*[ap]m)\s*<\/span>/i);
        const time = timeMatch ? timeMatch[1].trim().replace(/\s*(am|pm)$/i, (m) => m.trim().toUpperCase()) : null;
        const endTime = endTimeMatch ? endTimeMatch[1].trim().replace(/\s*(am|pm)$/i, (m) => m.trim().toUpperCase()) : null;

        // Link: prefer backend-button href, fall back to any link
        const linkMatch = block.match(/<a[^>]*class="[^"]*backend-button[^"]*"[^>]*href="([^"]+)"/i)
          || block.match(/href="(https?:\/\/[^"]+)"/i);
        const eventUrl = linkMatch?.[1] || "https://historysanjose.org/programs-events/";

        // Location from <span class="eventlocation">
        const locMatch = block.match(/<span class="eventlocation">\s*(.*?)\s*<\/span>/i);
        const location = locMatch ? locMatch[1].replace(/<[^>]+>/g, "").trim() : "History Park";
        const venue = location.split("|")[0].trim() || "History Park";
        const address = location.includes("|") ? location.split("|")[1].trim() : "635 Phelan Ave, San Jose, CA 95112";

        events.push({
          id: h("historysj", title, isoDate(start)),
          title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time,
          endTime,
          venue,
          address,
          city: "san-jose",
          category: inferCategory(title, "", ""),
          cost: "paid",
          description: "",
          url: eventUrl,
          source: "History San Jose",
          kidFriendly: /\b(kids|children|family|youth|toddler|baby|preschool|grade|ages?\s*\d)\b/i.test(title),
        });
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`  ✅ History San Jose: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  History San Jose: ${err.message}`);
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
    fetchMilpitasEvents,
    fetchLosGatosEvents,
    fetchSaratogaEvents,
    fetchLosAltosEvents,
    fetchLosAltosHistoryEvents,
    fetchOperaSanJoseEvents,
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
    fetchSantaCruzWarriorsSchedule,
    fetchSantaCruzPicks,
    fetchMvplEvents,
    // fetchSunnyvaleLibraryEvents, — 403 (Events feature disabled on their BiblioCommons); covered by SCCL
    fetchPaloAltoLibraryEvents,
    fetchHappyHollowEvents,
    fetchMaclaEvents,
    fetchHeritageTheatreEvents,
    fetchShorelineEvents,
    fetchScccfdEvents,
    fetchLgChamberEvents,
    fetchFarmersMarketEvents,
    fetchMiscHardcodedEvents,
    fetchMeetupEvents,
    fetchEastWestBookshopEvents,
    fetchKeplersEvents,
    fetchHicklebeesEvents,
    fetchLindenTreeEvents,
    fetchSjdaEvents,
    fetchSjMuseumOfArtEvents,
    fetchJamsjEvents,
    fetchHistorySanJoseEvents,
    fetchPlaywrightEvents,
    fetchInboundEvents,
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

  // Polish descriptions: drop boilerplate sentences, downcase ALL CAPS, capitalize sentence starts
  allEvents.forEach((e) => {
    if (e.description) e.description = polishDescription(e.description);
  });

  // Sanitize time field: clear values that aren't a clock time (e.g. "SATURDAY, APRIL 25, 2026"
  // ended up in the time field on a few SJMA / inbound listings). For comma-separated session
  // lists ("12pm, 1pm, 2pm") only the last token needs to parse.
  const TIME_PATTERN = /^\d{1,2}(:\d{2})?\s*(am|pm)$/i;
  function isClockTime(t) {
    if (!t) return false;
    const last = String(t).split(",").pop().trim();
    return TIME_PATTERN.test(last);
  }
  // Canonical "8:00 PM" form — different scrapers spit out "8PM", "10:30AM",
  // etc. Standardize so display + sort + comparisons are uniform.
  function normalizeClockTime(t) {
    if (!t) return t;
    const m = String(t).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
    if (!m) return t;
    const h = parseInt(m[1], 10);
    const min = m[2] ?? "00";
    return `${h}:${min} ${m[3].toUpperCase()}`;
  }
  allEvents.forEach((e) => {
    if (e.time && !isClockTime(e.time)) e.time = null;
    if (e.endTime && !isClockTime(e.endTime)) e.endTime = null;
    if (e.time) e.time = normalizeClockTime(e.time);
    if (e.endTime) e.endTime = normalizeClockTime(e.endTime);
  });

  // Time backfill: for events that lost their time at the source, fetch the
  // canonical event URL and try to recover it. Covers SJDA all_day theater
  // shows (Les Mis etc.), inbound newsletter events where the LLM extractor
  // couldn't parse a time, and similar "URL has the time but the feed didn't"
  // cases. Caches both successful times and "no time available" results.
  await backfillEventTimes(allEvents);

  // Filter: must have date and city and title, must be today or future, must be public, not cancelled
  // Also skip zero-duration university calendar markers (e.g. "5:00 PM – 5:00 PM")
  const uniSources = new Set(["Stanford Events", "Santa Clara University", "SJSU Events"]);
  const today = todayPT();
  // Cap non-sports events to 180 days out; sports schedules can go further
  const maxFuture = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const valid = allEvents.filter(
    (e) =>
      e.date &&
      e.date >= today &&
      (e.category === "sports" || e.date <= maxFuture) &&
      e.city &&
      e.title &&
      // Non-ongoing events must have a real start time. All-day announcements
      // ("Independent Bookstore Day", vague day-long fundraisers) and dup
      // listings of timed events that lost their time get dropped here.
      (e.ongoing || e.time) &&
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
  // Same date+venue+time across sources: catches "SJDA listing of SJMA gala" vs
  // "SJMA's own gala listing" by collapsing to one card.

  // Aggressive venue normalization: strip accents, leading article, all non-alnum.
  // Captures "The San José Museum of Art" === "San Jose Museum of Art".
  function normVenueKey(v) {
    if (!v) return "";
    return v.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/^(the|a|an)\s+/, "")
      .replace(/[^a-z0-9]/g, "")
      .substring(0, 30);
  }
  function normTimeKey(t) {
    if (!t) return "";
    return String(t).split(",").pop().trim().toLowerCase().replace(/\s+/g, "");
  }
  // Source-venue affinity: how many venue tokens appear in the source name.
  // Higher score means the source is the venue itself (e.g. SJMA listing
  // for an SJMA event), which we prefer to keep over an aggregator listing.
  function sourceVenueAffinity(e) {
    const s = (e.source || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ");
    const v = (e.venue || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ");
    if (!s || !v) return 0;
    const sTokens = new Set(s.split(/\s+/).filter((t) => t.length >= 3));
    const vTokens = v.split(/\s+/).filter((t) => t.length >= 3);
    let overlap = 0;
    for (const t of vTokens) if (sTokens.has(t)) overlap++;
    return overlap;
  }

  // Pre-sort capped events so that within any (date, venue, time) trio, the
  // source-venue match comes first — that's the listing dedup will keep.
  // Tiebreak by longer description (richer data).
  capped.sort((a, b) => {
    const aff = sourceVenueAffinity(b) - sourceVenueAffinity(a);
    if (aff !== 0) return aff;
    return (b.description?.length || 0) - (a.description?.length || 0);
  });

  const seen = new Set();
  const sportsByDateVenue = new Set();
  const sameSourceByDVT = new Set();
  const deduped = capped.filter((e) => {
    // Cross-source date+venue+time dedup: one listing per concrete event slot
    if (e.venue && e.date && e.time) {
      const dvtKey = `${e.date}|${normVenueKey(e.venue)}|${normTimeKey(e.time)}`;
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
    // Strip common venue suffixes (" — San Jose Jazz", " at SJSU", etc.) before comparing
    const strippedTitle = e.title.replace(/\s+[—–-]+\s+.+$/, "").replace(/\s+at\s+[A-Z].+$/, "");
    const normTitle = strippedTitle.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 30);
    const key = `${normTitle}|${e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Detect true exhibits and collapse to first occurrence as ongoing.
  // Single rule: same title + same URL + no clock time + 2+ dates → gallery
  // or exhibit. Earlier rules also flagged "same title + 3+ dates" or
  // "same title + venue + 2 dates within 5 days" as ongoing — those exiled
  // weekly recurring events (storytimes, ESL classes, multi-night theater
  // runs) to the Ongoing section even when each occurrence had a clock time.
  // Stephen 2026-04-25: those should appear in the day's normal feed on the
  // date they actually run.
  const normTitle = (e) =>
    e.title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim().substring(0, 50);

  const urlDates = {};
  deduped.forEach((e) => {
    if (e.url && !e.time) {
      const uk = `url:${e.url}`;
      if (!urlDates[uk]) urlDates[uk] = { dates: new Set(), key: normTitle(e) };
      urlDates[uk].dates.add(e.date);
    }
  });

  const exhibitKeys = new Set(
    Object.values(urlDates)
      .filter((v) => v.dates.size >= 2)
      .map((v) => v.key),
  );

  const seenExhibit = new Set();
  const finalEvents = deduped.filter((e) => {
    const key = normTitle(e);
    if (exhibitKeys.has(key)) {
      if (seenExhibit.has(key)) return false;
      seenExhibit.add(key);
      e.ongoing = true; // flag for UI — show in "Exhibits" section, not day-by-day feed
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

  // Normalize whitespace and decode HTML entities in all string fields — sources often
  // have double spaces, leading/trailing whitespace, or HTML-encoded characters in
  // titles and venue names (e.g. Kepler&#39;s Books, O&#8217;Flaherty&#8217;s)
  for (const e of collapsedEvents) {
    if (e.title) e.title = e.title.replace(/\s+/g, " ").trim();
    if (e.venue) {
      e.venue = e.venue
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/<[^>]+>/g, "")   // strip any residual HTML tags
        .replace(/[\u00a0]/g, " ") // non-breaking space → regular space
        .replace(/\s+/g, " ").trim();
    }
  }

  // Cross-source dedup — two sources occasionally surface the same event
  // (library event + newsletter item; Stanford + SVLG co-listings). Key by
  // normalizeName(title) + date + normalizeName(venue), keep the richest
  // entry (longest description, has time, has image/photoRef, has url).
  {
    const normKey = (s) => {
      let v = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      // Strip "Venue/org presents: " prefixes so "MACLA Presents: X" == "X" same venue+date
      v = v.replace(/^[a-z\s]{2,30}\s+presents?\s+/i, "");
      return v.trim();
    };
    const scoreRichness = (e) => {
      let s = 0;
      if (e.description) s += Math.min(e.description.length / 100, 5);
      if (e.time) s += 2;
      if (e.endTime) s += 1;
      if (e.image || e.photoRef) s += 2;
      if (e.url) s += 1;
      if (e.cost) s += 0.5;
      if (e.kidFriendly !== null && e.kidFriendly !== undefined) s += 0.5;
      return s;
    };
    const byKey = new Map();
    const kept = [];
    let dupeCount = 0;
    for (const e of collapsedEvents) {
      // Only dedup events with a title + date — closures and ambient entries
      // without those fields don't collide meaningfully.
      if (!e.title || !e.date) { kept.push(e); continue; }
      const k = `${normKey(e.title)}|${e.date}|${normKey(e.venue)}`;
      const existing = byKey.get(k);
      if (!existing) {
        byKey.set(k, { event: e, idx: kept.length });
        kept.push(e);
        continue;
      }
      dupeCount++;
      const existingScore = scoreRichness(existing.event);
      const newScore = scoreRichness(e);
      if (newScore > existingScore) {
        kept[existing.idx] = e;
        byKey.set(k, { event: e, idx: existing.idx });
      }
      // Loser is dropped silently (keeping stdout clean).
    }
    if (dupeCount > 0) console.log(`   🔀 dedup: dropped ${dupeCount} cross-source duplicate(s)`);
    collapsedEvents.length = 0;
    collapsedEvents.push(...kept);
  }

  // Shared rules — keep in sync with scripts/social/lib/content-rules.mjs.
  const { ACRONYM_FIXES, VIRTUAL_TITLE_SIGNALS, VIRTUAL_ADDRESS_SIGNALS } =
    await import("./social/lib/content-rules.mjs");

  // Title-casing fixes for common acronyms — library/museum scrapers write
  // them as "Aids", "Hiv", "Covid", etc. Plan blurbs shouldn't propagate the
  // mistake. Two generate-events-local extras (TED, STEM) that are too
  // context-dependent for the shared list live inline below.
  const LOCAL_ACRONYM_FIXES = [
    ...ACRONYM_FIXES,
    ["TED", /\bTed\b(?= talk| talks)/gi],
    ["STEM", /\b(Stem)\b(?= (?:night|lab|workshop|event|program|education|kids))/g],
  ];
  for (const e of collapsedEvents) {
    for (const field of ["title", "venue", "description"]) {
      if (!e[field]) continue;
      for (const [up, re] of LOCAL_ACRONYM_FIXES) e[field] = e[field].replace(re, up);
    }
  }

  // Virtual-flag normalization — if the title or address has a strong virtual
  // signal, mark the event virtual:true so downstream consumers (plan-day,
  // tonight-pick) can filter it out. This prevents "Online Author Talk: …"
  // from appearing as a place to "stop by" in a day-plan.
  let virtualFlagged = 0;
  for (const e of collapsedEvents) {
    if (e.virtual === true) continue;
    const title = e.title || "";
    const addr = e.address || e.location || "";
    if (VIRTUAL_TITLE_SIGNALS.some(r => r.test(title)) || VIRTUAL_ADDRESS_SIGNALS.some(r => r.test(addr))) {
      e.virtual = true;
      virtualFlagged++;
    }
  }
  if (virtualFlagged) console.log(`   🛰  auto-flagged ${virtualFlagged} virtual event(s)`);

  // Audience-age classification — tag every event "kids" | "adult" | "all"
  // based on title + description. Plan-day uses this to exclude kids-only
  // events from adult plans (e.g. "Kids Knitting") and 21+/drag/tasting
  // events from kids plans. Bias is conservative — default is "all" unless
  // the signal is strong.
  const { classifyAudienceAge } = await import("../src/lib/south-bay/audienceAge.mjs");
  const audienceCounts = { kids: 0, adult: 0, all: 0 };
  for (const e of collapsedEvents) {
    const tag = classifyAudienceAge(e);
    e.audienceAge = tag;
    audienceCounts[tag]++;
  }
  console.log(`   👥 audience: kids=${audienceCounts.kids} adult=${audienceCounts.adult} all=${audienceCounts.all}`);

  // Image resolution — Tier 1 (Places venue match) + Tier 2 (OG scrape) +
  // Tier 3 (Unsplash by category) always run. Tier 4 (Recraft) is opt-in
  // via RESOLVE_EVENT_IMAGES_RECRAFT=1 since it costs money. Cache is
  // persisted so re-runs don't re-fetch.
  const { resolveEventImages } = await import("../src/lib/south-bay/eventImages.mjs");
  console.log("\n🖼  Resolving event images (Places → OG → Unsplash → Recraft)...");
  const imgStats = await resolveEventImages(collapsedEvents);
  if (imgStats.prevalidated_decoded || imgStats.prevalidated_dropped) {
    console.log(`   Pre-pass: decoded=${imgStats.prevalidated_decoded} dropped=${imgStats.prevalidated_dropped} (broken pre-existing URLs)`);
  }
  console.log(`   Tier 1 venue-match:    ${imgStats.tier1}`);
  console.log(`   Tier 2 OG cached:      ${imgStats.tier2_cached}`);
  console.log(`   Tier 2 OG fetched:     ${imgStats.tier2_fetched}`);
  console.log(`   Tier 2 OG missed:      ${imgStats.tier2_missed}`);
  console.log(`   Tier 2 OG rejected:    ${imgStats.tier2_rejected || 0}`);
  console.log(`   Tier 3 unsplash cache: ${imgStats.tier3_unsplash_cached}`);
  console.log(`   Tier 3 unsplash fetch: ${imgStats.tier3_unsplash_fetched}`);
  console.log(`   Tier 3 unsplash skip:  ${imgStats.tier3_unsplash_skipped}`);
  console.log(`   Tier 4 recraft cached: ${imgStats.tier4_recraft_cached}`);
  console.log(`   Tier 4 recraft new:    ${imgStats.tier4_recraft_generated}`);
  console.log(`   Tier 4 recraft skip:   ${imgStats.tier4_recraft_skipped}`);
  const resolved = collapsedEvents.length - imgStats.final_missing;
  console.log(`   Total images resolved: ${resolved} / ${collapsedEvents.length} (${((resolved / collapsedEvents.length) * 100).toFixed(0)}%)`);
  if (imgStats.final_missing > 0) {
    const missingSamples = collapsedEvents.filter(e => !e.image && !e.photoRef).slice(0, 5);
    console.warn(`   ⚠️  ${imgStats.final_missing} event(s) shipped without a photo. Samples:`);
    for (const e of missingSamples) {
      console.warn(`      - "${e.title}" (${e.venue || e.city}) [${e.category}]`);
    }
  }

  // Blurb resolution — one Haiku pass per ingest so every event ships with a
  // stable "what to do here" sentence. Cache is persistent (keyed by URL), so
  // reruns only spend tokens on new/changed events. Behind RESOLVE_EVENT_BLURBS=1
  // so local dev doesn't pay unless explicitly asked.
  const { resolveEventBlurbs } = await import("../src/lib/south-bay/eventBlurbs.mjs");
  console.log("\n📝 Resolving event blurbs (cache → Haiku batch)...");
  const blurbStats = await resolveEventBlurbs(collapsedEvents);
  console.log(`   preexisting:   ${blurbStats.preexisting}`);
  console.log(`   cache hits:    ${blurbStats.cache_hits}`);
  console.log(`   generated:     ${blurbStats.generated}`);
  console.log(`   failed:        ${blurbStats.failed}`);
  console.log(`   skipped:       ${blurbStats.skipped}`);
  const blurbed = blurbStats.preexisting + blurbStats.cache_hits + blurbStats.generated;
  console.log(`   Total blurbed: ${blurbed} / ${collapsedEvents.length} (${((blurbed / collapsedEvents.length) * 100).toFixed(0)}%)`);

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
