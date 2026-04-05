#!/usr/bin/env /opt/homebrew/bin/node
// ---------------------------------------------------------------------------
// South Bay Signal — Social Analytics Collection
// Fetches engagement metrics from all platforms for recently published posts.
//
// Usage: node scripts/social/collect-metrics.mjs [--days 7]
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-approved-queue.json");
const ANALYTICS_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-analytics.json");

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
const lookbackDays = parseInt(args.find((a, i) => args[i - 1] === "--days") || "7");

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

// ── Platform metric fetchers ──────────────────────────────────────────────

async function fetchXMetrics(postId) {
  const baseUrl = `https://api.twitter.com/2/tweets/${postId}`;
  const queryParams = [["tweet.fields", "public_metrics"]];
  const auth = makeXAuthHeader("GET", baseUrl, queryParams);

  const url = `${baseUrl}?tweet.fields=public_metrics`;
  const res = await fetch(url, {
    headers: { Authorization: auth },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X metrics failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const m = data.data?.public_metrics || {};
  return {
    likes: m.like_count || 0,
    retweets: m.retweet_count || 0,
    replies: m.reply_count || 0,
    impressions: m.impression_count || 0,
  };
}

async function fetchBlueskyMetrics(uri) {
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

  const params = new URLSearchParams({ uri, depth: "0" });
  const res = await fetch(`https://bsky.social/xrpc/app.bsky.feed.getPostThread?${params}`, {
    headers: { Authorization: `Bearer ${session.accessJwt}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bluesky metrics failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const post = data.thread?.post;
  return {
    likes: post?.likeCount || 0,
    reposts: post?.repostCount || 0,
    replies: post?.replyCount || 0,
  };
}

async function fetchFacebookMetrics(postId) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");

  const fields = "reactions.summary(true),comments.summary(true),shares";
  const res = await fetch(
    `https://graph.facebook.com/v25.0/${postId}?fields=${fields}&access_token=${token}`
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook metrics failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    reactions: data.reactions?.summary?.total_count || 0,
    comments: data.comments?.summary?.total_count || 0,
    shares: data.shares?.count || 0,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📊 Collect metrics — last ${lookbackDays} days\n`);

  if (!existsSync(QUEUE_FILE)) {
    console.log("No queue file found.");
    return;
  }

  const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  // Find published posts within the lookback window
  const published = queue.filter((p) => {
    if (!p.published || !p.publishedAt) return false;
    if (p.publishResult === "expired") return false;
    if (!p.publishedTo || !Array.isArray(p.publishedTo)) return false;
    return new Date(p.publishedAt).getTime() >= cutoff;
  });

  if (published.length === 0) {
    console.log("No published posts in the last " + lookbackDays + " days.");
    return;
  }

  console.log(`Found ${published.length} published post(s).\n`);

  const postMetrics = [];

  for (const post of published) {
    const title = post.item?.title || "Untitled";
    console.log(`📌 ${title}`);

    const metrics = {};

    for (const entry of post.publishedTo) {
      if (!entry.ok) continue;

      try {
        switch (entry.platform) {
          case "x": {
            const id = entry.postId || entry.id;
            if (!id) break;
            metrics.x = await fetchXMetrics(id);
            console.log(`   x: ${metrics.x.likes} likes, ${metrics.x.retweets} RTs, ${metrics.x.impressions} impressions`);
            break;
          }

          case "bluesky": {
            const uri = entry.uri || entry.postId;
            if (!uri) break;
            metrics.bluesky = await fetchBlueskyMetrics(uri);
            console.log(`   bluesky: ${metrics.bluesky.likes} likes, ${metrics.bluesky.reposts} reposts`);
            break;
          }

          case "facebook": {
            const id = entry.postId || entry.id;
            if (!id) break;
            metrics.facebook = await fetchFacebookMetrics(id);
            console.log(`   facebook: ${metrics.facebook.reactions} reactions, ${metrics.facebook.comments} comments, ${metrics.facebook.shares} shares`);
            break;
          }

          case "threads":
            console.log("   threads: skipped (no read API for testers)");
            continue;
        }
      } catch (err) {
        console.log(`   ❌ ${entry.platform}: ${err.message}`);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    postMetrics.push({
      title,
      publishedAt: post.publishedAt,
      metrics,
    });
    console.log();
  }

  // Compute summary
  const summary = computeSummary(postMetrics);

  const analytics = {
    lastUpdated: new Date().toISOString(),
    posts: postMetrics,
    summary,
  };

  writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics, null, 2) + "\n");
  console.log(`💾 Saved to ${ANALYTICS_FILE}\n`);

  // Print summary
  console.log("── Summary ──────────────────────────────");
  console.log(`Total posts: ${summary.totalPosts}`);
  if (summary.avgEngagement) {
    const avg = summary.avgEngagement;
    if (avg.x) console.log(`Avg X: ${avg.x.likes} likes, ${avg.x.retweets} RTs, ${avg.x.impressions} impressions`);
    if (avg.bluesky) console.log(`Avg Bluesky: ${avg.bluesky.likes} likes, ${avg.bluesky.reposts} reposts`);
    if (avg.facebook) console.log(`Avg Facebook: ${avg.facebook.reactions} reactions, ${avg.facebook.comments} comments`);
  }
  if (summary.topPost) {
    console.log(`Top post: "${summary.topPost.title}" (${summary.topPost.totalEngagement} total engagements)`);
  }
}

function computeSummary(posts) {
  const summary = {
    totalPosts: posts.length,
    avgEngagement: {},
    topPost: null,
  };

  // Accumulate per-platform totals
  const totals = { x: null, bluesky: null, facebook: null };
  const counts = { x: 0, bluesky: 0, facebook: 0 };

  let topScore = 0;

  for (const post of posts) {
    let postTotal = 0;

    if (post.metrics.x) {
      const m = post.metrics.x;
      if (!totals.x) totals.x = { likes: 0, retweets: 0, replies: 0, impressions: 0 };
      totals.x.likes += m.likes;
      totals.x.retweets += m.retweets;
      totals.x.replies += m.replies;
      totals.x.impressions += m.impressions;
      counts.x++;
      postTotal += m.likes + m.retweets + m.replies;
    }

    if (post.metrics.bluesky) {
      const m = post.metrics.bluesky;
      if (!totals.bluesky) totals.bluesky = { likes: 0, reposts: 0, replies: 0 };
      totals.bluesky.likes += m.likes;
      totals.bluesky.reposts += m.reposts;
      totals.bluesky.replies += m.replies;
      counts.bluesky++;
      postTotal += m.likes + m.reposts + m.replies;
    }

    if (post.metrics.facebook) {
      const m = post.metrics.facebook;
      if (!totals.facebook) totals.facebook = { reactions: 0, comments: 0, shares: 0 };
      totals.facebook.reactions += m.reactions;
      totals.facebook.comments += m.comments;
      totals.facebook.shares += m.shares;
      counts.facebook++;
      postTotal += m.reactions + m.comments + m.shares;
    }

    if (postTotal > topScore) {
      topScore = postTotal;
      summary.topPost = { title: post.title, publishedAt: post.publishedAt, totalEngagement: postTotal };
    }
  }

  // Compute averages
  const round1 = (n) => Math.round(n * 10) / 10;

  if (totals.x && counts.x > 0) {
    summary.avgEngagement.x = {
      likes: round1(totals.x.likes / counts.x),
      retweets: round1(totals.x.retweets / counts.x),
      replies: round1(totals.x.replies / counts.x),
      impressions: round1(totals.x.impressions / counts.x),
    };
  }
  if (totals.bluesky && counts.bluesky > 0) {
    summary.avgEngagement.bluesky = {
      likes: round1(totals.bluesky.likes / counts.bluesky),
      reposts: round1(totals.bluesky.reposts / counts.bluesky),
      replies: round1(totals.bluesky.replies / counts.bluesky),
    };
  }
  if (totals.facebook && counts.facebook > 0) {
    summary.avgEngagement.facebook = {
      reactions: round1(totals.facebook.reactions / counts.facebook),
      comments: round1(totals.facebook.comments / counts.facebook),
      shares: round1(totals.facebook.shares / counts.facebook),
    };
  }

  return summary;
}

main().catch((err) => {
  console.error("Metrics collection error:", err);
  process.exit(1);
});
