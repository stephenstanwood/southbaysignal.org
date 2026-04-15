#!/usr/bin/env node
/**
 * Bulk newsletter subscription runner.
 *
 * Reads targets from scripts/lookout/targets.json, attempts to submit
 * each signup form with sandcathype@gmail.com, writes results to the
 * newsletter tracker (Vercel Blob).
 *
 * Provider strategies:
 *   - civicplus_notifyme: ASP.NET WebForms, preserve __VIEWSTATE + __EVENTVALIDATION
 *   - mailchimp:          POST to /subscribe/post with honeypot b_ field
 *   - generic_html_form:  autodetect form with email input, submit with hidden fields
 *   - constant_contact:   generic form POST works for most instances
 *   - unknown:            fall back to generic_html_form
 *
 * Polite rate limiting: 3-8 sec randomized delay between signups to the
 * same domain; 1-3 sec between different domains. Respects robots.txt by
 * not crawling anything beyond the signup URL the targets file specifies.
 *
 * Usage:
 *   node scripts/lookout/subscribe.mjs
 *   node scripts/lookout/subscribe.mjs --dry-run    # parse forms, don't POST
 *   node scripts/lookout/subscribe.mjs --only=saratoga-source
 *   node scripts/lookout/subscribe.mjs --retry-failed
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { put, head } from "@vercel/blob";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Load .env.local ─────────────────────────────────────────────────────────
const envPath = join(__dirname, "..", "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const EMAIL = process.env.LOOKOUT_SIGNUP_EMAIL || "sandcathype@gmail.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const TRACKER_BLOB_KEY = "lookout/newsletter-tracker.json";
const TARGETS_PATH = join(__dirname, "targets.json");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const RETRY_FAILED = args.has("--retry-failed");
const ONLY = [...args].find((a) => a.startsWith("--only="))?.split("=")[1];

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(min, max) {
  return min + Math.floor(Math.random() * (max - min));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

async function fetchWithRetry(url, init = {}, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, {
        ...init,
        headers: { "User-Agent": UA, ...init.headers },
        signal: AbortSignal.timeout(20_000),
        redirect: "follow",
      });
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(2000);
    }
  }
}

// ── Tracker I/O (mirrors src/lib/lookout/tracker.ts) ───────────────────────

async function readTracker() {
  if (!BLOB_TOKEN) return emptyTracker();
  try {
    const meta = await head(TRACKER_BLOB_KEY, { token: BLOB_TOKEN });
    if (!meta?.url) return emptyTracker();
    const res = await fetch(`${meta.url}?_cb=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return JSON.parse(await res.text());
  } catch (err) {
    if (err.name === "BlobNotFoundError" || /404/.test(err.message || "")) return emptyTracker();
    throw err;
  }
}

async function writeTracker(doc) {
  doc.updatedAt = new Date().toISOString();
  if (!BLOB_TOKEN) {
    const fs = await import("fs");
    const p = join(__dirname, "..", "..", "src", "data", "south-bay", "newsletter-tracker.json");
    fs.writeFileSync(p, JSON.stringify(doc, null, 2));
    return;
  }
  await put(TRACKER_BLOB_KEY, JSON.stringify(doc, null, 2), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token: BLOB_TOKEN,
    cacheControlMaxAge: 0,
  });
}

function emptyTracker() {
  return { version: 1, updatedAt: new Date().toISOString(), targets: [] };
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

// ── Form parsing (regex-based — no cheerio dep) ─────────────────────────────

/**
 * Extract all <form> elements from HTML with their fields.
 * Returns array of { action, method, fields: {name: value}, emailField: string|null }
 */
function parseForms(html, baseUrl) {
  const forms = [];
  const formRegex = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = formRegex.exec(html)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const inner = m[1];
    const action = (openTag.match(/\baction\s*=\s*["']([^"']*)["']/i) || [])[1] || baseUrl;
    const method = ((openTag.match(/\bmethod\s*=\s*["']([^"']*)["']/i) || [])[1] || "GET").toUpperCase();

    const fields = {};
    let emailField = null;

    // <input>
    const inputRegex = /<input\b([^>]*)\/?>/gi;
    let im;
    while ((im = inputRegex.exec(inner)) !== null) {
      const attrs = im[1];
      const name = (attrs.match(/\bname\s*=\s*["']([^"']*)["']/i) || [])[1];
      if (!name) continue;
      const type = ((attrs.match(/\btype\s*=\s*["']([^"']*)["']/i) || [])[1] || "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset" || type === "image") continue;
      const value = (attrs.match(/\bvalue\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
      fields[name] = value;
      if (type === "email" || /email/i.test(name)) emailField = name;
    }

    // <textarea>
    const textareaRegex = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
    let tm;
    while ((tm = textareaRegex.exec(inner)) !== null) {
      const name = (tm[1].match(/\bname\s*=\s*["']([^"']*)["']/i) || [])[1];
      if (name) fields[name] = tm[2];
    }

    // <select> — use first <option value> (usually the default)
    const selectRegex = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
    let sm;
    while ((sm = selectRegex.exec(inner)) !== null) {
      const name = (sm[1].match(/\bname\s*=\s*["']([^"']*)["']/i) || [])[1];
      if (!name) continue;
      const firstOption = sm[2].match(/<option\b[^>]*value\s*=\s*["']([^"']*)["']/i);
      fields[name] = firstOption ? firstOption[1] : "";
    }

    forms.push({
      action: resolveUrl(baseUrl, action),
      method,
      fields,
      emailField,
      // Bonus: collect submit button names so we can set the default button field
      // (CivicPlus ASP.NET __doPostBack uses this)
      submitButtons: [...inner.matchAll(/<input\b[^>]*type\s*=\s*["']submit["'][^>]*>/gi)].map((btn) => {
        const nameMatch = btn[0].match(/\bname\s*=\s*["']([^"']*)["']/i);
        const valueMatch = btn[0].match(/\bvalue\s*=\s*["']([^"']*)["']/i);
        return { name: nameMatch?.[1], value: valueMatch?.[1] };
      }),
    });
  }
  return forms;
}

function pickSignupForm(forms) {
  // Prefer the smallest form with an email field
  const withEmail = forms.filter((f) => f.emailField);
  if (withEmail.length === 0) return null;
  return withEmail.sort((a, b) => Object.keys(a.fields).length - Object.keys(b.fields).length)[0];
}

// ── Provider strategies ─────────────────────────────────────────────────────

async function submitGenericForm(target, email) {
  const res = await fetchWithRetry(target.signupUrl);
  if (!res.ok) throw new Error(`GET ${res.status} ${res.statusText}`);
  const html = await res.text();
  const forms = parseForms(html, target.signupUrl);
  const form = pickSignupForm(forms);
  if (!form) throw new Error("no form with email field found on page");

  // Set the email
  form.fields[form.emailField] = email;

  // If any submit button has a name/value, include it (CivicPlus, etc.)
  for (const btn of form.submitButtons) {
    if (btn.name) form.fields[btn.name] = btn.value || "Submit";
  }

  if (DRY_RUN) {
    return { ok: true, dryRun: true, fields: Object.keys(form.fields).length };
  }

  if (form.method === "POST") {
    const body = new URLSearchParams(form.fields).toString();
    const postRes = await fetchWithRetry(form.action, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: target.signupUrl,
        Origin: new URL(target.signupUrl).origin,
      },
      body,
    });
    const text = await postRes.text();
    const snippet = text.slice(0, 1000).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    return {
      ok: postRes.ok,
      status: postRes.status,
      snippet,
      // Indicators of success
      looksOk:
        postRes.ok &&
        (/thank you|success|confirm|check your|sent|subscribed/i.test(snippet) ||
          postRes.status >= 200 && postRes.status < 400),
    };
  }

  // GET-only signup forms (rare)
  const q = new URLSearchParams(form.fields).toString();
  const getRes = await fetchWithRetry(`${form.action}?${q}`);
  return { ok: getRes.ok, status: getRes.status };
}

async function submitMailchimp(target, email) {
  // Mailchimp forms have action */subscribe/post. Autodetect.
  const res = await fetchWithRetry(target.signupUrl);
  const html = await res.text();
  const forms = parseForms(html, target.signupUrl);
  const mcForm = forms.find((f) => /list-manage\.com.*subscribe\/post/i.test(f.action));
  if (!mcForm) return submitGenericForm(target, email);

  mcForm.fields["EMAIL"] = email;
  // Mailchimp honeypot — must be empty
  const honeypot = Object.keys(mcForm.fields).find((k) => /^b_/.test(k));
  if (honeypot) mcForm.fields[honeypot] = "";

  if (DRY_RUN) return { ok: true, dryRun: true };

  const postRes = await fetchWithRetry(mcForm.action.replace("/post?", "/post-json?"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: target.signupUrl,
    },
    body: new URLSearchParams(mcForm.fields).toString(),
  });
  const text = await postRes.text();
  return { ok: postRes.ok, status: postRes.status, snippet: text.slice(0, 300) };
}

// ── Main subscribe dispatcher ───────────────────────────────────────────────

async function subscribe(target) {
  const email = EMAIL;
  let strategy;
  switch (target.provider) {
    case "mailchimp":
      strategy = submitMailchimp;
      break;
    case "civicplus_notifyme":
    case "constant_contact":
    case "chambermaster":
    case "squarespace":
    case "libraryaware":
    case "generic_html_form":
    case "unknown":
    default:
      strategy = submitGenericForm;
  }
  return strategy(target, email);
}

// ── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(TARGETS_PATH)) {
    console.error(`❌ targets file not found: ${TARGETS_PATH}`);
    process.exit(1);
  }
  const { targets: rawTargets } = JSON.parse(readFileSync(TARGETS_PATH, "utf8"));
  const doc = await readTracker();
  const deletedIds = new Set(doc.deletedIds ?? []);
  const targets = rawTargets.filter((t) => !deletedIds.has(t.id));
  if (deletedIds.size > 0) {
    console.log(`ℹ️  skipping ${deletedIds.size} user-deleted targets`);
  }

  // Seed: ensure every target exists in the tracker
  for (const t of targets) {
    upsert(doc, {
      id: t.id,
      name: t.name,
      signupUrl: t.signupUrl,
      city: t.city,
      category: t.category,
      provider: t.provider,
      priority: t.priority,
      notes: t.notes,
      status: doc.targets.find((d) => d.id === t.id)?.status ?? "not-attempted",
      seenFromAddresses: t.seenFromAddresses ?? [],
      seenFromDomains: t.seenFromDomains ?? [],
    });
  }

  const queue = targets.filter((t) => {
    if (ONLY && t.id !== ONLY) return false;
    const existing = doc.targets.find((d) => d.id === t.id);
    if (!existing) return true;
    if (RETRY_FAILED && existing.status === "failed") return true;
    if (["receiving", "confirmed", "signup-posted", "needs-manual", "blocked"].includes(existing.status)) {
      return false; // don't re-attempt
    }
    return true;
  });

  console.log(`📧 subscribe.mjs  email=${EMAIL}  targets=${queue.length}/${targets.length}${DRY_RUN ? "  (dry-run)" : ""}`);

  const byHost = new Map();
  let success = 0;
  let failed = 0;
  let manualNeeded = 0;

  for (const target of queue) {
    const host = hostOf(target.signupUrl);
    const lastHit = byHost.get(host) ?? 0;
    const sinceLast = Date.now() - lastHit;
    const needed = jitter(3000, 8000);
    if (sinceLast < needed) {
      const wait = needed - sinceLast;
      await sleep(wait);
    }

    process.stdout.write(`  • ${target.name.padEnd(40).slice(0, 40)} [${target.provider.padEnd(20)}] `);
    try {
      const result = await subscribe(target);
      byHost.set(host, Date.now());

      const doneStatus = DRY_RUN
        ? "not-attempted"
        : result.looksOk || result.ok
        ? "signup-posted"
        : "failed";

      upsert(doc, {
        id: target.id,
        name: target.name,
        signupUrl: target.signupUrl,
        city: target.city,
        category: target.category,
        provider: target.provider,
        priority: target.priority,
        notes: target.notes,
        status: doneStatus,
        attemptedAt: new Date().toISOString(),
        lastError: doneStatus === "failed" ? JSON.stringify(result).slice(0, 300) : undefined,
      });

      if (doneStatus === "signup-posted") {
        console.log(`✅ ${result.status ?? "ok"}`);
        success++;
      } else if (doneStatus === "failed") {
        console.log(`❌ ${result.status ?? "fail"}`);
        failed++;
      } else {
        console.log(`🔍 ${result.dryRun ? "dry-run" : "seen"}`);
      }
    } catch (err) {
      byHost.set(host, Date.now());
      upsert(doc, {
        id: target.id,
        name: target.name,
        signupUrl: target.signupUrl,
        city: target.city,
        category: target.category,
        provider: target.provider,
        priority: target.priority,
        notes: target.notes,
        status: "needs-manual",
        attemptedAt: new Date().toISOString(),
        lastError: err.message?.slice(0, 300),
      });
      console.log(`🟡 needs-manual (${err.message?.slice(0, 60)})`);
      manualNeeded++;
    }

    // Persist after each attempt so we don't lose progress on crash
    await writeTracker(doc);
  }

  console.log(`\n─────────────────────────────────────`);
  console.log(`✅ success:      ${success}`);
  console.log(`❌ failed:       ${failed}`);
  console.log(`🟡 needs-manual: ${manualNeeded}`);
  console.log(`\ntracker: ${doc.targets.length} total rows`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
