#!/usr/bin/env /opt/homebrew/bin/node
// ---------------------------------------------------------------------------
// South Bay Signal — Post-Publish Verification
// Checks that recently published posts actually exist on each platform.
//
// Usage: node scripts/social/verify-posts.mjs [--window 30]
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-approved-queue.json");

const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1488592203251978271/Qf_2sPiCbbuQLnmn6AcSXmD7OfTQbbkKo2J-4K2FiASnQ-F3G0W71bfGwtJqfCKYrklz";

// Load env
try {
  const envPath = join(__dirname, "..", "..", ".env.local");
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const args = process.argv.slice(2);
const windowMinutes = parseInt(args.find((a, i) => args[i - 1] === "--window") || "30");

// ── X OAuth 1.0a signing ──────────────────────────────────────────────────

function percentEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function buildSignatureBaseString(method, url, params) {
  const sorted = [...params].sort((a, b) => a[0].localeCompare(b[0]));
  const paramStr = sorted.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join("&");
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramStr)}`;
}

function signOAuth(baseString, consumerSecret, tokenSecret) {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(baseString).digest("base64");
}

function makeXAuthHeader(method, url, queryParams = []) {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
    throw new Error("Missing X/Twitter credentials");
  }

  const oauthParams = [
    ["oauth_consumer_key", apiKey],
    ["oauth_nonce", randomBytes(16).toString("hex")],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", Math.floor(Date.now() / 1000).toString()],
    ["oauth_token", accessToken],
    ["oauth_version", "1.0"],
  ];

  const allParams = [...oauthParams, ...queryParams];
  const baseString = buildSignatureBaseString(method, url, allParams);
  const signature = signOAuth(baseString, apiSecret, accessTokenSecret);
  oauthParams.push(["oauth_signature", signature]);

  const parts = oauthParams
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ");
  return `OAuth ${parts}`;
}

// ── Platform verifiers ────────────────────────────────────────────────────

async function verifyX(postId) {
  const url = `https://api.twitter.com/2/tweets/${postId}`;
  const auth = makeXAuthHeader("GET", url);

  const res = await fetch(url, {
    headers: { Authorization: auth },
  });

  if (res.ok) {
    const data = await res.json();
    return { exists: true, id: data.data?.id };
  }
  if (res.status === 404) return { exists: false };
  const body = await res.text();
  return { exists: false, error: `${res.status}: ${body}` };
}

async function verifyBluesky(uri) {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) throw new Error("Missing Bluesky credentials");

  // Create session
  const authRes = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });
  if (!authRes.ok) throw new Error(`Bluesky auth failed: ${authRes.status}`);
  const session = await authRes.json();

  // Get post thread
  const params = new URLSearchParams({ uri, depth: "0" });
  const res = await fetch(`https://bsky.social/xrpc/app.bsky.feed.getPostThread?${params}`, {
    headers: { Authorization: `Bearer ${session.accessJwt}` },
  });

  if (res.ok) {
    const data = await res.json();
    return { exists: true, uri: data.thread?.post?.uri };
  }
  if (res.status === 404 || res.status === 400) return { exists: false };
  const body = await res.text();
  return { exists: false, error: `${res.status}: ${body}` };
}

async function verifyFacebook(postId) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");

  const res = await fetch(
    `https://graph.facebook.com/v25.0/${postId}?fields=id&access_token=${token}`
  );

  if (res.ok) {
    const data = await res.json();
    return { exists: true, id: data.id };
  }
  if (res.status === 404) return { exists: false };
  const body = await res.text();
  return { exists: false, error: `${res.status}: ${body}` };
}

// ── Discord notification ──────────────────────────────────────────────────

async function sendDiscordAlert(message) {
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch (err) {
    console.error("Discord webhook failed:", err.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Verify posts — window: ${windowMinutes} minutes\n`);

  if (!existsSync(QUEUE_FILE)) {
    console.log("No queue file found.");
    return;
  }

  const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  const cutoff = Date.now() - windowMinutes * 60 * 1000;

  // Find recently published posts
  const recent = queue.filter((p) => {
    if (!p.published || !p.publishedAt) return false;
    if (p.publishResult === "expired") return false;
    return new Date(p.publishedAt).getTime() >= cutoff;
  });

  if (recent.length === 0) {
    console.log("No posts published in the last " + windowMinutes + " minutes.");
    return;
  }

  console.log(`Found ${recent.length} recently published post(s).\n`);

  const missing = [];

  for (const post of recent) {
    const title = post.item?.title || "Untitled";
    console.log(`📌 ${title}`);

    if (!post.publishedTo || !Array.isArray(post.publishedTo)) {
      console.log("   ⚠️  No publishedTo data, skipping.\n");
      continue;
    }

    for (const entry of post.publishedTo) {
      if (!entry.ok) {
        console.log(`   ⏭️  ${entry.platform}: publish failed, skipping`);
        continue;
      }

      try {
        let result;
        switch (entry.platform) {
          case "x":
            if (!entry.postId && !entry.id) {
              console.log("   ⚠️  x: no post ID recorded");
              continue;
            }
            result = await verifyX(entry.postId || entry.id);
            break;

          case "bluesky":
            if (!entry.uri && !entry.postId) {
              console.log("   ⚠️  bluesky: no URI recorded");
              continue;
            }
            result = await verifyBluesky(entry.uri || entry.postId);
            break;

          case "facebook":
            if (!entry.postId && !entry.id) {
              console.log("   ⚠️  facebook: no post ID recorded");
              continue;
            }
            result = await verifyFacebook(entry.postId || entry.id);
            break;

          case "threads":
            console.log("   ⏭️  threads: no read API for testers");
            continue;

          default:
            console.log(`   ⏭️  ${entry.platform}: unknown platform`);
            continue;
        }

        if (result.exists) {
          console.log(`   ✅ ${entry.platform}: verified`);
        } else {
          console.log(`   ❌ ${entry.platform}: MISSING${result.error ? ` (${result.error})` : ""}`);
          missing.push({ title, platform: entry.platform, error: result.error });
        }
      } catch (err) {
        console.log(`   ❌ ${entry.platform}: verification error — ${err.message}`);
        missing.push({ title, platform: entry.platform, error: err.message });
      }

      // Brief pause between API calls
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log();
  }

  // Summary
  if (missing.length === 0) {
    console.log("✅ All posts verified successfully.");
  } else {
    console.log(`⚠️  ${missing.length} missing post(s) detected!\n`);

    const lines = missing.map(
      (m) => `• **${m.title}** on ${m.platform}${m.error ? ` — ${m.error}` : ""}`
    );
    const alertMsg = `🚨 **Post Verification Alert**\n${missing.length} post(s) missing after publish:\n${lines.join("\n")}`;

    console.log("Sending Discord alert...");
    await sendDiscordAlert(alertMsg);
    console.log("Alert sent.");
  }
}

main().catch((err) => {
  console.error("Verification error:", err);
  process.exit(1);
});
