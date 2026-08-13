#!/usr/bin/env node
// Fetches a real logo for every company in tech-companies.ts and self-hosts it
// in /public/logos/. Writes a manifest at src/lib/south-bay/tech-logo-manifest.ts
// that gets imported by tech-logos.ts.
//
// Resolution cascade per company:
//   1. Wikipedia REST API (originalimage.source) — works for big brands
//   2. icon.horse with high-res check (must be >= 64x64 and not 16x16 placeholder)
//   3. og:image scraped from company URL
//   4. apple-touch-icon scraped from company URL
//
// Usage: node scripts/fetch-tech-logos.mjs            (only fetches missing)
//        node scripts/fetch-tech-logos.mjs --refresh  (re-fetches all)
//        node scripts/fetch-tech-logos.mjs --id ebay  (one company)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { auditLogoManifest } from "./lib/logo-audit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGO_DIR = path.join(ROOT, "public", "logos");
const MANIFEST_PATH = path.join(ROOT, "src", "lib", "south-bay", "tech-logo-manifest.ts");
const DATA_PATH = path.join(ROOT, "src", "data", "south-bay", "tech-companies.ts");

const args = new Set(process.argv.slice(2));
const REFRESH = args.has("--refresh");
const ONLY_ID = (() => {
  const idx = process.argv.indexOf("--id");
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WIKI_UA = "SouthBayTodayLogoFetch/1.0 (https://southbaytoday.org; stephen@stanwood.dev)";

// Hard-pinned Wikimedia Commons files for IDs whose auto-discovery picks the
// wrong image (e.g. Apple → Wikimedia Foundation logo, Google → careers OG).
// Format: id → File: name on Commons.
const PINNED_WIKI_LOGOS = {
  apple: "Apple_logo_black.svg",
  google: "Google_2015_logo.svg",
  linkedin: "LinkedIn_logo_initials.png",
  intel: "Intel_logo_2023.svg",
  amd: "AMD_Logo.svg",
  nvidia: "Nvidia_logo.svg",
  meta: "Meta_Platforms_Inc._logo.svg",
  hp: "HP_logo_2012.svg",
  netflix: "Netflix_2015_logo.svg",
  oracle: "Oracle_logo.svg",
  paypal: "PayPal_logo.svg",
  zoom: "Zoom_Communications_Logo.svg",
  yahoo: "Yahoo!_(2019).svg",
  cisco: "Cisco_logo_blue_2016.svg",
  adobe: "Adobe_Corporate_logo.svg",
  android: "Android_logo_(2019-2023).svg",
  tesla: "Tesla_logo.png",
  vmware: "Vmware.svg",
  java: "Java_programming_language_logo.svg",
  atari: "Atari_logo_black.svg",
  "atari-2600": "Atari_logo_black.svg",
  "atari-founding": "Atari_logo_black.svg",
  "fairchild-semiconductor": "Fairchild_Semiconductor.svg",
  "palm-computing": "Logo_of_the_Palm_Computing_Platform.svg",
  "palmpilot-launch": "Logo_of_the_Palm_Computing_Platform.svg",
  netscape: "Netscape_logo.svg",
  "netscape-ipo": "Netscape_logo.svg",
  "sun-microsystems": "Sun_Microsystems_logo.svg",
  supermicro: "Super_Micro_Computer_Logo.svg",
  "rsa-conference": "New_RSA_Conference_Logo.png",
  // TECH_MILESTONES entries carry no `url`, so Wikipedia is their ONLY source —
  // every website/favicon strategy below has no domain to work with. Their
  // `company` values are event phrases ("Apple IPO", "Intel 4004", "Moore's
  // Law"), which land on article pages whose image lists are pure site chrome,
  // so all 16 of these resolved to the same Wikipedia puzzle-globe. Pin them to
  // the parent brand's mark, same as the atari-2600 / netscape-ipo aliases above.
  "app-store-launch": "Apple_logo_black.svg",
  "apple-acquires-next": "Apple_logo_black.svg",
  "apple-ipo": "Apple_logo_black.svg",
  "apple-retail": "Apple_logo_black.svg",
  "apple-think-different": "Apple_logo_black.svg",
  "apple-wwdc": "Apple_logo_black.svg",
  "iphone-announcement": "Apple_logo_black.svg",
  "iphone-on-sale": "Apple_logo_black.svg",
  ipod: "Apple_logo_black.svg",
  "mac-introduction": "Apple_logo_black.svg",
  "intel-4004": "Intel_logo_2023.svg",
  "intel-8086": "Intel_logo_2023.svg",
  "intel-core2": "Intel_logo_2023.svg",
  "intel-pentium": "Intel_logo_2023.svg",
  "moores-law": "Intel_logo_2023.svg",
  "google-ipo": "Google_2015_logo.svg",
  "yahoo-ipo": "Yahoo!_(2019).svg",
  "hp35-calculator": "HP_logo_2012.svg",
};

// SHARED_LOGO_GROUPS (ids that legitimately share one mark) and the audit
// itself live in scripts/lib/logo-audit.mjs so the prebuild gate
// (scripts/check-tech-logos.mjs) enforces the exact same rules on every build.

// ── data parser ──────────────────────────────────────────────────────────────
// Light TS-source parser for the entries we need.
async function loadCompanies() {
  const src = await readFile(DATA_PATH, "utf8");
  const blocks = {
    TECH_COMPANIES: extractArrayBlock(src, "TECH_COMPANIES"),
    SCC_SPOTLIGHT: extractArrayBlock(src, "SCC_SPOTLIGHT"),
    RECENTLY_FUNDED: extractArrayBlock(src, "RECENTLY_FUNDED"),
    TECH_MILESTONES: extractArrayBlock(src, "TECH_MILESTONES"),
    TECH_CONFERENCES: extractArrayBlock(src, "TECH_CONFERENCES"),
  };
  const out = [];
  for (const [groupName, body] of Object.entries(blocks)) {
    if (!body) continue;
    const items = splitObjectLiterals(body);
    for (const item of items) {
      const id = matchField(item, "id");
      if (!id) continue;
      const name =
        matchField(item, "name") ||
        matchField(item, "company") ||
        matchField(item, "title");
      const url =
        matchField(item, "careersUrl") ||
        matchField(item, "url") ||
        matchField(item, "website");
      const stage = matchField(item, "stage");
      out.push({
        id,
        name: name || id,
        url: url || "",
        group: groupName,
        stage: stage || "",
      });
    }
  }
  // De-dupe by id (TECH_COMPANIES + TECH_MILESTONES often share IDs).
  const seen = new Map();
  for (const c of out) {
    const prev = seen.get(c.id);
    if (!prev) seen.set(c.id, c);
    else if (!prev.url && c.url) seen.set(c.id, c); // prefer entry with url
  }
  return [...seen.values()];
}

function extractArrayBlock(src, name) {
  const re = new RegExp(`export\\s+const\\s+${name}[^=]*=\\s*\\[`);
  const m = re.exec(src);
  if (!m) return "";
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

function splitObjectLiterals(body) {
  const items = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") {
      if (depth === 0) buf = "";
      depth++;
      buf += ch;
    } else if (ch === "}") {
      depth--;
      buf += ch;
      if (depth === 0) items.push(buf);
    } else if (depth > 0) {
      buf += ch;
    }
  }
  return items;
}

function matchField(item, field) {
  const re = new RegExp(`\\b${field}\\s*:\\s*"([^"]*)"`);
  const m = re.exec(item);
  return m ? m[1] : null;
}

// ── image utilities ──────────────────────────────────────────────────────────
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  // Use a descriptive UA on Wikimedia hosts (they request this).
  const isWiki = /(\.wikipedia\.org|\.wikimedia\.org|\.wikidata\.org)/.test(url);
  const ua = isWiki ? WIKI_UA : UA;
  // Retry transient errors with longer backoffs on rate-limited Wikipedia.
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: { "User-Agent": ua, ...(opts.headers || {}) },
        redirect: "follow",
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const wait = isWiki ? 2000 * (attempt + 1) : 500 * (attempt + 1);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      if (attempt < 3) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
}

async function fetchBuffer(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: ct };
}

// Decode width/height from PNG/JPEG/GIF/WebP/ICO/SVG headers.
function decodeImageDims(buf, contentType = "") {
  if (!buf || buf.length < 16) return null;
  const sig = buf.slice(0, 8).toString("hex");
  // PNG: 89504e47 0d0a1a0a, then IHDR with dims at offset 16
  if (sig.startsWith("89504e470d0a1a0a")) {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return { w, h, format: "png" };
  }
  // JPEG: ffd8ff
  if (sig.startsWith("ffd8ff")) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        return { w, h, format: "jpeg" };
      }
      const segLen = buf.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
    return null;
  }
  // GIF: 47494638
  if (sig.startsWith("47494638")) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), format: "gif" };
  }
  // WebP: RIFF....WEBP
  const head = buf.slice(0, 12).toString("ascii");
  if (head.startsWith("RIFF") && head.includes("WEBP")) {
    const fourcc = buf.slice(12, 16).toString("ascii");
    if (fourcc === "VP8 ") {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, format: "webp" };
    }
    if (fourcc === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, format: "webp" };
    }
    if (fourcc === "VP8X") {
      const w = (buf.readUIntLE(24, 3) & 0xffffff) + 1;
      const h = (buf.readUIntLE(27, 3) & 0xffffff) + 1;
      return { w, h, format: "webp" };
    }
    return { w: 0, h: 0, format: "webp" };
  }
  // ICO: 00 00 01 00
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) {
    let maxW = 0, maxH = 0;
    const count = buf.readUInt16LE(4);
    for (let n = 0; n < count; n++) {
      const off = 6 + n * 16;
      let w = buf[off];
      let h = buf[off + 1];
      if (w === 0) w = 256;
      if (h === 0) h = 256;
      if (w > maxW) {
        maxW = w;
        maxH = h;
      }
    }
    return { w: maxW, h: maxH, format: "ico" };
  }
  // SVG (XML)
  const txt = buf.slice(0, 200).toString("utf8");
  if (/<svg/i.test(txt) || contentType.includes("svg")) return { w: 999, h: 999, format: "svg" };
  return null;
}

async function imageIsRealLogo(buf, contentType, minSide = 48, minBytes = 1500) {
  if (!buf) return false;
  if (buf.length < minBytes) return false;
  const dims = decodeImageDims(buf, contentType);
  if (!dims) return false;
  if (dims.format === "svg") return true;
  if (dims.w < minSide || dims.h < minSide) return false;
  // Reject icon.horse "letter on grey" placeholders — distinctive low byte count
  // for full 256x256 PNG (single background + a centered letter compresses tiny).
  if (dims.format === "png" && dims.w >= 200 && dims.h >= 200 && buf.length < 4500) {
    // Look at sharp stats — if very few unique colors, it's a placeholder.
    try {
      const { entropy } = await sharp(buf).stats();
      if (typeof entropy === "number" && entropy < 1.3) return false;
    } catch {}
  }
  return true;
}

// ── normalize to PNG, write to public/logos ──────────────────────────────────
async function writeLogo(id, buf, contentType) {
  const dims = decodeImageDims(buf, contentType);
  let outBuf = buf;
  let outExt = "png";
  if (dims?.format === "svg" || /svg/i.test(contentType || "")) {
    // Render SVG to PNG via resvg for consistent sizing
    try {
      const resvg = new Resvg(buf, { fitTo: { mode: "width", value: 512 } });
      outBuf = resvg.render().asPng();
    } catch (e) {
      // If resvg fails, just store the raw SVG
      outExt = "svg";
    }
  } else {
    // Resize down to <=512 max side to keep files reasonable
    try {
      outBuf = await sharp(buf)
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
    } catch (e) {
      // Some ICO files break sharp — fall back to raw
      if (dims?.format === "ico") {
        outExt = "ico";
        outBuf = buf;
      } else {
        throw e;
      }
    }
  }
  const fname = `${id}.${outExt}`;
  const fpath = path.join(LOGO_DIR, fname);
  await writeFile(fpath, outBuf);
  return `/logos/${fname}`;
}

// ── strategies ───────────────────────────────────────────────────────────────
async function resolveCommonsFile(filename) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent("File:" + filename)}&prop=imageinfo&iiprop=url&iiurlwidth=1024&format=json&origin=*`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pages = data?.query?.pages || {};
    for (const p of Object.values(pages)) {
      const info = p.imageinfo?.[0];
      const u = info?.thumburl || info?.url;
      if (u) return u;
    }
  } catch {}
  return null;
}

// Wikimedia sister-project / site chrome. A company named after a common word
// ("Glow", "Hark", "Simile", "Queue") resolves to a dictionary or disambiguation
// page whose image list includes these, and they sail through a bare
// /(logo|wordmark)/ filter — every one of them came back as the same Wiktionary
// mark. Never a company logo; reject by filename before fetching.
const WIKIMEDIA_CHROME =
  /(wiktionary|wikipedia|wikimedia|wikisource|wikiquote|wikibooks|wikinews|wikiversity|wikivoyage|wikidata|wikispecies|commons-logo|mediawiki|meta-wiki|disambig|ambox|question_book|edit-clear|wiki_letter|nuvola|crystal_clear|gnome-|oojs_ui|padlock|portal-puzzle|symbol_|text_document|magnify-clip)/i;

function isWikimediaChrome(filename) {
  return WIKIMEDIA_CHROME.test(String(filename).replace(/^File:/i, ""));
}

async function tryWikipedia(name) {
  if (!name) return null;
  const baseNames = [
    name,
    name.replace(/!/g, ""),
    name.replace(/\s+\(.*\)$/, ""),
    name.split(/\s+/)[0],
  ].filter(Boolean);

  // Strategy A: parse API on a candidate page name → look for logo images
  for (const cand of baseNames) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(cand.replace(/\s+/g, "_"))}&format=json&prop=images&origin=*`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const data = await res.json();
      const imgs = data?.parse?.images || [];
      const logoCandidates = imgs.filter(
        (f) => /(logo|wordmark)/i.test(f) && /\.(svg|png|jpg|jpeg)$/i.test(f) && !isWikimediaChrome(f),
      );
      // Prefer SVG, then PNG. Prefer most recent (year suffix) by sorting desc.
      logoCandidates.sort((a, b) => {
        const av = a.endsWith(".svg") ? 0 : 1;
        const bv = b.endsWith(".svg") ? 0 : 1;
        if (av !== bv) return av - bv;
        const ay = (a.match(/(\d{4})/g) || []).map(Number).pop() || 0;
        const by = (b.match(/(\d{4})/g) || []).map(Number).pop() || 0;
        return by - ay;
      });
      for (const fname of logoCandidates.slice(0, 4)) {
        const u = await resolveCommonsFile(fname);
        if (!u) continue;
        try {
          const got = await fetchBuffer(u);
          if (await imageIsRealLogo(got.buffer, got.contentType, 64, 1500)) return got;
        } catch {}
      }
    } catch {}
  }

  // Strategy B: Commons search for "{name} logo" — also accept SVG titles that
  // are clearly the brand even without "logo" in the filename (e.g. "Yahoo!_(2019).svg")
  try {
    const q = `${baseNames[0]} logo`;
    const url = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srnamespace=6&srlimit=8&format=json&origin=*`;
    const res = await fetchWithTimeout(url);
    if (res.ok) {
      const data = await res.json();
      const hits = data?.query?.search || [];
      const firstWord = baseNames[0].toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, "");
      // Re-rank: prefer SVGs, then ones with "logo" or "wordmark" in name.
      hits.sort((a, b) => {
        const av = a.title.endsWith(".svg") ? 0 : 1;
        const bv = b.title.endsWith(".svg") ? 0 : 1;
        if (av !== bv) return av - bv;
        const al = /logo|wordmark/i.test(a.title) ? 0 : 1;
        const bl = /logo|wordmark/i.test(b.title) ? 0 : 1;
        return al - bl;
      });
      for (const h of hits) {
        const title = h.title || "";
        if (!/\.(svg|png|jpg|jpeg)$/i.test(title)) continue;
        if (isWikimediaChrome(title)) continue;
        const t = title.toLowerCase().replace(/^file:/, "");
        // Must contain the first word of the brand. Strip non-alnum from
        // both sides since titles like "Yahoo!_(2019)" have punctuation.
        const tStripped = t.replace(/[^a-z0-9]/g, "");
        if (!firstWord || !tStripped.includes(firstWord)) continue;
        // Reject building/HQ photos
        if (/(hq|building|headquarters|campus|office|sign|store)/i.test(title) && !/logo|wordmark/i.test(title)) continue;
        // Reject if SVG name doesn't contain logo/wordmark/brand AND is also
        // not just the bare brand name (heuristic: title length close to brand name)
        if (!/logo|wordmark|brand|emblem|icon|symbol/i.test(title)) {
          // Allow if title is close to "{Brand}.svg" or "{Brand}_(year).svg"
          const bare = t.replace(/\.[a-z]+$/, "").replace(/[\s_]+\(.*\)$/, "");
          const bareStripped = bare.replace(/[^a-z0-9]/g, "");
          const brandStripped = baseNames[0].toLowerCase().replace(/[^a-z0-9]/g, "");
          if (bareStripped !== brandStripped) continue;
        }
        const fname = title.replace(/^File:/, "");
        const u = await resolveCommonsFile(fname);
        if (!u) continue;
        try {
          const got = await fetchBuffer(u);
          if (await imageIsRealLogo(got.buffer, got.contentType, 64, 1500)) return got;
        } catch {}
      }
    }
  } catch {}

  // Strategy C: direct filename guesses
  const baseSlug = baseNames[0].replace(/\s+/g, "_");
  const guesses = [
    `${baseSlug}_logo.svg`,
    `${baseSlug}_Logo.svg`,
    `${baseSlug}_logo.png`,
    `${baseSlug}-logo.svg`,
    `${baseSlug}_wordmark.svg`,
    `${baseSlug}.svg`,
  ];
  for (const fname of guesses) {
    const u = await resolveCommonsFile(fname);
    if (!u) continue;
    try {
      const got = await fetchBuffer(u);
      if (await imageIsRealLogo(got.buffer, got.contentType, 64, 1500)) return got;
    } catch {}
  }

  return null;
}

async function tryIconHorse(domain) {
  if (!domain) return null;
  try {
    const got = await fetchBuffer(`https://icon.horse/icon/${domain}`);
    // icon.horse returns 16x16 placeholder ICO when there's no good logo
    if (await imageIsRealLogo(got.buffer, got.contentType, 64, 2000)) return got;
  } catch {}
  return null;
}

async function tryDuckDuckGo(domain) {
  if (!domain) return null;
  try {
    const got = await fetchBuffer(`https://icons.duckduckgo.com/ip3/${domain}.ico`);
    if (await imageIsRealLogo(got.buffer, got.contentType, 64, 2000)) return got;
  } catch {}
  return null;
}

async function tryGoogleFavicon(domain) {
  if (!domain) return null;
  try {
    const got = await fetchBuffer(`https://www.google.com/s2/favicons?domain=${domain}&sz=256`);
    // Google s2 returns 16x16 fallback for unknown — must check dims
    if (await imageIsRealLogo(got.buffer, got.contentType, 64, 1500)) return got;
  } catch {}
  return null;
}

async function tryWebsiteScrape(siteUrl) {
  if (!siteUrl) return null;
  let html;
  try {
    const res = await fetchWithTimeout(siteUrl);
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const tried = new Set();
  const tryUrl = async (u, minSide = 64, minBytes = 1500) => {
    if (!u || tried.has(u)) return null;
    tried.add(u);
    try {
      const abs = new URL(u, siteUrl).toString();
      const got = await fetchBuffer(abs);
      if (await imageIsRealLogo(got.buffer, got.contentType, minSide, minBytes)) return got;
    } catch {}
    return null;
  };

  // 1. apple-touch-icon (usually a clean square logo, 180x180+)
  const appleMatches = [...html.matchAll(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/gi)];
  for (const m of appleMatches) {
    const got = await tryUrl(m[1], 96, 2000);
    if (got) return got;
  }
  const appleMatchesRev = [...html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*apple-touch-icon[^"']*["']/gi)];
  for (const m of appleMatchesRev) {
    const got = await tryUrl(m[1], 96, 2000);
    if (got) return got;
  }

  // 2. <link rel="icon" sizes="..."> — pick high-res ones
  const iconLinks = [...html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi)];
  for (const m of iconLinks) {
    const tag = m[0];
    const sizes = /sizes=["']([^"']+)["']/i.exec(tag)?.[1] || "";
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    const big = sizes && /(\d+)x\1/.test(sizes) && parseInt(sizes.match(/(\d+)x/)[1]) >= 64;
    if (big || !sizes) {
      const got = await tryUrl(href, big ? 64 : 96, 1500);
      if (got) return got;
    }
  }

  // 3. <img> tags with "logo" in src/alt/class — keep these in DOM order so
  //    the header logo wins over a footer logo.
  const imgs = [...html.matchAll(/<img\s+[^>]+>/gi)];
  for (const m of imgs) {
    const tag = m[0];
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    const alt = /\balt=["']([^"']*)["']/i.exec(tag)?.[1] || "";
    const cls = /\bclass=["']([^"']*)["']/i.exec(tag)?.[1] || "";
    const idAttr = /\bid=["']([^"']*)["']/i.exec(tag)?.[1] || "";
    const blob = `${src} ${alt} ${cls} ${idAttr}`.toLowerCase();
    if (!/(logo|wordmark|brand)/.test(blob)) continue;
    if (/\b(footer|partner|client|sponsor|backed|investor)/.test(blob)) continue;
    const got = await tryUrl(src, 64, 1500);
    if (got) return got;
  }

  // 4. og:image / twitter:image (sometimes a logo, sometimes a hero photo —
  //    accepted only if it looks square-ish so we don't get a wide hero image)
  const meta = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of meta) {
    const m = re.exec(html);
    if (m && m[1]) {
      try {
        const abs = new URL(m[1], siteUrl).toString();
        if (tried.has(abs)) continue;
        tried.add(abs);
        const got = await fetchBuffer(abs);
        if (await imageIsRealLogo(got.buffer, got.contentType, 128, 3000)) return got;
      } catch {}
    }
  }

  return null;
}

function urlToDomain(u) {
  if (!u) return "";
  try {
    const host = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    return host.replace(/^(jobs|careers|invest|investor|developer|developers|store|en-us|www2)\./i, "");
  } catch {
    return "";
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(LOGO_DIR, { recursive: true });
  const companies = await loadCompanies();
  const filtered = ONLY_ID ? companies.filter((c) => c.id === ONLY_ID) : companies;
  console.log(`Resolving logos for ${filtered.length} companies...`);

  const manifest = {};
  // Always load existing manifest. --refresh means "re-fetch entries we
  // process this run", not "wipe everything we don't touch."
  if (existsSync(MANIFEST_PATH)) {
    const raw = await readFile(MANIFEST_PATH, "utf8");
    const m = /^\s+"([^"]+)":\s*"([^"]+)"/gm;
    let mm;
    while ((mm = m.exec(raw))) manifest[mm[1]] = mm[2];
  }
  // When NOT refreshing, the per-company loop below also short-circuits on
  // entries that already have a manifest value.

  async function tryPinned(id) {
    const fname = PINNED_WIKI_LOGOS[id];
    if (!fname) return null;
    const u = await resolveCommonsFile(fname);
    if (!u) return null;
    try {
      const got = await fetchBuffer(u);
      if (await imageIsRealLogo(got.buffer, got.contentType, 32, 1500)) return got;
    } catch {}
    return null;
  }

  // Common-word startup names where Wikipedia search returns the wrong subject.
  // Skip Wikipedia for these — go straight to website / icon.horse.
  const SKIP_WIKI_IDS = new Set([
    "sycamore", // matches Indiana State Sycamores sports team
    "aria-networks", // matches Aria opera houses
    "java", // ambiguous; covered by PINNED instead
    "android", // covered by PINNED
    "tesla", // covered by PINNED
  ]);

  // Wikipedia is worse than useless for RECENTLY_FUNDED startups. These are
  // young private companies with no article, and their names are often common
  // words — "Glow", "Hark", "Simile", "Queue", "Terra AI", "Scout AI". The
  // lookup lands on a dictionary or disambiguation page and returns that page's
  // chrome or an unrelated same-named business (Glow → a kiwi bird, Hark → a
  // German stove maker). The company's own favicon is authoritative here, so
  // skip straight to it. Big public companies and historical milestones still
  // use Wikipedia, where it genuinely has the best mark.
  //
  // SCC_SPOTLIGHT carries the same exposure for everything that isn't public
  // yet: it mixes 22 listed companies (Intuit, Broadcom, Synopsys — real
  // articles, best-in-class marks) with 29 private ones whose names are plain
  // nouns. That mix is why the group can't be skipped wholesale, and why not
  // skipping it at all shipped two wrong brands: "Nile" (nilesecure.com)
  // resolved to a Wikimedia Commons UI icon off the river article, and "Kai"
  // (kai.ai) resolved to the logo of KAI Bandara, the Indonesian state
  // railway's airport line. Gate on `stage` instead — private means favicon.
  //
  // `stage` is a funding label, not a fame label, so a few private companies are
  // household enough to have a real article with a clean mark AND a website that
  // serves something useless. Both of these were verified by hand: ampere's own
  // site yields a product photo of a chip on a circuit board, and cohesity's
  // yields a banner whose wordmark is white-on-white. Wikipedia beats the site
  // for exactly these; opt them back in by id rather than widening the rule.
  const FORCE_WIKI_IDS = new Set(["ampere-computing", "cohesity"]);

  const skipWiki = (c) =>
    !FORCE_WIKI_IDS.has(c.id) &&
    (c.group === "RECENTLY_FUNDED" ||
      (c.group === "SCC_SPOTLIGHT" && c.stage !== "public") ||
      SKIP_WIKI_IDS.has(c.id));

  async function resolveOne(c) {
    const domain = urlToDomain(c.url);
    return (
      (await tryPinned(c.id)) ||
      (skipWiki(c) ? null : await tryWikipedia(c.name)) ||
      (await tryIconHorse(domain)) ||
      (await tryWebsiteScrape(c.url)) ||
      (await tryDuckDuckGo(domain)) ||
      (await tryGoogleFavicon(domain))
    );
  }

  let resolved = 0;
  let failed = [];
  for (const c of filtered) {
    if (!REFRESH && manifest[c.id]) {
      resolved++;
      continue;
    }
    process.stdout.write(`  ${c.id.padEnd(28)} `);
    let got;
    try {
      got = await resolveOne(c);
    } catch {}

    if (!got) {
      console.log("✗ no logo");
      failed.push(c);
      await sleep(150);
      continue;
    }
    try {
      const logoUrl = await writeLogo(c.id, got.buffer, got.contentType);
      manifest[c.id] = logoUrl;
      resolved++;
      console.log(`✓ ${logoUrl}`);
    } catch (e) {
      console.log(`✗ write failed: ${e.message}`);
      failed.push(c);
    }
    await sleep(150);
  }

  // Retry pass — Wikipedia/Commons rate-limit during long batches. Wait, retry.
  if (failed.length) {
    console.log(`\nRetrying ${failed.length} failures after 5s cooldown...`);
    await sleep(5000);
    const stillFailed = [];
    for (const c of failed) {
      process.stdout.write(`  ${c.id.padEnd(28)} `);
      let got;
      try {
        got = await resolveOne(c);
      } catch {}
      if (!got) {
        console.log("✗ no logo");
        stillFailed.push(c);
        await sleep(400);
        continue;
      }
      try {
        const logoUrl = await writeLogo(c.id, got.buffer, got.contentType);
        manifest[c.id] = logoUrl;
        resolved++;
        console.log(`✓ ${logoUrl}`);
      } catch (e) {
        console.log(`✗ write failed: ${e.message}`);
        stillFailed.push(c);
      }
      await sleep(400);
    }
    failed = stillFailed;
  }

  // Write manifest TS file
  const sortedIds = Object.keys(manifest).sort();
  const ts = `// AUTO-GENERATED by scripts/fetch-tech-logos.mjs — do not edit by hand
export const TECH_LOGO_MANIFEST: Record<string, string> = {
${sortedIds.map((id) => `  "${id}": "${manifest[id]}",`).join("\n")}
};
`;
  await writeFile(MANIFEST_PATH, ts, "utf8");

  console.log(`\nResolved ${resolved}/${filtered.length} (${failed.length} failed)`);
  if (failed.length) {
    console.log("\nFailed:");
    for (const f of failed) console.log(`  ${f.id}  (${f.name}, ${f.url})`);
  }

  await auditDuplicateLogos(manifest);
}

// One wrong image served as 16 different companies' logos for months because
// nothing ever compared the files on disk. Report anything the audit flags —
// identical bytes across unrelated brands means a strategy fell through to
// somebody's site chrome, which is the one failure mode this page can't afford.
// Warn-only here (the run has already written the manifest); the same audit is
// a hard build failure in scripts/check-tech-logos.mjs.
async function auditDuplicateLogos(manifest) {
  const { missing, duplicates } = await auditLogoManifest(manifest, ROOT);
  if (missing.length) {
    console.log(`\n⚠️  ${missing.length} manifest entr(ies) point at a missing file:`);
    for (const { id, rel } of missing) console.log(`  ${id} → ${rel}`);
  }
  if (!duplicates.length) {
    if (!missing.length) console.log("\nDuplicate audit: OK (no unexpected shared logos)");
    return;
  }
  console.log(`\n⚠️  Duplicate audit: ${duplicates.length} unexpected shared logo(s):`);
  for (const ids of duplicates) console.log(`  ${ids.join(", ")}`);
  console.log(
    "  These ids resolved to byte-identical images. Either pin them in\n" +
      "  PINNED_WIKI_LOGOS or add them to SHARED_LOGO_GROUPS if intentional.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
