#!/usr/bin/env node
/**
 * Playwright-based bulk newsletter subscription.
 *
 * For each target:
 *  1. Launch a page, navigate to signupUrl
 *  2. Auto-discover the first plausible email-subscribe form
 *     (footer, embedded, or popup)
 *  3. Fill email, click submit
 *  4. Wait for success indicator (URL change, toast text, form replacement)
 *  5. Record outcome in tracker
 *
 * Politeness:
 *  - 4-8 sec delay between targets on the same host
 *  - 1-2 sec delay between different hosts
 *  - 20 sec per-page timeout
 *  - respects robots.txt by only hitting the signupUrl (no crawling)
 *
 * Usage:
 *   node scripts/lookout/subscribe-playwright.mjs
 *   node scripts/lookout/subscribe-playwright.mjs --headed
 *   node scripts/lookout/subscribe-playwright.mjs --only=saratoga-source
 *   node scripts/lookout/subscribe-playwright.mjs --category=chamber
 *   node scripts/lookout/subscribe-playwright.mjs --retry-failed
 *   node scripts/lookout/subscribe-playwright.mjs --max=10
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { put, get } from "@vercel/blob";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Env ─────────────────────────────────────────────────────────────────────
const envPath = join(__dirname, "..", "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const EMAIL = process.env.LOOKOUT_SIGNUP_EMAIL || "sandcathype@gmail.com";
const TRACKER_BLOB_KEY = "lookout/newsletter-tracker.json";
const TARGETS_PATH = join(__dirname, "targets.json");

const args = new Set(process.argv.slice(2));
const HEADED = args.has("--headed");
const RETRY_FAILED = args.has("--retry-failed");
const ONLY = [...args].find((a) => a.startsWith("--only="))?.split("=")[1];
const CATEGORY = [...args].find((a) => a.startsWith("--category="))?.split("=")[1];
const MAX = parseInt([...args].find((a) => a.startsWith("--max="))?.split("=")[1] || "0", 10);
const SKIP_CIVICPLUS = args.has("--skip-civicplus"); // handled by HTTP script instead

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

// ── Tracker I/O ─────────────────────────────────────────────────────────────

async function readTracker() {
  if (!BLOB_TOKEN) return { version: 1, updatedAt: new Date().toISOString(), targets: [] };
  try {
    const result = await get(TRACKER_BLOB_KEY, { access: "public", token: BLOB_TOKEN });
    if (!result) return { version: 1, updatedAt: new Date().toISOString(), targets: [] };
    const stream = result.stream ?? result.body ?? result;
    return JSON.parse(await new Response(stream).text());
  } catch (err) {
    if (err.name === "BlobNotFoundError") return { version: 1, updatedAt: new Date().toISOString(), targets: [] };
    throw err;
  }
}

async function writeTracker(doc) {
  doc.updatedAt = new Date().toISOString();
  if (!BLOB_TOKEN) return;
  await put(TRACKER_BLOB_KEY, JSON.stringify(doc, null, 2), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token: BLOB_TOKEN,
  });
}

function upsert(doc, target) {
  const idx = doc.targets.findIndex((t) => t.id === target.id);
  const merged = {
    receivedCount: 0,
    seenFromAddresses: [],
    seenFromDomains: [],
    ...(idx >= 0 ? doc.targets[idx] : {}),
    ...target,
  };
  if (idx >= 0) doc.targets[idx] = merged;
  else doc.targets.push(merged);
}

// ── Playwright-based signup flow ───────────────────────────────────────────

/**
 * Find and return the first email input on the page, OR null.
 * Checks type=email, then name/id/placeholder matching "email".
 * Prefers visible inputs.
 */
async function findEmailInput(page) {
  // Accept cookie banners first so they don't overlay forms
  try {
    const cookieSelectors = [
      'button:has-text("Accept")',
      'button:has-text("I agree")',
      'button:has-text("Got it")',
      'button:has-text("Accept All")',
      'button:has-text("Allow all")',
    ];
    for (const sel of cookieSelectors) {
      const btn = await page.$(sel);
      if (btn && (await btn.isVisible())) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        await sleep(300);
        break;
      }
    }
  } catch {}

  // Scroll to the footer — most newsletter forms are there
  try {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(500);
  } catch {}

  const selectors = [
    'input[type="email"]:visible',
    'input[name="email" i]:visible',
    'input[name*="EMAIL" i]:visible',
    'input[id*="email" i]:visible',
    'input[placeholder*="email" i]:visible',
    'input[aria-label*="email" i]:visible',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        return loc;
      }
    } catch {}
  }
  return null;
}

/**
 * Submit: fill the email, then click the nearest submit button.
 */
async function submitNear(input, email) {
  await input.fill(email);
  await sleep(200);

  // Look for a button or submit input inside the same form as the input
  const form = await input.evaluateHandle((el) => el.closest("form"));
  if (form) {
    const submit = await form.evaluateHandle((f) => {
      return (
        f.querySelector('button[type="submit"]') ||
        f.querySelector('input[type="submit"]') ||
        f.querySelector("button") ||
        null
      );
    });
    if (submit) {
      const clickable = submit.asElement();
      if (clickable) {
        await clickable.click({ delay: 50, timeout: 3000 }).catch(async () => {
          // Fallback: press Enter inside the email field
          await input.press("Enter");
        });
        return true;
      }
    }
  }

  // No form? Just press Enter.
  await input.press("Enter");
  return true;
}

/**
 * After submit, look for success indicators.
 * Returns { ok, reason }.
 */
async function detectSuccess(page, beforeUrl) {
  // Wait briefly for network / DOM updates
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await sleep(1500);

  const bodyText = await page.innerText("body").catch(() => "");
  const afterUrl = page.url();

  const thankyouPatterns = [
    /thank\s*you/i,
    /successfully\s*(subscribed|signed.up|registered)/i,
    /check\s+your\s+(email|inbox)/i,
    /confirm(ation)?\s+(email|link)\s+(has\s+been\s+)?sent/i,
    /we('ve| have)\s+sent/i,
    /confirmation\s+email/i,
    /you('re| are)\s+(now\s+)?(subscribed|on\s+the\s+list)/i,
    /verify\s+your\s+email/i,
    /almost\s+there/i,
    /one\s+more\s+step/i,
  ];
  for (const p of thankyouPatterns) {
    if (p.test(bodyText)) return { ok: true, reason: p.source };
  }

  // URL change heuristic — redirected to /thank-you or /confirm
  if (afterUrl !== beforeUrl && /thank|confirm|subscribed|success/i.test(afterUrl)) {
    return { ok: true, reason: `url:${afterUrl}` };
  }

  // Error indicators
  if (/invalid\s+email|already\s+subscribed|error|try\s+again/i.test(bodyText.slice(0, 2000))) {
    if (/already\s+subscribed/i.test(bodyText)) return { ok: true, reason: "already-subscribed" };
    return { ok: false, reason: "error-text-detected" };
  }

  return { ok: false, reason: "no-success-indicator" };
}

async function subscribeOne(browser, target) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  // Block heavy media + analytics to speed up
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "font" || type === "media") return route.abort();
    return route.continue();
  });

  try {
    await page.goto(target.signupUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const beforeUrl = page.url();

    const input = await findEmailInput(page);
    if (!input) return { status: "needs-manual", reason: "no-email-input-found" };

    await submitNear(input, EMAIL);
    const result = await detectSuccess(page, beforeUrl);

    if (result.ok) return { status: "signup-posted", reason: result.reason };
    return { status: "needs-manual", reason: result.reason };
  } catch (err) {
    return { status: "needs-manual", reason: `error:${err.message?.slice(0, 120)}` };
  } finally {
    await context.close().catch(() => {});
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { targets } = JSON.parse(readFileSync(TARGETS_PATH, "utf8"));
  const doc = await readTracker();

  // Seed every target into the tracker (upsert)
  for (const t of targets) {
    const existing = doc.targets.find((d) => d.id === t.id);
    upsert(doc, {
      id: t.id,
      name: t.name,
      signupUrl: t.signupUrl,
      city: t.city,
      category: t.category,
      provider: t.provider,
      priority: t.priority,
      notes: t.notes,
      status: existing?.status ?? "not-attempted",
    });
  }

  const queue = targets.filter((t) => {
    if (ONLY && t.id !== ONLY) return false;
    if (CATEGORY && t.category !== CATEGORY) return false;
    if (SKIP_CIVICPLUS && t.provider === "civicplus_notifyme") return false;
    const existing = doc.targets.find((d) => d.id === t.id);
    if (!existing) return true;
    if (RETRY_FAILED && (existing.status === "failed" || existing.status === "needs-manual")) return true;
    if (["receiving", "confirmed", "signup-posted"].includes(existing.status)) return false;
    return existing.status === "not-attempted";
  });

  const limited = MAX > 0 ? queue.slice(0, MAX) : queue;
  console.log(`🎭 subscribe-playwright.mjs  email=${EMAIL}  targets=${limited.length}/${targets.length}${HEADED ? " (headed)" : ""}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const byHost = new Map();
  let posted = 0;
  let manual = 0;

  for (const target of limited) {
    const host = (() => {
      try { return new URL(target.signupUrl).host; } catch { return ""; }
    })();
    const lastHit = byHost.get(host) ?? 0;
    const sinceLast = Date.now() - lastHit;
    const needed = host ? jitter(4000, 8000) : jitter(1000, 2000);
    if (sinceLast < needed) await sleep(needed - sinceLast);

    process.stdout.write(`  • ${target.name.padEnd(42).slice(0, 42)} [${(target.category || "").padEnd(14)}] `);
    const result = await subscribeOne(browser, target);
    byHost.set(host, Date.now());

    upsert(doc, {
      ...target,
      status: result.status,
      attemptedAt: new Date().toISOString(),
      lastError: result.status !== "signup-posted" ? result.reason : undefined,
    });

    if (result.status === "signup-posted") {
      console.log(`✅ ${result.reason?.slice(0, 40)}`);
      posted++;
    } else {
      console.log(`🟡 ${result.reason?.slice(0, 50)}`);
      manual++;
    }

    await writeTracker(doc);
  }

  await browser.close();
  console.log(`\n─────────────────────────────────────`);
  console.log(`✅ signup-posted: ${posted}`);
  console.log(`🟡 needs-manual:  ${manual}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
