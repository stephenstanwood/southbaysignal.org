/**
 * Recover signup-posted status by matching confirmation/welcome emails in
 * Resend to tracker rows. Each "please confirm your subscription" / welcome
 * message is proof we submitted the signup form for that source.
 *
 * Only flips rows currently at "not-attempted" — won't downgrade rows already
 * at receiving/needs-manual/etc.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { head, put } from "@vercel/blob";

const __dirname = dirname(fileURLToPath(import.meta.url));
const token = process.env.BLOB_READ_WRITE_TOKEN;
const resendKey = process.env.RESEND_API_KEY;
if (!token || !resendKey) { console.error("need BLOB_READ_WRITE_TOKEN + RESEND_API_KEY"); process.exit(1); }

const KEY = "lookout/newsletter-tracker.json";

async function rget(p) {
  const r = await fetch(`https://api.resend.com${p}`, { headers: { Authorization: `Bearer ${resendKey}` } });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
}

async function fetchAll() {
  const out = []; let after = null;
  while (true) {
    const qs = new URLSearchParams({ limit: "100" }); if (after) qs.set("after", after);
    const p = await rget(`/emails/receiving?${qs}`);
    const d = p.data ?? []; out.push(...d);
    if (!p.has_more || !d.length) break;
    after = d[d.length - 1].id;
    await new Promise(r => setTimeout(r, 120));
  }
  return out;
}

function parseFrom(raw) {
  if (!raw) return { address: "", displayName: "", domain: "" };
  const m = raw.trim().match(/^(.*?)\s*<([^>]+)>\s*$/);
  const address = (m ? m[2] : raw.trim()).toLowerCase().trim();
  return { address, displayName: m ? m[1].replace(/^["']|["']$/g, "").trim() : "", domain: address.split("@")[1] ?? "" };
}
function nk(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
const STOP = new Set(["www","mail","mailer","mails","email","emails","news","newsletter","info","hello","contact","subscribe","updates","update","noreply","donotreply","bounces","list","lists","campaign","campaigns","relay","smtp","ccsend","mailchimpapp","mailgun","sendgrid","sparkpost","constantcontact","hubspot","klaviyo","mailjet","mandrill","postmark","squarespace","wix","civicplus","opengov","libraryaware","com","org","net","edu","gov","biz","co","city","town","county","the","and","for","inc"]);
function tok(s) { return (s||"").toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>=4&&!STOP.has(t)); }
function frags(d) {
  const skip = new Set(["www","mail","mailer","news","email","em","m","smtp","relay","ccsend","ccsend2","list-manage","list","lt","campaign","go","click","e"]);
  const f = d.toLowerCase().split(".").filter(Boolean).filter(p=>!skip.has(p));
  if (f.length>1) f.pop();
  return f;
}
function score(t, s) {
  if ((t.seenFromAddresses??[]).some(a=>a.toLowerCase()===s.address)) return 1000;
  if (s.domain && (t.seenFromDomains??[]).some(d=>d.toLowerCase()===s.domain)) return 900;
  if (t.signupUrl) { try { if (new URL(t.signupUrl).hostname.toLowerCase().replace(/^www\./,"")===s.domain) return 850; } catch {} }
  const tk = nk(t.name), tik = nk(t.id);
  const fr = [...frags(s.domain), nk(s.displayName), nk(s.address.split("@")[0]||"")].filter(f=>f.length>=5);
  let best = 0;
  for (const f of fr) { const k = nk(f); if (!k) continue;
    if (k===tk||k===tik) best=Math.max(best,700);
    else if (tk.includes(k)||k.includes(tk)) best=Math.max(best,650);
    else if (tik.includes(k)||k.includes(tik)) best=Math.max(best,600);
  }
  if (best>0) return best;
  const st = new Set([...tok(s.displayName),...tok(s.domain),...tok(s.address.split("@")[0]||"")]);
  const tt = new Set([...tok(t.name),...tok(t.id)]);
  let o=0; for (const x of st) if (tt.has(x)) o++;
  if (o>=2) return 450+o*20;
  return 0;
}
function isConfirm(s) {
  s = s ?? "";
  return /confirm|verify|activate|welcome/i.test(s) || /complete.*(registration|signup|sign.up)/i.test(s) || /please.*confirm/i.test(s) || /subscription.+(change|confirmation)/i.test(s) || /thank.*you.*for.*subscribing/i.test(s) || /you.*(have been|are now|'?ve been).*subscribed to/i.test(s) || /you have successfully subscribed/i.test(s) || /opt.?in|opt-in/i.test(s);
}

console.log("fetching Resend inbox...");
const list = await fetchAll();
console.log(`list: ${list.length}`);
const details = [];
for (let i=0;i<list.length;i++) {
  try {
    const d = await rget(`/emails/receiving/${list[i].id}`);
    details.push({ from: d.from ?? list[i].from, subject: d.subject ?? list[i].subject, replyTo: Array.isArray(list[i].reply_to)?list[i].reply_to[0]:null, receivedAt: d.created_at ?? list[i].created_at });
  } catch {}
  if (i%20===19) process.stdout.write(`  ${i+1}/${list.length}\r`);
  await new Promise(r=>setTimeout(r,100));
}
console.log(`\ndetails: ${details.length}`);

const SELF = new Set(["events@in.southbaytoday.org"]);
const IGNORE = new Set(["in.southbaytoday.org","southbaytoday.org","stanwood.dev","gmail.com"]);
for (const e of details) {
  if (SELF.has(parseFrom(e.from).address) && e.replyTo) e.from = e.replyTo;
}

const meta = await head(KEY, { token });
const doc = await (await fetch(`${meta.url}?_cb=${Date.now()}`)).json();
console.log(`tracker: ${doc.targets.length} targets`);

let promoted = 0;
const promotedIds = new Set();
for (const e of details) {
  if (!isConfirm(e.subject)) continue;
  const s = parseFrom(e.from);
  if (!s.address || IGNORE.has(s.domain)) continue;
  let bestScore=0, best=null;
  for (const t of doc.targets) { const sc=score(t,s); if (sc>bestScore){bestScore=sc;best=t;} }
  if (!best || bestScore < 450) continue;
  if (best.status !== "not-attempted") continue;
  best.status = "signup-posted";
  best.attemptedAt = e.receivedAt;
  promoted++;
  promotedIds.add(best.id);
}

doc.updatedAt = new Date().toISOString();
await put(KEY, JSON.stringify(doc, null, 2), {
  access: "public", token, allowOverwrite: true, cacheControlMaxAge: 0, contentType: "application/json",
});

console.log(`promoted ${promoted} rows from not-attempted → signup-posted (${promotedIds.size} unique targets)`);
for (const id of promotedIds) console.log(`  - ${id}`);
