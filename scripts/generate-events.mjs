#!/usr/bin/env node
/**
 * generate-events.mjs
 *
 * Scrapes upcoming events from all available South Bay feeds and writes
 * them to src/data/south-bay/upcoming-events.json.
 *
 * Sources include:
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
 *   - The Pear Theatre (VBO Tickets HTML)
 *   - San Jose Theaters (iCal)
 *   - South Bay Musical Theatre (show pages)
 *   - Los Altos Stage Company (WordPress events)
 *   - Palo Alto Players (Venture Event Manager AJAX, per-performance)
 *   - Hammer Theatre (VBO Tickets HTML)
 *   - Gamble Garden (The Events Calendar API)
 *   - Mexican Heritage Plaza (Squarespace events)
 *   - Museum of American Heritage (Squarespace events)
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

import { readFileSync, existsSync } from "fs";
import { writeFileAtomic } from "./lib/io.mjs";
import { catSignal } from "./lib/notify.mjs";
import { extractVenueFromTitle, stripRedundantVenueSuffix } from "./lib/venue-suffix.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, createSign } from "crypto";
import { VIRTUAL_EVENT_PATTERNS } from "../src/lib/south-bay/eventFilters.mjs";
import { fuzzyDedupEvents } from "../src/lib/south-bay/eventFuzzyDedup.mjs";
import { SLUG_TO_CITY_TOKENS } from "./social/lib/content-rules.mjs";
import { loadEnvLocal } from "./lib/env.mjs";
import { fetchJson, fetchText, UA } from "./lib/http.mjs";
import { parseDate, parseDatePT, isoDate, todayPT, displayDate, displayTime } from "./lib/dates.mjs";
import { cleanDisplayCopy, cleanDisplayName } from "../src/lib/south-bay/displayText.mjs";
import { isEventPublishable } from "../src/lib/south-bay/eventOccurrence.mjs";
import {
  marketOccurrenceEvidence,
  verifyMarketScheduleSource,
} from "../src/lib/south-bay/marketOccurrence.mjs";
import { parseMontalvoOccurrencePage } from "../src/lib/south-bay/montalvoOccurrence.mjs";
import { mergeLosGatosSummerConcerts } from "./lib/los-gatos-summer-concerts-2026.mjs";
import { normalizeInboundEventPresentation } from "./lib/inbound-event-normalize.mjs";
import {
  extractAddressLocality,
  extractSanJoseJazzDayUrls,
  extractVboSession,
  parseCivicPlusCalendarPage,
  parseHappyHollowSchedules,
  parseJazzOnThePlazzSchedule,
  parseMusicInParkSchedule,
  parseSanJoseJazzLineup,
} from "./lib/official-event-sources.mjs";
import {
  DEFAULT_SNAPSHOT_MAX_AGE_HOURS,
  buildSourceHealth,
  criticalSourceProblems,
  eventRegressionProblem,
  sourceRegressionProblems,
  strictRefreshInputHealth,
} from "./lib/event-source-health.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnvLocal();
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");
const BLACKLIST_PATH = join(__dirname, "..", "src", "data", "south-bay", "social-blacklist.json");
const PLAYWRIGHT_EVENTS_PATH = join(__dirname, "..", "src", "data", "south-bay", "playwright-events.json");
const INBOUND_EVENTS_PATH = join(__dirname, "..", "src", "data", "south-bay", "inbound-events.json");
const TIME_BACKFILL_CACHE_PATH = join(__dirname, "..", "src", "data", "south-bay", "event-time-backfill-cache.json");
const STRICT_EVENT_REFRESH = process.env.SBT_STRICT_EVENT_REFRESH === "1";

function strictSnapshotMaxAgeHours() {
  const raw = String(process.env.SBT_EVENT_SNAPSHOT_MAX_AGE_HOURS || "").trim();
  if (!raw) return DEFAULT_SNAPSHOT_MAX_AGE_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`invalid SBT_EVENT_SNAPSHOT_MAX_AGE_HOURS: ${raw}`);
  }
  return hours;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

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
  /\btask\s+force\s+(?:monthly\s+)?meeting\b/i, // member-only working sessions (SVLG tax/workforce task forces)
  /\b(town|city)\s+council\b/i, // "Town Council Meeting", "City Council Budget Hearing", etc. — gov tab content
  /\bzoning\s+administrator\b/i, // land-use hearing/agenda content belongs in Gov, not Events
  /\b(?:mayor|vice mayor|councilmember)\b.*\boffice hours\b/i,
  /\bcommittee\s*$/i,     // titles ending in "Committee" (Development Review Committee, Historic Preservation Committee)
  /\bcommission\s*$/i,    // titles ending in "Commission" (Parks and Sustainability Commission, Civic Improvement Commission)
  /\bclosed\s*(for|—|–|-|:)/i, // closure notices ("Closed for", "Closed: Independence Day", etc.)
  /^[\w\s]*\bclosed\s*$/i, // bare "<venue> Closed" closures w/ no time-of-day signal — "Museum Closed", "Library Closed" (annual-holiday iCal entries with no actionable info). Partial-day notices like "Library Closed from 2pm" survive because the time keeps them from ending in "closed".
  /\bcancelled?\b/i,      // cancelled events
  /\bIndustry Insights with Alumni\b/i, // Stanford affiliates only
  /\bnetworking mixer\b/i, // internal student/professional mixers
  /\bimpact of ICE\b/i,    // political
  /\bTerminalFour\b/i,     // internal CMS staff training
  /\bTree Trackers\b/i,    // on-campus student activity
  /\bFidelity One on One\b/i, // internal HR appointments
  /\bPay Day\b/i,          // internal HR payroll notices
  /\bResearch Week Braintrust\b/i, // internal student workshop
  /\bFlash Sale Fridays\b/i, // Stanford gear hub — requires SUID card
  /\bSierra Nevada Concert Experience\b/i, // Ticketmaster VIP lounge package, not the show itself
  /\bCrossFit Games Lounge Day\s+\d+\b/i, // Ticketmaster lounge add-on, not the event itself
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
    // Preserve `\u2026` \u2014 the catch-all stripper below would otherwise drop it,
    // which loses the `[\u2026]` marker that CHM's stripChmRssBoilerplate uses to
    // anchor the WordPress footer strip. Without this, the footer survives
    // until truncate() chops it mid-sentence ("The post\u2026").
    .replace(/&hellip;|&#8230;|&#x2026;/gi, "\u2026")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&[a-z]+;/g, "")
    // BiblioCommons (and other rich-text editors) occasionally save a word
    // wrapped across two adjacent same-tag inline-formatting runs — e.g.
    // `<strong>g</strong><strong>rades 4-5</strong>` from an SCCL Page
    // Turners listing. The catch-all tag-stripper below replaces each tag
    // with a single space, which turns the boundary into "g rades" (two
    // adjacent spaces collapse to one, leaving a literal space mid-word).
    // Drop the boundary when both tags are the same inline-formatting tag
    // so the word reunites before the catch-all runs.
    .replace(/<\/(strong|em|b|i|u|span)\b[^>]*><\1\b[^>]*>/gi, "")
    // Superscript/subscript tags wrap a fragment that's joined to the
    // preceding token with no whitespace — ordinal suffixes ("3<sup>rd</sup>"
    // → "3rd"), footnote markers, chemical formulas ("H<sub>2</sub>O").
    // The catch-all tag stripper replaces each tag with a space, which
    // turns "3<sup>rd</sup>" into "3 rd". Drop sup/sub tags without
    // inserting whitespace so the fragment stays joined.
    .replace(/<\/?(sup|sub)\b[^>]*>/gi, "")
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
  /\b(faculty|fac)\s+(meeting|senate|assembly)\b/i,
  /\bstaff\s+(meeting|development|recognition|affairs|senate)\b/i,
  // Faculty review / personnel admin software training (SCU Provost)
  /\bfac(?:ulty)?\s*180\b/i,
  /\binterfolio\b/i,
  // Graduate Business Career Services (SCU LSB) — career events for enrolled MBAs
  /\bgbcs\b/i,
  // Internal department scholarship/awards banquets — scholarship recipients only
  /\b(accounting|finance|marketing|management)\s+awards?\s+banquet\b/i,
  // Events explicitly limited to a university's staff / faculty / employees
  /\bfor\s+(scu|sjsu|stanford)\s+(staff|faculty|employees)\b/i,
  // Instructor-facing course-design training ("...home pages for your online
  // courses", "...easy for your students to navigate") — SJSU Localist keeps
  // re-emitting a 2021 "Creative Canvas Home Pages" workshop with current dates
  /\byour\s+(online\s+)?courses?\b/i,
  /\byour\s+students\b/i,
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
  // SCU's LiveWhale calendar CMS — internal staff training for posting events
  // to the University Calendar, not a public event itself
  /\blivewhale\b/i,
  // SCU Wave HPC cluster training — research-computing workshops gated to
  // enrolled students/faculty with cluster access
  /\bwave\s+hpc\b/i,
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
  // Catch "Mandatory Peer Advising", "Mandatory Group Advising",
  // "Mandatory Academic Advising", etc. — internal academic admin
  /\bmandatory\s+(\w+\s+){0,2}advising\b/i,
  // Catch "Annual mandatory academic advising period" and similar
  // multi-week registration windows that aren't single events
  /\bacademic\s+advising\s+period\b/i,
  /\b(annual\s+)?(mandatory\s+)?advising\s+period\b/i,
  // Stanford listing of department drop-in advising hours — same admin
  // category as SJSU/SCU's STUDENT_ONLY_TITLE filter, but Stanford intake
  // doesn't run that gate, so we add it here too
  /\bdrop[-\s]?in\s+advising\b/i,
  /\bstudent\s+recognition\s+program\b/i,
  /\brecognition\s+(ceremony|reception|program)\b/i,
  // Internal volunteer appreciation events (e.g. SCU Osher "Volunteer
  // Luncheon Reception", SJSU "Annual Volunteer Luncheon"). Public-facing
  // volunteer events use different framing — "Volunteer Day", "Cleanup",
  // "Orientation". A "Volunteer Luncheon" is almost always an internal
  // appreciation event for existing volunteers.
  /\bvolunteer\s+luncheon\b/i,
  /\bdean'?s\s+(reception|address|brunch)\b/i,
  /\bclub\s+sport\s+practice\b/i,
  /\bclass\s+meeting\s+for\s+/i,
  // Private class visits (faculty-arranged, not public)
  /\bclass\s+visit\b/i,
  /^Visit:\s+.*\bHigh School\b/i,
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
// Cancellation phrases that appear in description/blurb but not the title.
// Examples seen: Ticketmaster shoves "Unfortunately, the Event Organizer has
// had to cancel your event…" into `info`/`pleaseNote`; library scrapers
// sometimes write "this event has been cancelled" in the body. Keep this
// list tight — we're matching language, not the bare word "cancel" (a
// "Cancel Culture Book Club" should stay).
const CANCELLED_BODY_PATTERNS = [
  /\bevent (?:has been|is|was) cancell?ed\b/i,
  /\bhas had to cancel (?:your |the |this )?event\b/i,
  /\bthis (?:show|performance) (?:has been|is) cancell?ed\b/i,
  /\bcancell?ed[;.]\s+refunds? (?:will be|are being)\s+issued\b/i,
];

function looksCancelled(description, blurb) {
  const text = [description, blurb].filter(Boolean).join(" ");
  if (!text) return false;
  return CANCELLED_BODY_PATTERNS.some((p) => p.test(text));
}

// Ticketmaster's `pleaseNote` field is venue policy boilerplate (bag rules,
// prohibited items, clear-bag requirements), not event-specific info. When
// `info` is empty the mapper falls through to `pleaseNote` and the resulting
// "description" is a security blurb like "Attention! - SAP Center enforces a
// restricted bag policy for all events…", which then poisons the Sonnet blurb
// resolver's input and surfaces in search hits. Detect and drop.
const VENUE_POLICY_PATTERNS = [
  /\b(?:restricted |clear[- ])?bag\s+(?:policy|rule|check|size|requirement)/i,
  /\bbags?\s+(?:larger than|must be|are\s+(?:not\s+)?(?:permitted|allowed))/i,
  /\b(?:prohibited|allowed)\s+items?\b/i,
  /\b(?:weapons?|firearms?|outside\s+food|coolers?)\s+(?:are\s+)?(?:strictly\s+)?prohibit/i,
  /\benforces?\s+a\s+(?:restricted|strict)/i,
  /\bmetal\s+detect/i,
  // SJ Improv-style "DO NOT POST PHOTOS / DO NOT USE PHONES / DO NOT PURCHASE
  // TICKETS FROM..." comedy-venue rule text gets shoved into Ticketmaster's
  // `info` field. Truncate cuts at the first newline and produces a useless
  // "DO NOT…" description. The opening "DO NOT" is itself a reliable signal —
  // a real event blurb wouldn't lead with it.
  /^\s*(?:please\s+)?do\s+not\b/i,
  /\byondr\s+pouch/i,
];

function looksLikeVenuePolicy(text) {
  if (!text) return false;
  // Strip leading "Please Note:" / "Attention!" markers before scoring — they
  // wrap the actual policy text but don't carry signal themselves.
  const stripped = text.replace(/^\s*(?:please note[:\-]?\s*|attention[!:\-]?\s*)+/gi, "").trim();
  if (!stripped) return true;
  return VENUE_POLICY_PATTERNS.some((p) => p.test(stripped));
}

const VIRTUAL_PATTERNS = [
  /\bvirtual\b/i,
  /\bvia zoom\b/i,
  /\bon zoom\b/i,
  /\bzoom link\b/i,
  /\bonline only\b/i,
  /\bwebinar\b/i,
  /\blive[-\s]?stream\b/i,
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

// SJSU / SCU / Stanford sometimes co-sponsor events held in another country
// (e.g. an AI symposium at Eötvös Loránd University in Budapest). The local
// university's events feed surfaces them, but they're not attendable from the
// South Bay. Drop when title/venue/description name a clearly foreign host.
const OFF_REGION_PATTERNS = [
  /\b(eötvös|loránd)\b/i,
  /\b(tsinghua|peking)\s+university\b/i,
  // Use full university names so "Cambridge Avenue" / "Oxford Street" don't
  // false-positive against actual local addresses
  /\b(oxford|cambridge|sorbonne)\s+university\b/i,
  /\buniversity\s+of\s+(oxford|cambridge|tokyo|kyoto|hong\s+kong|melbourne|sydney|toronto|british\s+columbia)\b/i,
  /\bin\s+(budapest|hungary|tokyo|kyoto|paris|france|berlin|germany|london|england|madrid|spain|rome|italy|singapore|seoul|beijing|shanghai|mumbai|delhi)\b/i,
  // SCU regional alumni chapters host travel-day events at home stadiums in
  // their own city (e.g. Chicagoland Broncos → Wrigley Field). The SCU events
  // feed surfaces them with venue="Santa Clara University" — drop by chapter.
  /\b(chicagoland|nyc|seattle|portland|denver|boston|austin|dallas|houston|phoenix|atlanta|miami)\s+broncos\b/i,
  // Iconic out-of-region venues — safe to drop on any university feed since
  // there's no local namesake (Wrigley Field is uniquely Chicago, Chase Center
  // is uniquely SF — SJSU's "Night at the Valkyries" event showed up here even
  // though the game is at Chase Center with a Spark Social SF pre-event).
  /\bwrigley\s+field\b/i,
  /\bchase\s+center\b/i,
  /\bspark\s+social\s+sf\b/i,
];

function isOffRegionUniversityEvent(title, description, venue) {
  const fields = [title, description, venue].filter(Boolean).join(' ');
  return OFF_REGION_PATTERNS.some(p => p.test(fields));
}

function isPublicEvent(title, source, description, venue) {
  // Title blocklist — applies to ALL sources (not just university feeds)
  if (isBlockedEvent(title)) return false;
  // Always filter cancelled events regardless of source
  if (CANCELLED_PATTERN.test(title)) return false;
  // Cancellations announced in the body — the title still says "Zakir Khan
  // Live" but the description says "Unfortunately, the Event Organizer has
  // had to cancel your event…". Catch those before they reach a reader.
  if (looksCancelled(description, null)) return false;
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
    // Stanford-internal access requirements (SUID card / SUNet ID) — Stanford-only
    if (source === "Stanford Events") {
      if (description && (/\bSUID\b/i.test(description) || /\bSUNet\s*ID\b/i.test(description))) return false;
      // Vaden Student Health Center is Stanford CAPS / student health — every
      // event there is enrolled-student-only by design (counseling drop-ins,
      // mental health support groups, etc). Catches "Anxiety Toolbox", "Living
      // with OCD", "Rooted! Black Graduate Student Support Group" and similar.
      if (venue && /\bvaden\b/i.test(venue)) return false;
      // Stanford CAPS-style support groups frequently route through other
      // venues but are explicit in description: "for [demographic] students",
      // "MHT clinicians" (Mental Health & Treatment), "Counseling and
      // Psychological Services". These are Stanford-only by program design.
      if (description) {
        if (/\bMHT\s+clinicians?\b/i.test(description)) return false;
        if (/\bcounseling\s+(?:and|&)\s+psychological\s+services\b/i.test(description)) return false;
        if (/\bsupport\s+group\s+for\s+(?:black|asian|latin[oax]+|hispanic|queer|lgbtq\+?|trans|first[\s-]?gen(?:eration)?|undocumented|graduate|undergraduate|medical|stanford|international)[\s-]?(?:identified\s+)?(?:stanford\s+)?(?:graduate\s+|undergraduate\s+|medical\s+)?students?\b/i.test(description)) return false;
        if (/\bgroup\s+for\s+(?:stanford\s+)?(?:graduate\s+|undergraduate\s+|medical\s+)?students?\s+who\s+(?:live|are|identify|experience|have)\b/i.test(description)) return false;
      }
    }
    // SCU internal-staff addresses — "Colleagues, join us …" / "Dear colleagues,
    // please …" open the description when the event is a staff/faculty briefing
    // (e.g. HSI Advisory group strategic-recommendations meetings on the SCU
    // calendar). Public events don't address readers as "colleagues" in their
    // opening line. Title alone doesn't carry the signal — the existing SCU
    // patterns above only test against title.
    if (source === "Santa Clara University" && description) {
      if (/^\s*(?:dear\s+)?colleagues[,!]?\s+(?:join|please|kindly)\b/i.test(description)) return false;
    }
    // Filter away athletic events — games played outside the South Bay
    if (isAwayGame(title)) return false;
    // Filter co-sponsored international events (e.g. SJSU listing a symposium
    // in Budapest) — venue/description fields catch these even when the title
    // looks normal
    if (isOffRegionUniversityEvent(title, description, venue)) return false;
  }
  return true;
}

// Strip calendar-artifact date prefixes like "Apr 1, 2026: " or "March 28: "
// Also decodes HTML entities that may survive title extraction
// Known recurring scraper typos — keyed by the bad string, value is the fix.
// Add entries here when a source consistently sends bad data.
const TITLE_FIXES = {
  "Fun Runa": "Fun Run",
  "Pop Up Art Event": "Pop Up Art Gallery",
  "San Benito Co. Line": "San Benito County Line",
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
  "Crossfit": "CrossFit",  // Ticketmaster's CrossFit Games event titles arrive title-cased
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
  "Xfyd ": "XFYD ",     // XFYD chess club — all-caps brand name on flyers
  "Grpc's": "GRPC's",   // Guadalupe River Park Conservancy — Google Cal title-cases it
  " Uv ": " UV ",       // ultraviolet resin classes — library feeds/old data title-case the acronym
  // Performer/brand acronyms styled ALL-CAPS in the act's own marketing — the
  // 2+ regex downcases them once the rest of the title tips into mixed case,
  // and they're too generic (ONE, RJ, DSP, EXE) to safely add to KEEP_UPPER.
  // Targeting the specific brand string keeps the fix narrow.
  "Ampers&One": "Ampers&ONE",          // K-pop boy group Ampers&ONE
  "Rockstar Dsp": "Rockstar DSP",      // composer Devi Sri Prasad, billed as DSP
  "Densetsu.Exe": "Densetsu.EXE",      // anime idol group Densetsu.EXE
  "Lori & Rj": "Lori & RJ",            // Magical Bridge performers Lori & RJ
  // "US" the pronoun vs. "US" the country abbreviation: KEEP_UPPER preserves
  // "US" so country uses ("In US") stay capitalized, but a few source titles
  // capitalize the pronoun ("Makes US"). Override the specific pronoun cases.
  "Makes US": "Makes Us",
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
    // Strip trademark/copyright/service-mark symbols. They render as visual
    // noise on cards and badges; the underlying entities are still legally
    // recognizable without the glyph.
    .replace(/[®©™℠℗]/g, "")
    // Strip emoji and pictographic decoration. Meetup/community feeds wrap
    // titles in sparkles, hiking boots, wizards, etc. ("✨ TLAB Relaunch ✨",
    // "💚Easy Walk🥾Hike…") — same visual-noise rationale as the ®™ strip above.
    // Replace with a space (not "") so emoji used as word separators don't fuse
    // neighbors ("Walk🥾Hike" → "Walk Hike"); the \s{2,} collapse + trim below
    // tidy the result. Covers regional indicators, the main pictograph blocks,
    // misc symbols + dingbats (incl. ✨ U+2728), variation selectors, ZWJ, and
    // skin-tone modifiers.
    .replace(
      /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu,
      " ",
    )
    // Straighten curly quotes — match polishDescription so titles and bodies
    // share normalization. Smart-quote forms render fine in some fonts but
    // break copy-paste, search, and our typography defaults.
    .replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"')
    // Strip stray space before terminal punctuation ("Bookmarks ,", "Title !").
    // Includes colon ("Friday Fun : DIY" → "Friday Fun:") — appears in SJPL and
    // Palo Alto Library titles ("Online Author Talk : Nir Eyal").
    .replace(/\s+([,.;:!?])/g, "$1")
    // Insert a missing space AFTER a colon between two letters
    // ("Challenger:A True Story" → "Challenger: A True Story"). Library and
    // Ticketmaster titles occasionally drop the space in "Main Title:Subtitle".
    // Letter-only on both sides so clock times (1:00), ratios, and URLs (://)
    // stay untouched. Runs after the space-before-colon strip so a stray
    // " : " collapses cleanly to ": ".
    .replace(/([A-Za-z]):([A-Za-z])/g, "$1: $2")
    .replace(/\s{2,}/g, " ")
    // Expand concert-billing "w/" shorthand to "with". Ticketmaster lineup
    // titles like "Dana Carvey w/ David Spade" or "Kaleo w/ Dawes" arrive as
    // raw scraper output; requiring a trailing space means "w/o" (without)
    // and URL fragments stay untouched.
    .replace(/\bw\/\s+/gi, "with ")
    // Strip BiblioCommons "External Event:" prefix (Palo Alto Library tags
    // events organized by outside groups — venue + source already convey
    // that, the prefix is just visible noise in display titles).
    .replace(/^External Event:\s*/i, "")
    // Strip wrapping double-quotes when the entire title is quoted (Ticketmaster
    // sometimes emits show titles as `"The Hayley Williams Show"`). Only fires
    // when the quotes are paired with no internal quotes, so titles with an
    // internal quoted phrase like `Kiki Yeung "Sweet and Sour Chicks"` keep
    // their inner quotes.
    .replace(/^"([^"]+)"$/, "$1")
    // Strip BiblioCommons asterisk-wrapped format markers like "*In Person*",
    // "*Virtual*", "*Online*" (San Jose Public Library prefixes some titles
    // with these — format is shown elsewhere via venue/url).
    .replace(/^\*[^*]{1,20}\*\s*/, "")
    // Strip calendar-artifact date prefixes
    .replace(
      /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\s*:\s*/i,
      "",
    )
    // Normalize possessive 'S → 's after a word. Sources that title-case
    // every word ("Vera Wong'S Unsolicited Advice") leave the possessive S
    // capitalized. Run before the case-balancing rules so they see the fixed
    // form ("Wong's" reads as mixed-case, not as a 1-letter all-caps run).
    .replace(/(\w)'S\b/g, "$1's")
    // Recover the "Let's" contraction when feeds drop the apostrophe. A
    // capitalized standalone "Lets" token in an event title is effectively
    // always the contraction ("Lets eat", "Lets Talk", "Lets Dance") — the
    // verb sense ("the pass lets you in") only appears lowercase mid-sentence,
    // which a Title-cased event name doesn't produce. Case-sensitive so all-caps
    // brand styling ("LETS") and substrings ("Outlets", "Tablets") stay intact.
    // Recurring manual copy-edit in the title data — handle it upstream.
    .replace(/\bLets\b/g, "Let's")
    .trim();
  // Downcase ALL-CAPS words that aren't known acronyms. Titles that are
  // mostly mixed-case (lowerRatio ≥ 0.5) get the aggressive 2+ letter rule:
  // this catches stylized fillers ("KID Cudi" → "Kid Cudi", "ALL Things" →
  // "All Things", "THE Tainted CUP" → "The Tainted Cup", "IN Stanford" →
  // "In Stanford"). Titles that are mostly all-caps (BLACKPINK-style brand
  // marks) fall back to the 4+ rule so two-letter brand fragments stay intact.
  const KEEP_UPPER = new Set([
    "ICYMI", "LGBTQ", "LGBTQIA", "BIPOC", "STEAM", "LEGO",
    // 4-letter acronyms to preserve
    "SJSU", "SJPL", "SJPD", "SJFD", "FIFA", "UEFA", "ESPN", "STEM", "AAPI", "ACLU",
    "NASA", "IEEE", "YMCA", "YWCA", "ROTC", "FEMA", "NOAA", "WWII", "UCLA",
    "FOPAL", "AANHPI", "PAUSD", "SJUSD", "FUHSD", "MVWSD", "CUSD", "BVAL", "SCVAL",
    // Japanese American Citizens League — appears as "SJ JACL" in JAMsj titles.
    // 4-letter so it survives the conservative pass, but the second 2+ pass
    // downcases it once the surrounding title tips into mixed case.
    "JACL",
    // Local youth-program brand names that arrive ALL-CAPS from BiblioCommons
    "XFYD",
    // Library/program acronyms that arrive ALL-CAPS in source titles but the
    // 2+ regex would downcase ("TLAB Relaunch" → "Tlab Relaunch", "(HICAP)"
    // → "(Hicap)"). TLAB = Teen Library Advisory Board (Palo Alto Library);
    // HICAP = Health Insurance Counseling & Advocacy Program (CA state).
    "TLAB", "HICAP",
    // South Bay venues / institutions. SVCF = Silicon Valley Community
    // Foundation — title-cased to "Svcf" by the 2+ pass without coverage.
    "SJMA", "MACLA", "SVLG", "SJDA", "SCCC", "MOFAD", "SVCF", "KCAT",
    "USPS", "USPTO", "USDA", "UCSF", "UCSC", "UCSD", "UCSB",
    // South Bay org/agency acronyms
    "SJMADE", "SCCFD", "SCVMC", "PACL", "SJDT", "LGPNS",
    // South Bay venue/program/sponsor acronyms that arrive ALL-CAPS but get
    // downcased by the 2+ pass once the surrounding title tips mixed-case
    // ("ASML Next Gen Stage…" → "Asml", "TSRP: Henna Designs" → "Tsrp",
    // "RJJT Presents Moana Jr." → "Rjjt"). ASML = the lithography company
    // sponsoring SJMA's SJ Jazz stage; TSRP = Teen Summer Reading Program
    // (SCC Library); RJJT = Roberta Jones Junior Theatre (City of Santa Clara).
    // Recurring manual copy-edit in the title data — handled upstream here.
    "ASML", "TSRP", "RJJT",
    // More South Bay venue/org/program acronyms that arrive ALL-CAPS from
    // source feeds but the 2+/4+ pass downcases once the title tips mixed-case:
    //   NUMU = New Museum Los Gatos ("Still Life Drawing at NUMU")
    //   CMT  = Children's Musical Theater San Jose ("Legally Blonde – CMT Mainstage")
    //   ACGA = Assoc. of Clay & Glass Artists of CA ("ACGA Clay & Glass Festival")
    //   SBDC = Small Business Development Center ("Silicon Valley SBDC x Emumba")
    //   BMR  = Below Market Rate (spelled out in title: "Below Market Rate (BMR)…")
    //   CRC  = Collegiate Recovery Community (spelled out in title)
    //   ASL  = American Sign Language ("The Sound of Music - ASL Performance")
    //   UX / UXR = design/research terms ("UX Wizards UX, Product + UXR … Mixer")
    "NUMU", "CMT", "ACGA", "SBDC", "BMR", "CRC", "ASL", "UX", "UXR",
    // 2–3 letter acronyms that legitimately appear in event titles. Anything
    // NOT in this list gets title-cased when the surrounding title is mostly
    // mixed-case (which is how we catch stylized fillers like THE/ALL/KID).
    "AI", "AR", "VR", "UV", "EV", "PM", "AM", "DJ", "TV", "PC", "IT", "HR", "PR", "ER",
    "SF", "SJ", "LA", "CA", "SC", "US", "UK", "FC", "RB",
    "GK", "II", "TK", "JR", "SR", "VS",
    "BBQ", "BYOB", "CEO", "CFO", "CTO", "CPR", "AED", "API", "DIY", "ELL", "ESL", "EVC",
    "HPC",
    "FAR", "FBI", "GED", "ICU", "IRS", "LED", "MLB", "MLS", "NBA", "NFL", "NHL",
    "NCAA", "PAC", "POV", "PSA", "SAG", "SAT", "SAP", "SBN", "SCU", "SIG", "SJZ",
    "SMT", "SUV", "TBA", "TBD", "USA", "USB", "VPN", "VHS", "FAQ", "JFK", "MLK", "CCC",
    "FDA", "CDC", "ICE", "TSA", "EPA", "DOJ", "DUI", "PTA", "PTO", "HOA", "VFW",
    "BTS", "WWE", "AEW", "UFC", "MMA", "EDM", "RNB", "HIP", "HIF", "NPR", "PBS",
    "AARP", "NAACP", "NAMI", "SCORE",
    // Federally-recognized institutional designations + Jesuit institution
    // abbreviations that surface in SCU calendar titles. Without these the 2+
    // rule downcases "(HSI) Initiative" → "(Hsi)" and "JST-SCU Lay Sending"
    // → "Jst-SCU". HSI = Hispanic-Serving Institution (ED.gov designation);
    // JST = Jesuit School of Theology (the merged SCU theology program is
    // styled JST-SCU on SCU's calendar).
    "HSI", "JST",
    // Art on the Grounds — Montalvo Arts Center's outdoor-installation program.
    // Its JSON-LD titles arrive as "AOG Marcus Fest: …" and the 2+ rule downcased
    // the prefix to "Aog".
    "AOG",
    // Sports leagues / clubs the existing list missed. Sources name-drop these
    // in mixed-case titles where the 2+ rule downcases them — e.g. "San Jose
    // Earthquakes vs LAFC - Prime Time" from the City Newsletter became "vs
    // Lafc". CSU is 3-letter so only at risk under the 2+ rule, but the same
    // family of bug (Bay FC CSU Night vs. an alumni mailer with more body copy)
    // can flip it.
    "LAFC", "NWSL", "WNBA", "PGA", "LPGA", "CSU",
    // Medical / academic acronyms that legitimately appear in titles. Without
    // these the 2+ rule lowercases "AIDS" → "Aids" and "MFA" → "Mfa".
    "AIDS", "HIV", "PTSD", "ADHD", "MFA", "BFA", "MBA",
    // Medical credentials that show up after presenter names ("Sandra Karol,
    // MS, RDMS, RVT") in description copy — and would, if any title carried
    // them, get downcased the same way.
    "RDMS", "RVT", "CNM",
    // Society for Human Resource Management — SJSU's continuing-ed prep course
    // for the SHRM-CP and SHRM-SCP certifications arrives as "SHRM Test Prep
    // Course Informational Session" from Localist and gets downcased to "Shrm
    // Test Prep…" by the 4+ pass. SHRM is the standard sector-wide acronym for
    // the certification body; preserving it.
    "SHRM",
    // Web-tech acronyms that BiblioCommons computer-help listings and Stanford/
    // SJSU CS course descriptions name-drop in titles ("HTML Code Bootcamp",
    // "Intro to CSS / JSON / PDF Workflow"). 4 letters survives the 4+ pass
    // only with KEEP_UPPER coverage.
    "HTML", "JSON",
    // Deep Cuts Book Club — Kepler's brands its 2026 series "DCBC Comes of Age"
    // in the event title; the venue uses DCBC as its own program abbreviation
    // in the poster filename and elsewhere on keplers.org. 4 letters, downcased
    // by the 4+ pass without coverage.
    "DCBC",
  ]);
  {
    const letters = t.replace(/[^A-Za-z]/g, "");
    const lowerCount = letters ? letters.replace(/[^a-z]/g, "").length : 0;
    const lowerRatio = letters.length ? lowerCount / letters.length : 0;
    // Use Unicode-aware lookarounds so a run like "MAN" inside "MANÁ" doesn't
    // get partial-matched and rewritten — \b in JS regex without /u treats
    // Á as a non-word char, which would otherwise carve "MAN" out of "MANÁ".
    const re = lowerRatio >= 0.5
      ? /(?<!\p{Letter})[A-Z]{2,}(?!\p{Letter})/gu
      : /(?<!\p{Letter})[A-Z]{4,}(?!\p{Letter})/gu;
    t = t.replace(re, (w) => (KEEP_UPPER.has(w) ? w : w[0] + w.slice(1).toLowerCase()));
    // Second pass: when the first pass tipped a previously-all-caps title into
    // mixed-case, run the 2+ regex to catch stragglers the conservative 4+
    // rule left behind. Ticketmaster ships titles like "2026 AMPERS&ONE LIVE
    // TOUR 'BORN TO DEFINE' IN SAN JOSE" — the 4+ pass lowercases LIVE/TOUR/
    // BORN/DEFINE/JOSE but leaves ONE/SAN/TO/IN as caps; the resulting
    // mixed-case form is exactly the shape the 2+ rule is meant for.
    if (lowerRatio < 0.5) {
      const letters2 = t.replace(/[^A-Za-z]/g, "");
      const lowerRatio2 = letters2.length ? letters2.replace(/[^a-z]/g, "").length / letters2.length : 0;
      if (lowerRatio2 >= 0.5) {
        t = t.replace(
          /(?<!\p{Letter})[A-Z]{2,}(?!\p{Letter})/gu,
          (w) => (KEEP_UPPER.has(w) ? w : w[0] + w.slice(1).toLowerCase()),
        );
      }
    }
  }
  // Contraction recovery: when an ALL-CAPS run gets downcased to title case,
  // a trailing apostrophe-S (or 'D, 'LL, etc.) stays uppercase because the
  // {2,}/{4,} regex stops at the apostrophe (non-letter). "BERMAN'S" rolls
  // through as Berman + 'S → reads as a typo. Downcase the lone uppercase
  // letters when they sit after a Titlecased word + apostrophe and end at a
  // word boundary. Requires the leading run to have lowercase (so true
  // acronyms like "JFK'S" / "FBI'S" — which the upstream pass didn't touch
  // — stay intact).
  t = t.replace(/([A-Z][a-z]+)'([A-Z]+)\b/g, (_, w, suffix) => w + "'" + suffix.toLowerCase());
  // Downcase capitalized small words mid-title — Ticketmaster and Shoreline
  // feeds title-case every word ("Valley Of Heart's Delight", "Eleanor The
  // Great", "Born To Define"). Standard title-case style lowercases articles,
  // short prepositions, and conjunctions when they're not the first word of a
  // segment. The lookbehind requires a Latin letter immediately before the
  // whitespace, which keeps small words at the start of the title and right
  // after `:` / `&` / `-` / `–` untouched ("A New Hope", "Mike & The Mechanics",
  // "Stanford – And Beyond"). The lookahead requires the following word to be
  // capitalized too, so only the "every word is Title-Cased" antipattern fires.
  t = t.replace(
    /(?<=[A-Za-z])(\s+)(A|An|Of|The|And|To|By|In|On|For|Or|But|Nor|As|At|With|From)(?=\s+[A-Z])/g,
    (_, sp, w) => sp + w.toLowerCase(),
  );
  // Re-capitalize the article "The" when it directly follows a possessive and
  // leads into a capitalized word ("Disney's the Lion King Jr.", "Rodgers &
  // Hammerstein's the Sound of Music"): in `X's The …`, the article begins the
  // proper title of a work, so the downcase pass above shouldn't have touched
  // it. Scoped to "the" only — "a"/"an" after a possessive are usually
  // grammatical articles ("Everyone's a Star"), not title leads, so those stay
  // lowercased. The 4 Hammer Theatre Lion King date-variants kept reverting to
  // lowercase "the" because the live patch couldn't survive the nightly regen.
  t = t.replace(/(['’]s\s+)the(\s+[A-Z])/g, "$1The$2");
  // Companion pass: same downcase when the small word sits in front of a
  // lowercase determiner / possessive / demonstrative. Catches the History SJ
  // "Cars In the Park" pattern where the source already lowercased "the" but
  // left "In" capitalized — the strict-lookahead pass above skips it because
  // the following word isn't capital, even though every reader expects
  // standard title case to lowercase the preposition here.
  t = t.replace(
    /(?<=[A-Za-z])(\s+)(Of|To|By|In|On|For|At|With|From|And|Or|As)(?=\s+(?:the|a|an|our|my|your|his|her|their|its|this|that|these|those)\b)/g,
    (_, sp, w) => sp + w.toLowerCase(),
  );
  // Apostrophe-trailing pass: when a quoted subtitle ends with an apostrophe
  // immediately before the preposition's leading space, the [A-Za-z] lookbehind
  // above fails because the closing quote isn't a letter. Ticketmaster ships
  // tour titles like "...'Born to Define' In San Jose" / "...' Archive. 1 ' In
  // US" where the preposition deserves the same downcase. Require letter+quote
  // (not just bare quote) so we don't touch leading quoted phrases like
  // `"In the beginning..."`.
  t = t.replace(
    /(?<=[A-Za-z]['"])(\s+)(A|An|Of|The|And|To|By|In|On|For|Or|But|Nor|As|At|With|From)(?=\s+[A-Z])/g,
    (_, sp, w) => sp + w.toLowerCase(),
  );
  // Wider variant: when the close quote sits after a digit ("'Archive.1'") or
  // is whitespace-padded ("' Archive. 1 '"), the letter+quote lookbehind above
  // misses. Anchor on a balanced quote pair so we only fire after a real
  // closing quote (not a leading quoted phrase). Caught WOODZ' "...' Archive.
  // 1 ' In US" 2026-05-25.
  t = t.replace(
    /(['"][^'"]*['"])(\s+)(A|An|Of|The|And|To|By|In|On|For|Or|But|Nor|As|At|With|From)(?=\s+[A-Z])/g,
    (_, q, sp, w) => q + sp + w.toLowerCase(),
  );
  // Normalize "--" → en-dash. Stanford Localist feeds emit raw double-hyphens
  // as subtitle separators ("Literature of the Middle East--Book Display");
  // standard typography wants a single en-dash with spaces. Only fires when
  // surrounded by alphanumerics so URLs, ranges, and CLI fragments stay put.
  t = t.replace(/(\w)\s*--\s*(\w)/g, "$1 – $2");
  // Collapse repeated terminal punctuation. SJDA's WP feed leaks "!!"
  // ("Pete's Soundhouse is officially Live!!") and BiblioCommons feeds
  // occasionally splash "?!?!" style chains. Keep "!?" as a deliberate
  // interrobang; everything else flattens to a single mark.
  t = t.replace(/!{2,}/g, "!").replace(/\?{2,}/g, "?");
  // Title-case fully-lowercase titles. City Lights Theater (cltc.org) styles
  // play titles in their menu as lowercase ("anthropology"); the textContent
  // scrape inherits that styling. Don't touch titles with any uppercase letter,
  // so stylized brand names like "allcove x PACL Book Club" stay intact.
  if (/[a-z]/.test(t) && !/[A-Z]/.test(t)) {
    const SMALL_WORDS = new Set([
      "a","an","the","and","or","but","nor","for","of","in","on","at","to","by",
      "as","is","it","be","vs","via",
    ]);
    t = t.replace(/(\w[\w']*)/g, (word, _g, offset) => {
      const lower = word.toLowerCase();
      if (offset > 0 && SMALL_WORDS.has(lower)) return lower;
      return word[0].toUpperCase() + word.slice(1);
    });
  }
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
  // Strip bilingual translation suffix joined by hyphen (often no spaces, SJPL
  // style): "Vietnamese Storytime & Craft-Kể chuyện và làm thủ công…". Triggers
  // on Latin Extended Additional (U+1E00-U+1EFF, Vietnamese-specific
  // diacritics) or CJK in the tail, and requires the tail to have noticeably
  // more non-ASCII than the head so titles where the diacritics live in the
  // head ("René Liu - Final Call 2026 Live Tour") stay untouched.
  {
    const dashMatch = t.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (dashMatch) {
      const head = dashMatch[1];
      const tail = dashMatch[2];
      const nonAscii = /[\u1E00-\u1EFF\u2E80-\u9FFF\uF900-\uFAFF]/g;
      const tailHits = (tail.match(nonAscii) || []).length;
      const headHits = (head.match(nonAscii) || []).length;
      if (tailHits >= 2 && tailHits > headHits && head.trim().length >= 10) {
        t = head.trim();
      }
    }
  }
  // Strip trailing time annotations: "Good Friday Liturgy 3 PM" → "Good Friday
  // Liturgy". Skip when preceded by a preposition that makes the time
  // semantically load-bearing in the title — Los Gatos Library publishes
  // "Library Closed from 2pm" and stripping the "2pm" leaves the orphan tail
  // "Library Closed from". Same hazard for until/till/by/after/before/since/
  // past, plus "to"/"at" where stripping the time would orphan the preposition.
  t = t.replace(/(?<!\b(?:from|until|till|til|by|after|before|since|past|to|at)\b)\s+\d{1,2}(?::\d{2})?\s*(?:AM|PM)\s*$/i, "");
  // Strip trailing date/time annotations that East West Bookshop's Squarespace
  // export (and similar sources) appends to titles — examples:
  //   "Seated Sound Bath • Thurs. June 11th •"
  //   "Introduction To Crystal Singing Bowls - Friday - 5/29 •"
  //   "May Full Immersion Sound Bath Saturday, May 30th, | 6:30pm–8:00pm"
  // The trailing chunk can combine a bullet, dash, day-of-week, month+ordinal,
  // slash-date, or pipe+time-range. Iterate until no further pieces strip.
  {
    let prev;
    do {
      prev = t;
      t = t
        // "| 6:30pm–8:00pm"
        .replace(/\s*\|\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*$/i, "")
        // "- 5/29" (slash-date preceded by separator)
        .replace(/\s*[•\-–—]\s*\d{1,2}\/\d{1,2}\s*$/, "")
        // "June 11th" (month + day with optional ordinal/comma)
        .replace(/\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*$/i, "")
        // "Saturday," (day-of-week with trailing comma — date-context marker)
        .replace(/\s+(?:Sun(?:day)?|Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:rs(?:day)?)?|Fri(?:day)?|Sat(?:urday)?),\s*$/i, "")
        // "- Friday" or "• Thurs." (day-of-week preceded by separator)
        .replace(/\s+[•\-–—]\s+(?:Sun(?:day)?|Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:rs(?:day)?)?|Fri(?:day)?|Sat(?:urday)?)\.?,?\s*$/i, "")
        // Standalone trailing separator left after the above ("Foo •" → "Foo")
        .replace(/\s*[•\-–—]\s*$/, "")
        .trim();
    } while (t !== prev);
  }
  // Strip a trailing colon left by source subtitles. Stanford Localist
  // ("Public Tour | Cantor Highlights:") and Meetup ("Brunch Ethics at
  // Jack's:") emit titles whose trailing subtitle/label got truncated,
  // leaving a dangling colon — no event title legitimately ends in one.
  t = t.replace(/\s*:\s*$/, "");
  // Strip a trailing sentence period when the final token is a full word
  // (≥4 letters) and not a known abbreviation. Meetup hike titles arrive as
  // full sentences ("Friday Night Hike @ Rancho San Antonio in Cupertino.",
  // "Almaden Quicksilver Hike @ Mockingbird Hill Entrance."). The ≥4-letter
  // guard + abbreviation set keeps terminal-period abbreviations intact:
  // "Damon Wayans Jr." (Jr = 2 letters), "W.A.S.P." (final run is 1 letter),
  // "Disney's The Lion King Jr.", and "...Bros."
  {
    const TITLE_ABBR = new Set(["Blvd", "Corp", "Dept", "Univ", "Assn", "Bros", "Mtns"]);
    t = t.replace(/\b([A-Za-z]{4,})\.\s*$/, (m, word) => (TITLE_ABBR.has(word) ? m : word));
  }
  // Restore missing apostrophes in possessives. Ticketmaster ships college
  // sports titles as "Stanford Cardinal Womens Volleyball vs. Marquette Golden
  // Eagles Womens Volleyball"; DESC_TYPO_FIXES only runs on body copy, so the
  // shared list is applied here too. Case of the match's first letter is kept.
  for (const [pat, fix] of POSSESSIVE_FIXES) {
    t = t.replace(pat, (m) =>
      m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase()
        ? fix.charAt(0).toUpperCase() + fix.slice(1)
        : fix,
    );
  }
  // Strip orphaned CJK/fullwidth punctuation. Some Meetup feeds (e.g. JTPA's
  // Japanese-language events) arrive with the Japanese title text lost upstream,
  // leaving only the structural punctuation behind — "JTPA ー 「 ー ： ー 」" —
  // which renders as meaningless glyph noise on cards. When a title carries CJK
  // brackets, the prolonged-sound mark (ー), or fullwidth punctuation but holds
  // ZERO CJK letters (kana/kanji/hangul) to anchor them, the punctuation is
  // orphaned junk; strip it. Titles with real CJK text are left untouched, so
  // legitimate Japanese/Chinese/Korean event names keep their punctuation. This
  // was a recurring manual copy-edit (the garble regenerated nightly) — handled
  // upstream now.
  {
    const hasCjkLetter = /[぀-ゟァ-ヺヿ㐀-䶿一-鿿豈-﫿가-힣ｦ-ﾝ]/.test(t);
    const CJK_PUNCT = /[　-〿・ー！-／：-＠［-｀｛-･]/;
    if (!hasCjkLetter && CJK_PUNCT.test(t)) {
      t = t.replace(/[　-〿・ー！-／：-＠［-｀｛-･]/g, " ").replace(/\s{2,}/g, " ").trim();
    }
  }
  // Apply known recurring fixes from source data
  for (const [bad, fix] of Object.entries(TITLE_FIXES)) {
    t = t.replaceAll(bad, fix);
  }
  return cleanDisplayName(t);
}

function truncate(text, len = 200) {
  if (!text || text.length <= len) return text || "";
  return text.substring(0, len).replace(/\s+\S*$/, "") + "…";
}

// CivicPlus RSS descriptions often pack structured metadata into the body, e.g.
// "Event date: May 3, 2026 Event Time: 12:30 PM - 11:59 PM Location: 1 W. Campbell Ave..."
// Pull out the actual description (anything after "Description:") and drop the rest.
function stripCivicPlusMetadata(text) {
  if (!text) return "";
  const descMatch = text.match(/\bDescription:\s*(.+)$/is);
  if (descMatch) return descMatch[1].trim();
  if (/^\s*Event date:/i.test(text)) return "";
  return text;
}

// Strip bare URLs and common scraper artifacts from description text.
// CivicPlus iCal and some RSS feeds append calendar URLs and UI text to descriptions.
function stripBareUrls(text) {
  return text
    .replace(/https?:\/\/\S+/g, "")
    // Protocol-relative or hostless URL fragments. The Los Altos History Museum
    // iCal feed embeds DonorPerfect donate links as `//interland3.donorperfect.net/…`
    // which survive the http(s) strip and leave a meaningless fragment in
    // description. Anchor on `//host/` shape to avoid touching `//` inside prose.
    .replace(/(?:^|\s)\/\/[a-z0-9.-]+\.[a-z]{2,}\/\S*/gi, "")
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
  // Newsletter/notification call-to-action lines. Cupertino's "Monthly Chat
  // with Mayor Moore" scrape trails the real description with a mashed-up UI
  // block — "Sign up to receive notifications about upcoming meetings: e
  // Notification Sign-Up Dates and Locations [venue] [address] View Map" —
  // which arrives as the final no-terminator fragment and survives every other
  // filter. The CTA verb phrase is never substantive event prose, so dropping
  // any fragment that carries it strips the whole tail cleanly.
  /\bsign up to receive (notifications?|updates?|emails?|alerts?|reminders?)\b/i,
  // Truncation artifact: SJ Improv Ticketmaster `info` field opens with a
  // ticket-delivery-delay preamble that DOES NOT match `^do not`, so the raw
  // looksLikeVenuePolicy gate accepts it. truncate(text,200) then cuts inside
  // the next "DO NOT PURCHASE TICKETS..." sentence and leaves "DO NOT…" alone.
  // The earlier sentences in this list catch the delivery-delay prefix; this
  // catches the short trailing remnant so descriptions clear to "" and the
  // blurb (from event-blurb-cache) takes over on the card.
  /^\s*do\s+not\b.*…\s*$/i,
];

/**
 * Polish description text for display:
 * - downcase ALL-CAPS shouting (4+ word runs)
 * - drop promotional/boilerplate sentences
 * - capitalize sentence-start words ("free performance" → "Free performance")
 * - tidy whitespace
 */
// Missing-apostrophe possessives that appear in BOTH titles and body copy, so
// cleanTitle and polishDescription can share one list. Ticketmaster is the main
// offender ("Stanford Cardinal Womens Volleyball vs. Marquette ... Womens
// Volleyball"); titles never reach DESC_TYPO_FIXES, so cleanTitle applies these
// itself.
const POSSESSIVE_FIXES = [
  [/\bwomens\b/gi, "women's"],
  [/\bmens\b/gi, "men's"],
  [/\bchildrens\b/gi, "children's"],
  // NOTE: "Veterans Day" / "Veterans Memorial" take no apostrophe by convention —
  // deliberately not listed here.
];

// Common scraper-introduced typos. Replacement preserves the original case of
// the matched word (lowercase → lowercase, Capitalized → Capitalized).
const DESC_TYPO_FIXES = [
  [/\bpreformance(s?)\b/gi, "performance"],
  [/\battendence\b/gi, "attendance"],
  [/\boccured\b/gi, "occurred"],
  [/\brecieve\b/gi, "receive"],
  [/\bsepearate\b/gi, "separate"],
  // Missing-apostrophe possessives. Source feeds (CHM, a few BiblioCommons
  // events) drop the apostrophe in body copy; the trailing 's' replacement
  // hook in polishDescription preserves it.
  [/\btodays\b/gi, "today's"],
  [/\btomorrows\b/gi, "tomorrow's"],
  [/\byesterdays\b/gi, "yesterday's"],
  // Ticketmaster sports titles/bodies ship "Womens Volleyball", "Mens Basketball".
  // Same list cleanTitle applies, so titles and bodies agree.
  ...POSSESSIVE_FIXES,
  // Missing-apostrophe contractions. Only forms with no valid apostrophe-less
  // English word are listed — "lets" (he lets us) and "wont" (wont to wander)
  // are deliberately excluded, as is "cant" (cant = jargon/slang noun).
  [/\bdont\b/gi, "don't"],
  [/\bdoesnt\b/gi, "doesn't"],
  [/\bdidnt\b/gi, "didn't"],
  [/\bisnt\b/gi, "isn't"],
  [/\barent\b/gi, "aren't"],
  [/\bwasnt\b/gi, "wasn't"],
  [/\bwerent\b/gi, "weren't"],
  [/\bhavent\b/gi, "haven't"],
  [/\bhasnt\b/gi, "hasn't"],
  [/\bcouldnt\b/gi, "couldn't"],
  [/\bwouldnt\b/gi, "wouldn't"],
  [/\bshouldnt\b/gi, "shouldn't"],
  [/\byoure\b/gi, "you're"],
  [/\btheyre\b/gi, "they're"],
  // Ticketmaster drag listings spell the show "Ru Pauls Drag Race". The
  // camel-case splitter downstream re-breaks the intercap, so it is closed back
  // up alongside the other single-word brand marks (see "Ru Paul" below).
  [/\bru\s?paul'?s\b/gi, "RuPaul's"],
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
// Case-insensitive: the all-caps downcaser on line ~709 will rewrite
// "PMABBR" → "Pmabbr" before restore runs, so both forms must match.
const ABBR_RESTORE_PAIRS = [
  [/PMABBR/gi, "p.m."],
  [/AMABBR/gi, "a.m."],
  [/EGABBR/gi, "e.g."],
  [/IEABBR/gi, "i.e."],
  [/ETCABBR/gi, "etc."],
];

// Private-Use placeholder for periods that must survive the sentence splitter:
// decimal numbers ("1.5-hour"), URLs ("sccld.org/accessibility"), and email/
// website hostnames ("@svlg.org"). Without masking, the splitter chops these
// at the dot, the join+capitalize step then produces "1. 5-hour", "sccld. Org",
// "svlg. Org" — visible regressions in event descriptions.
const DOT_PLACEHOLDER = "";
const KNOWN_TLDS = "org|com|net|edu|gov|io|co|app|ai|info|biz|us|tv|aspx|html|htm|php|pdf";

function maskDomainAndDecimalDots(text) {
  let t = text;
  // Decimals: "1.5", "24.3", "$1.5M"
  t = t.replace(/(\d)\.(\d)/g, `$1${DOT_PLACEHOLDER}$2`);
  // Hostnames ending in a known TLD ("sccld.org", "svlg.org", "TICKETWEB.COM").
  // Case-insensitive so SHOUTY-CASE source text ("TICKETWEB.COM Ticket Resale")
  // gets masked the same as the polite form. Without `i` the dot survives,
  // sentence-splitter chops at the period, and the leftover ".COM Ticket Resale"
  // fragment leaks through boilerplate filters into the visible description.
  // Multi-pass so multi-segment hosts ("interland3.donorperfect.net") get every dot.
  const tldRe = new RegExp(
    `\\b([A-Za-z][\\w-]*)\\.(${KNOWN_TLDS})\\b`,
    "gi",
  );
  let prev;
  do {
    prev = t;
    t = t.replace(tldRe, `$1${DOT_PLACEHOLDER}$2`);
    // Promote a preceding "<word>." into the placeholder run so the next pass
    // can see it as part of the same hostname.
    t = t.replace(
      new RegExp(`\\b([A-Za-z][\\w-]*)\\.([A-Za-z][\\w-]*${DOT_PLACEHOLDER})`, "g"),
      `$1${DOT_PLACEHOLDER}$2`,
    );
  } while (t !== prev);
  return t;
}

function restoreDomainAndDecimalDots(text) {
  return text.replace(new RegExp(DOT_PLACEHOLDER, "g"), ".");
}

function polishDescription(text) {
  if (!text) return "";
  let t = text;

  // Drop boilerplate "About this Event:" / "Text from presenter:" prefixes that
  // BiblioCommons feeds emit at the head of some descriptions. The content
  // immediately following is the real description; the label adds no info.
  t = t.replace(
    /^(?:About this Event|Text from presenter|Event Description|Event Details?|Description)\s*:\s*/i,
    "",
  );

  // Straighten curly quotes. Source HTML and BiblioCommons feeds serve smart
  // quotes (U+2018/19/1A/1B for singles, U+201C/1D/1E/1F for doubles); the
  // recurring copy-edit commits straightening these are the visible symptom.
  t = t.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');

  // Strip trademark/copyright/service-mark glyphs from body copy — parity with
  // cleanTitle (which strips them from titles) and the venue-name cleaner.
  // Feeds emit "LEGO® fans unite" and "Cake Picnic™phenomenon"; the glyph is
  // visual noise. When it sits wedged between two word characters with no
  // space (the Cake Picnic™phenomenon case) replace it with a space so the
  // words don't fuse — otherwise just drop it. A later \s{2,} collapse tidies
  // any double space left behind ("LEGO® " → "LEGO  " → "LEGO ").
  t = t.replace(/([A-Za-z0-9])[®©™℠℗](?=[A-Za-z0-9])/g, "$1 ").replace(/[®©™℠℗]/g, "");

  // Ticketmaster `info` fields sometimes open with asterisk-wrapped show
  // annotations: `*21+..... Doors/show start time 8:00pm*`. The block contains
  // no `.!?` outside the dot-runs and is fused to the following real content
  // with no whitespace, so the sentence splitter pulls the whole annotation +
  // first real sentence into a single chunk that no BOILERPLATE_SENTENCE_PATTERN
  // matches — the preamble leaks into description search/city-page text.
  // Strip only blocks containing an age tag (`\d+\+`) or `Doors/show start`,
  // so legitimate `*emphasis*` formatting is preserved.
  t = t.replace(
    /\s*\*\s*[^*]*?(?:\d+\+|Doors\/show\s+start)[^*]*?\*\s*/gi,
    " ",
  );

  // Strip stray space before terminal punctuation ("Birds !", "Social ,",
  // "Passage ;"). Source feeds wrap and re-flow text leaving these. Restricted
  // to , ; . ! ? — colons can be valid styled separators ("Topic : Talk").
  t = t.replace(/\s+([,.;!?])/g, "$1");

  // Insert a missing space AFTER a colon wedged between two letters
  // ("Cohousing:Intentional Neighborhoods" → "Cohousing: Intentional ...").
  // Mirror of cleanTitle's colon fix — Meetup group names and feed bodies drop
  // the space in "Title:Subtitle". Letter-only on both sides so clock times
  // (1:00), ratios (2:1), and URLs (https://) stay untouched. This was a
  // recurring manual copy-edit in the event JSON that got wiped on every
  // regen — handle it upstream so it sticks.
  t = t.replace(/([A-Za-z]):([A-Za-z])/g, "$1: $2");

  // Tighten the `. "` artifact at end-of-string — Kepler's and SCU description
  // bodies emit a stray space between a clause-terminating period and the
  // closing quote of a tail quoted phrase (`...as an "urgent manifesto. "`).
  // Run before sentence-splitting so the closing quote pairs with the period
  // and the trailing-fragment-drop step below doesn't strip it as a lone quote.
  t = t.replace(/\.\s+"\s*$/, '."');

  // Collapse repeated terminal punctuation in body copy ("Be a Mini Maker!!!!"
  // from a SJPL BiblioCommons description). Mirror of cleanTitle's collapse so
  // titles and bodies normalize the same way.
  t = t.replace(/!{2,}/g, "!").replace(/\?{2,}/g, "?");

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

  // Recover from prior-regen artifacts where p.m./a.m. was already split into
  // "p. M." (capital M, space after period). The mask below only matches the
  // intact "p.m." form, so without this step the broken text passes through
  // unchanged. Case-sensitive: only the uppercase-M regression is targeted.
  t = t.replace(/(\d)\s*([pa])\. M\./g, "$1 $2.m.");
  t = t.replace(/(\d)\s*([pa])\. M,/g, "$1 $2.m.,");
  t = t.replace(/(\s)([pa])\. M\./g, "$1$2.m.");
  t = t.replace(/(\s)([pa])\. M,/g, "$1$2.m.,");

  // Source-side title-cased acronyms in body text (BiblioCommons title-cases
  // some acronyms in descriptions, not just titles).
  t = t.replace(/\bAanhpi\b/g, "AANHPI");
  t = t.replace(/\bFopal\b/g, "FOPAL");

  // Mask abbreviations so their internal periods don't trip the sentence splitter.
  for (const [pat, sub] of ABBR_MASK_PAIRS) t = t.replace(pat, sub);

  // Mask domain hostnames ("sccld.org", "interland3.donorperfect.net") and
  // decimals ("1.5-hour", "24.3%") so their dots survive sentence-splitting.
  t = maskDomainAndDecimalDots(t);

  // Downcase ALL-CAPS runs of 4+ uppercase letters (preserve common acronyms).
  // Same logic as cleanTitle but applied to body text.
  const KEEP_UPPER = new Set([
    "ICYMI", "LGBTQ", "LGBTQIA", "BIPOC", "STEAM", "LEGO",
    "SJSU", "SJPL", "SJPD", "SJFD", "FIFA", "UEFA", "ESPN", "STEM", "AAPI", "ACLU",
    "NASA", "IEEE", "YMCA", "YWCA", "ROTC", "FEMA", "NOAA", "WWII", "UCLA",
    "AAVE", "ADHD", "PTSD",
    // South Bay / arts venues
    "SJMA", "MACLA", "SJZ", "SVLG", "SJDA", "SCCC", "MOFAD", "SVCF", "VTAA", "VTAS",
    "SJMADE", "SCCFD", "SCVMC", "PACL", "SJDT", "LGPNS",
    // School districts (mostly title-only, but BiblioCommons body copy
    // occasionally name-drops them — keep parity with cleanTitle's list).
    "PAUSD", "SJUSD", "FUHSD", "MVWSD",
    // Misc
    "USPS", "USPTO", "WIPO", "USDA", "FBI", "CIA", "NSA", "EPA", "FDA",
    "MIT", "UCSF", "UCSC", "UCLA", "UCSD", "UCSB", "UCD",
    "AAPI", "AAJA", "NAHJ", "NABJ", "GLAAD", "ACLU",
    "AARP", "NAACP", "NAMI", "SCORE",
    // Sports leagues / clubs that appear in body copy. 4-letter members of the
    // same set added to cleanTitle's KEEP_UPPER — body text only runs the 4+
    // rule so 3-letter PGA/CSU don't need entries here.
    "LAFC", "NWSL", "WNBA", "LPGA", "NCAA",
    // Medical / academic acronyms (4+ letters only at this body-level rule).
    "AIDS", "RDMS",
    // Heritage-month and library-system acronyms that appear in BiblioCommons
    // (SCCL) and Localist (SJSU) description copy. Without them the 4+ rule
    // downcases "AANHPI Heritage Month" → "Aanhpi" and the SJSU library's
    // "Africana, Asian American, Chicano, Native American (AAACNA) Studies
    // Center" → "(Aaacna)".
    "AANHPI", "AAACNA",
    // Library/program acronyms that may appear in body copy alongside their
    // title parentheticals. Mirrored from cleanTitle's KEEP_UPPER so body
    // text doesn't drift out of sync with the title.
    "TLAB", "HICAP",
    // Japanese American Citizens League — mirrored from cleanTitle's KEEP_UPPER.
    "JACL",
    // "Bring Your Own Book" book club acronym — SJPL ships it in titles like
    // "BYOB (Bring Your Own Book) Book Club". 4 letters, survives the 4+ pass,
    // but the 2+ second pass downcases it once the surrounding title (with the
    // long parenthetical) tips into mixed case.
    "BYOB",
    // Mirrored from cleanTitle's KEEP_UPPER — SHRM-CP / SHRM-SCP body copy in
    // SJSU's HR-prep listings, HTML/JSON in BiblioCommons computer-help
    // descriptions, DCBC in Kepler's Deep Cuts Book Club series text.
    "SHRM", "HTML", "JSON", "DCBC",
    // Mirrored from cleanTitle's KEEP_UPPER (4-letter only — the body rule below
    // runs the 4+ pass): NUMU = New Museum Los Gatos, SBDC = Small Business
    // Development Center, ACGA = Assoc. of Clay & Glass Artists of CA. The
    // shorter siblings (CMT/BMR/CRC/ASL/UX/UXR) are never matched by the 4+ rule.
    "NUMU", "SBDC", "ACGA",
  ]);
  t = t.replace(/\b[A-Z]{4,}\b/g, (w) => KEEP_UPPER.has(w) ? w : w[0] + w.slice(1).toLowerCase());
  // Contraction recovery: mirror of the cleanTitle apostrophe-S fix. When the
  // 4+ rule downcases an ALL-CAPS run (PHOEBE BERMAN → Phoebe Berman) but the
  // trailing 'S sits past the apostrophe word boundary, it stays uppercase
  // ("Phoebe Berman'S Gonna Lose IT" from Kepler's Brooke Averick description).
  // Downcase any uppercase letters that sit after a Titlecased word + apostrophe
  // and end at a word boundary. Same conservative shape as cleanTitle —
  // requires the leading run to have lowercase so "JFK'S" / "FBI'S" stay intact.
  t = t.replace(/([A-Z][a-z]+)'([A-Z]+)\b/g, (_, w, suffix) => w + "'" + suffix.toLowerCase());

  // Insert space between concatenated words ("NIGHTSat" → "NIGHTS at", "USAMex" → "USA Mex")
  // — split all-caps run before a Cap+lowercase WORD prefix. Requires 2+
  // trailing lowercase letters so pluralized acronyms ("DVDs", "CDs", "URLs")
  // stay intact instead of becoming "DV Ds".
  t = t.replace(/([A-Z]{2,})([A-Z][a-z]{2,})/g, "$1 $2");
  // — split lowercase + uppercase boundary ("nightSat" → "night Sat").
  t = t.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Normalize 1-2 letter all-caps fragments left over from prior step ("EN" preserved if before all-caps)
  // Only rewrites words wedged between mixed-case neighbors — keeps "EN" in "Rock EN Espanol" lowercased.
  // KEEP_UPPER_SHORT protects 3-letter acronyms ("The ESL Conversation Club")
  // which the wedge rule would otherwise downcase to "The Esl Conversation Club".
  const KEEP_UPPER_SHORT = new Set([
    "ESL", "ELL", "BBQ", "CEO", "CFO", "CTO", "CPR", "AED", "API", "DIY",
    "FBI", "GED", "ICU", "IRS", "LED", "MLB", "MLS", "NBA", "NFL", "NHL",
    "PAC", "POV", "PSA", "SAT", "SAP", "SCU", "SJZ", "SUV", "TBA", "TBD",
    "USA", "USB", "VPN", "VHS", "FAQ", "JFK", "MLK", "FDA", "CDC", "ICE",
    "TSA", "EPA", "DOJ", "DUI", "PTA", "PTO", "HOA", "VFW", "BTS", "EDM",
    "RNB", "NPR", "PBS", "PGA", "CSU", "HIV", "MFA", "BFA", "MBA", "RVT",
    "CNM", "UFC", "MMA", "WWE", "AEW",
    // Mirrored from cleanTitle KEEP_UPPER — 3-letter institutional designations
    // that can appear inside body copy and would be downcased by the wedge rule
    // if surrounded by mixed-case neighbors ("Catholic JST programs offer…").
    "HSI", "JST",
    // Football-club designation: SJSU's CSU-alumni-night mailer for Bay FC
    // wrote "be a part of the Bay FC Legacy" in body copy. The wedge rule
    // matched "Bay " + FC + " Legacy" and downcased FC → "Fc" because the
    // 2-letter club designation wasn't mirrored from cleanTitle's KEEP_UPPER.
    // FC is unambiguously a football-club abbreviation in English body copy.
    "FC",
  ]);
  t = t.replace(/(?<=[A-Z][a-z]+ )([A-Z]{2,3})(?= [A-Z][a-z])/g, (w) => KEEP_UPPER_SHORT.has(w) ? w : w[0] + w.slice(1).toLowerCase());
  // Reunite known compound brand names broken by the lowercase+uppercase splitter.
  // The split rule above turns "PayPal" → "Pay Pal"; restore them here so brand
  // copy ("Pay Pal Park") survives polishing intact.
  t = t.replace(/\bPay Pal\b/g, "PayPal");
  // Ticketmaster CrossFit Games + Sierra Nevada VIP lounge feeds leak the
  // sponsor "NetApp" and brand "CrossFit" as two-word splits ("Net App Celly
  // Lounge", "Cross Fit Games"). Both are single-word brand marks.
  t = t.replace(/\bNet App\b/g, "NetApp");
  t = t.replace(/\bCross Fit\b/g, "CrossFit");
  // Los Gatos Music in the Park performer The BentPeter Band uses a closed-up
  // stage name; the generic camel-case splitter must not rewrite that proper noun.
  t = t.replace(/\bBent Peter\b/g, "BentPeter");
  // Ticketmaster drag listings reference "Ru Pauls Drag Race"; DESC_TYPO_FIXES
  // restores the possessive as "RuPaul's", which the splitter above then breaks
  // into "Ru Paul's". Close it back up to the official one-word stage name.
  t = t.replace(/\bRu Paul(?='s\b)/g, "RuPaul");
  // CHM body copy name-drops Steve Jobs's post-Apple venture "NeXT" — the
  // lowercase+uppercase splitter turns it into "Ne XT". Single-word brand mark
  // (1985 founding through 1996 Apple acquisition).
  t = t.replace(/\bNe XT\b/g, "NeXT");
  // Japanese American Museum of San Jose styles itself "JAMsj" in its own
  // newsletters and on jamsj.org; the splitter rule above turns "JAMsj" into
  // "JA Msj" because the ([A-Z]{2,})([A-Z][a-z]{2,}) shape matches JA + Msj.
  // Same family of fix as PayPal/NetApp/CrossFit/NeXT — single-word brand mark
  // that the camel-splitter pulls apart.
  t = t.replace(/\bJA Msj\b/g, "JAMsj");
  // Consumer-tech brand marks the camel-splitter pulls apart: SJPL computer-help
  // listings write "PowerPoint", Palo Alto library uses "YouTube", inbound
  // ICS feeds drop "iPhone" — all become "Power Point" / "You Tube" / "i Phone"
  // after the [a-z][A-Z] splitter. Reunite them so brand copy reads correctly.
  t = t.replace(/\bPower Point\b/g, "PowerPoint");
  t = t.replace(/\bYou Tube\b/g, "YouTube");
  // iPhone is tricky — lowercase "i" is rare as a word, but "I Phone" at a
  // sentence start would be a real two-word phrase. Only reunite the lowercase
  // form ("i Phone") since that's the only camel-split shape that produces it.
  t = t.replace(/\bi Phones?\b/g, (m) => m.endsWith("s") ? "iPhones" : "iPhone");
  // SJPL library tech-help listings write "WiFi" (no hyphen) — the camel
  // splitter turns it into "Wi Fi". The brand is officially Wi-Fi (Wi-Fi
  // Alliance trademark), so reunite to the hyphenated canonical form rather
  // than the closed-up WiFi the source used.
  t = t.replace(/\bWi Fi\b/g, "Wi-Fi");
  // Back to the Future the Musical body copy ("When Marty McFly finds himself
  // transported back to 1955…") becomes "Marty Mc Fly" after the camel
  // splitter hits the c→F boundary. McFly is a single-word surname brand mark
  // (the character + the UK band of the same spelling).
  t = t.replace(/\bMc Fly\b/g, "McFly");
  // "NorCal" (Northern California, as in NorCal Academy of Performing Arts) is a
  // closed-up single token; the lowercase+uppercase splitter pulls it into
  // "Nor Cal". Capital-N "Nor Cal" only ever comes from that split — a genuine
  // "neither … nor Cal" conjunction would be lowercase "nor" — so reuniting is
  // safe. Same family as PayPal/NetApp/CrossFit/NeXT/McFly.
  t = t.replace(/\bNor Cal\b/g, "NorCal");

  // Split into sentences and drop boilerplate. Capture trailing closers
  // (`"`, `'`, `)`, `]`) as part of the terminator group so a quoted clause
  // ending the sentence (`...as an "urgent manifesto for our tumultuous time."`)
  // doesn't split into `...time.` + lone `"`, which the drop-trailing-noise
  // step below would then strip as an unclosed-quote artifact.
  const sentences = t.match(/[^.!?]+[.!?]+["'’”)\]]*|[^.!?]+$/g) || [t];
  const kept = sentences.filter((s) => {
    const trimmed = s.trim();
    if (!trimmed) return false;
    return !BOILERPLATE_SENTENCE_PATTERNS.some((re) => re.test(trimmed));
  });

  // Drop a trailing no-terminator fragment when it follows a complete sentence
  // and signals truncation noise. Two recurring sources:
  // 1. CHM RSS teasers cut mid-sentence at a "[…] Read more" link; the boilerplate
  //    strip removes the link suffix but leaves the dangling pre-text behind
  //    (e.g. Steve Jobs in Exile: "...called NeXT. Though often described as his \"wilderness").
  // 2. BiblioCommons feeds concatenate accessibility-metadata section headers
  //    into description bodies without separators (e.g. SJPL Bingo:
  //    "...join us! ADA Accommodation Requests").
  // Conservative — only fires when there's a prior terminated sentence AND the
  // dangling fragment carries a clear noise signal (unclosed quote or known
  // metadata label). Short legit fragments ending mid-phrase are preserved.
  if (kept.length > 1) {
    const last = kept[kept.length - 1].trim();
    const prev = kept[kept.length - 2].trim();
    if (!/[.!?…]$/.test(last) && /[.!?…]$/.test(prev)) {
      const openQuotes = (last.match(/"/g) || []).length;
      const hasUnclosedQuote = openQuotes % 2 === 1;
      const isMetadataLabel = /^(ADA Accommodation Requests|Wheelchair Accessible|Reading Levels|Hearing Loop|Audio Description|Closed Captioning|Sign Language Interpretation|Sensory[\s-]?Friendly|Accessibility Features?|Special Accommodations?)\b/i.test(last);
      // Bare call-to-action verb left dangling when the scraper truncated the
      // CTA sentence mid-phrase (e.g. "...accompanied by an adult. Register"
      // from a cut "Register at the door"). The complete CTA forms are dropped
      // upstream by BOILERPLATE_SENTENCE_PATTERNS, but a lone trailing verb with
      // no object slips through. It's never substantive prose — drop it.
      const isCtaFragment = /^(Register|RSVP|Sign\s?up|Tickets?|Buy\s+tickets?|Get\s+tickets?|Learn\s+more|More\s+info|Read\s+more|Details)(\s+(now|here|online|today))?[.!]?$/i.test(last);
      if (hasUnclosedQuote || isMetadataLabel || isCtaFragment) kept.pop();
    }
  }

  t = kept.join(" ").replace(/\s+/g, " ").trim();

  // Capitalize first letter of each sentence
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());

  // Restore masked abbreviations (must run after capitalization so an "a.m."
  // at the start of a sentence isn't accidentally re-cased to "A.m.")
  for (const [pat, sub] of ABBR_RESTORE_PAIRS) t = t.replace(pat, sub);

  // Restore domain/decimal placeholder dots.
  t = restoreDomainAndDecimalDots(t);

  return cleanDisplayCopy(t);
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
  // Decode common HTML entities to their real glyph BEFORE the catch-all
  // entity stripper turns them into spaces. Without this, "Hobee&apos;s"
  // becomes "Hobee s" instead of "Hobee's".
  v = v
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&rsquo;|&lsquo;|&#8217;|&#8216;|&#x2019;|&#x2018;/gi, "'")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;|&#x201C;|&#x201D;/gi, '"')
    .replace(/&ndash;|&mdash;|&#8211;|&#8212;|&#x2013;|&#x2014;/gi, "-")
    .replace(/&amp;|&#38;/gi, "&");
  v = v.replace(/<[^>]+>/g, "").replace(/&[a-zA-Z]+;|&#\d+;/g, " ").replace(/\s+/g, " ").trim();
  // Remove leading "- " dash artifact from CivicPlus iCal
  v = v.replace(/^-\s+/, "");
  // Localist/athletics feeds prefix the city+state onto the venue field, e.g.
  // "Santa Clara, Calif., Stevens Stadium - Buck Shaw Field". Strip a leading
  // "<City>, Calif.," / "<City>, CA," block only when a real venue name follows
  // (the required comma after the state token protects names like "Palo Alto,
  // California Avenue Station"); a bare "Santa Clara, Calif." is left for the caller.
  v = v.replace(/^[A-Z][A-Za-z.'\- ]+,\s*(?:Calif\.?|California|CA)\.?,\s*(?=\S)/, "");
  // If the string is meeting directions ("Meet at...", "Check in at..."), not a venue name
  if (/^(meet|check\s+in)\s+(at|in)\s+/i.test(v)) return "";
  // Locational sentences slip into the venue field on some CivicPlus calendars,
  // e.g. Los Altos "Downtown Park Outreach" booths whose location reads
  // "Booth is located near State St & Third St." or "Booth located near the
  // front door of the community center". A real venue name never contains the
  // verb "located", so treat any such string as directions, not a place name,
  // and let the caller fall back to a civic venue guess or the city.
  if (/\blocated\s+(at|near|in|by|on|next|across|behind|inside|outside)\b/i.test(v)) return "";
  // Meetup organizers sometimes type a parking note into the venue-name field
  // ("Street Parking for Free", "Free Parking"). That's an instruction, not a
  // place name — return empty so the caller falls back to the group/source name.
  // Anchored to the whole string so legitimate "<Place> Parking Lot" venues
  // (e.g. "De Anza College Parking Lot A") are untouched.
  if (/^(?:free\s+|street\s+)*parking(?:\s+lot)?(?:\s+(?:is\s+)?(?:for\s+)?free)?$/i.test(v)) return "";
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
  v = v.replace(
    /[,\s]+\d+\s+[A-Z][a-zA-Z\.\s]*?\b(St|Ave|Avenue|Blvd|Boulevard|Rd|Road|Way|Ln|Lane|Dr|Drive|Ct|Court|Pl|Place|Hwy|Highway|Pkwy|Parkway|Cir|Circle|Ter|Terrace)\b\.?\s*(?:,?\s+(Campbell|Cupertino|Los Altos|Los Gatos|Milpitas|Mountain View|Palo Alto|San Jose|San José|Santa Clara|Saratoga|Sunnyvale))?\s*$/i,
    "",
  );
  // Some sources omit the street suffix after a numbered street:
  // "UC Student and Policy Center, 1115 11th" → "UC Student and Policy Center".
  v = v.replace(/,\s*\d+\s+\d+(?:st|nd|rd|th)?\s*$/i, "");
  // Same pattern but tolerant of a unit/building tail AFTER the street suffix:
  // "Koll Oakmead Park, 3350 Scott Blvd Building 54" → "Koll Oakmead Park".
  // Meetup organizers append a full street address (number + street + unit) into
  // the venue-name field; the address field already carries it, so strip from the
  // house number onward when a street-suffix token is followed by a unit keyword.
  v = v.replace(/[,\s]+\d+\s+[A-Z][a-zA-Z\.\s]*?\b(St|Ave|Avenue|Blvd|Boulevard|Rd|Road|Way|Ln|Lane|Dr|Drive|Ct|Court|Pl|Place|Hwy|Highway|Pkwy|Parkway|Cir|Circle|Ter|Terrace)\b\.?\s+(Building|Bldg|Suite|Ste|Unit|Floor|Fl|Room|Rm|Apt|#)\b.*$/i, "");
  // Strip trailing "<truncated dir>" e.g. "Los Altos History Museum, 51 So." or
  // "Civic Center Lawn 110 E." (truncated address) — comma OR space separated.
  v = v.replace(/[,\s]+\d+\s+(N|S|E|W|N\.|S\.|E\.|W\.|No|So|Ea|We)\.?\s*$/i, "");
  // Strip trailing bare number after a street/trail suffix: "Balzer Field and
  // LG Creek Trail 41" → "Balzer Field and LG Creek Trail". Happens when the
  // street/zip tail upstream got truncated, leaving an orphan house number.
  // Guarded by a street-suffix word so legitimate "Building 80" / "Room 317"
  // / "Hall 5" style venue names aren't chopped.
  v = v.replace(
    /\b(Trail|Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Way|Court|Ct|Place|Pl|Highway|Hwy|Parkway|Pkwy|Circle|Cir|Terrace|Ter)\.?\s+\d{1,5}\s*$/i,
    (_m, suffix) => suffix,
  );
  // Strip trailing " - " or lone dash at end
  v = v.replace(/\s*-\s*$/, "");
  // Strip " - <address>" suffix where address starts with a number, e.g.
  // "Council Chambers - 110 E. Main St" or just a partial street number
  // "Saratoga Senior Center - 19655" (CivicPlus often appends only the number).
  v = v.replace(/\s+-\s+\d+(\s+.*)?$/, "");
  // Strip a bare trailing state ", CA" (no zip) so the city-suffix strip below
  // can then remove the city. Handles Meetup's "Sanborn-Skyline County Park,
  // Saratoga, CA" → drop ", CA", then ", Saratoga" → "Sanborn-Skyline County
  // Park". A real venue name ending in a lone ", CA" token doesn't occur; it's
  // always the trailing state abbreviation.
  v = v.replace(/,\s*CA\s*$/i, "");
  // Strip trailing ", <SouthBayCity>" when no street/state/zip follows.
  // Example: "West Valley College, Saratoga" → "West Valley College".
  // The `city` field already carries this info; duplicating it in the venue
  // is redundant and reads awkwardly in the UI. Runs AFTER the dash-address
  // strip above because Saratoga's iCal often emits
  // "West Valley College, Saratoga - 14000 Fruitvale Ave..." — once the
  // address tail is removed the city suffix becomes the new tail.
  v = v.replace(
    /,\s+(Campbell|Cupertino|Los Altos|Los Gatos|Milpitas|Mountain View|Palo Alto|San Jose|San José|Santa Clara|Saratoga|Sunnyvale)\s*$/i,
    "",
  );
  // Meetup/Eventbrite organizers routinely lowercase the place-type word that
  // ends a venue name ("Martial Cottle park"). Uppercase it when the preceding
  // token is already capitalized, so the venue reads the way the place brands
  // itself. Scoped to a place-type whitelist in final position, so venues with
  // no trailing type word ("The Tech Interactive") are left alone.
  v = v.replace(
    /(?<=\b[A-Z][\w'’.&-]*\s)(park|library|center|centre|theatre|theater|museum|plaza|gardens?|stadium|ballpark|college|university|school|church|winery|brewery|taproom)$/,
    (w) => w[0].toUpperCase() + w.slice(1),
  );
  // Source-typo fixes (sources occasionally publish misspelled venue names)
  v = v.replace(/\bNursey\b/g, "Nursery");
  v = v.replace(/\bInfront\b/g, "In Front");
  // SJDA's WP feed occasionally drops the "&" between "Quilts" and "Textiles"
  // (likely a double-encoded entity that the entity-stripper turned into a space).
  v = v.replace(/Museum of Quilts\s+Textiles/g, "Museum of Quilts & Textiles");
  // Canonicalize SJSU's "Hammer Theater Center" feed and Ticketmaster's
  // identical variant. The venue's official name uses British "Theatre".
  v = v.replace(/\bHammer Theater Center\b/g, "Hammer Theatre Center");
  // ICA San José uses the accented form per icasanjose.org branding.
  v = v.replace(/\bICA San Jose\b/g, "ICA San José");
  // Truncated library name ("Dr. Martin Luther King" with no ", Jr. Library" tail).
  v = v.replace(/^Dr\.?\s+Martin\s+Luther\s+King\s*$/i, "Dr. Martin Luther King, Jr. Library");
  // SJSU's Localist feed emits the SJSU/SJPL joint library as
  // "Martin Luther King Junior Library" (no "Dr.", "Junior" spelled out).
  // Normalize to the canonical "Dr. Martin Luther King, Jr. Library".
  v = v.replace(/^(?:Dr\.?\s+)?Martin\s+Luther\s+King\s+(?:Jr\.?|Junior)\s+Library$/i, "Dr. Martin Luther King, Jr. Library");
  // Strip trademark/copyright/service-mark glyphs from venue names. Parity
  // with cleanTitle — Ticketmaster's feed often emits "Levi's® Stadium",
  // which then sits next to clean "Levi's Stadium" entries from other feeds
  // and creates duplicate-looking entries in venue lists.
  v = v.replace(/[®©™℠℗]/g, "").replace(/\s{2,}/g, " ").trim();
  // SJDA's WP feed publishes "Dr Funk" (no period) for the downtown SJ bar,
  // whose owner-branded name uses "Dr." with the period (dr-funk.com).
  // Normalize so the venue and any blurb generated from the venue field
  // ("Test your knowledge … at Dr. Funk") read naturally.
  v = v.replace(/^Dr\s+Funk\b/, "Dr. Funk");
  // If the entire string is just a raw address (starts with a number), return empty so caller can use fallback
  if (/^\d+\s/.test(v)) return "";
  // Organizer typed raw GPS coordinates into the venue-name field (e.g.
  // "37°19'05.5\"N 121°54'25.9\"W" or "37.318, -121.907"). Coordinates aren't a
  // display name — return empty so the caller falls back to the group/source name.
  if (/\d\s*°/.test(v) || /^[-+]?\d{1,3}\.\d{3,}\s*,\s*[-+]?\d{1,3}\.\d{3,}$/.test(v)) return "";
  // If the cleaning passes left only digits behind (e.g. "41" or "457" — typically
  // a CivicPlus location field that contained only an event ID or partial address),
  // return empty so the caller falls back to the source name.
  if (/^\d+$/.test(v)) return "";
  // If the cleaned value is just a South Bay city/state name with no actual venue,
  // return empty so the caller emits null rather than rendering "Campbell" as a venue.
  if (/^(Campbell|Cupertino|Los Altos|Los Gatos|Milpitas|Mountain View|Palo Alto|San Jose|San José|Santa Clara|Saratoga|Sunnyvale)(,?\s+CA)?$/i.test(v.trim())) return "";
  return cleanDisplayName(v);
}

/**
 * For civic calendar events whose iCal/RSS feed didn't include a LOCATION,
 * infer a sensible default venue from the title. Council/commission/board
 * meetings happen at council chambers; everything else stays null so the
 * caller can decide. Existing Los Gatos data already uses "Council Chambers"
 * for these — this matches that convention so backfill blends in cleanly.
 */
function inferCivicVenueFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (
    /\b(town council|city council|council meeting|council\s+study\s+session|study session|public hearing|zoning\s+administrator|planning commission|civic improvement commission|parks (?:and|&)\s+sustainability commission|parks (?:and|&)\s+recreation commission|arts commission|library commission|board meeting|city manager|special meeting)\b/.test(
      t,
    )
  ) {
    return "Council Chambers";
  }
  if (/\bcommission\b/.test(t) && /\b(meeting|hearing)\b/.test(t)) {
    return "Council Chambers";
  }
  return null;
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
  // Some callers pass raw RSS HTML descriptions. Strip tags/entities defensively
  // so anchor hrefs and class names ("...athletics-page", class="sports-tag")
  // can't trigger false-positive keyword matches in the rules below.
  const cleanDesc = stripHtml(desc || "");
  const t = `${title} ${cleanDesc} ${type} ${venue}`.toLowerCase();
  const titleLower = title.toLowerCase();
  // Bookstores host author talks and book launches — even when the description
  // mentions sports (e.g. a runner discussing a memoir), it's an arts/literary
  // event, not a sports event. Check before the sports/education rules below.
  const venueLower = venue.toLowerCase();
  const isBookstoreVenue = /\b(books?|bookshop|bookstore)\b/.test(venueLower);
  if (isBookstoreVenue) return "arts";
  // Title-anchored overrides for terms that source-supplied category tags
  // routinely override (e.g. SJDA tags SoFA Market trivia nights "Music"
  // because the venue is music-coded; tags Marriott live-music nights
  // "Family"; "Amphitheater" / "Theatre" venues otherwise route concerts to
  // arts). Trivia and live music are unambiguous when present in the title.
  if (/\btrivia\b/.test(titleLower)) return "community";
  if (/\blive\s+music\b/.test(titleLower)) return "music";
  // Title-anchored "concert" / "choir" / "symphony" / "orchestra" / "philharmonic"
  // wins over the arts rule below — venues like "Heritage Theatre" or "Hammer
  // Theatre Center" otherwise capture symphony/concert performances (Peninsula
  // Symphony, San Jose Wind Symphony, Brandi Carlile, hand bell choir) into arts
  // because of a "theater"/"theatre" / "performance" substring match in the
  // venue or description.
  if (/\bconcert\b/.test(titleLower) || /\bchoir\b/.test(titleLower) || /\bsymphony\b/.test(titleLower) || /\borchestra\b/.test(titleLower) || /\bphilharmonic\b/.test(titleLower)) return "music";
  // "baby" check: only match when it's not a proper name (e.g. "Baby Bash" the rapper)
  const hasBaby = /\bbaby\b/.test(t) && !/\bbaby\s+bash\b/i.test(t);
  if (t.includes("story time") || t.includes("storytime") || t.includes("toddler") || hasBaby || t.includes("preschool") || t.includes("kids") || t.includes("children") || /\bbedtime\b/.test(titleLower) || /\bpuppet\s+show\b/.test(t)) return "family";
  // Medical/clinical procedure courses are always education, never arts — even if descriptions
  // contain "performance" (as in "procedural performance") or the venue has "theater" (OR).
  const isMedicalProcedureEvent = /\b(bronchoscopy|endoscopy|radiology|biopsy|anesthesia|cone beam ct|cbct imaging|surgical technique|clinical training|colonoscopy|laparoscopy|bronchoscop)\b/.test(t);
  if (isMedicalProcedureEvent) return "education";
  // Startup pitch events hosted in campus theaters should be community, not arts.
  const isStartupPitch = /\b(pitch\s+jam|incubator\s+pitch|startup\s+pitch|pitch\s+competition|pitch\s+night|pitch\s+circuit)\b/.test(t);
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
  // Adult-education classes (ESL, literacy) and meditation/movement classes (Qi Gong,
  // Falun Dafa, Tai Chi) are routinely miscategorized as "arts" because their
  // descriptions mention boilerplate like a "Classical Arts Foundation" sponsor or
  // "language arts" framing. Anchor on the title and short-circuit before the arts
  // heuristic so a stray "art" in the description can't override the actual subject.
  if (/\b(esl|literacy|english\s+(class|conversation|tutoring))\b/i.test(titleLower)) return "education";
  if (/\b(qi\s*gong|qigong|falun\s+dafa|tai\s+chi)\b/i.test(titleLower)) return "community";
  // Meditation / mindfulness / yoga / pilates classes are community wellness, not arts —
  // anchor on title so a stray "Art of Living" sponsor name (a meditation org) can't
  // promote the event into the arts bucket via the isArtWord check below.
  if (/\b(meditation|mindfulness|yoga|pilates)\b/i.test(titleLower)) return "community";
  const isArtWord = /\barts?\b|\bartist|\bartwork|\bartistry/.test(t);
  if (t.includes("exhibit") || t.includes("gallery") || t.includes("theater") || t.includes("theatre") || t.includes("film") || t.includes("cinema") || t.includes("dance") || t.includes("performance") || t.includes("museum") || (isArtWord && !t.includes("martial art"))) return "arts";
  // Theater play descriptions — university/community theaters often title shows by the
  // play name alone ("Exit... Pursued by a Bear") with no overt arts keyword. Detect
  // the production-credit pattern in the description: "Directed by X", "Written and
  // directed by", "Playwright", "By [Author] Directed by [Director]", etc.
  if (/\bdirected\s+by\b/i.test(cleanDesc) || /\bplaywright\b/i.test(cleanDesc) || /\bplay\s+by\b/i.test(cleanDesc)) return "arts";
  // Book clubs and discussions are arts/reading events, not formal education
  if (/\bbook\s+(club|discussion|group)\b/.test(t)) return "arts";
  // Brunch / breakfast / dinner with optional ambient live music is primarily a food
  // event, not music. SJDA tags Mother's Day brunches at hotel restaurants as "Music"
  // because of background entertainment, but the title-anchored meal is the headline.
  // Skip if title is explicitly a music format (concert, recital, jazz brunch is fine
  // as music — "jazz" in title is enough to override).
  if (/\bbrunch\b/.test(titleLower) && !/\b(jazz|concert|recital|symphony|live\s+music)\b/.test(titleLower)) return "food";
  // Genre tour titles ("Usher & Chris Brown - The R&B Tour", hip-hop bills) come in
  // from the City Newsletter feed with no Ticketmaster classification to lean on,
  // so the bare "music" keyword check above misses them. R&B and hip-hop are
  // unambiguous music genre markers — anchor on word boundary so "rapture",
  // "hop" by itself, and stray ampersands don't false-positive.
  if (/\br\s*&\s*b\b|\bhip[-\s]?hop\b/i.test(t)) return "music";
  if (t.includes("concert") || t.includes("music") || t.includes("jazz") || t.includes("symphony") || t.includes("band") || t.includes("orchestra") || t.includes("choir")) return "music";
  if (t.includes("comedy") || t.includes("stand-up") || t.includes("standup") || t.includes("improv show") || t.includes("comedian")) return "arts";
  // Comedy-club venues (San Jose Improv, Rooster T. Feathers, etc.) host
  // stand-up almost exclusively — many tour titles are just a performer's
  // name ("Phil Medina", "Shawn Felipe") with no comedy keyword, which
  // otherwise falls through to the "community" default. The venue itself
  // is the unambiguous signal. Runs after the title-anchored music/family
  // checks above so a hypothetical music night wouldn't be miscategorized.
  if (/\b(improv|comedy\s+club|rooster\s+t)\b/.test(venueLower)) return "arts";
  // Nature / wildlife events — check BEFORE sports to avoid false positives.
  // Guard against swim-stroke names ("butterfly", "freestyle", etc.) that share
  // vocabulary with insect/bird watching but describe swimming clinics.
  // Also guard against library venues — wildlife presentations at libraries are
  // indoor educational talks, not outdoor activities.
  const isSwimContext = /\b(swim|stroke|freestyle|breaststroke|backstroke|aquatic)\b/.test(t);
  const isLibraryVenueEarly = /\b(library|libraries)\b/.test(venueLower);
  if (!isSwimContext && !isLibraryVenueEarly && /\b(wildlife|bird watching|birdwatching|birding|egret|heron|pelican|raptor|owl|hawk|falcon|butterfly|butterflies|monarchs?|pollinators?|dragonfly|wildflower|tide pool|tidepool|nature walk|nature tour)\b/.test(t)) return "outdoor";
  // Volunteering (farm, park, trail) is community, not sports — check before sports rules
  if (/\b(volunteer|volunteering)\b/.test(t) && /\b(farm|garden|trail|park|nature)\b/.test(t)) return "community";
  // Public road/trail races (5K, 10K, half marathon, marathon, triathlon, fun
  // runs) are participatory community events — entrants register, run, go home.
  // Spectator pro/college sports never use these distance/race tokens and come
  // from dedicated scrapers (PayPal Park, SAP Center, Excite Ballpark), so this
  // is safe to flip from sports → community without affecting league games.
  // Catches the recurring "Jolly 10K" miscategorization on the Town of Los
  // Gatos calendar that the previous (school-fundraiser-only) carve-out missed.
  if (/\b(5k|10k|half marathon|marathon|triathlon|fun run|road run|trail run|color run)\b/.test(t)) return "community";
  // Government/civic commission and committee meetings are always community events.
  // Must run BEFORE the sports check because "transportation" contains "sport" as substring.
  // Match either "<body> meeting/hearing/session" or a title that is purely a commission/
  // committee/board name (e.g. "Parks and Sustainability Commission") — city RSS feeds
  // often surface these as bare titles with no "meeting" suffix.
  if (/\b(commission|committee|council|board)\s+(meeting|hearing|session)\b/i.test(title) ||
      /\b(commission|committee|board)\s*$/i.test(title) ||
      /\b(city council|town council|planning commission|city manager|public works)\b/i.test(title)) return "community";
  // Public-input meetings (community meeting, town hall, listening session, survey
  // meeting) are civic gatherings even when the title names a sport — e.g. a
  // "Tennis & Pickleball Survey Community Meeting" is residents weighing in on
  // rec facilities, not an athletic event. Must run BEFORE the sports check, which
  // would otherwise catch the "tennis"/"pickleball" token.
  if (/\b(community meeting|public meeting|input meeting|town hall|listening session|survey (meeting|community))\b/i.test(title)) return "community";
  // Yoga, pilates, and wellness classes are community, not sports — check before sports block
  // (event type fields from sources like SJDA can include "Sports & Activities" even for yoga)
  if (/\b(yoga|pilates|meditation|mindfulness|tai chi)\b/.test(t)) return "community";
  // Recreational swim sessions (rec swim, lap swim, open swim, family swim, public swim)
  // are community/family wellness, not competitive sports. Anchor on the title so a
  // generic "swim" word in a description can still hit the sports check below.
  if (/\b(rec(?:reational)?\s+swim|lap\s+swim|open\s+swim|family\s+swim|public\s+swim|adult\s+swim)\b/i.test(titleLower)) {
    return /\b(family|kid|child|tot)\b/i.test(titleLower) ? "family" : "community";
  }
  // Robotics events are STEM education — competitions and demos use words like
  // "game", "match", "competition" that would otherwise hit the sports branch.
  if (/\brobotics?\b/.test(titleLower)) return "education";
  // Board games, card games, tabletop games and D&D are community, not sports
  const isBoardGame = /\b(board games?|card games?|tabletop|dungeons.{0,5}dragons|d&d|rpg club|wargame)\b/.test(t);
  // "Games, crafts, and activities" in library/family program descriptions is not sports.
  // Protects against events like "Fabulous Friday: games, crafts, activities" being misclassified.
  // Also: any event hosted at a library — libraries don't host athletic sports, so a stray
  // "games" / "play games" reference (teen lock-ins, board game nights, etc.) shouldn't
  // override the program type. Explicit sport names like "soccer"/"basketball" still trigger.
  const isLibraryVenue = /\b(library|libraries)\b/.test(venueLower);
  const isLibraryActivityGames = isLibraryVenue ||
    /\bgames[,;]?\s*(crafts?|activities|bubbles|more|food|prizes|drinks|raffles?)/i.test(t) ||
    /\b(crafts?|activities|food|prizes|drinks|raffles?)\s+(?:and\s+)?games\b/i.test(t) ||
    /\bgames\s+and\s+(activities|prizes|food|drinks|raffles?)\b/i.test(t) ||
    // BBQ/cookout/potluck/mixer/social title signals: "games" in the description
    // here describes lawn games (cornhole, ladder ball, trivia) at a networking
    // gathering, not athletic sports. Title-anchored to avoid matching legitimate
    // sports events that mention socializing in their description.
    /\b(bbq|barbecue|barbeque|cookout|potluck|mixer|reception|networking)\b/i.test(title) ||
    // "lawn games" anywhere (cornhole, ladder ball, giant Jenga) are casual
    // recreation at park pop-ups / community series, not athletic sports.
    /\blawn games?\b/i.test(t) ||
    // Culinary/tasting socials (e.g. the View Teen Center "AfterHours" series:
    // "sensory speed-round games", "mystery drink tastings", "food assembly")
    // describe party games at a food event, not athletics. Let these fall
    // through to the food check below.
    /\b(culinary|tasting|tastings|food\s+assembly)\b/i.test(t);
  // Carnivals (school carnivals, business carnivals, festival carnivals) are community
  // events — descriptions often mention "carnival games" which would otherwise hit the
  // sports branch via t.includes("game"). Music/arts carnivals (e.g. Mötley Crüe's
  // "Carnival of Sins", Saint-Saëns' "Carnival of the Animals") are caught by the
  // earlier music/arts checks and never reach this point.
  if (/\bcarnival\b/.test(titleLower)) return "community";
  // Picnics are community/social gatherings — descriptions mention "games"
  // (lawn games, raffles, activities) that would otherwise hit the sports branch.
  if (/\bpicnic\b/.test(titleLower)) return "community";
  // "vs." and "vs " as sports indicators should only be checked in the TITLE, not descriptions —
  // descriptions can use "vs." for technical comparisons ("DataFrames vs. Series").
  const titleHasVs = titleLower.includes("vs.") || titleLower.includes(" vs ");
  // For library venues, restrict the sports detector to the TITLE (not desc + type
  // + venue). Library events about gardening or insects pick up "sports" tags from
  // BiblioCommons type fields ("Activity / Sports") or descriptions that mention
  // physical activities incidentally, even when the actual program is a lecture.
  const sportsHaystack = isLibraryVenue ? titleLower : t;
  // Use word-boundary regex (not substring includes) for short sports tokens that
  // collide with common words/proper nouns: "game" → "Burlingame", "polo" →
  // "metropolitan", "track" → "soundtrack"/"racetrack", "crew" → "screw"/"crewneck".
  // "track" by itself is too idiomatic ("stay on track", "track record", "fast-track")
  // and was mis-routing SJSU's SHRM Test Prep description ("...stay on track with a…")
  // into the sports bucket. Require sports context — "track and field", "track meet",
  // "track team", or a track-modifier compound — before treating "track" as athletics.
  const isTrackSport = /\btrack\s+(?:and|&)\s+field\b|\btrack\s+(?:meet|event|race|season|team|coach|practice|tryouts?|workout|relay)\b|\b(?:relay|cinder|running|all[-\s]weather|spartan)\s+track\b/.test(sportsHaystack);
  if (!isBoardGame && (!isLibraryActivityGames && /\bgames?\b/.test(sportsHaystack) || /\bsports?\b/.test(sportsHaystack) || /\bathletics?\b/.test(sportsHaystack) || sportsHaystack.includes("golf") || sportsHaystack.includes("tennis") || sportsHaystack.includes("soccer") || sportsHaystack.includes("basketball") || sportsHaystack.includes("baseball") || sportsHaystack.includes("softball") || sportsHaystack.includes("volleyball") || /\bswim(s|ming|mer|mers)?\b/.test(sportsHaystack) || sportsHaystack.includes("swim meet") || sportsHaystack.includes("freestyle") || sportsHaystack.includes("breaststroke") || sportsHaystack.includes("backstroke") || isTrackSport || sportsHaystack.includes("cross country") || sportsHaystack.includes("lacrosse") || sportsHaystack.includes("football") || sportsHaystack.includes("gymnastics") || sportsHaystack.includes("wrestling") || sportsHaystack.includes("water polo") || /\bpolo\b/.test(sportsHaystack) || sportsHaystack.includes("hockey") || sportsHaystack.includes("rugby") || /\browing\b/.test(sportsHaystack) || /\bcrew\b/.test(sportsHaystack) || /\bdiving\b/.test(sportsHaystack) || sportsHaystack.includes("fencing") || sportsHaystack.includes("skiing") || sportsHaystack.includes("snowboard") || /\bcycling\b/.test(sportsHaystack) || sportsHaystack.includes("equestrian") || titleHasVs)) return "sports";
  // Government/civic events at markets are still community events
  if (/\b(office hours|mayor|city council|council member|supervisor)\b/.test(t) && t.includes("market")) return "community";
  // "craft" alone is too broad — "well-crafted resume", "refine your craft" → require craft market context
  const isCraftMarket = /\bcraft\s*(fair|market|show|sale|night|bazaar|booth|vendor)\b/.test(t);
  // "fair" alone is too broad — only match community/arts fairs, not job/health/resource/housing fairs
  const isFairEvent = /\b(craft|art|artisan|maker|vendor|street|holiday|county|state|flea|antique|swap|harvest|spring|summer|fall|winter) fair\b/.test(t);
  // Title-only market match: a venue or restaurant brand containing "Market" (e.g.
  // "San Pedro Square Market", "SoFA Market", "Hobee's Pancake Market") shouldn't
  // override the actual event type. Match real market activities only.
  const titleMarketActivity = /\b(farmers? market|swap meet|night market|street market|food market|art market|craft market|holiday market|flea market|antique market|maker market|vendor market|artisan market|public market|outdoor market|pop-?up market|christmas market|harvest market)\b/.test(titleLower);
  const titleEndsInMarketWord = /(?:^|\s)markets?\s*$/.test(titleLower); // "Muse Markets"
  const titleHasAtMarketVenue = /\bat\s+[\w'’ ]*\bmarkets?\b/i.test(titleLower); // "...at San Pedro Square Market"
  const titleHasBrandPossessiveMarket = /\b\w+(?:'|’)s\s+[\w ]*\bmarkets?\b/i.test(titleLower); // "Hobee's Pancake Market"
  const isMarketTitle = (titleMarketActivity || titleEndsInMarketWord) && !titleHasAtMarketVenue && !titleHasBrandPossessiveMarket;
  // A market/fair is an in-person gathering. Online/virtual talks ABOUT a fair
  // (e.g. "State Fair Crafts with Smithsonian Curator") are lectures, not markets —
  // skip the market bucket so they fall through to the education/arts checks below.
  const isOnlineEvent = /\b(online|virtual|webinar|zoom|livestream)\b/.test(venueLower);
  if (!isOnlineEvent && (isMarketTitle || isFairEvent || /\bvendor\b/.test(titleLower) || isCraftMarket)) return "market";
  // Workshops/classes/lectures in the TITLE are educational — check before outdoor to avoid false positives
  if (/\b(workshop|webinar|seminar|lecture|class|tutorial|training|course)\b/.test(titleLower)) return "education";
  // Indoor venues (libraries, aquatic centers, etc.) host gardening/nature talks and rec swims —
  // skip the outdoor branch so a venue keyword like "Central Park Library" or "Master Gardeners"
  // talk in a library doesn't get mis-tagged outdoor.
  const isIndoorVenue = /\b(library|libraries|aquatic|aquatics)\b/.test(venueLower);
  // Outdoor keywords come ONLY from title/desc/type, never the venue alone — names like
  // "PayPal Park" (soccer stadium), "History Park" (museum), or "Rose Garden Library"
  // contain "park"/"garden" but the events themselves aren't outdoor activities.
  // Use word-boundary anchors so substrings like "spark"/"sparking" don't trigger the
  // park rule (real bug: "Fandom Swap" desc with "sparking joy" got tagged outdoor).
  const outdoorHaystack = `${title} ${desc} ${type}`.toLowerCase();
  const hasOutdoorWord = /\b(hik\w*|outdoor\w*|garden\w*|nature|trail\w*|park\w*)\b/.test(outdoorHaystack);
  if (!isIndoorVenue && hasOutdoorWord) return "outdoor";
  if (t.includes("book") || t.includes("reading") || t.includes("lecture") || t.includes("workshop") || t.includes("class") || t.includes("learn") || t.includes("seminar") || t.includes("talk") || t.includes("discussion") || t.includes("curator") || t.includes("stem") || t.includes("science") || t.includes("coding") || t.includes("tech")) return "education";
  if (t.includes("food") || t.includes("cooking") || t.includes("taste") || t.includes("chef") || t.includes("wine") || t.includes("beer") || t.includes("culinary") || /\b(pancake|breakfast|brunch|bake sale|food truck|barbecue|bbq|bake-off|chili cook-off)\b/.test(t)) return "food";
  return "community";
}

function isOngoingExhibitLike(title, desc = "", venue = "") {
  const cleanDesc = stripHtml(desc || "");
  const haystack = `${title || ""} ${cleanDesc} ${venue || ""}`.toLowerCase();

  // These are recurring programs, talks, trainings, or services that Localist
  // can model as long-running series. They are not "on view" listings.
  if (/\b(yoga|pilates|meditation|mindfulness|workshop|training|class|course|rounds?|speaker series|lecture series|guest speaker|worship|service|volunteer|volunteering|al-anon|qualtrics|upstander|book club|storytime)\b/.test(haystack)) {
    return false;
  }

  return /\b(exhibit|exhibition|showcase|installation|on view|gallery|art\s+show|book display|map exhibit|sculpture walk|works by|mfa thesis|archive room|collection|artist|artwork|sculpture|painting|photography|printmaker|contemporary art|art and architecture)\b/.test(haystack);
}

function inferUniversityCategory(title, desc, type, venue = "") {
  const titleLower = String(title || "").toLowerCase();
  const cleanDesc = stripHtml(desc || "");
  const haystack = `${title || ""} ${cleanDesc} ${type || ""} ${venue || ""}`.toLowerCase();

  if (isOngoingExhibitLike(title, desc, venue)) return "arts";
  if (/\b(yoga|pilates|meditation|mindfulness|wellness|al-anon|worship|volunteer|volunteering)\b/.test(haystack)) return "community";
  if (/\b(guest speaker|speaker series|lecture|symposium|workshop|training|class|course|rounds?|seminar|qualtrics|research|science|book display|reading)\b/.test(haystack)) return "education";
  if (/\b(concert|carillon|recital|choir|orchestra|jazz|music)\b/.test(titleLower)) return "music";

  return inferCategory(title, cleanDesc, type, venue);
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
      livewhaleId: get("livewhale:id"),
      livewhaleCategories: get("livewhale:categories"),
      livewhaleTags: get("livewhale:tags"),
      georssPoint: get("georss:point"),
      georssFeatureName: get("georss:featurename"),
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
      // Capture the delimiter so we know whether the line uses parameter syntax
      // (`PROP;PARAM=value:value`) or plain (`PROP:value`). Without this split,
      // a DESCRIPTION body containing HTML with `class=` / `src=` before any
      // `https://` would trip the parameter-handler and the parser would chop
      // the description at the colon inside the URL — leaving leftover image-tag
      // attribute fragments (`width='200' height='200' />…`) in the body.
      const regex = new RegExp(`^${prop}([;:])(.*)`, "mi");
      const m = block.match(regex);
      if (!m) return "";
      const delim = m[1];
      let val = m[2];
      // Only re-parse for the colon that ends the parameter list when params
      // are actually present (delimiter was `;`).
      if (delim === ";") {
        const colonIdx = val.indexOf(":");
        if (colonIdx > 0) {
          val = val.substring(colonIdx + 1);
        }
      }
      return val.trim();
    };
    const summary = get("SUMMARY");
    const dtstart = get("DTSTART");
    const dtend = get("DTEND");
    const location = get("LOCATION");
    const description = get("DESCRIPTION");
    const categories = get("CATEGORIES");
    const url = get("URL");
    const uid = get("UID");

    if (!summary) continue;

    events.push({ summary, dtstart, dtend, location, description, categories, url, uid });
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
      const venue = cleanVenue(ev.location_name || "") || "Stanford University";
      const description = stripHtml(ev.description_text || ev.description || "");
      let eventDate = start;
      let isOngoing = false;
      if (start < now) {
        if (end && end >= now) {
          if (!isOngoingExhibitLike(ev.title, description, venue)) return null;
          eventDate = now; // currently running exhibit → anchor to today
          isOngoing = true; // show in Exhibits section, not Today
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
        venue,
        address: ev.address || "",
        city: "palo-alto",
        category: inferUniversityCategory(ev.title, description, "", venue),
        cost: (ev.free || /\balcoholics anonymous\b/i.test(ev.title)) ? "free" : "paid",
        description: truncate(description),
        url: ev.localist_url || `https://events.stanford.edu/event/${ev.id}`,
        source: "Stanford Events",
        kidFriendly: false,
      };
    }).filter(Boolean);
    console.log(`  ✅ Stanford: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Stanford: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

// Filter out student-internal events from university feeds.
// These are org meetings, advising sessions, career fairs for enrolled students, etc.
// Public-facing events (exhibits, performances, athletics, lectures) should pass through.
// `executive-education` covers Leavey School of Business paid short-courses
// for working professionals (e.g. "Corporate Governance for Executives") —
// these are multi-thousand-dollar enrollment-required programs, not public
// events. `osher` covers SCU's Osher Lifelong Learning Institute, a
// paid-membership program for adults 50+ whose listings ("Tech SIG",
// "Volunteer Luncheon Reception") are members-only.
const STUDENT_ONLY_URL_PATHS = /\/(school-of-law|career-center|global-engagement|registrar|financial-aid|residence-life|housing|student-life|orientation|commencement|human-resources|advancement-services|teaching-and-learning|campus-ministry|provost|governance|lead-scholars|executive-education|osher|accounting)\//i;
// `scuaa` = SCU Accounting Association (student club); `bva café` /
// `bronco ventures accelerator` = SCU's internal startup accelerator program
// (cohort-only events). Both leaked through cycle 146's broader SCU filter
// because the title patterns are unique to those internal programs.
// `alumni panel` is consistently a student career-prep event ("hear from
// alumni at Firm X") — surfaced via SCU Accounting Association feed.
const STUDENT_ONLY_TITLE = /\b(board meeting|drop-in advising|office hours|spartan safe|wellness and recovery meeting|register now on handshake|sample class|performance conversations?|spark60|beyond the major|improv@work|alumni panel)\b|^workshop\s*\||\bbucky['’]?s\s+closet\b|\bsanta\s+claran\b|\bscuaa\b|\bbva\s+caf(?:é|e)(?=\b|$|\s)|\bbronco\s+ventures\s+accelerator\b/i;
const STUDENT_ONLY_DESC = /\b(for international students|requesting classroom|register now on handshake|brown bag|forge garden)\b/i;
// SCU brands students/alumni as "Broncos". Marketing language addressed to
// "Broncos" (Free to all Broncos! / Bronco community / MBA students and alumni
// — join…) reliably signals a campus-internal event even when the title looks
// generic. Conservative phrases only — bare "Broncos" appears in public sports
// coverage too.
const SCU_INTERNAL_DESC = /\b(?:free|open)\s+to\s+(?:all\s+)?broncos\b|\bbronco\s+(?:community|family)\b|\b(?:mba|ms|phd|undergraduate|graduate)\s+(?:and\s+\w+\s+)?students?\s+and\s+alumni\b/i;
// Audience gating: a university-feed event explicitly addressed to "students"
// (or limited to them) is campus-internal, not for the general public —
// e.g. "Free Chair Massages for Students" / "during finals week, students only".
// Only applied to the SJSU + SCU feeds (see isStudentOnlyEvent callers), so
// "for students" here is a reliable internal signal; a public lecture or
// performance won't address its audience as "students". Matched against both
// title and description. Deliberately NOT triggered by a bare "student"
// (e.g. "student art exhibition open to the public" stays).
const STUDENT_ONLY_AUDIENCE = /\b(?:students?[\s-]only|for\s+(?:scu\s+|sjsu\s+|spartan\s+|bronco\s+|current\s+|currently[\s-]enrolled\s+|enrolled\s+|all\s+|our\s+|fellow\s+)?students\b|open\s+to\s+(?:all\s+)?students\b|currently\s+enrolled|valid\s+student\s+id|with\s+(?:a\s+)?(?:valid\s+)?student\s+id|finals?\s+week|during\s+finals|study\s+break)\b/i;

function isStudentOnlyEvent(item) {
  if (STUDENT_ONLY_URL_PATHS.test(item.link || "")) return true;
  if (STUDENT_ONLY_TITLE.test(item.title || "")) return true;
  if (STUDENT_ONLY_AUDIENCE.test(item.title || "")) return true;
  const desc = stripHtml(item.description || "");
  if (STUDENT_ONLY_DESC.test(desc)) return true;
  if (SCU_INTERNAL_DESC.test(desc)) return true;
  if (STUDENT_ONLY_AUDIENCE.test(desc)) return true;
  return false;
}

// SJSU's Localist feed title-cases all words including acronyms, so
// "SHRM Test Prep Course" arrives as "Shrm Test Prep Course". Restore the
// uppercase for the few professional-cert acronyms we've actually seen in
// the feed so the displayed title and description match the real program.
function restoreSjsuAcronyms(text) {
  if (!text) return text;
  return text.replace(/\bShrm\b/g, "SHRM");
}

// SJSU's Localist feed defaults every event to the San Jose campus, but
// `item.location` sometimes names an off-campus partner venue in another
// covered city (D56: "Cupertino Community Hall" for an SBDC pitch
// competition). Cross-check the venue string against the other covered
// cities' name tokens — SJSU's own campus buildings never contain another
// city's name, so a match is a confident correction, not a false positive.
// Excludes the curated out-of-area slugs (santa-cruz, santa-clara-county) —
// those are hand-picked elsewhere, not something this feed should infer.
const SJSU_OTHER_CITY_TOKENS = Object.entries(SLUG_TO_CITY_TOKENS)
  .filter(([slug]) => slug !== "san-jose" && slug !== "santa-cruz" && slug !== "santa-clara-county");

function inferSjsuCity(venue) {
  const v = String(venue || "").toLowerCase();
  for (const [slug, tokens] of SJSU_OTHER_CITY_TOKENS) {
    if (tokens.some((t) => v.includes(t))) return slug;
  }
  return "san-jose";
}

async function fetchSjsuEvents() {
  console.log("  ⏳ SJSU Events...");
  try {
    const xml = await fetchText("https://events.sjsu.edu/calendar.xml", { timeout: 45_000 }); // large feed ~1.4MB
    const items = parseRssItems(xml);
    let skipped = 0;
    let venueCityFixes = 0;
    const parsed = items.map((item) => {
      if (isStudentOnlyEvent(item)) { skipped++; return null; }
      const start = parseDate(item.pubDate);
      if (!start) return null;
      item.title = restoreSjsuAcronyms(item.title);
      item.description = restoreSjsuAcronyms(item.description);
      const venue = item.location || extractVenueFromTitle(item.title) || "San Jose State University";
      const city = inferSjsuCity(venue);
      if (city !== "san-jose") {
        venueCityFixes++;
        console.warn(`[sjsu] venue "${venue}" names ${city}, not san-jose — correcting city (${item.title})`);
      }
      const category = inferUniversityCategory(item.title, item.description, "", venue);
      // SJSU's Localist platform emits a 224x42 wordmark as og:image which
      // crops to "SAN UNI" on a square tile. Pin a real square asset:
      // Spartan helmet for athletics, SJSU monogram for everything else.
      const image = category === "sports" ? "/logos/sjsu-spartan.png" : "/logos/sjsu-monogram.png";
      // SJSU's Localist feed has no price field, so we default to free —
      // accurate for campus lectures, library events, exhibits. Two
      // exceptions: every athletics entry, and the "Alumni Night at the
      // <pro team>" promotions SJSU runs at PayPal Park, Excite Ballpark,
      // and the Mountain West Championship. Those are commercial-ticket
      // events and the FREE badge is wrong. Match on category OR the
      // commercial-venue signature — "food" / "community" categorization
      // bleeds when the description plays up the alumni dinner.
      const COMMERCIAL_TICKET_VENUE = /\b(paypal park|excite ballpark|levi'?s stadium|sap center|cefcu stadium|spartan stadium|provident credit union event center|shoreline amphitheatre|mountain winery|mountain west championship)\b/i;
      const cost = category === "sports" || COMMERCIAL_TICKET_VENUE.test(venue) ? "paid" : "free";
      return {
        id: h("sjsu", item.link || item.title, item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: null,
        venue,
        address: "",
        city,
        category,
        cost,
        description: truncate(stripBareUrls(stripHtml(item.description))),
        url: item.link,
        source: "SJSU Events",
        image,
        kidFriendly: false,
        _startMs: start.getTime(),
      };
    }).filter(Boolean);

    // SJSU's Localist RSS emits each occurrence of a recurring event as a
    // separate item — a single exhibit like "Fists of Fury" floods Today
    // with 9 identical 4 PM entries on consecutive days. Stanford's Localist
    // API exposes first_date/last_date so its scraper collapses series at
    // ingest; the RSS feed gives us only per-occurrence rows. Group by event
    // detail URL and, when the same URL appears on 3+ dates, emit a single
    // ongoing entry at the earliest future date. 2-occurrence URLs remain
    // separate sessions (real workshops often run 2 dates).
    const byUrl = new Map();
    const collapsibleUrlPattern = /^https?:\/\/events\.sjsu\.edu\/event\//i;
    for (const e of parsed) {
      if (!e.url || !collapsibleUrlPattern.test(e.url)) continue;
      if (!byUrl.has(e.url)) byUrl.set(e.url, []);
      byUrl.get(e.url).push(e);
    }
    const dropIds = new Set();
    let collapsed = 0;
    for (const [, occurrences] of byUrl) {
      if (occurrences.length < 3) continue;
      occurrences.sort((a, b) => a._startMs - b._startMs);
      const keep = occurrences[0];
      if (!isOngoingExhibitLike(keep.title, keep.description, keep.venue)) continue;
      keep.time = null;
      keep.endTime = null;
      keep.ongoing = true;
      for (let i = 1; i < occurrences.length; i++) dropIds.add(occurrences[i].id);
      collapsed += occurrences.length - 1;
    }
    const events = parsed
      .filter((e) => !dropIds.has(e.id))
      .map(({ _startMs, ...e }) => e);

    console.log(`  ✅ SJSU: ${events.length} events (${skipped} student-only filtered${collapsed ? `, ${collapsed} occurrences collapsed into exhibits` : ""}${venueCityFixes ? `, ${venueCityFixes} venue-vs-city corrections` : ""})`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SJSU: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

const SOUTH_BAY_GEO_CENTERS = [
  { city: "campbell", lat: 37.2872, lon: -121.9500 },
  { city: "cupertino", lat: 37.3230, lon: -122.0322 },
  { city: "los-altos", lat: 37.3852, lon: -122.1141 },
  { city: "los-gatos", lat: 37.2261, lon: -121.9822 },
  { city: "milpitas", lat: 37.4323, lon: -121.8996 },
  { city: "mountain-view", lat: 37.3861, lon: -122.0839 },
  { city: "palo-alto", lat: 37.4419, lon: -122.1430 },
  { city: "san-jose", lat: 37.3382, lon: -121.8863 },
  { city: "santa-clara", lat: 37.3541, lon: -121.9552 },
  { city: "saratoga", lat: 37.2638, lon: -122.0230 },
  { city: "sunnyvale", lat: 37.3688, lon: -122.0363 },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestSouthBayCityFromGeoPoint(point) {
  const [latRaw, lonRaw] = String(point || "").trim().split(/\s+/).map(Number);
  if (!Number.isFinite(latRaw) || !Number.isFinite(lonRaw)) return null;
  let best = null;
  for (const center of SOUTH_BAY_GEO_CENTERS) {
    const km = haversineKm(latRaw, lonRaw, center.lat, center.lon);
    if (!best || km < best.km) best = { ...center, km };
  }
  // Far enough to catch San Luis Obispo / SF / Oakland / other regional alumni
  // events, wide enough to keep normal South Bay edge cases.
  return best && best.km <= 35 ? best.city : null;
}

function inferScuCost(item) {
  const haystack = [
    item.livewhaleCategories,
    item.livewhaleTags,
    item.description,
  ].filter(Boolean).join(" ");
  if (/\bfree\b/i.test(haystack)) return "free";
  return "";
}

async function fetchScuEvents() {
  console.log("  ⏳ Santa Clara University Events...");
  try {
    const xml = await fetchText("https://events.scu.edu/live/rss/events");
    const items = parseRssItems(xml);
    let skippedScu = 0;
    const parsed = items.map((item) => {
      if (isStudentOnlyEvent(item)) { skippedScu++; return null; }
      const start = parseDate(item.pubDate);
      if (!start) return null;
      const geoCity = item.georssPoint ? nearestSouthBayCityFromGeoPoint(item.georssPoint) : null;
      if (item.georssPoint && !geoCity) {
        skippedScu++;
        return null;
      }
      const venue = cleanVenue(item.location || item.georssFeatureName || "") || "Santa Clara University";
      return {
        id: h("scu", item.link || item.title, item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: displayTime(start),
        endTime: null,
        venue,
        address: "",
        city: geoCity || "santa-clara",
        category: inferUniversityCategory(item.title, item.description, "", venue),
        cost: inferScuCost(item),
        description: truncate(stripHtml(item.description)),
        url: item.link,
        source: "Santa Clara University",
        kidFriendly: false,
        _startMs: start.getTime(),
      };
    }).filter(Boolean);

    // SCU's Localist RSS emits each occurrence of a multi-day exhibit as a
    // separate item with `pubDate = T00:00:00` — displayTime() returns
    // "12:00 AM" on non-PT runtimes, slipping past the global no-time
    // exhibit-collapse rule. Mirror the SJSU URL-collapse: group by event
    // detail URL, and when the same URL appears on 3+ dates, emit a single
    // ongoing entry at the earliest future date. 2-occurrence URLs stay
    // separate (real two-day workshops exist).
    const byUrl = new Map();
    const collapsibleUrlPattern = /^https?:\/\/events\.scu\.edu\/.+\/event\//i;
    for (const e of parsed) {
      if (!e.url || !collapsibleUrlPattern.test(e.url)) continue;
      if (!byUrl.has(e.url)) byUrl.set(e.url, []);
      byUrl.get(e.url).push(e);
    }
    const dropIds = new Set();
    let collapsed = 0;
    for (const [, occurrences] of byUrl) {
      if (occurrences.length < 3) continue;
      occurrences.sort((a, b) => a._startMs - b._startMs);
      const keep = occurrences[0];
      if (!isOngoingExhibitLike(keep.title, keep.description, keep.venue)) continue;
      keep.time = null;
      keep.endTime = null;
      keep.ongoing = true;
      for (let i = 1; i < occurrences.length; i++) dropIds.add(occurrences[i].id);
      collapsed += occurrences.length - 1;
    }
    const events = parsed
      .filter((e) => !dropIds.has(e.id))
      .map(({ _startMs, ...e }) => e);

    console.log(`  ✅ SCU: ${events.length} events (${skippedScu} student-only filtered${collapsed ? `, ${collapsed} occurrences collapsed into exhibits` : ""})`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SCU: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
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

// CHM event pages use the canonical template "<h2>{Month} {Day}, {Year}<br />{H}:{MM} {am|pm}</h2>".
// The RSS feed only carries pubDate (= announcement date) so we have to fetch each item.
async function fetchChmEventDateTime(url) {
  try {
    const html = await fetchText(url, { timeout: 30_000 });
    const m = html.match(
      /<h2>\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s*\d{4})\s*<br\s*\/?\s*>\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
    );
    if (!m) return null;
    const dt = new Date(`${m[1]} ${m[2]}`);
    if (isNaN(dt.getTime())) return null;
    return { date: dt, time: m[2] };
  } catch (err) {
    if (STRICT_EVENT_REFRESH) throw err;
    return null;
  }
}

// CHM RSS descriptions are wrapped in WordPress excerpt boilerplate:
//   - Leading sold-out notice: "In-person attendance for this event is full.
//     Please join the waitlist or sign up to see the show virtually.
//     Unfortunately, we will not be able to admit walk-ins." — eats ~140 of the
//     200-char description budget when present, leaving a sliver of real content
//     and causing the Sonnet blurb resolver to write "Watch virtually or join the
//     waitlist…" instead of describing the actual event.
//   - Trailing WordPress excerpt footer: "[…] The post <title> appeared first on
//     CHM." — usually clipped by truncate() at 200 chars, but stripping pre-cut
//     widens the budget for real content on shorter descriptions.
function stripChmRssBoilerplate(text) {
  if (!text) return "";
  let t = text;
  // Lead boilerplate — three optional sentences in fixed order.
  t = t.replace(
    /^\s*In-person attendance for this event is full\.\s*/i,
    "",
  );
  t = t.replace(
    /^\s*Please join the waitlist or sign up to see the show virtually\.\s*/i,
    "",
  );
  t = t.replace(
    /^\s*Unfortunately, we will not be able to admit walk-ins\.\s*/i,
    "",
  );
  // Trailing WordPress footer: "[<a>&hellip;</a>] The post <a>title</a> appeared first on <a>CHM</a>."
  // stripHtml replaces inline anchor tags with single spaces, so the bracketed
  // ellipsis arrives as "[ … ]" (not "[…]"), the title is bracketed by spaces from
  // its own anchors, and the closing tag before the period turns "CHM." into "CHM ."
  // Allow optional whitespace inside the brackets and around the period so the
  // anchor regex still matches after stripHtml has run.
  t = t.replace(/\s*\[\s*…\s*\]\s*The post\b.*?\bappeared first on\s+CHM\s*\.?\s*$/i, "");
  t = t.replace(/\s*The post\b.*?\bappeared first on\s+CHM\s*\.?\s*$/i, "");
  return t.trim();
}

async function fetchChmEvents() {
  console.log("  ⏳ Computer History Museum...");
  try {
    const xml = await fetchText("https://computerhistory.org/events/feed/");
    const items = parseRssItems(xml);
    const today = todayPT();
    const results = await Promise.all(items.map(async (item) => {
      if (!item.link) return null;
      const dt = await fetchChmEventDateTime(item.link);
      if (!dt) return null;
      const iso = isoDate(dt.date);
      if (iso < today) return null; // past event — drop
      const rawDesc = stripHtml(item.description || item.content);
      return {
        id: h("chm", item.link, iso),
        title: item.title,
        date: iso,
        displayDate: displayDate(dt.date),
        time: dt.time,
        endTime: null,
        venue: "Computer History Museum",
        address: "1401 N Shoreline Blvd, Mountain View",
        city: "mountain-view",
        category: inferCategory(item.title, item.description, "", "Computer History Museum"),
        cost: "paid",
        ongoing: false,
        description: truncate(stripChmRssBoilerplate(rawDesc)),
        url: item.link,
        source: "Computer History Museum",
        kidFriendly: false,
      };
    }));
    const events = results.filter(Boolean);
    console.log(`  ✅ CHM: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  CHM: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

async function fetchSjJazzEvents() {
  console.log("  ⏳ San Jose Jazz Summer Fest...");
  try {
    // The legacy sanjosejazz.org/events page currently renders "No events
    // found" while the first-party Summer Fest lineup publishes complete
    // day/time/stage records. Use the stable lineup route instead of dated
    // filter slugs, which change every festival year.
    const origin = "https://summerfest.sanjosejazz.org";
    const lineupHtml = await fetchText(`${origin}/lineup`);
    let lineup = parseSanJoseJazzLineup(lineupHtml);

    // The official host occasionally returns a complete shell with no artist
    // cards to GitHub-hosted runners while serving the full page to the Mini.
    // Recover through its other stable view, then through the current day URLs
    // discovered from the first-party menu. The dated slugs remain data, not
    // hardcoded configuration, so this rolls forward with each festival year.
    if (lineup.length === 0) {
      console.log("  ↻ San Jose Jazz lineup was empty; trying official chronological view");
      const chronologicalHtml = await fetchText(`${origin}/chronological`);
      lineup = parseSanJoseJazzLineup(chronologicalHtml);

      if (lineup.length === 0) {
        const dayUrls = [...new Set([
          ...extractSanJoseJazzDayUrls(lineupHtml),
          ...extractSanJoseJazzDayUrls(chronologicalHtml),
        ])];
        if (dayUrls.length > 0) {
          console.log(`  ↻ San Jose Jazz: trying ${dayUrls.length} discovered official day page(s)`);
          const dayPages = await Promise.all(dayUrls.map((url) => fetchText(url)));
          const unique = new Map();
          for (const event of dayPages.flatMap(parseSanJoseJazzLineup)) {
            unique.set(`${event.url}|${event.date}|${event.time}|${event.stage}`, event);
          }
          lineup = [...unique.values()];
        }
      }
    }

    if (lineup.length === 0) throw new Error("official lineup parser returned no artist performances");
    const today = todayPT();
    const events = lineup
      .filter((event) => event.date >= today)
      .map((event) => ({
        id: h("sjz", event.url, event.date, event.time, event.stage),
        title: event.title,
        date: event.date,
        displayDate: displayDate(parseDatePT(`${event.date}T12:00:00`)),
        time: event.time,
        endTime: null,
        venue: event.stage,
        address: "Downtown San Jose, San Jose, CA 95113",
        city: "san-jose",
        category: "music",
        cost: "paid",
        description: truncate(event.description),
        url: event.url,
        source: "San Jose Jazz",
        kidFriendly: false,
        ...(event.image ? { image: event.image } : {}),
      }));

    console.log(`  ✅ San Jose Jazz: ${events.length} artist performances`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  San Jose Jazz: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

// Montalvo's JSON-LD stamps every startDate with "+00:00" but the value is
// local wall-clock time, not UTC. Honoring the offset shifts every event 7-8
// hours earlier: a 09:00 summer camp became "2:00 AM", Opera San Jose's 19:00
// curtain became "12:00 PM". Dropping the offset hands parseDatePT a naive
// timestamp, which it already resolves as PT. Confirmed against Montalvo's own
// listings and the city newsletter (Marcus Fest 18:00 = 6:00 PM).
function stripBogusUtcOffset(str) {
  return typeof str === "string" ? str.replace(/(?:Z|\+00:00)$/, "") : str;
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
        const endDate = item.endDate;
        const url = item.url;
        if (!name || !startDate || !url) continue;
        const start = parseDatePT(stripBogusUtcOffset(startDate));
        const end = endDate ? parseDatePT(stripBogusUtcOffset(endDate)) : null;
        if (!start || start < now) continue;
        events.push({
          id: h("montalvo", url, startDate),
          title: name,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: end && isoDate(end) === isoDate(start) ? displayTime(end) : null,
          venue: "Montalvo Arts Center",
          address: "15400 Montalvo Rd, Saratoga",
          city: "saratoga",
          category: inferCategory(name, item.description || "", "", "Montalvo Arts Center"),
          cost: Number(item.offers?.price) === 0 ? "free" : "paid",
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

    const enriched = await Promise.all(unique.map(async (event) => {
      try {
        const detailHtml = await fetchText(event.url);
        const detail = parseMontalvoOccurrencePage(detailHtml);
        if (!detail || (detail.date && detail.date !== event.date)) return event;
        return {
          ...event,
          title: detail.title || event.title,
          time: detail.time || event.time,
          endTime: detail.endTime || event.endTime,
          cost: detail.cost || event.cost,
          occurrenceEvidence: {
            kind: "first-party-occurrence-page",
            sourceUrl: event.url,
            date: event.date,
            checkedAt: new Date().toISOString(),
          },
        };
      } catch {
        return event;
      }
    }));

    console.log(`  ✅ Montalvo Arts Center: ${enriched.length} events`);
    return enriched;
  } catch (err) {
    console.log(`  ⚠️  Montalvo Arts Center: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

async function fetchSvlgEvents() {
  console.log("  ⏳ Silicon Valley Leadership Group...");
  try {
    const xml = await fetchText("https://www.svlg.org/events/feed/");
    const items = parseRssItems(xml);
    const events = items.map((item) => {
      if (isBlockedEvent(item.title)) return null;
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
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

// ── CivicPlus RSS ──

function cleanCampbellVenue(raw) {
  const location = String(raw || "");
  // Campbell's RSS publishes Jack Fischer Park as only its intersection,
  // while the linked first-party event page supplies the actual facility name.
  // Keep the reader-facing venue stable across future events at this location.
  if (/\bAbbott Ave\.?\s*&\s*Pollard Road\b/i.test(location)) return "Jack Fischer Park";
  return cleanVenue(location);
}

async function fetchCampbellEvents() {
  console.log("  ⏳ Campbell Community Calendar...");
  try {
    const xml = await fetchText(
      "https://www.campbellca.gov/RSSFeed.aspx?ModID=58&CID=14-Community-Event-Calendar",
    );
    const items = parseRssItems(xml);
    const now = new Date();
    let skippedPlaceholder = 0;
    const events = items.map((item) => {
      // Campbell uses calendarEvent:EventDates ("March 28, 2026" or "April 6, 2026 - April 10, 2026")
      // not calendarEvent:startDate. Fall back to pubDate only if EventDates is missing.
      if (isBlockedEvent(item.title)) return null;
      const start = parseCivicPlusEventDates(item.eventDates)
        || parseDate(item.startDate)
        || parseDate(item.pubDate);
      if (!start || start < now) return null;
      const timeStr = parseCivicPlusEventTime(item.eventTimes);
      const venueLabel = cleanCampbellVenue(item.location) || inferCivicVenueFromTitle(item.title) || null;
      const description = truncate(stripCivicPlusMetadata(stripHtml(item.description)));
      // Same placeholder filter as fetchCivicPlusRssCity — Campbell's RSS also
      // emits bare-title entries ("Theatre Event", "Almaden Spirit Athletics
      // End of Season Showcase") with no description, no venue, no address.
      // Drop them at ingest so the blurb resolver doesn't fabricate filler.
      if (!description && !venueLabel) {
        skippedPlaceholder++;
        return null;
      }
      return {
        id: h("campbell", item.link || item.title, item.eventDates || item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: timeStr,
        endTime: null,
        venue: venueLabel,
        address: "",
        city: "campbell",
        category: inferCategory(item.title, item.description, ""),
        cost: "free",
        description,
        url: item.link,
        source: "City of Campbell",
        // Prefix-only boundary — match compounds like "Storytime", "Babies",
        // "Grades K-6". Mirrors the canonical regex in playwright-scrapers.mjs.
        kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(item.title),
      };
    }).filter(Boolean);
    if (skippedPlaceholder > 0) {
      console.log(`     · skipped ${skippedPlaceholder} placeholder entry/ies (no desc + no venue)`);
    }
    console.log(`  ✅ Campbell: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Campbell: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

// ── CivicPlus iCal feeds ──

async function fetchCivicPlusIcal(name, url, defaultCity, defaultCost = "free") {
  console.log(`  ⏳ ${name}...`);
  try {
    const feedOrigin = new URL(url).origin;
    const ical = await fetchText(url);
    const rawEvents = parseIcalEvents(ical);
    const now = new Date();
    const thirtyDaysOut = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

    let skippedPlaceholder = 0;
    const events = rawEvents
      .map((ev) => {
        if (isBlockedEvent(ev.summary)) return null;
        const start = parseIcalDate(ev.dtstart);
        if (!start || start < now || start > thirtyDaysOut) return null;
        const end = parseIcalDate(ev.dtend);
        // City-of-X calendars list branded programs ("Let's Hike Saratoga",
        // "Mayor's Office Hours at the Saratoga Farmers' Market") whose
        // trailheads or venues straddle a neighboring city — e.g. Fremont
        // Older Open Space Preserve geocodes to Cupertino but the hike is a
        // Saratoga city program. When the event title explicitly names the
        // host city, trust the host calendar instead of the inferCity geocode.
        const hostCityWords = defaultCity.replace(/-/g, " ");
        const titleNamesHost = new RegExp(`\\b${hostCityWords}\\b`, "i").test(ev.summary || "");
        const city = titleNamesHost ? defaultCity : (inferCity(ev.location, "") || defaultCity);
        const rawDesc = (ev.description || "").replace(/\\n/g, "\n").replace(/\\,/g, ",");
        const descText = truncate(stripHtml(rawDesc));
        // If the DESCRIPTION field is just a URL, use it as the event URL instead.
        // Also catch protocol-relative fragments (`//host/path`) which the
        // Los Altos History Museum feed emits as DonorPerfect donate links.
        const descTrimmed = descText.trim();
        const descIsUrl = /^https?:\/\/\S+$/.test(descTrimmed);
        const descIsProtocolRelative = /^\/\/[a-z0-9.-]+\.[a-z]{2,}\/\S*$/i.test(descTrimmed);
        // Relative iCal feed URLs (e.g. /common/modules/iCalendar/...) are not useful links
        const rawUrl = ev.url || null;
        const urlIsRelativeIcal = rawUrl && rawUrl.startsWith("/common/modules/iCalendar/");
        const uidUrl = /^\d+$/.test(String(ev.uid || "")) ? `${feedOrigin}/Calendar.aspx?EID=${ev.uid}` : null;
        const eventUrl = descIsUrl ? descTrimmed : (!urlIsRelativeIcal ? rawUrl : uidUrl);
        const cleanedVenue = cleanVenue((ev.location || "").replace(/\\,/g, ","));
        const venueLabel = cleanedVenue || inferCivicVenueFromTitle(ev.summary) || null;
        const description = (descIsUrl || descIsProtocolRelative) ? "" : stripBareUrls(descText);
        // Same placeholder filter as fetchCivicPlusRssCity — the Los Gatos iCal
        // feed in particular emits bare-title recurring entries ("Muse Markets")
        // with no description, no venue, no address. Drop them so the blurb
        // resolver doesn't fabricate filler from the title alone.
        if (!description && !venueLabel) {
          skippedPlaceholder++;
          return null;
        }
        // Races (5K/10K/marathon/triathlon/etc.) on civic iCal feeds almost
        // always have an entry fee — the iCal default of "free" is misleading
        // when there's no description or URL to verify cost. Null it out so the
        // card omits the cost badge instead of asserting free.
        const isRace = /\b(5k|10k|half marathon|marathon|triathlon|fun run|road run|trail run|color run)\b/i.test(ev.summary || "");
        return {
          id: h(defaultCity, ev.uid || ev.summary, ev.dtstart),
          title: cleanTitle(ev.summary.replace(/\\,/g, ",").replace(/\\n/g, " ")),
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          // Some iCal feeds (e.g. Opera SJ) write dtend == dtstart for events
          // without a published end time. Treat those as "no end time" rather
          // than a zero-duration event.
          endTime: end && end.getTime() !== start.getTime() ? displayTime(end) : null,
          venue: venueLabel,
          address: "",
          city,
          category: inferCategory(ev.summary, ev.description || "", ""),
          cost: isRace ? null : defaultCost,
          description,
          url: eventUrl,
          source: name,
          // Prefix-only boundary — match compounds like "Storytime", "Babies",
          // "Grades K-6". Mirrors the canonical regex in playwright-scrapers.mjs.
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(ev.summary),
        };
      })
      .filter(Boolean);

    if (skippedPlaceholder > 0) {
      console.log(`     · skipped ${skippedPlaceholder} placeholder entry/ies (no desc + no venue)`);
    }
    console.log(`  ✅ ${name}: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  ${name}: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
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

async function fetchMusicInParkEvents() {
  console.log("  ⏳ Los Gatos Music in the Park lineup...");
  const url = "https://www.losgatosca.gov/350/Music-in-the-Park";
  try {
    const html = await fetchText(url);
    const schedule = parseMusicInParkSchedule(html);
    if (schedule.length === 0) throw new Error("official schedule parser returned no concerts");
    const today = todayPT();
    const events = schedule
      .filter((entry) => entry.date >= today)
      .map((entry) => ({
        id: `los-gatos-music-in-the-park-${entry.date}`,
        title: `Music in the Park - ${entry.performer}`,
        date: entry.date,
        displayDate: displayDate(parseDatePT(`${entry.date}T12:00:00`)),
        time: "5:00 PM",
        endTime: "7:00 PM",
        venue: "Los Gatos Civic Center Lawn",
        address: "110 E. Main Street, Los Gatos, CA 95030",
        city: "los-gatos",
        category: "music",
        cost: "free",
        description: `Free, family-friendly outdoor concert featuring ${entry.performer}.`,
        url,
        source: "Town of Los Gatos",
        kidFriendly: true,
      }));
    console.log(`  ✅ Music in the Park lineup: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Music in the Park lineup: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

async function fetchJazzOnThePlazzEvents() {
  console.log("  ⏳ Jazz on the Plazz lineup...");
  try {
    const year = new Date().getFullYear();
    const url = `https://jazzontheplazz.com/${year}-concerts/`;
    const html = await fetchText(url);
    const schedule = parseJazzOnThePlazzSchedule(html);
    if (schedule.length === 0) throw new Error("official schedule parser returned no concerts");
    const today = todayPT();
    const events = schedule
      .filter((entry) => entry.date >= today)
      .map((entry) => ({
        id: `los-gatos-jazz-on-the-plazz-${entry.date}`,
        title: `Jazz on the Plazz - ${entry.performer}`,
        date: entry.date,
        displayDate: displayDate(parseDatePT(`${entry.date}T12:00:00`)),
        time: "6:30 PM",
        endTime: "8:30 PM",
        venue: "Los Gatos Town Plaza Park",
        address: "Montebello Way, Los Gatos, CA 95030",
        city: "los-gatos",
        category: "music",
        cost: "free",
        description: truncate(entry.description),
        url,
        source: "Los Gatos Music & Arts",
        kidFriendly: false,
      }));
    console.log(`  ✅ Jazz on the Plazz lineup: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Jazz on the Plazz lineup: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

async function fetchSaratogaEvents() {
  return fetchCivicPlusIcal(
    "City of Saratoga",
    "https://www.saratoga.ca.us/common/modules/iCalendar/iCalendar.aspx?catID=35&feed=calendar",
    "saratoga",
  );
}

async function fetchLosAltosEvents() {
  console.log("  ⏳ City of Los Altos...");
  try {
    // catID=37 is a real but empty calendar, and the all-calendar RSS omits
    // recurring rows visible on the official page. CivicPlus publishes full
    // schema.org Event blocks in its HTML, so read this month plus two ahead.
    const [year, month] = todayPT().split("-").map(Number);
    const pages = await Promise.all([0, 1, 2].map((offset) => {
      const target = new Date(Date.UTC(year, month - 1 + offset, 1));
      const url = new URL("https://www.losaltosca.gov/Calendar.aspx");
      url.searchParams.set("month", String(target.getUTCMonth() + 1));
      url.searchParams.set("year", String(target.getUTCFullYear()));
      return fetchText(url.toString());
    }));

    const today = todayPT();
    const seen = new Set();
    const events = pages
      .flatMap(parseCivicPlusCalendarPage)
      .filter((entry) => {
        const date = entry.startsAt.slice(0, 10);
        const key = `${entry.id}|${date}`;
        if (seen.has(key) || date < today || isBlockedEvent(entry.title)) return false;
        seen.add(key);
        return true;
      })
      .map((entry) => {
        const start = parseDatePT(entry.startsAt);
        return {
          id: h("los-altos", entry.id, entry.startsAt),
          title: entry.title,
          date: entry.startsAt.slice(0, 10),
          displayDate: displayDate(start),
          time: entry.time,
          endTime: entry.endTime,
          venue: cleanVenue(entry.venue) || null,
          address: entry.address,
          city: "los-altos",
          category: inferCategory(entry.title, entry.description, entry.venue),
          cost: "free",
          description: truncate(entry.description),
          url: new URL(entry.href, "https://www.losaltosca.gov").toString(),
          source: "City of Los Altos",
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|ages?\s*\d|grades?\s+[K0-9])/i.test(`${entry.title} ${entry.description}`),
        };
      });
    console.log(`  ✅ City of Los Altos: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  City of Los Altos: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
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
    let skippedPlaceholder = 0;
    const events = items.map((item) => {
      if (isBlockedEvent(item.title)) return null;
      const start = parseCivicPlusEventDates(item.eventDates)
        || parseDate(item.startDate)
        || parseDate(item.pubDate);
      if (!start || start < now) return null;
      const timeStr = parseCivicPlusEventTime(item.eventTimes);
      const venueLabel = cleanVenue(item.location || "") || inferCivicVenueFromTitle(item.title) || null;
      const description = truncate(stripCivicPlusMetadata(stripHtml(item.description)));
      // CivicPlus city calendars carry bare-title placeholders ("Memorial Day",
      // "Theatre Event", "Week 3: Prepared to Protect", "Muse Markets") that
      // surface with no description, no venue, and no address. The blurb
      // resolver then fabricates a sentence from the title alone — misleading.
      // Drop them at ingest; ceremonies/markets with real info keep their
      // venue or description and pass through normally.
      if (!description && !venueLabel) {
        skippedPlaceholder++;
        return null;
      }
      const titleLower = item.title.toLowerCase();
      return {
        id: h(defaultCity, item.link || item.title, item.eventDates || item.pubDate),
        title: item.title,
        date: isoDate(start),
        displayDate: displayDate(start),
        time: timeStr,
        endTime: null,
        venue: venueLabel,
        address: "",
        city: defaultCity,
        category: inferCategory(item.title, item.description, ""),
        cost: "free",
        description,
        url: item.link,
        source: name,
        // Prefix-only boundary — match compounds like "Storytime", "Babies",
        // "Grades K-6". Mirrors the canonical regex in playwright-scrapers.mjs.
        kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(titleLower),
      };
    }).filter(Boolean);
    if (skippedPlaceholder > 0) {
      console.log(`     · skipped ${skippedPlaceholder} placeholder entry/ies (no desc + no venue)`);
    }
    console.log(`  ✅ ${name}: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  ${name}: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
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
    if (STRICT_EVENT_REFRESH) throw err;
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
        // BiblioCommons marks online-only library events with definition.isVirtual.
        // Title-pattern fallbacks ("Online …", "Virtual …") miss titles like
        // "Short Story Social" and "Learn English: Online Conversation Group"
        // (where "Online" isn't at the start). Trust the authoritative flag.
        const isVirtual = ev.definition?.isVirtual === true;

        const displayVenue = branchName
          ? (branchName.toLowerCase().endsWith("library") ? branchName : `${branchName} Library`)
          : libraryName;

        // Month-long exhibits arrive from BiblioCommons as start = open day @
        // arbitrary clock, end = close day @ same clock (e.g. Oil Painting
        // Exhibit: May 31 5:00 PM → Jun 30 5:00 PM). Underlying timestamps
        // differ so the getTime-based dedupe below doesn't fire, but both
        // sides format to "5:00 PM" and the card renders a deceptive
        // one-minute event. When end is on a different calendar day AND the
        // clock-time display matches start, the API endpoints aren't real
        // event times — treat as ongoing and null both clocks.
        const dayMs = 24 * 60 * 60 * 1000;
        const spansMultipleDays = end && (end.getTime() - start.getTime()) >= dayMs;
        const sameClockDisplay = end && displayTime(start) === displayTime(end);
        const isOngoingExhibit = spansMultipleDays && sameClockDisplay;

        return {
          id: `${libraryId}-${ev.id}`,
          title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: isOngoingExhibit ? null : displayTime(start),
          // BiblioCommons sometimes returns end == start for ongoing exhibits
          // and drop-in programs — surface that as "no end time" rather than a
          // zero-duration block.
          endTime: isOngoingExhibit
            ? null
            : (end && end.getTime() !== start.getTime() ? displayTime(end) : null),
          ...(isOngoingExhibit ? { ongoing: true } : {}),
          venue: displayVenue,
          address: branchAddr,
          city,
          ...(isVirtual ? { virtual: true } : {}),
          // Pass the rendered venue so isIndoorVenue can detect "library" — short
          // branch names like "Cambrian" (no "Library" suffix) used to slip past it.
          category: inferCategory(title, stripHtml(desc), ev.type || "", displayVenue),
          cost: "free",
          description: truncate(stripHtml(desc)),
          url: ev.registrationUrl || `https://${libraryId}.bibliocommons.com/events/${ev.id}`,
          source: libraryName,
          // Prefix-only boundary on the title+desc regex — match compounds like
          // "Storytime", "Babies", "Grades K-6". Mirrors playwright-scrapers.mjs.
          kidFriendly: (ev.audiences || []).some((a) => {
            const name = typeof a === "string" ? a : a?.name || "";
            return /child|teen|family|baby|toddler/i.test(name);
          }) || /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|puppet show|ages?\s*\d|grades?\s+[K0-9])/i.test(title + " " + stripHtml(desc)),
        };
      })
      .filter(Boolean);

    console.log(`  ✅ ${libraryName}: ${results.length} events`);
    return results;
  } catch (err) {
    console.log(`  ⚠️  ${libraryName}: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
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

// SCCL branch display names (used as the `venue` field on the event card so the
// city-specific branch shows in the meta row instead of the generic system name).
// Without this, every SCCL event reads "Santa Clara County Library" and the
// title has to carry the branch (e.g. "ESL Conversation Club at Milpitas
// Library") — we'd rather move the branch info to the venue line.
const SCCL_LOCATION_BRANCH = {
  CA: "Campbell Library",
  CU: "Cupertino Library",
  LA: "Los Altos Library",
  WO: "Woodland Library",
  LG: "Los Gatos Library",
  MI: "Milpitas Library",
  SA: "Saratoga Library",
  SC: "Santa Clara City Library",
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
        const branchVenue = SCCL_LOCATION_BRANCH[locationCode] || libraryName;
        // See fetchBiblioEvents: BiblioCommons' definition.isVirtual is the
        // canonical online-only marker. SCCL doesn't typically use it (no
        // hits in current data), but mirror the handling so it stays in sync.
        const isVirtual = ev.definition?.isVirtual === true;

        allEvents.push({
          id: `${libraryId}-${ev.id}`,
          title,
          date: isoDate(start),
          displayDate: displayDate(start),
          time: displayTime(start),
          endTime: end && end.getTime() !== start.getTime() ? displayTime(end) : null,
          venue: branchVenue,
          address: "",
          city,
          ...(isVirtual ? { virtual: true } : {}),
          category: inferCategory(title, stripHtml(desc), ev.type || "", branchVenue),
          cost: "free",
          description: truncate(stripHtml(desc)),
          url: ev.registrationUrl || `https://${libraryId}.bibliocommons.com/events/${ev.id}`,
          source: libraryName,
          kidFriendly: (() => {
            const haystack = title + " " + stripHtml(desc);
            // Adult-only override: parent/caregiver workshops, ESL classes,
            // estate planning, etc. trip the family-keyword regex (their
            // descriptions mention "families") but are programmed FOR adults.
            // Title-anchored — descriptions are too noisy.
            if (/\b(parents?|caregivers?|adults?\s+only|seniors?|memoir|estate planning|tax\s+(prep|help)|investing|retirement|widow|grief|alzheimer|dementia|book club for adults|esl)\b/i.test(title)) return false;
            if ((ev.audiences || []).some((a) => {
              const name = typeof a === "string" ? a : a?.name || "";
              return /child|teen|family|baby|toddler/i.test(name);
            })) return true;
            // Prefix-only boundary — match compounds like "Storytime", "Babies",
            // "Grades K-6". Mirrors the canonical regex in playwright-scrapers.mjs.
            return /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|puppet show|ages?\s*\d|grades?\s+[K0-9])/i.test(haystack);
          })(),
        });
      }
    }
    console.log(`  ✅ ${libraryName}: ${allEvents.length} events`);
    return allEvents;
  } catch (err) {
    console.log(`  ⚠️  ${libraryName}: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
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
        kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test((e.name?.text || "") + (e.description?.html || "")),
      };
    }).filter(Boolean);

    console.log(`  ✅ Eventbrite: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Eventbrite: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
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

  // Drop cancelled / postponed at the source. Discovery API exposes the
  // booking status as `dates.status.code` ∈ {"onsale", "offsale",
  // "rescheduled", "cancelled", "postponed"}. Postponed events have no real
  // date — keeping them produces "ghost" listings for a date the show isn't
  // happening on.
  const tmStatus = (e.dates?.status?.code || "").toLowerCase();
  if (tmStatus === "cancelled" || tmStatus === "postponed") return null;

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

  // Drop parking-pass listings — Ticketmaster sells these as separate "events"
  // with the same title as the concert (e.g. "BTS World Tour 'Arirang' IN
  // Stanford") but the description is for parking, not the show. They clutter
  // the feed and break city briefings ("BTS plays two nights" while the only
  // entries are parking passes). Detect via Discovery classification or the
  // `info`/`pleaseNote` text that starts with "Event parking".
  const classType = (classification?.type?.name || "").toLowerCase();
  const classSubtype = (classification?.subType?.name || "").toLowerCase();
  if (classType === "parking" || classSubtype === "parking") return null;
  const blurbText = `${e.info || ""} ${e.pleaseNote || ""}`.trim();
  if (/^\s*(event\s+)?parking\b/i.test(blurbText)) return null;

  // Prefer `info` (real event copy). Fall through to `pleaseNote` only if it
  // isn't venue-policy boilerplate — at SAP Center and Tech CU Arena the
  // pleaseNote is bag-policy text that has nothing to do with the show.
  const rawInfo = (e.info || "").trim();
  const rawNote = (e.pleaseNote || "").trim();
  let descCandidate = "";
  if (rawInfo && !looksLikeVenuePolicy(rawInfo)) {
    descCandidate = rawInfo;
  } else if (rawNote && !looksLikeVenuePolicy(rawNote)) {
    descCandidate = rawNote;
  }

  return {
    id: `tm-${e.id}`,
    title: normalizeTicketmasterTitle(e.name),
    date: dateStr,
    displayDate: displayDate(start),
    time: timeStr ? displayTime(start) : null,
    endTime: null,
    venue: cleanVenue(venueName),
    address: venue?.address?.line1 || "",
    city,
    category: inferCategory(e.name, genre, segment, venueName),
    cost,
    costNote: minPrice ? `From $${Math.round(minPrice)}` : undefined,
    description: truncate(descCandidate),
    url: fixTicketmasterUrl(e.url, e.name, city, dateStr),
    source: "Ticketmaster",
    kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9]|disney|cirque)/i.test(e.name + " " + genre),
  };
}

// Ticketmaster title-cases ALL-CAPS source strings, leaving artifacts like
// "Everyone'S A Star" and "Presents: THE Rebel Ragers". Fix the obvious ones
// without touching titles that are intentionally mostly-uppercase. Also
// strip Mountain Winery's trailing venue-policy parenthetical ("(Children
// age 3 and older require a ticket)") that gets appended to every concert
// title and pollutes the display, e.g. "Seal (Children age 3 and older
// require a ticket)" → "Seal". The URL slug still includes the policy
// suffix because Ticketmaster builds it from the raw name, which we don't
// touch here.
function normalizeTicketmasterTitle(name) {
  if (!name) return name;
  let working = name;
  // Strip trailing parenthetical ticket-policy boilerplate. Conservative:
  // only matches parens containing "ticket" with an age/children/adult cue,
  // so informative tags like "(Ages 5–10)" or "(Spanish)" are left alone.
  working = working.replace(
    /\s*\((?:children?|kids?|adults?|all ages?|ages?)[^)]*?(?:require|need|must|are required)[^)]*?tickets?[^)]*\)\s*$/i,
    "",
  );
  // Normalize "Group X-" → "Group X -" when Ticketmaster omits the space
  // before the hyphen separating the group label from the matchup, e.g.
  // "World Cup: Match 8 Group B- Qatar vs Switzerland". The rest of the
  // World Cup feed uses " - " consistently, so the missing-space form is a
  // typo at the source. Narrow scope (only after "Group <letter>") so we
  // don't reflow legitimate hyphenated words.
  working = working.replace(/\b(Group\s+[A-Z])-\s+/g, "$1 - ");
  working = working.trim();
  const letters = working.replace(/[^A-Za-z]/g, "");
  if (!letters) return working;
  const lowerRatio = letters.replace(/[^a-z]/g, "").length / letters.length;
  if (lowerRatio < 0.2) return working; // mostly-caps title (BLACKPINK, etc.) — leave alone
  let out = working.replace(/(\w)'S\b/g, (_, p1) => `${p1}'s`);
  out = out.replace(/\b(THE|AND|OF|OR|AN|IN|ON|FOR|TO|WITH)\b/g, (m) => m[0] + m.slice(1).toLowerCase());
  return out;
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
  if (!apiKey) {
    console.log("  ⚠️  Ticketmaster: no API key");
    if (STRICT_EVENT_REFRESH) throw new Error("Ticketmaster API key is missing");
    return [];
  }

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
    if (STRICT_EVENT_REFRESH) throw err;
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
    if (STRICT_EVENT_REFRESH) throw err;
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
    {
      title: "Santa Cruz Shakespeare 2026 Summer Season Opens",
      date: "2026-06-22",
      time: "7:30 PM",
      venue: "The Grove at DeLaveaga Park",
      address: "501 Upper Park Rd, Santa Cruz, CA 95065",
      url: "https://santacruzshakespeare.org",
      image: "https://santacruzshakespeare.org/wp-content/uploads/2026/03/home-2026-post-300x300.png",
      description: "Opening night of Santa Cruz Shakespeare's outdoor summer rep season at the Grove at DeLaveaga Park. Season runs through late August.",
    },
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
        ...(e.image ? { image: e.image } : {}),
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
    if (STRICT_EVENT_REFRESH) throw err;
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
    if (STRICT_EVENT_REFRESH) throw err;
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
    if (STRICT_EVENT_REFRESH) throw err;
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
        // mismatches the description and confuses readers. For some Copa games
        // the API returns the promo name in locationName/teamName too — guard
        // against that by skipping any opponent whose city isn't a real
        // California League market.
        const CAL_LEAGUE_LOCATIONS = new Set([
          "fresno", "inland empire", "lake elsinore", "modesto",
          "rancho cucamonga", "san jose", "stockton", "visalia",
        ]);
        const awayLoc = game.teams?.away?.team?.locationName;
        const awayMascot = game.teams?.away?.team?.teamName;
        if (!awayLoc || !CAL_LEAGUE_LOCATIONS.has(awayLoc.toLowerCase())) {
          continue;
        }
        const awayTeam = `${awayLoc} ${awayMascot}`;
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
    if (STRICT_EVENT_REFRESH) throw err;
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
    if (STRICT_EVENT_REFRESH) throw err;
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
    // The old /events/feed/ endpoint is an empty RSS channel. Happy Hollow's
    // actual first-party dates live on its current program and benefit pages.
    const [seniorHtml, hoorayHtml] = await Promise.all([
      fetchText("https://happyhollow.org/seniorsafari/"),
      fetchText("https://happyhollow.org/hh-foundation/hooray/"),
    ]);
    const schedule = parseHappyHollowSchedules({ seniorHtml, hoorayHtml });
    if (schedule.length === 0) throw new Error("official program pages returned no dated events");
    const today = todayPT();
    const events = schedule
      .filter((entry) => entry.date >= today)
      .map((entry) => {
        const senior = entry.kind === "senior-safari";
        const url = senior
          ? "https://happyhollow.org/seniorsafari/"
          : "https://happyhollow.org/hh-foundation/hooray/";
        return {
          id: h("happyhollow", entry.kind, entry.date),
          title: entry.title,
          date: entry.date,
          displayDate: displayDate(parseDatePT(`${entry.date}T12:00:00`)),
          time: entry.time,
          endTime: entry.endTime,
          venue: "Happy Hollow Park & Zoo",
          address: "748 Story Rd, San Jose, CA 95112",
          city: "san-jose",
          category: "community",
          cost: senior ? "free" : "paid",
          description: senior
            ? "Adults 50 and over get early park entry, animal meet-and-greets, zookeeper chats, and activities."
            : "Happy Hollow Foundation's annual 21+ benefit supports animal care, conservation, access, and park improvements.",
          url,
          source: "Happy Hollow Park & Zoo",
          kidFriendly: false,
        };
      });
    console.log(`  ✅ Happy Hollow: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Happy Hollow Park & Zoo: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
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
    if (STRICT_EVENT_REFRESH) throw err;
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
    if (STRICT_EVENT_REFRESH) throw err;
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
    // San Martín is south of Morgan Hill and outside our 11-city coverage area.
    // The Eventbrite organizer publishes it, but we drop it at ingest so it
    // doesn't surface in San Jose's event feed.
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

async function fetchFarmersMarketEvents() {
  console.log("  ⏳ Farmers markets...");
  const markets = [
    {
      title: "Mountain View Farmers Market", day: 0, time: "9:00 AM", endTime: "1:00 PM",
      venue: "Caltrain Station", address: "600 W Evelyn Ave, Mountain View", city: "mountain-view",
      url: "https://www.cafarmersmkts.com/mountain-view-farmers-market/", season: [1, 12],
      evidencePatterns: [/Mountain View Farmers[’']? Market/i, /Every Sunday/i, /9(?::00)?\s*(?:am|a\.m\.)\s*(?:to|[-–])\s*1(?::00)?\s*(?:pm|p\.m\.)/i],
    },
    {
      title: "Los Gatos Farmers Market", day: 0, time: "9:00 AM", endTime: "1:00 PM",
      venue: "Town Park Plaza", address: "50 University Ave, Los Gatos", city: "los-gatos",
      url: "https://www.cafarmersmkts.com/losgatos-farmers-market/", season: [1, 12],
      evidencePatterns: [/Los Gatos Farmers[’']? Market/i, /Every Sunday/i, /9(?::00)?\s*(?:am|a\.m\.)\s*(?:to|[-–])\s*1(?::00)?\s*(?:pm|p\.m\.)/i],
    },
    {
      title: "Saratoga Farmers Market", day: 6, time: "9:00 AM", endTime: "1:00 PM",
      venue: "West Valley College", address: "14000 Fruitvale Ave, Saratoga", city: "saratoga",
      url: "https://www.cafarmersmkts.com/saratoga-farmers-market", season: [1, 12],
      evidencePatterns: [/Saratoga Farmers[’']? Market/i, /Every Saturday/i, /9(?::00)?\s*(?:am|a\.m\.)\s*(?:to|[-–])\s*1(?::00)?\s*(?:pm|p\.m\.)/i],
    },
    {
      title: "Santana Row Farmers Market", day: 3, time: "4:00 PM", endTime: "8:00 PM",
      venue: "Santana Row", address: "377 Santana Row, San Jose", city: "san-jose",
      url: "https://santanarow.com/event/farmers-market/", season: [6, 9],
      startDate: "2026-07-22", endDate: "2026-09-30",
      evidencePatterns: [/Santana Row Farmers[’']? Market/i, /every Wednesday/i, /4(?::00)?\s*(?:pm|p\.m\.)\s*(?:to|[-–])\s*8(?::00)?\s*(?:pm|p\.m\.)/i, /July 22, 2026\s*[-–]\s*September 30, 2026/i],
    },
    // Urban Village Farmers' Market publishes the current Campbell schedule and
    // date-specific street-closure exceptions on its first-party market pages.
    {
      title: "Campbell Farmers Market", day: 0, time: "9:00 AM", endTime: "1:00 PM",
      venue: "Downtown Campbell", address: "Campbell Ave, Campbell", city: "campbell",
      url: "https://uvfm.org/campbell-sundays", season: [1, 12],
      excludedDates: ["2026-05-17", "2026-10-18"],
      evidencePatterns: [/Campbell Farmers[’']? Market/i, /every Sunday/i, /9(?::00)?\s*(?:am|a\.m\.)\s*(?:to|[-–])\s*1(?::00)?\s*(?:pm|p\.m\.)/i],
    },
    {
      title: "Sunnyvale Farmers Market", day: 6, time: "9:00 AM", endTime: "1:00 PM",
      venue: "Murphy Avenue", address: "Murphy Ave, Sunnyvale", city: "sunnyvale",
      url: "https://uvfm.org/sunnyvale-saturday", season: [1, 12],
      excludedDates: ["2026-06-06", "2026-07-04"],
      evidencePatterns: [/Sunnyvale Farmers[’']? Market/i, /Saturdays/i, /9(?::00)?\s*(?:am|a\.m\.)\s*(?:to|[-–])\s*1(?::00)?\s*(?:pm|p\.m\.)/i],
    },
    {
      title: "California Ave Farmers Market", day: 0, time: "9:00 AM", endTime: "1:00 PM",
      venue: "California Avenue", address: "California Ave, Palo Alto", city: "palo-alto",
      url: "https://uvfm.org/palo-alto-sundays", season: [1, 12],
      evidencePatterns: [/California Ave(?:nue)? Farmers[’']? Market/i, /Sundays/i, /9(?::00)?\s*(?:am|a\.m\.)\s*(?:to|[-–])\s*1(?::00)?\s*(?:pm|p\.m\.)/i],
    },
  ];

  const verifiedMarkets = [];
  for (const market of markets) {
    const verification = await verifyMarketScheduleSource(market, { userAgent: UA });
    if (!verification.confirmed) {
      console.log(`  ⚠️  Farmers markets: suppressed ${market.title} (${verification.reason})`);
      continue;
    }
    verifiedMarkets.push({ market, verification });
  }

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

    for (const { market: m, verification } of verifiedMarkets) {
      if (dayOfWeek !== m.day) continue;
      if (month < m.season[0] || month > m.season[1]) continue;
      if (m.startDate && dateStr < m.startDate) continue;
      if (m.endDate && dateStr > m.endDate) continue;
      if (m.excludedDates?.includes(dateStr)) continue;

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
        projectedRecurrence: true,
        occurrenceEvidence: marketOccurrenceEvidence(verification, dateStr),
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
  /\bbusiness\s+referral\b/i,
  /\breferral\s+group\b/i,
  /\bnetworking\b/i,
  /\byoung\s+professionals?\s+mixer\b/i,
  /\bventure\s+capital\b/i,
  /\bcowork(?:ing)?\b/i,
  /\bco-?work\b/i,
  /\bmembers?\s+meeting\b/i,
  /\bbooth\s+build\s+meeting\b/i,
  /\bspeaker\s+and\s+title\s+tba\b/i,
  /\bsan\s+francisco\b/i,
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMeetupAddress(address, city) {
  let cleaned = address?.trim();
  if (!cleaned || /^https?:\/\//i.test(cleaned)) return null;
  cleaned = cleaned.replace(/,\s*$/, "");
  if (city && !new RegExp(`\\b${escapeRegExp(city)}\\b`, "i").test(cleaned)) {
    cleaned = `${cleaned}, ${city}`;
  }
  return cleaned;
}

function isIntersectionVenue(value) {
  return /\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ct|court|ln|lane|way|pkwy|parkway|cir|circle|pl|place)\b\.?\s*(?:&|and|\/)\s*.+\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ct|court|ln|lane|way|pkwy|parkway|cir|circle|pl|place)\b/i.test(String(value || ""));
}

function meetupVenueFromTitle(title) {
  const match = String(title || "").match(
    /\b(?:at|in)\s+(?:the\s+)?([A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z][A-Za-z0-9'&.-]*){0,5}\s+(?:Park|Garden|Preserve|Trail|Library|Center|Museum|Theater|Theatre|Winery))\b/,
  );
  return match ? cleanVenue(match[1]) : "";
}

async function fetchMeetupEvents() {
  const CLIENT_ID = process.env.MEETUP_CLIENT_ID?.trim();
  const MEMBER_ID = process.env.MEETUP_MEMBER_ID?.replace(/\\n/g, "").trim();
  const KID = process.env.MEETUP_KID?.trim();
  const PRIVATE_KEY = process.env.MEETUP_PRIVATE_KEY?.trim().replace(/\\n/g, "\n");

  if (!CLIENT_ID || !MEMBER_ID || !KID || !PRIVATE_KEY) {
    console.log("  ⚠️  Meetup: credentials not set, skipping");
    if (STRICT_EVENT_REFRESH) throw new Error("Meetup credentials are incomplete");
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
    if (STRICT_EVENT_REFRESH) throw new Error("Meetup authentication returned no access token");
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
    if (!res.ok) throw new Error(`Meetup GraphQL returned ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      throw new Error(`Meetup GraphQL error: ${data.errors[0]?.message || "unknown error"}`);
    }
    return data;
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
      if (STRICT_EVENT_REFRESH) throw err;
    }
  }

  // Apply quality filters
  const MIN_MEMBERS = 50;
  const MIN_RSVP = 3;

  // Blocked Meetup group urlnames — add when a group consistently produces off-brand content
  const BLOCKED_MEETUP_GROUPS = new Set([
    "bay-area-childfree-connections", // childfree social group — not a fit for SBS audience
    "bay-area-how-to-build-a-business-training-networking-group",
    "bay-area-jewish-singles-havurah",
    "bay-area-social-networking-group",
    "los-gatos-business-referral-networking-meetup-group",
    "silicon-valley-startup-idea-to-ipo",
    "svtech_ai_venture_capital",
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
    const qualityText = [
      title,
      node.group?.name,
      node.group?.urlname,
    ].filter(Boolean).join(" ");
    if (MEETUP_JUNK.some((p) => p.test(qualityText))) continue;

    const city = node.venue?.city;
    const citySlug = meetupCitySlug(city);
    if (!citySlug || !MEETUP_ACCEPTED_CITIES.has(citySlug)) continue;

    const start = parseDate(node.dateTime);
    if (!start) continue;

    // Run through cleanVenue so Meetup organizers who type a raw street address
    // into the venue-name field ("22500 Cristo Rey Dr") fall back to the group
    // name rather than rendering a bare address as the venue.
    const address = normalizeMeetupAddress(node.venue?.address, city);
    let venue = cleanVenue(node.venue?.name?.trim() || "");
    if (isIntersectionVenue(venue)) {
      venue = meetupVenueFromTitle(title) || "";
    }
    venue ||= node.group?.name || "TBD";
    const locationText = [venue, address].filter(Boolean).join(" ");
    if (/\b(?:somewhere|secret(?:\s+\w+){0,3}\s+location|released\s+on\s+day|private\s+home|home\s+near)\b/i.test(locationText)) continue;

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
          ? `${loc.addressLine1}, ${loc.addressLine2 || ""}`.replace(/,\s*$/, "").trim()
          : defaultAddress;
        const city = inferCity(venue, addr) || defaultCity;
        const locality = extractAddressLocality(loc.addressLine2 || addr);
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
          city,
          ...(locality ? { locality } : {}),
          category: inferCategory(item.title, desc, "", venue),
          // "Free Admission" or "Free " in the title (e.g. JAMsj's free-admission
          // days) overrides the venue's default "paid" cost.
          cost: /\bfree\s+(admission|event|food|concert|workshop)\b/i.test(item.title + " " + desc)
            || /\badmission\s+is\s+free\b/i.test(desc)
            || /^free\b/i.test(item.title.trim())
            ? "free"
            : "paid",
          description: desc,
          url: fullUrl,
          source,
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(item.title + " " + desc),
        };
      })
      .filter(Boolean);

    console.log(`  ✅ ${source}: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  ${source}: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
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

async function fetchMexicanHeritagePlazaEvents() {
  return fetchSquarespaceEvents(
    "https://mhplaza.org/allevents",
    "Mexican Heritage Plaza",
    "san-jose",
    "Mexican Heritage Plaza",
    "1700 Alum Rock Ave, San Jose, CA 95116",
  );
}

async function fetchMuseumOfAmericanHeritageEvents() {
  return fetchSquarespaceEvents(
    "https://www.moah.org/moahevents",
    "Museum of American Heritage",
    "palo-alto",
    "Museum of American Heritage",
    "351 Homer Avenue, Palo Alto, CA 94301",
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
    if (STRICT_EVENT_REFRESH) throw err;
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
    writeFileAtomic(TIME_BACKFILL_CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
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
  const candidates = events.filter((e) => {
    if (e.time || e.ongoing || !e.url || !/^https?:/.test(e.url)) return false;
    // Skip canned "events list" pages — they won't have per-event times
    if (/\/events\/?$|\/pages\/events\/?$/.test(e.url)) return false;
    // Skip domain-root URLs — the extractor's last-resort "first time in
    // body text" fallback grabs gallery hours / random homepage numbers and
    // pins them to whatever event happens to point at the homepage.
    // Reproduced on Montalvo: homepage shows "8:30 AM" gallery hours and
    // every Montalvo event with a bare URL inherited it.
    try {
      const path = new URL(e.url).pathname.replace(/\/+$/, "");
      if (path === "") return false;
    } catch { return false; }
    return true;
  });
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

// Linden Tree Books (Los Altos) — handled by playwright-scrapers.mjs
// (`scrapeLindenTree`). The old HTTP-fetch path was kept here for redundancy
// but always won dedup with a stale 170 State St address (correct is 265) and
// junk date-string descriptions like "Sunday, June 14 at 10:30am", so it
// was dropped in favor of the playwright path's clean output.

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
        // All-day / multi-day exhibits: skip the synthetic 00:00–23:59
        // window — there is no real start time to surface.
        const isAllDay = e.all_day === true || e.all_day === "true";

        const rawVenue = typeof e.venue === "object" && e.venue
          ? (e.venue.venue || "").trim()
          : "";
        // SJDA's WP API sometimes returns a raw street address as the venue
        // string. cleanVenue strips out address blobs and returns "" so the
        // fallback ("Downtown San Jose") kicks in.
        const venue = cleanVenue(rawVenue);
        // Only build a joined address when SJDA actually supplies a street.
        // When e.venue.address is empty the old join produced a bare
        // ", San Jose" tail (the `city` field already carries san-jose), which
        // surfaced as a stray leading-comma address on cards.
        const addr = (() => {
          if (typeof e.venue !== "object" || !e.venue) return "";
          const street = (e.venue.address || "").replace(/[\s,]+$/, "").trim();
          return street ? `${street}, ${e.venue.city || "San Jose"}` : "";
        })();
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
          time: isAllDay ? null : displayTime(start),
          endTime: isAllDay ? null : (end && end.getTime() !== start.getTime() ? displayTime(end) : null),
          venue: venue || "Downtown San Jose",
          address: addr,
          city: "san-jose",
          category: inferCategory(title, desc, cats, venue),
          cost,
          description: desc,
          url: e.url || "https://sjdowntown.com/dtsj-events/",
          source: "SJDA",
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(title + " " + desc + " " + cats),
        });
      }

      if (page >= (data.total_pages || 1)) break;
      await new Promise((r) => setTimeout(r, 300)); // polite delay
    }

    console.log(`  ✅ SJDA (Downtown San Jose): ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  SJDA: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
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

// SJMA's calendar occasionally lists cross-promotions for other venues (e.g.
// a San Jose Giants game) that the Drupal Views scrape stamps with SJMA's own
// venue/address regardless. We can't resolve the real off-site venue from the
// listing alone, so drop rather than publish a wrong "Directions" address —
// conservative: only titles matching an obvious sports-team-vs pattern.
const SJMA_CROSS_PROMO_TITLE_RE = /\bvs\.?\s|\bversus\b/i;

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
      if (SJMA_CROSS_PROMO_TITLE_RE.test(title)) continue; // off-site cross-promotion, wrong venue data

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
        kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(title),
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
    if (STRICT_EVENT_REFRESH) throw err;
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

// ── The Pear Theatre (VBO Tickets HTML) ──

function decodePearText(value = "") {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPearHtml(value = "") {
  return decodePearText(stripHtml(value));
}

function parsePearDateRange(rangeText) {
  const match = decodePearText(rangeText).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4}))?/);
  if (!match) return null;

  const startMonth = parseInt(match[1], 10);
  const startDay = parseInt(match[2], 10);
  const startYear = parseInt(match[3], 10);
  const endMonth = match[4] ? parseInt(match[4], 10) : startMonth;
  const endDay = match[5] ? parseInt(match[5], 10) : startDay;
  const endYear = match[6] ? parseInt(match[6], 10) : startYear;

  return {
    startMonth,
    startDay,
    startYear,
    endMonth,
    endDay,
    endYear,
    startDate: `${startYear}-${String(startMonth).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`,
    endDate: `${endYear}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
  };
}

function parsePearOccurrences(sliderHtml, rangeText) {
  const months = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const range = parsePearDateRange(rangeText);
  const currentYear = new Date().getFullYear();
  const occurrences = [];
  const seen = new Set();
  const re = /DateMonth[^>]*>\s*([A-Za-z]{3,9})[\s\S]*?DateDay[^>]*>\s*(\d{1,2})[\s\S]*?WeekDayTime[^>]*>\s*-\s*([^<]+)/gi;

  let match;
  while ((match = re.exec(sliderHtml)) !== null) {
    const month = months[match[1].slice(0, 3).toLowerCase()];
    const day = parseInt(match[2], 10);
    if (!month || !day) continue;

    let year = range?.startYear ?? currentYear;
    let date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (range && date < range.startDate && range.endYear > range.startYear) {
      year = range.endYear;
      date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    if (range && (date < range.startDate || date > range.endDate)) continue;

    const time = match[3]
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s*(am|pm)$/i, (_, suffix) => ` ${suffix.toUpperCase()}`);
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    occurrences.push({ date, time });
  }

  return occurrences;
}

async function fetchPearTheatreEvents() {
  console.log("  ⏳ The Pear Theatre...");
  try {
    const siteId = "42AED627-D621-4B8F-960F-B0AA83FB1469";
    const orgId = "7928";
    const pluginUrl = `https://plugin.vbotickets.com/plugin/loadplugin?siteid=${siteId}&page=ListEvents&o=${orgId}&eid=0&edid=0&PluginType=Embed`;
    const pluginHtml = await fetchText(pluginUrl, { timeout: 20_000 });
    const session = extractVboSession(pluginHtml);
    if (!session) throw new Error("missing VBO session");

    const listUrl = `https://plugin.vbotickets.com/Plugin/events/showevents?ViewType=list&EventType=current&day=&s=${session}`;
    const listHtml = await fetchText(listUrl, { timeout: 20_000 });
    const today = todayPT();
    const events = [];

    const blocks = listHtml.split(/<div id="EDID/).slice(1).map((block) => `<div id="EDID${block}`);
    for (const block of blocks) {
      const edid = block.match(/id="EDID(\d+)"/i)?.[1];
      const eid = block.match(/\bEID(\d+)\b/)?.[1];
      const title = decodePearText(block.match(/data-event-name="([^"]+)"/i)?.[1] ?? "")
        || cleanPearHtml(block.match(/HeaderEventName[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
      if (!edid || !eid || !title) continue;

      const rangeText = cleanPearHtml(block.match(/TextEventDate[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
      const venue = cleanPearHtml(block.match(/TextVenueName[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "") || "The Pear Theatre";
      const address = cleanPearHtml(block.match(/TextVenueAddress[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "")
        || "1110 La Avenida Street Suite A, Mountain View, CA 94043";
      const description = truncate(cleanPearHtml(block.match(/EventIntroText[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? ""));
      const priceText = cleanPearHtml(block.match(/EventListPrice[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "")
        .replace(/^price\s*:?\s*/i, "")
        .replace(/\.00\b/g, "");
      const image = decodePearText(block.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? "");
      const url = `https://thepear.vbotickets.com/events?eid=${eid}`;
      const sliderUrl = `https://plugin.vbotickets.com/v5.0/controls/events.asp?a=load_eventdate_slider&page=seatmap.asp&eid=${eid}&edid=${edid}&req=1&s=${session}`;

      let occurrences = [];
      try {
        const sliderHtml = await fetchText(sliderUrl, { timeout: 20_000 });
        occurrences = parsePearOccurrences(sliderHtml, rangeText);
      } catch (err) {
        console.log(`  ↳ The Pear Theatre date fetch failed for ${title}: ${err.message}`);
        if (STRICT_EVENT_REFRESH) throw err;
      }

      for (const occurrence of occurrences) {
        if (occurrence.date < today) continue;
        const start = parseDatePT(`${occurrence.date}T12:00:00`);
        events.push({
          id: h("peartheatre", eid, occurrence.date, occurrence.time),
          title,
          date: occurrence.date,
          displayDate: displayDate(start),
          time: occurrence.time,
          endTime: null,
          venue,
          address,
          city: "mountain-view",
          category: "arts",
          cost: /\bfree\b/i.test(priceText) ? "free" : (priceText ? "paid" : null),
          ...(priceText ? { costNote: priceText } : {}),
          description,
          url,
          source: "The Pear Theatre",
          ...(image ? { image } : {}),
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(title + " " + description),
        });
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`  ✅ The Pear Theatre: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  The Pear Theatre: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

// ── Performing arts calendars ──

function cleanEscapedCalendarText(value = "") {
  return stripHtml(String(value)
    .replace(/\\n/g, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\"))
    .replace(/\s+/g, " ")
    .trim();
}

const BAD_EXTRACTED_IMAGE_URL = /(?:^|[/_\-.])(?:logo|icon|favicon|default(?:[-_]image)?|placeholder|empty|blank|spacer|sprite|og[-_]default|share[-_]image|social[-_]share)(?:[/_\-.]|$)/i;
const BAD_EXTRACTED_IMAGE_ATTR = /\b(?:icon|favicon|header|footer|sticky|newsletter|bloom|social|share|avatar)\b/i;

function decodeHtmlAttr(value = "") {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function attrValue(attrs, name) {
  const m = String(attrs || "").match(new RegExp(`\\b${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i"));
  return m ? decodeHtmlAttr(m[2]) : "";
}

function absolutizeImageUrl(url, baseUrl = "") {
  const raw = decodeHtmlAttr(url).trim();
  if (!raw || /^(?:data|javascript):/i.test(raw)) return "";
  try {
    return baseUrl ? new URL(raw, baseUrl).toString() : raw;
  } catch {
    return raw;
  }
}

function bestSrcsetUrl(srcset, baseUrl = "") {
  const candidates = decodeHtmlAttr(srcset)
    .split(",")
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      const url = absolutizeImageUrl(bits[0], baseUrl);
      const descriptor = bits[1] || "";
      const width = descriptor.endsWith("w") ? parseInt(descriptor, 10) : 0;
      const density = descriptor.endsWith("x") ? parseFloat(descriptor) * 1000 : 0;
      return { url, score: width || density || 1 };
    })
    .filter((c) => c.url);
  return candidates.sort((a, b) => b.score - a.score)[0]?.url || "";
}

function imageScore({ url, attrs = "", source = "img", index = 0 }) {
  if (!url || BAD_EXTRACTED_IMAGE_URL.test(url)) return -Infinity;
  if (BAD_EXTRACTED_IMAGE_ATTR.test(attrs)) return -Infinity;

  const width = Number(attrValue(attrs, "width")) || 0;
  const height = Number(attrValue(attrs, "height")) || 0;
  if ((width && width <= 40) || (height && height <= 40)) return -Infinity;

  let score = source === "meta" ? 30 : 20;
  if (/\/wp-content\/uploads\//i.test(url)) score += 12;
  if (/\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(url)) score += 4;
  if (width >= 100 && height >= 100) score += 20;
  if (Math.max(width, height) >= 600) score += 6;
  if (/\b(?:wp-image|size-|alignleft|alignright|featured|poster)\b/i.test(attrs)) score += 10;
  if (/\b(?:loading|lazy|decode|fetchpriority)\b/i.test(attrs)) score += 2;
  score -= index * 0.01;
  return score;
}

function extractFirstImageUrl(html = "", baseUrl = "") {
  const candidates = [];
  let index = 0;

  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=['"](?:og:image(?::secure_url)?|twitter:image)['"][^>]+content=['"]([^'"]+)['"][^>]*>/gi)) {
    candidates.push({ url: absolutizeImageUrl(m[1], baseUrl), source: "meta", attrs: m[0], index: index++ });
  }
  for (const m of html.matchAll(/<meta[^>]+content=['"]([^'"]+)['"][^>]+(?:property|name)=['"](?:og:image(?::secure_url)?|twitter:image)['"][^>]*>/gi)) {
    candidates.push({ url: absolutizeImageUrl(m[1], baseUrl), source: "meta", attrs: m[0], index: index++ });
  }
  for (const m of html.matchAll(/<link[^>]+rel=['"]image_src['"][^>]+href=['"]([^'"]+)['"][^>]*>/gi)) {
    candidates.push({ url: absolutizeImageUrl(m[1], baseUrl), source: "meta", attrs: m[0], index: index++ });
  }
  for (const m of html.matchAll(/<img\b([^>]+)>/gi)) {
    const attrs = m[1];
    const url = bestSrcsetUrl(attrValue(attrs, "srcset"), baseUrl)
      || absolutizeImageUrl(attrValue(attrs, "src"), baseUrl);
    candidates.push({ url, source: "img", attrs, index: index++ });
  }

  return candidates
    .map((candidate) => ({ ...candidate, score: imageScore(candidate) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score)[0]?.url || "";
}

function contentImageHtml(html = "") {
  const start = String(html).search(/<div[^>]+class=['"][^'"]*(?:post-content|entry-content)[^'"]*['"][^>]*>/i);
  if (start < 0) return html;
  const body = html.slice(start);
  const end = body.search(/<(?:footer|script)\b|<div[^>]+class=['"][^'"]*(?:fusion-footer|footer-widget|et_bloom|et_social)[^'"]*['"][^>]*>/i);
  return end > 0 ? body.slice(0, end) : body;
}

function normalizeLinkText(value = "") {
  return stripHtml(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findInternalContentPageByTitle(html = "", title = "", baseUrl = "") {
  const wanted = normalizeLinkText(title);
  if (!wanted) return "";
  const base = baseUrl ? new URL(baseUrl) : null;
  for (const m of html.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/gi)) {
    const label = normalizeLinkText(m[2]);
    if (label !== wanted) continue;
    const href = attrValue(m[1], "href");
    if (!href) continue;
    try {
      const url = base ? new URL(href, base).toString() : href;
      if (base && new URL(url).host !== base.host) continue;
      if (/\/events\//i.test(new URL(url).pathname)) continue;
      return url;
    } catch {
      continue;
    }
  }
  return "";
}

function parseNaturalDateTime(monthName, day, year, time, ampm) {
  const months = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  const month = months[monthName.toLowerCase().replace(/\.$/, "").slice(0, monthName.toLowerCase().startsWith("sept") ? 4 : 3)];
  if (!month) return null;
  const date = `${year}-${String(month).padStart(2, "0")}-${String(parseInt(day, 10)).padStart(2, "0")}`;
  const clock = `${time} ${ampm.toUpperCase()}`.replace(/^(\d{1,2}):(\d{2})\s+/, (_, h, m) => `${parseInt(h, 10)}:${m} `);
  return { date, time: clock };
}

async function fetchSanJoseTheatersEvents() {
  console.log("  ⏳ San Jose Theaters...");
  try {
    const ical = await fetchText(
      "https://sanjosetheaters.org/?plugin=all-in-one-event-calendar&controller=ai1ec_exporter_controller&action=export_events",
      { timeout: 30_000 },
    );
    const rawEvents = parseIcalEvents(ical);
    const today = todayPT();
    const events = [];

    for (const ev of rawEvents) {
      const title = cleanEscapedCalendarText(ev.summary);
      if (!title || isBlockedEvent(title)) continue;
      const start = parseIcalDate(ev.dtstart);
      if (!start) continue;
      const date = isoDate(start);
      if (date < today) continue;
      const time = displayTime(start);
      if (!time) continue;
      const end = parseIcalDate(ev.dtend);
      const venueParts = cleanEscapedCalendarText(ev.location).split("|").map((part) => part.trim()).filter(Boolean);
      const venue = cleanEscapedCalendarText(ev.categories) || venueParts[0] || "San Jose Theaters";
      const address = venueParts[1] || "";
      const url = ev.url || "https://sanjosetheaters.org/calendar/";
      const rawDesc = String(ev.description || "").replace(/\\n/g, "\n").replace(/\\,/g, ",");
      const description = truncate(stripBareUrls(stripHtml(rawDesc)));
      const image = extractFirstImageUrl(rawDesc, url);

      events.push({
        id: h("sanjosetheaters", url, date, time),
        title,
        date,
        displayDate: displayDate(start),
        time,
        endTime: end && end.getTime() !== start.getTime() ? displayTime(end) : null,
        venue,
        address,
        city: "san-jose",
        category: inferCategory(title, description, ev.categories || "", venue),
        cost: "paid",
        description,
        url,
        source: "San Jose Theaters",
        ...(image ? { image } : {}),
        kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9]|cmt|bluey|disney)\b/i.test(title + " " + description),
      });
    }

    console.log(`  ✅ San Jose Theaters: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  San Jose Theaters: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

async function fetchSouthBayMusicalTheatreEvents() {
  console.log("  ⏳ South Bay Musical Theatre...");
  const pages = [
    "https://southbaymt.com/shows/ticket-sales/in-the-heights/",
    "https://southbaymt.com/shows/ticket-sales/ouam/",
    "https://southbaymt.com/shows/ticket-sales/holiday-sunshine/",
    "https://southbaymt.com/shows/ticket-sales/come-from-away/",
    "https://southbaymt.com/shows/ticket-sales/musicomedy/",
    "https://southbaymt.com/shows/ticket-sales/southpacific2027/",
    "https://southbaymt.com/shows/ticket-sales/candide/",
  ];
  const today = todayPT();
  const events = [];

  for (const pageUrl of pages) {
    try {
      const html = await fetchText(pageUrl, { timeout: 20_000 });
      const title = cleanEscapedCalendarText(html.match(/<title[^>]*>([^<]+)/i)?.[1] || "")
        .replace(/\s+(?:[-–]\s+)?South Bay Musical Theatre\s*$/i, "");
      if (!title) continue;
      const bodyText = cleanEscapedCalendarText(html)
        .replace(/\s+/g, " ")
        .trim();
      const sectionStart = bodyText.search(/SHOW DATES\s*(?:&|AND)?\s*TIMES|DATES\s*(?:&|AND)?\s*TIMES/i);
      const dateText = sectionStart >= 0 ? bodyText.slice(sectionStart, sectionStart + 2500) : bodyText;
      const description = truncate(stripBareUrls(bodyText
        .replace(/^.*?Loading\.\.\.\s*/i, "")
        .replace(/SHOW DATES[\s\S]*$/i, "")
        // Strip the page header meta block that prefixes every SBMT synopsis:
        // "<Show Title> <byline> <ISO-8601 timestamp> [EspaÑOL] <Show Title>
        // <run-date range>." — e.g. "Once Upon a Mattress Doug Hughes
        // 2026-04-30T14:37:43-07:00 Once Upon a Mattress Sep. 25 – Oct. 17, 2026
        // Music by…". The byline + published timestamp are dev metadata, the
        // repeated title + dates duplicate the card's own title/date, and the
        // mojibake "EspaÑOL" is a corrupted language-toggle link. Drop through
        // the timestamp first, then through the trailing "<Month D … YYYY>"
        // caption (anchored to a month name so a synopsis without the caption,
        // on other show pages, is left intact).
        .replace(/^[\s\S]*?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}\s*/, "")
        .replace(/^Espa[\wñÑ]*\s*/i, "")
        .replace(
          /^[\s\S]{0,80}?\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z.]*\s+\d{1,2}\b[\s\S]*?\b20\d{2}[.,]?\s+/i,
          "",
        )
        .trim()));
      const image = extractFirstImageUrl(contentImageHtml(html), pageUrl);
      const re = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t\.?|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s+(20\d{2})\s+at\s+(\d{1,2}:\d{2})\s*(am|pm)\b/gi;
      let match;
      while ((match = re.exec(dateText)) !== null) {
        const parsed = parseNaturalDateTime(match[1], match[2], match[3], match[4], match[5]);
        if (!parsed || parsed.date < today) continue;
        const start = parseDatePT(`${parsed.date}T12:00:00`);
        events.push({
          id: h("southbaymt", pageUrl, parsed.date, parsed.time),
          title,
          date: parsed.date,
          displayDate: displayDate(start),
          time: parsed.time,
          endTime: null,
          venue: "Saratoga Civic Theater",
          address: "13777 Fruitvale Avenue, Saratoga, CA 95070",
          city: "saratoga",
          category: "arts",
          cost: "paid",
          costNote: "From $30",
          description,
          url: pageUrl,
          source: "South Bay Musical Theatre",
          ...(image ? { image } : {}),
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9]|disney)\b/i.test(title + " " + description),
        });
      }
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      console.log(`  ↳ South Bay Musical Theatre page failed: ${err.message}`);
      if (STRICT_EVENT_REFRESH) throw err;
    }
  }

  console.log(`  ✅ South Bay Musical Theatre: ${events.length} events`);
  return events;
}

async function fetchLosAltosStageEvents() {
  console.log("  ⏳ Los Altos Stage Company...");
  try {
    const items = await fetchJson("https://losaltosstage.org/wp-json/wp/v2/events?per_page=50", { timeout: 20_000 });
    const today = todayPT();
    const events = [];

    for (const item of items || []) {
      const pageUrl = item.link;
      const title = cleanEscapedCalendarText(item.title?.rendered || "");
      if (!pageUrl || !title || isBlockedEvent(title)) continue;
      try {
        const html = await fetchText(pageUrl, { timeout: 20_000 });
        const text = cleanEscapedCalendarText(html);
        const match = text.match(/\bStart date\s+([A-Za-z]+)\s+(\d{1,2}),\s+(20\d{2})\s+(\d{1,2}:\d{2})\s*(am|pm)\b/i);
        if (!match) continue;
        const parsed = parseNaturalDateTime(match[1], match[2], match[3], match[4], match[5]);
        if (!parsed || parsed.date < today) continue;
        const start = parseDatePT(`${parsed.date}T12:00:00`);
        let image = extractFirstImageUrl(contentImageHtml(html), pageUrl);
        if (!image) {
          const showPageUrl = findInternalContentPageByTitle(html, title, pageUrl);
          if (showPageUrl) {
            try {
              const showHtml = await fetchText(showPageUrl, { timeout: 20_000 });
              image = extractFirstImageUrl(contentImageHtml(showHtml), showPageUrl);
            } catch {
              // Keep the event; image resolver will try Places/OG/cache later.
            }
          }
        }

        events.push({
          id: h("losaltosstage", pageUrl, parsed.date, parsed.time),
          title,
          date: parsed.date,
          displayDate: displayDate(start),
          time: parsed.time,
          endTime: null,
          venue: "Los Altos Stage Company",
          address: "97 Hillview Ave, Los Altos, CA 94022",
          city: "los-altos",
          category: "arts",
          cost: "paid",
          description: "",
          url: pageUrl,
          source: "Los Altos Stage Company",
          ...(image ? { image } : {}),
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9]|youth)\b/i.test(title),
        });
        await new Promise((r) => setTimeout(r, 150));
      } catch (err) {
        console.log(`  ↳ Los Altos Stage detail failed for ${title}: ${err.message}`);
        if (STRICT_EVENT_REFRESH) throw err;
      }
    }

    console.log(`  ✅ Los Altos Stage Company: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Los Altos Stage Company: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

async function fetchPaloAltoPlayersEvents() {
  console.log("  ⏳ Palo Alto Players...");
  try {
    // Venture Event Manager calendar AJAX (robots.txt allows admin-ajax.php).
    // Returns one entry per performance with an epoch start + ticket link —
    // calendar id 263 is the public /calendar/ page's all-productions view.
    const now = Math.floor(Date.now() / 1000);
    const res = await fetch("https://paplayers.org/wp-admin/admin-ajax.php", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "vem_get_events",
        id: "263",
        event: "0",
        start: String(now - 86_400),
        end: String(now + 150 * 86_400),
        moment: "x",
        futureOnly: "false",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const perfs = (JSON.parse(await res.text())?.events || []).filter((p) => p?.start && p?.title);

    // One detail fetch per production (a handful per season) for the synopsis,
    // pretty permalink, and venue. PAP's resident home is the Lucie Stern
    // Theater; the page's JSON-LD location overrides if a show plays elsewhere.
    const detailCache = new Map();
    async function productionDetail(rawUrl) {
      const pageUrl = String(rawUrl || "").replace(/&#0*38;/g, "&").replace(/&amp;/g, "&");
      if (detailCache.has(pageUrl)) return detailCache.get(pageUrl);
      const detail = {
        url: pageUrl || "https://paplayers.org/calendar/",
        description: "",
        venue: "Lucie Stern Theatre",
        address: "1305 Middlefield Rd, Palo Alto, CA 94301",
      };
      if (pageUrl) {
        try {
          const html = await fetchText(pageUrl, { timeout: 20_000 });
          detail.url = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || detail.url;
          const og = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1];
          if (og) detail.description = truncate(cleanEscapedCalendarText(og));
          const venueName = html.match(/"@type":\s*"Place",\s*"name":\s*"([^"]+)"/)?.[1];
          const street = html.match(/"streetAddress":\s*"([^"]+)"/)?.[1];
          const locality = html.match(/"addressLocality":\s*"([^"]+)"/)?.[1];
          const zip = html.match(/"postalCode":\s*"([^"]+)"/)?.[1];
          // Keep the default "Lucie Stern Theatre" spelling (matches the
          // TheatreWorks scraper) — only override for a different venue.
          if (venueName && street && locality && !/lucie stern/i.test(venueName)) {
            detail.venue = cleanEscapedCalendarText(venueName);
            detail.address = `${street}, ${locality}, CA${zip ? ` ${zip}` : ""}`;
          }
          await new Promise((r) => setTimeout(r, 150));
        } catch {
          // Keep Lucie Stern defaults — every PAP production runs there.
        }
      }
      detailCache.set(pageUrl, detail);
      return detail;
    }

    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    const today = todayPT();
    const events = [];

    for (const perf of perfs) {
      const title = cleanEscapedCalendarText(perf.title);
      if (!title || isBlockedEvent(title)) continue;
      const parts = Object.fromEntries(
        fmt.formatToParts(new Date(Number(perf.start) * 1000)).map((p) => [p.type, p.value]),
      );
      const date = `${parts.year}-${parts.month}-${parts.day}`;
      if (date < today) continue;
      const time = `${parts.hour}:${parts.minute} ${parts.dayPeriod.toUpperCase()}`;
      const detail = await productionDetail(perf.url);

      events.push({
        id: h("paplayers", title, date, time),
        title,
        date,
        displayDate: displayDate(parseDatePT(`${date}T12:00:00`)),
        time,
        endTime: null,
        venue: detail.venue,
        address: detail.address,
        city: "palo-alto",
        category: "arts",
        cost: "paid",
        description: detail.description,
        url: detail.url,
        source: "Palo Alto Players",
        ...(perf.thumb ? { image: perf.thumb } : {}),
        kidFriendly: /\b(kid|child|family|story|youth|teen|junior|disney)\b/i.test(title + " " + detail.description),
      });
    }

    console.log(`  ✅ Palo Alto Players: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Palo Alto Players: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

async function fetchHammerTheatreEvents() {
  console.log("  ⏳ Hammer Theatre...");
  try {
    const siteId = "8B177AF0-B39C-408B-B5CB-47CD99E2BC9D";
    const orgId = "7239";
    const pluginUrl = `https://plugin.vbotickets.com/plugin/loadplugin?siteid=${siteId}&page=ListEvents&o=${orgId}&eid=0&edid=0&PluginType=Embed`;
    const pluginHtml = await fetchText(pluginUrl, { timeout: 20_000 });
    const session = pluginHtml.match(/events\?s=([0-9a-f-]{36})/i)?.[1];
    if (!session) throw new Error("missing VBO session");

    const listUrl = `https://plugin.vbotickets.com/Plugin/events/showevents?ViewType=list&EventType=current&day=&s=${session}`;
    const listHtml = await fetchText(listUrl, { timeout: 20_000 });
    const today = todayPT();
    const events = [];

    const blocks = listHtml.split(/<div id="EDID/).slice(1).map((block) => `<div id="EDID${block}`);
    for (const block of blocks) {
      const edid = block.match(/id="EDID(\d+)"/i)?.[1];
      const eid = block.match(/\bEID(\d+)\b/)?.[1];
      const title = cleanHammerTitle(
        decodePearText(block.match(/data-event-name="([^"]+)"/i)?.[1] ?? "")
        || cleanPearHtml(block.match(/HeaderEventName[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ""),
      );
      if (!edid || !eid || !title || isBlockedEvent(title)) continue;

      const rangeText = cleanPearHtml(block.match(/TextEventDate[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");
      const venue = cleanPearHtml(block.match(/TextVenueName[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "") || "Hammer Theatre Center";
      const address = cleanPearHtml(block.match(/TextVenueAddress[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "")
        || "101 Paseo De San Antonio, San Jose, CA 95113";
      const description = truncate(cleanPearHtml(block.match(/EventIntroText[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? ""));
      const image = decodePearText(block.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? "");
      const url = decodePearText(block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i)?.[1] ?? "")
        || `https://hammertheatre.vbotickets.com/event/details/${eid}`;
      const sliderUrl = `https://plugin.vbotickets.com/v5.0/controls/events.asp?a=load_eventdate_slider&page=seatmap.asp&eid=${eid}&edid=${edid}&req=1&s=${session}`;

      let occurrences = [];
      try {
        const sliderHtml = await fetchText(sliderUrl, { timeout: 20_000 });
        occurrences = parsePearOccurrences(sliderHtml, rangeText);
      } catch (err) {
        console.log(`  ↳ Hammer Theatre date fetch failed for ${title}: ${err.message}`);
        if (STRICT_EVENT_REFRESH) throw err;
      }

      if (occurrences.length === 0) {
        const fallback = rangeText.match(/(?:[A-Za-z]{3},\s*)?(\d{1,2})\/(\d{1,2})\/(20\d{2})\s*@\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
        if (fallback) {
          const date = `${fallback[3]}-${fallback[1].padStart(2, "0")}-${fallback[2].padStart(2, "0")}`;
          const time = fallback[4].replace(/\s+/g, " ").replace(/\s*(am|pm)$/i, (_, suffix) => ` ${suffix.toUpperCase()}`);
          occurrences = [{ date, time }];
        }
      }

      for (const occurrence of occurrences) {
        if (occurrence.date < today) continue;
        const start = parseDatePT(`${occurrence.date}T12:00:00`);
        events.push({
          id: h("hammertheatre", eid, occurrence.date, occurrence.time),
          title,
          date: occurrence.date,
          displayDate: displayDate(start),
          time: occurrence.time,
          endTime: null,
          venue,
          address,
          city: "san-jose",
          category: inferCategory(title, description, "", venue),
          cost: /\b(free admission|admission is free|pay what you can|donations? (?:are )?welcome)\b/i.test(title + " " + description) ? "free" : "paid",
          description,
          url,
          source: "Hammer Theatre",
          ...(image ? { image } : {}),
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9]|alice in wonderland)\b/i.test(title + " " + description),
        });
      }

      await new Promise((r) => setTimeout(r, 150));
    }

    console.log(`  ✅ Hammer Theatre: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Hammer Theatre: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

function cleanHammerTitle(title) {
  return String(title || "")
    .replace(/&#183;|&middot;/gi, "·")
    .replace(/\bLeo Presents presents\b/i, "Leo Presents")
    .replace(/\s*\(APAPA[^)]*\)/i, "")
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, "")
    .replace(/\bpresents\s*·\s*/gi, "presents ")
    .replace(/\s*·\s*\|\s*/g, " ")
    .replace(/\s+\|\s+/g, " ")
    .replace(/\s+·\s+/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchGambleGardenEvents() {
  console.log("  ⏳ Gamble Garden...");
  try {
    const today = todayPT();
    const events = [];
    for (let page = 1; page <= 5; page++) {
      const url = `https://www.gamblegarden.org/wp-json/tribe/events/v1/events?per_page=50&page=${page}`;
      const data = await fetchJson(url, { timeout: 20_000 });
      const rawEvents = data.events || [];
      for (const ev of rawEvents) {
        const start = parseDatePT(ev.start_date);
        if (!start) continue;
        const date = isoDate(start);
        if (date < today) continue;
        const title = stripHtml(ev.title || "").trim();
        if (!title || isBlockedEvent(title)) continue;
        const end = parseDatePT(ev.end_date);
        const venue = ev.venue?.venue || "Gamble Garden";
        const addressParts = [
          ev.venue?.address,
          ev.venue?.city,
          ev.venue?.stateprovince,
          ev.venue?.zip,
        ].filter(Boolean);
        const address = addressParts.length ? addressParts.join(", ") : "1431 Waverley Street, Palo Alto, CA 94301";
        const description = truncate(stripBareUrls(stripHtml(ev.description || ev.excerpt || "")));
        const image = ev.image?.url || "";

        events.push({
          id: h("gamblegarden", ev.id || ev.url, date, displayTime(start) || ""),
          title,
          date,
          displayDate: displayDate(start),
          time: ev.all_day ? null : displayTime(start),
          endTime: end && end.getTime() !== start.getTime() ? displayTime(end) : null,
          venue,
          address,
          city: "palo-alto",
          category: inferCategory(title, description, "", venue),
          cost: /\bfree\b/i.test(`${ev.cost || ""} ${title} ${description}`) ? "free" : (ev.cost ? "paid" : null),
          description,
          url: ev.url || "https://www.gamblegarden.org/events/",
          source: "Gamble Garden",
          ...(image ? { image } : {}),
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9]|second saturday|scavenger|craft)\b/i.test(title + " " + description),
        });
      }
      if (page >= (data.total_pages || 1)) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    console.log(`  ✅ Gamble Garden: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  Gamble Garden: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
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
    if (STRICT_EVENT_REFRESH) throw err;
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

// Third line of defense — the cityKey check above only catches an extractor
// that names a city we don't cover. It can't catch one that names a covered
// city for an event that isn't there: a Books Inc. Opera Plaza author talk in
// San Francisco came through tagged "san-jose" and published on the San Jose
// tab. So also read the location string: if it names a Bay Area city we don't
// cover and names none that we do, drop it regardless of cityKey.
const OUT_OF_AREA_LOCATION = /\b(san francisco|oakland|berkeley|alameda|fremont|hayward|walnut creek|san mateo|redwood city|daly city|san leandro|richmond|concord|vallejo|sacramento|los angeles|san rafael|novato|petaluma|napa|emeryville|burlingame|san bruno|pacifica|half moon bay|morgan hill|gilroy|marin)\b/i;
const COVERED_LOCATION = /\b(san jos[eé]|santa clara|sunnyvale|cupertino|campbell|milpitas|saratoga|los gatos|los altos|palo alto|mountain view|monte sereno|stanford|moffett)\b/i;
// Exception: organized outings depart from a covered city even though the
// destination is elsewhere — "August Day Trip to San Francisco Zoo & Gardens"
// is a Sunnyvale senior-center trip, not an SF event. Keep those.
const LOCAL_DEPARTURE_TRIP = /\b(day\s+trip|bus\s+trip|field\s+trip|excursion|trip\s+to|tour\s+to)\b/i;

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
    const inboundImageForEvent = (event) => {
      const sourceUrl = String(event.sourceUrl || "");
      if (/mountainview\.gov\/our-city\/departments\/community-services\/music-on-castro/i.test(sourceUrl)) {
        return "https://www.mountainview.gov/home/showpublishedimage/8655/639045040316800000";
      }
      return "";
    };
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
      const inboundLocation = e.location ?? "";
      if (
        OUT_OF_AREA_LOCATION.test(inboundLocation) &&
        !COVERED_LOCATION.test(inboundLocation) &&
        !LOCAL_DEPARTURE_TRIP.test(e.title)
      ) { skipCity++; continue; }

      const startDate = new Date(e.startsAt);
      if (isNaN(startDate.getTime())) continue;

      // Normalize extractor timestamps before they become visitor-facing
      // clock times. Inbound feeds use midnight and 23:59:59 as unknown/all-day
      // sentinels; source-specific first-party overrides can then supply real
      // published visitor hours and canonical URLs.
      const presentation = normalizeInboundEventPresentation(e);
      const { time, endTime } = presentation;

      // Real category inference instead of hardcoded "community" — this is
      // what makes newsletter events show up on the right tabs (Tech, Sports,
      // Arts, Food, etc) instead of just being lumped into Events.
      // Pass location as venue so school-fundraiser detection works for events
      // like "Leigh Longhorn 5K" hosted at "Leigh High School".
      const category = inferCategory(e.title, e.description ?? "", "", e.location ?? "");
      const titleLower = e.title.toLowerCase();
      const descLower = (e.description ?? "").toLowerCase();
      // Prefix-only boundary on title — match compounds like "Storytime",
      // "Babies", "Grades K-6". Mirrors the canonical regex in
      // playwright-scrapers.mjs; description check stays narrow to avoid
      // false positives from "family-friendly food trucks", etc.
      const kidFriendly = /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9]|easter\s?egg|egg\s?hunt)/i.test(titleLower)
        || /\b(kid|family|children|story\s?time)\b/i.test(descLower);

      // Extract venue name from location (first part before the comma).
      // If the leading segment is just a street address ("1680 Foley Avenue",
      // "315-367 S First St"), drop the leading number/range so we display the
      // street name instead of a raw address. The full address still rides
      // along in the address field.
      const location = e.location ?? "";
      // Leading street number, including multi-number ranges joined by a dash,
      // ampersand, slash, or "and" ("315-367 S First St", "21 & 23 Post Street").
      // Without consuming the whole range, "21 & 23 Post Street" strips only "21 "
      // and leaves "& 23 Post Street" — which then dodges the bare-address empty-out
      // below (it requires a leading letter) and surfaces a broken venue.
      const LEADING_STREET_NUMBER = /^\d+(?:\s*[-–&/]\s*\d+|\s+and\s+\d+)*\s+/i;
      const hadLeadingNumber = LEADING_STREET_NUMBER.test(location);
      let venueName = location.includes(",") ? location.split(",")[0].trim() : location;
      // Strip leading street number and optional "block of" phrasing — newsletter
      // sources sometimes write "200 block of Castro Street (near Dana Street)"
      // which yields a useless "block of Castro Street …" venue otherwise.
      const LEADING_STREET_NUMBER_BLOCK = /^\d+(?:\s*[-–&/]\s*\d+|\s+and\s+\d+)*\s+(block\s+of\s+)?/i;
      if (LEADING_STREET_NUMBER_BLOCK.test(venueName)) {
        venueName = venueName.replace(LEADING_STREET_NUMBER_BLOCK, "").trim();
      }
      // If the original location was a bare street address (e.g.
      // "123 Los Gatos Blvd, Los Gatos, CA") with no venue name, the strip
      // above leaves only a street name — which is not a venue. Drop it so
      // the UI falls back to the address. Parenthetical context like
      // "Castro Street (near Dana Street)" survives because the source
      // intentionally meant a street-level event.
      if (
        hadLeadingNumber &&
        /^[A-Z][\w'.]*(\s+[A-Z][\w'.]*){0,3}\s+(Blvd|Boulevard|Ave|Avenue|St|Street|Rd|Road|Way|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Pkwy|Parkway|Cir|Circle|Hwy|Highway|Ter|Terrace)\.?$/i.test(
          venueName,
        )
      ) {
        venueName = "";
      }
      // Drop bare city/state stubs like "Campbell" or "San Jose, CA" — those aren't venues.
      venueName = cleanVenue(venueName) || null;
      const image = inboundImageForEvent(e);

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
        url: presentation.url,
        source: "City Newsletter",
        ...(image ? { image } : {}),
        kidFriendly,
      });
    }
    console.log(`  ✅ Inbound events: ${out.length} events (skipped ${skipBlocked} blocked, ${skipCity} out-of-area, ${skipPast} past)`);
    return out;
  } catch (err) {
    console.log(`  ⚠️  Inbound events: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
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
        const location = locMatch ? locMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "History Park";
        const venue = location.split("|")[0].trim() || "History Park";
        // History San Jose's "eventlocation" field sometimes carries trailing
        // editorial copy ("Stay tuned for ticket information!"). When we know
        // we're at History Park, use its canonical street address; otherwise
        // strip any sentence after the address line.
        const HISTORY_PARK_ADDRESS = "635 Phelan Ave, San Jose, CA 95112";
        const rawAddress = location.includes("|") ? location.split("|")[1].trim() : HISTORY_PARK_ADDRESS;
        const address = /history park/i.test(venue)
          ? HISTORY_PARK_ADDRESS
          : rawAddress.split(/\s+(?=Stay tuned|Tickets|Tickets:|Note:)/i)[0].trim();

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
          kidFriendly: /\b(kid|child|family|story|youth|teen|toddler|baby|preschool|infant|lap[-\s]?sit|ages?\s*\d|grades?\s+[K0-9])/i.test(title),
        });
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`  ✅ History San Jose: ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  ⚠️  History San Jose: ${err.message}`);
    if (STRICT_EVENT_REFRESH) throw err;
    return [];
  }
}

// ── Main ──

async function main() {
  console.log("Scraping upcoming South Bay events...\n");

  // Source-level baselines have to be captured before any output write. They
  // catch one official adapter collapsing even when large feeds keep the
  // aggregate event count looking healthy.
  let prevRun = null;
  try { prevRun = JSON.parse(readFileSync(OUT_PATH, "utf8")); } catch { /* first run */ }

  let inputHealth = null;
  if (STRICT_EVENT_REFRESH) {
    inputHealth = strictRefreshInputHealth({
      playwright: readJsonFile(PLAYWRIGHT_EVENTS_PATH),
      inbound: readJsonFile(INBOUND_EVENTS_PATH),
      maxAgeHours: strictSnapshotMaxAgeHours(),
    });
    if (!inputHealth.ok) {
      const detail = inputHealth.problems.join("; ");
      await catSignal({
        key: "events-refresh-input-health",
        title: "Event refresh blocked before overwrite",
        body: detail,
      });
      throw new Error(`strict refresh inputs failed: ${detail}`);
    }
    console.log(
      `🔒 Strict inputs: ${inputHealth.snapshots.map((item) => `${item.name}=${item.count} (${item.ageHours}h old)`).join(", ")}\n`,
    );
  }

  const source = (fn, { id = fn.name, label = fn.name, critical = false } = {}) => ({
    id,
    label,
    critical,
    fn,
  });

  const sources = [
    source(fetchStanfordEvents),
    source(fetchSjsuEvents),
    source(fetchScuEvents),
    source(fetchChmEvents),
    source(fetchCampbellEvents),
    source(fetchMilpitasEvents),
    source(fetchLosGatosEvents),
    source(fetchMusicInParkEvents, { label: "Los Gatos Music in the Park" }),
    source(fetchJazzOnThePlazzEvents, { label: "Jazz on the Plazz" }),
    source(fetchSaratogaEvents),
    source(fetchLosAltosEvents, { label: "City of Los Altos", critical: true }),
    source(fetchLosAltosHistoryEvents),
    source(fetchOperaSanJoseEvents),
    // fetchMountainViewEvents,  — 403 blocked since 2026-03
    // fetchSunnyvaleEvents,     — 403 blocked since 2026-03
    // fetchCupertinoEvents,     — 404/timeout since 2026-03; covered by SCCL BiblioCommons
    // fetchSanJoseCityEvents,   — 403 blocked since 2026-03
    // fetchTheTechEvents,       — no /feed/ endpoint as of 2026-03
    source(fetchSjplEvents),
    source(fetchScclEvents),
    source(fetchSvlgEvents),
    source(fetchSjJazzEvents, { label: "San Jose Jazz" }),
    source(fetchMontalvoEvents),
    // fetchEventbriteEvents, — deprecated: /v3/events/search/ removed by Eventbrite
    source(fetchEarthquakesSchedule),
    source(fetchBayFCSchedule),
    source(fetchSJGiantsSchedule),
    source(fetchTicketmasterEvents, { label: "Ticketmaster", critical: true }),
    source(fetchSharksSchedule),
    source(fetchSantaCruzWarriorsSchedule),
    source(fetchSantaCruzPicks),
    source(fetchMvplEvents),
    // fetchSunnyvaleLibraryEvents, — 403 (Events feature disabled on their BiblioCommons); covered by SCCL
    source(fetchPaloAltoLibraryEvents),
    source(fetchHappyHollowEvents, { label: "Happy Hollow Park & Zoo" }),
    source(fetchMaclaEvents),
    source(fetchHeritageTheatreEvents),
    source(fetchShorelineEvents),
    source(fetchScccfdEvents),
    source(fetchLgChamberEvents),
    source(fetchFarmersMarketEvents),
    source(fetchMiscHardcodedEvents),
    source(fetchMeetupEvents, { label: "Meetup", critical: true }),
    source(fetchEastWestBookshopEvents),
    source(fetchKeplersEvents),
    source(fetchHicklebeesEvents),
    source(fetchSjdaEvents),
    source(fetchSjMuseumOfArtEvents),
    source(fetchJamsjEvents),
    source(fetchHistorySanJoseEvents),
    source(fetchPearTheatreEvents, { label: "The Pear Theatre" }),
    source(fetchSanJoseTheatersEvents),
    source(fetchSouthBayMusicalTheatreEvents),
    source(fetchLosAltosStageEvents),
    source(fetchPaloAltoPlayersEvents),
    source(fetchHammerTheatreEvents),
    source(fetchGambleGardenEvents),
    source(fetchMexicanHeritagePlazaEvents),
    source(fetchMuseumOfAmericanHeritageEvents),
    source(fetchPlaywrightEvents, { label: "Playwright source snapshot", critical: true }),
    source(fetchInboundEvents, { label: "Inbound newsletter snapshot", critical: true }),
  ];

  const results = await Promise.allSettled(sources.map(({ fn }) => fn()));
  const sourceHealth = buildSourceHealth(sources, results);
  const criticalProblems = criticalSourceProblems(sourceHealth);
  if (STRICT_EVENT_REFRESH && criticalProblems.length > 0) {
    const detail = criticalProblems.join("; ");
    await catSignal({
      key: "events-refresh-critical-source",
      title: "Event refresh blocked before overwrite",
      body: detail,
    });
    throw new Error(`critical event sources failed: ${detail}`);
  }

  const sourceRegressions = sourceRegressionProblems({
    previousSourceHealth: prevRun?.sourceHealth,
    nextSourceHealth: sourceHealth,
    today: todayPT(),
  });
  if (STRICT_EVENT_REFRESH && sourceRegressions.length > 0) {
    const detail = sourceRegressions.join("; ");
    await catSignal({
      key: "events-single-source-regression",
      title: "Event refresh blocked before overwrite",
      body: detail,
    });
    throw new Error(`individual event sources regressed: ${detail}`);
  }

  const allEvents = [];
  const sourceNames = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.length > 0) {
      allEvents.push(...result.value);
      for (const event of result.value) {
        if (event.source && !sourceNames.includes(event.source)) sourceNames.push(event.source);
      }
    }
  }

  // The Town's CivicPlus feed carries generic series titles and currently
  // omits the August 26 Jazz on the Plazz finale. Newsletter extraction also
  // produced a duplicate July 19 Music in the Park row with the wrong time.
  // Replace every row for these two verified 2026 schedules with the complete,
  // performer-specific first-party records before global cleanup and dedup.
  const losGatosSummer = mergeLosGatosSummerConcerts(allEvents, {
    fromDate: todayPT(),
  });
  allEvents.length = 0;
  allEvents.push(...losGatosSummer.events);
  for (const event of losGatosSummer.canonicalEvents) {
    if (!sourceNames.includes(event.source)) sourceNames.push(event.source);
  }
  console.log(
    `  ✅ Los Gatos summer concerts: ${losGatosSummer.canonicalEvents.length} canonical `
      + `(${losGatosSummer.replacedCount} source row(s) replaced, ${losGatosSummer.addedCount} added)`,
  );

  // Clean titles: strip calendar-artifact date prefixes, apply to all events
  allEvents.forEach((e) => { e.title = cleanTitle(e.title); });

  // Strip redundant venue suffix: SJSU's RSS feed appends " at <Venue>" to
  // many event titles, where <Venue> is also in the venue field. The card
  // shows venue separately, so the trailing suffix is pure duplication
  // ("Brass Ensemble at Music Building" + venue=Music Building → "Brass
  // Ensemble"). Also strips SJSU sports' " at San Jose, Calif." location
  // tail. Conservative — base title must remain ≥6 chars after strip.
  //
  // Runs before the venue field is entity-decoded and cleanVenue()'d further
  // down, so the comparison in venue-suffix.mjs decodes both sides itself.
  allEvents.forEach((e) => { e.title = stripRedundantVenueSuffix(e.title, e.venue); });

  // Polish descriptions: drop boilerplate sentences, downcase ALL CAPS, capitalize sentence starts
  allEvents.forEach((e) => {
    if (e.description) e.description = polishDescription(e.description);
  });

  // Drop descriptions that just repeat the title — SJSU's Localist RSS feeds
  // sports events with description == title, which adds noise to plan-day blurbs
  // and event cards. Compare on a normalized form so casing/whitespace doesn't
  // hide the duplication.
  allEvents.forEach((e) => {
    if (!e.description || !e.title) return;
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
    if (norm(e.description) === norm(e.title)) e.description = "";
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
      isEventPublishable(e) &&
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
  // Tiebreak by richer data, especially a real URL. Newsletter duplicates can
  // differ only by sourceUrl; keep the sourceable row over a slightly longer
  // unsourced blurb.
  capped.sort((a, b) => {
    const aff = sourceVenueAffinity(b) - sourceVenueAffinity(a);
    if (aff !== 0) return aff;
    const richness = (e) => {
      let score = 0;
      if (e.url) score += 20;
      if (e.time) score += 2;
      if (e.endTime) score += 1;
      if (e.description) score += Math.min(e.description.length / 100, 5);
      return score;
    };
    return richness(b) - richness(a);
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
    const key = `${normTitle}|${e.date}|${normTimeKey(e.time)}`;
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
    if (exhibitKeys.has(key) && isOngoingExhibitLike(e.title, e.description, e.venue)) {
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
      e.venue = cleanVenue(e.venue) || null;
    }
    // Address gets the same entity/whitespace treatment as venue, plus a strip
    // of CivicPlus "View Map" link text and normalized comma spacing. Sources
    // like City of Cupertino emit "Venue, Street, Zip, View Map" with
    // non-breaking-space separators; Palo Alto emits double-spaced streets.
    if (e.address) {
      e.address = e.address
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/[ ]/g, " ")          // non-breaking space → regular space
        .replace(/,?\s*View Map\s*$/i, "")  // strip CivicPlus map-link CTA
        .replace(/\s+/g, " ")
        .replace(/\s*,\s*/g, ", ")          // normalize comma spacing
        .replace(/(?:\s*,)+\s*$/, "")       // strip trailing comma(s)
        .replace(/^\s*,\s*/, "")            // strip leading comma
        .trim();
    }
    // WordPress sources emit &#038; (and &amp;) inside href attrs; the scraper
    // grabs the raw attr text, so the entity survives into the URL. Decode the
    // ampersand variants so query-string separators round-trip as `&` when the
    // URL is copied directly (calendar links, share buttons, raw paste).
    if (e.url) {
      e.url = e.url.replace(/&#0*38;/g, "&").replace(/&amp;/g, "&");
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
      const k = `${normKey(e.title)}|${e.date}|${normKey(e.venue)}|${normTimeKey(e.time)}`;
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

  // Fuzzy fallback dedup — catches near-duplicates the exact-key pass above
  // misses (organizer prefixes like "LGPNS X" vs "X", venue strings differing
  // between sources, tour-vs-tours casing, etc.). Requires same date+city,
  // strong title overlap (subset or jaccard ≥ 0.85), AND either same start
  // time within 30 min OR overlapping venue tokens (jaccard ≥ 0.4).
  {
    const before = collapsedEvents.length;
    const { kept, droppedCount } = fuzzyDedupEvents(collapsedEvents);
    if (droppedCount > 0) {
      console.log(`   🔀 fuzzy-dedup: dropped ${droppedCount} additional near-duplicate(s) (${before} → ${kept.length})`);
      collapsedEvents.length = 0;
      collapsedEvents.push(...kept);
    }
  }

  // Library holiday-closure filter — BiblioCommons occasionally lists
  // recurring programs (Storytime, Homework Help, Tech Help) on dates when
  // the branch is closed for a federal holiday. Drop those, but keep
  // explicitly themed events (e.g. "Celebrate Juneteenth! Storytime").
  {
    const { filterClosedLibraryEvents } = await import(
      "../src/lib/south-bay/libraryClosures.mjs"
    );
    const { kept, dropped } = filterClosedLibraryEvents(collapsedEvents);
    if (dropped.length > 0) {
      console.log(`   🔒 library-closure: dropped ${dropped.length} event(s) on holiday closure dates`);
      for (const e of dropped) {
        console.log(`      - ${e.date} "${e.title}" @ ${e.venue || "?"} (${e.source})`);
      }
      collapsedEvents.length = 0;
      collapsedEvents.push(...kept);
    }
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

  // Blurb resolution — one Sonnet pass per ingest so every event ships with a
  // stable "what to do here" sentence. Cache is persistent (keyed by URL), so
  // reruns only spend tokens on new/changed events. Behind RESOLVE_EVENT_BLURBS=1
  // so local dev doesn't pay unless explicitly asked.
  const { resolveEventBlurbs } = await import("../src/lib/south-bay/eventBlurbs.mjs");
  console.log("\n📝 Resolving event blurbs (cache → Sonnet batch)...");
  const blurbStats = await resolveEventBlurbs(collapsedEvents);
  console.log(`   preexisting:   ${blurbStats.preexisting}`);
  console.log(`   cache hits:    ${blurbStats.cache_hits}`);
  console.log(`   generated:     ${blurbStats.generated}`);
  console.log(`   failed:        ${blurbStats.failed}`);
  console.log(`   skipped:       ${blurbStats.skipped}`);
  const blurbed = blurbStats.preexisting + blurbStats.cache_hits + blurbStats.generated;
  console.log(`   Total blurbed: ${blurbed} / ${collapsedEvents.length} (${((blurbed / collapsedEvents.length) * 100).toFixed(0)}%)`);

  // Final guard: remap any non-canonical categories that slipped through from
  // upstream scrapers (e.g. stale playwright-events.json from before a fix).
  // EventCategory in src/data/south-bay/events-data.ts is the source of truth.
  const VALID_EVENT_CATEGORIES = new Set([
    "market", "family", "music", "arts", "sports",
    "community", "outdoor", "education", "food",
  ]);
  const CATEGORY_REMAP = {
    nature: "outdoor",
    volunteer: "community",
    technology: "education",
  };
  let remapped = 0;
  for (const e of collapsedEvents) {
    if (!VALID_EVENT_CATEGORIES.has(e.category)) {
      const next = CATEGORY_REMAP[e.category] ?? "community";
      e.category = next;
      remapped++;
    }
  }
  if (remapped > 0) console.log(`\n🛠  Remapped ${remapped} invalid event categories`);

  // Freshness stamp — tag each event with `firstSeenAt` so the UI can show a
  // "JUST ADDED" pill on items that appeared in the last few days. Keeps a
  // persistent id → ISO timestamp cache; cold start backdates by 7 days so
  // the feature doesn't flag every event the first time it ships.
  const { stampFirstSeen } = await import("../src/lib/south-bay/eventFreshness.mjs");
  const freshStats = stampFirstSeen(collapsedEvents);
  console.log(`\n🆕 Freshness: stamped=${freshStats.stamped} fresh=${freshStats.fresh} pruned=${freshStats.pruned}${freshStats.coldStart ? " (cold start — backdated by 7d)" : ""}`);

  const ongoingCount = collapsedEvents.filter((e) => e.ongoing).length;

  const output = {
    generatedAt: new Date().toISOString(),
    eventCount: collapsedEvents.length,
    sources: sourceNames,
    sourceHealth,
    ...(inputHealth ? { inputSnapshots: inputHealth.snapshots } : {}),
    events: collapsedEvents,
  };

  const regression = eventRegressionProblem({
    previous: prevRun,
    nextSourceCount: sourceNames.length,
    nextEventCount: collapsedEvents.length,
  });
  if (STRICT_EVENT_REFRESH && regression) {
    await catSignal({
      key: "events-source-regression",
      title: "Event refresh blocked before overwrite",
      body: regression,
    });
    throw new Error(regression);
  }

  // Rolling 30-day archive of events that age out of the upcoming file. The
  // static /event/<slug> pages build from upcoming ∪ archive so a page keeps
  // resolving (with a "this event has passed" banner) instead of 404ing the
  // morning after — preserves earned links and avoids index churn. Never let
  // archive maintenance break the main pipeline.
  try {
    const ARCHIVE_PATH = join(__dirname, "..", "src", "data", "south-bay", "events-archive.json");
    const todayPt = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffPt = cutoff.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

    let archive = { events: [] };
    try { archive = JSON.parse(readFileSync(ARCHIVE_PATH, "utf8")); } catch { /* first run */ }
    const byId = new Map((archive.events ?? []).map((e) => [e.id ?? `${e.date}|${e.title}`, e]));

    const aging = (prevRun?.events ?? []).filter(
      (e) => typeof e?.date === "string" && e.date < todayPt,
    );
    for (const e of aging) byId.set(e.id ?? `${e.date}|${e.title}`, e);

    const kept = [...byId.values()].filter(
      (e) => typeof e?.date === "string" && e.date >= cutoffPt && e.date < todayPt,
    );
    kept.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id ?? "").localeCompare(String(b.id ?? "")));
    writeFileAtomic(ARCHIVE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), eventCount: kept.length, events: kept }, null, 2) + "\n");
    console.log(`🗄️  Archive: +${aging.length} aged-out, ${kept.length} kept (30-day window)`);
  } catch (err) {
    console.warn(`⚠️  events-archive maintenance failed (non-fatal): ${err.message}`);
  }

  writeFileAtomic(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ Done — ${collapsedEvents.length} events (${ongoingCount} ongoing) from ${sourceNames.length} sources → ${OUT_PATH}`);

  // Regression guard. Scrapers fail quietly — each logs "⚠️ <Source>" and the run
  // continues with fewer events — so a whole batch breaking goes unnoticed. If the
  // contributing-source count or total events craters vs the previous run, DM.
  if (regression) {
    console.warn(`⚠️  ${regression}`);
    await catSignal({
      key: "events-source-regression",
      title: "Event pipeline regression",
      body: `${regression}. A batch of scrapers likely broke — check the run log for warnings.`,
    });
  }

  // Summary by city
  const byCity = {};
  collapsedEvents.forEach((e) => { byCity[e.city] = (byCity[e.city] || 0) + 1; });
  console.log("\nBy city:", byCity);
}

// When invoked directly, run the full event-generation pipeline. When imported
// (e.g. by repolish-event-descriptions.mjs to re-use polishDescription on
// existing data), skip the auto-run so the importer can call individual helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

export {
  cleanTitle,
  fetchFarmersMarketEvents,
  fetchHappyHollowEvents,
  fetchJazzOnThePlazzEvents,
  fetchLosAltosEvents,
  fetchMusicInParkEvents,
  fetchPaloAltoPlayersEvents,
  fetchPearTheatreEvents,
  fetchSjJazzEvents,
  polishDescription,
  stripRedundantVenueSuffix,
};
