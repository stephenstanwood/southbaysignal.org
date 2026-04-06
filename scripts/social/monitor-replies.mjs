#!/usr/bin/env /opt/homebrew/bin/node
// ---------------------------------------------------------------------------
// South Bay Signal — Reply Monitor & Auto-Interaction
// Monitors replies on Bluesky, Threads, Facebook, and X (Twitter).
// Classifies replies with Claude Haiku and auto-acts on simple ones.
//
// Usage: node scripts/social/monitor-replies.mjs [--dry-run]
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-approved-queue.json");
const REPLIES_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-replies.json");

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const BSKY_API = "https://bsky.social/xrpc";
const THREADS_API = "https://graph.threads.net/v1.0";
const FB_API = "https://graph.facebook.com/v25.0";
const X_API = "https://api.twitter.com";
const LOOKBACK_DAYS = 7;

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
const dryRun = args.includes("--dry-run");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Bluesky auth ─────────────────────────────────────────────────────────

let _bskySession = null;

async function bskyCreateSession() {
  if (_bskySession) return _bskySession;
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) throw new Error("Missing BLUESKY_HANDLE or BLUESKY_APP_PASSWORD");

  const res = await fetch(`${BSKY_API}/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bluesky auth failed (${res.status}): ${text}`);
  }
  _bskySession = await res.json();
  return _bskySession;
}

// ── Load recently published posts ────────────────────────────────────────

function loadRecentPublished() {
  if (!existsSync(QUEUE_FILE)) return [];
  const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  return queue.filter((p) => {
    if (!p.published || !p.publishedAt) return false;
    if (p.publishResult === "expired") return false;
    if (!p.publishedTo || !Array.isArray(p.publishedTo)) return false;
    return new Date(p.publishedAt).getTime() >= cutoff;
  });
}

// ── Load existing replies ────────────────────────────────────────────────

function loadReplies() {
  if (!existsSync(REPLIES_FILE)) {
    return { lastChecked: null, replies: [] };
  }
  try {
    return JSON.parse(readFileSync(REPLIES_FILE, "utf8"));
  } catch {
    return { lastChecked: null, replies: [] };
  }
}

function saveReplies(data) {
  writeFileSync(REPLIES_FILE, JSON.stringify(data, null, 2) + "\n");
}

// ── Bluesky: fetch replies ───────────────────────────────────────────────

function bskyPermalink(uri) {
  // AT URI: at://did:plc:xxx/app.bsky.feed.post/rkey
  const parts = uri.split("/");
  const rkey = parts[parts.length - 1];
  const did = parts[2];
  // We need the handle, but we can use the DID-based URL that redirects
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

function extractBskyReplies(thread, originalUri, postTitle) {
  const replies = [];
  if (!thread?.replies) return replies;

  for (const reply of thread.replies) {
    const post = reply?.post;
    if (!post) continue;

    const author = post.author?.handle || post.author?.displayName || "unknown";
    const text = post.record?.text || "";
    const timestamp = post.record?.createdAt || post.indexedAt || new Date().toISOString();

    replies.push({
      id: `bsky-${post.uri}`,
      platform: "bluesky",
      postTitle,
      postId: originalUri,
      author,
      text,
      timestamp,
      permalink: bskyPermalink(post.uri),
      replyUri: post.uri,
      replyCid: post.cid,
      classified: null,
      responded: false,
      liked: false,
      action: null,
      actionNote: null,
    });

    // Recurse into nested replies
    if (reply.replies?.length) {
      replies.push(...extractBskyReplies(reply, originalUri, postTitle));
    }
  }
  return replies;
}

async function fetchBlueskyReplies(published) {
  const session = await bskyCreateSession();
  const allReplies = [];

  for (const post of published) {
    const bskyEntry = post.publishedTo.find((e) => e.platform === "bluesky" && e.ok && e.uri);
    if (!bskyEntry) continue;

    const title = post.item?.title || "Untitled";

    try {
      const params = new URLSearchParams({ uri: bskyEntry.uri, depth: "6" });
      const res = await fetch(`${BSKY_API}/app.bsky.feed.getPostThread?${params}`, {
        headers: { Authorization: `Bearer ${session.accessJwt}` },
      });
      if (!res.ok) {
        console.log(`   bluesky thread fetch failed for "${title}": ${res.status}`);
        continue;
      }
      const data = await res.json();
      const replies = extractBskyReplies(data.thread, bskyEntry.uri, title);
      allReplies.push(...replies);
    } catch (err) {
      console.log(`   bluesky error for "${title}": ${err.message}`);
    }

    await sleep(200);
  }

  // Also check notifications for mentions
  try {
    const res = await fetch(`${BSKY_API}/app.bsky.notification.listNotifications?limit=50`, {
      headers: { Authorization: `Bearer ${session.accessJwt}` },
    });
    if (res.ok) {
      const data = await res.json();
      const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      for (const notif of data.notifications || []) {
        if (notif.reason !== "reply" && notif.reason !== "mention") continue;
        if (new Date(notif.indexedAt).getTime() < cutoff) continue;

        const id = `bsky-notif-${notif.uri}`;
        // Only add if not already captured from thread fetching
        if (allReplies.some((r) => r.replyUri === notif.uri)) continue;

        allReplies.push({
          id,
          platform: "bluesky",
          postTitle: `(${notif.reason})`,
          postId: notif.reasonSubject || notif.uri,
          author: notif.author?.handle || "unknown",
          text: notif.record?.text || "",
          timestamp: notif.indexedAt || new Date().toISOString(),
          permalink: bskyPermalink(notif.uri),
          replyUri: notif.uri,
          replyCid: notif.cid,
          classified: null,
          responded: false,
          liked: false,
          action: null,
          actionNote: null,
        });
      }
    }
  } catch (err) {
    console.log(`   bluesky notifications error: ${err.message}`);
  }

  return allReplies;
}

// ── Threads: fetch replies ───────────────────────────────────────────────

async function fetchThreadsReplies(published) {
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token) {
    console.log("   threads: skipped (no THREADS_ACCESS_TOKEN)");
    return [];
  }

  const allReplies = [];

  for (const post of published) {
    const threadsEntry = post.publishedTo.find((e) => e.platform === "threads" && e.ok && (e.postId || e.id));
    if (!threadsEntry) continue;

    const mediaId = threadsEntry.postId || threadsEntry.id;
    const title = post.item?.title || "Untitled";

    try {
      const fields = "id,text,username,timestamp,permalink,is_reply_owned_by_me";
      const res = await fetch(
        `${THREADS_API}/${mediaId}/replies?fields=${fields}&access_token=${token}`
      );
      if (!res.ok) {
        const body = await res.text();
        // 10 = permission denied — may not have reply read scope
        if (res.status === 400) {
          console.log(`   threads: no reply access for "${title}" (may need permissions)`);
        } else {
          console.log(`   threads reply fetch failed for "${title}" (${res.status}): ${body.slice(0, 120)}`);
        }
        continue;
      }
      const data = await res.json();
      for (const reply of data.data || []) {
        if (reply.is_reply_owned_by_me) continue; // skip our own replies

        allReplies.push({
          id: `threads-${reply.id}`,
          platform: "threads",
          postTitle: title,
          postId: mediaId,
          author: reply.username || "unknown",
          text: reply.text || "",
          timestamp: reply.timestamp || new Date().toISOString(),
          permalink: reply.permalink || "",
          classified: null,
          responded: false,
          liked: false,
          action: null,
          actionNote: null,
        });
      }
    } catch (err) {
      console.log(`   threads error for "${title}": ${err.message}`);
    }

    await sleep(200);
  }

  return allReplies;
}

// ── Facebook: fetch comments ─────────────────────────────────────────────

async function fetchFacebookReplies(published) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;
  if (!token || !pageId) {
    console.log("   facebook: skipped (no FB_PAGE_ACCESS_TOKEN or FB_PAGE_ID)");
    return [];
  }

  const allReplies = [];

  for (const post of published) {
    const fbEntry = post.publishedTo.find((e) => e.platform === "facebook" && e.ok && (e.postId || e.id));
    if (!fbEntry) continue;

    const fbPostId = fbEntry.postId || fbEntry.id;
    const title = post.item?.title || "Untitled";

    try {
      const fields = "id,message,from,created_time,like_count";
      const res = await fetch(
        `${FB_API}/${fbPostId}/comments?fields=${fields}&access_token=${token}`
      );
      if (!res.ok) {
        const body = await res.text();
        console.log(`   facebook comments failed for "${title}" (${res.status}): ${body.slice(0, 120)}`);
        continue;
      }
      const data = await res.json();
      for (const comment of data.data || []) {
        const authorName = comment.from?.name || "unknown";
        allReplies.push({
          id: `fb-${comment.id}`,
          platform: "facebook",
          postTitle: title,
          postId: fbPostId,
          author: authorName,
          text: comment.message || "",
          timestamp: comment.created_time || new Date().toISOString(),
          permalink: `https://www.facebook.com/${comment.id}`,
          fbCommentId: comment.id,
          classified: null,
          responded: false,
          liked: false,
          action: null,
          actionNote: null,
        });
      }
    } catch (err) {
      console.log(`   facebook error for "${title}": ${err.message}`);
    }

    await sleep(200);
  }

  return allReplies;
}

// ── X (Twitter): OAuth 1.0a helpers ─────────────────────────────────────

function xPercentEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function xBuildSignatureBaseString(method, url, params) {
  const sorted = [...params].sort((a, b) => a[0].localeCompare(b[0]));
  const paramStr = sorted.map(([k, v]) => `${xPercentEncode(k)}=${xPercentEncode(v)}`).join("&");
  return `${method.toUpperCase()}&${xPercentEncode(url)}&${xPercentEncode(paramStr)}`;
}

function xSign(baseString, consumerSecret, tokenSecret) {
  const key = `${xPercentEncode(consumerSecret)}&${xPercentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(baseString).digest("base64");
}

function xBuildAuthHeader(oauthParams) {
  const parts = oauthParams
    .map(([k, v]) => `${xPercentEncode(k)}="${xPercentEncode(v)}"`)
    .join(", ");
  return `OAuth ${parts}`;
}

function xMakeOAuthHeader(method, url, queryParams = [], creds) {
  const oauthParams = [
    ["oauth_consumer_key", creds.apiKey],
    ["oauth_nonce", randomBytes(16).toString("hex")],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", Math.floor(Date.now() / 1000).toString()],
    ["oauth_token", creds.accessToken],
    ["oauth_version", "1.0"],
  ];

  const allParams = [...oauthParams, ...queryParams];
  const baseString = xBuildSignatureBaseString(method, url, allParams);
  const signature = xSign(baseString, creds.apiSecret, creds.accessTokenSecret);
  oauthParams.push(["oauth_signature", signature]);

  return xBuildAuthHeader(oauthParams);
}

function getXCredentials() {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) return null;
  return { apiKey, apiSecret, accessToken, accessTokenSecret };
}

// ── X (Twitter): fetch mentions ─────────────────────────────────────────

async function fetchXUserId(creds) {
  const url = `${X_API}/2/users/me`;
  const authHeader = xMakeOAuthHeader("GET", url, [], creds);
  const res = await fetch(url, { headers: { Authorization: authHeader } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X users/me failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.data.id;
}

async function fetchXMentions(published) {
  const creds = getXCredentials();
  if (!creds) {
    console.log("   x: skipped (no X credentials)");
    return [];
  }

  let userId;
  try {
    userId = await fetchXUserId(creds);
  } catch (err) {
    console.log(`   x: failed to get user ID: ${err.message}`);
    return [];
  }
  await sleep(200);

  const url = `${X_API}/2/users/${userId}/mentions`;
  const queryParams = [
    ["max_results", "20"],
    ["tweet.fields", "created_at,text,author_id,conversation_id,in_reply_to_user_id"],
  ];

  const authHeader = xMakeOAuthHeader("GET", url, queryParams, creds);
  const qs = queryParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

  try {
    const res = await fetch(`${url}?${qs}`, { headers: { Authorization: authHeader } });
    if (!res.ok) {
      const body = await res.text();
      console.log(`   x: mentions fetch failed (${res.status}): ${body.slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const allReplies = [];

    for (const tweet of data.data || []) {
      if (new Date(tweet.created_at).getTime() < cutoff) continue;

      // Try to find the matching published post by conversation
      let postTitle = "(mention)";
      for (const post of published) {
        const xEntry = post.publishedTo?.find((e) => e.platform === "x" && e.ok && e.id);
        if (xEntry && tweet.conversation_id === xEntry.id) {
          postTitle = post.item?.title || "Untitled";
          break;
        }
      }

      allReplies.push({
        id: `x-${tweet.id}`,
        platform: "x",
        postTitle,
        postId: tweet.conversation_id || tweet.id,
        author: tweet.author_id,
        text: tweet.text || "",
        timestamp: tweet.created_at || new Date().toISOString(),
        permalink: `https://x.com/i/status/${tweet.id}`,
        tweetId: tweet.id,
        conversationId: tweet.conversation_id,
        classified: null,
        responded: false,
        liked: false,
        action: null,
        actionNote: null,
      });
    }

    return allReplies;
  } catch (err) {
    console.log(`   x: error fetching mentions: ${err.message}`);
    return [];
  }
}

async function xLikeTweet(userId, tweetId, creds) {
  const url = `${X_API}/2/users/${userId}/likes`;
  const authHeader = xMakeOAuthHeader("POST", url, [], creds);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tweet_id: tweetId }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X like failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return true;
}

async function xReplyToTweet(text, inReplyToTweetId, creds) {
  const url = `${X_API}/2/tweets`;
  const authHeader = xMakeOAuthHeader("POST", url, [], creds);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      reply: { in_reply_to_tweet_id: inReplyToTweetId },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X reply failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return true;
}

// ── Threads: reply to a thread ──────────────────────────────────────────

async function threadsReply(text, replyToId) {
  const token = process.env.THREADS_ACCESS_TOKEN;
  const userId = process.env.THREADS_USER_ID;
  if (!token || !userId) throw new Error("Missing Threads credentials");

  // Create reply container
  const createParams = new URLSearchParams({
    media_type: "TEXT",
    text,
    reply_to_id: replyToId,
    access_token: token,
  });

  const createRes = await fetch(`${THREADS_API}/${userId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: createParams.toString(),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Threads reply container failed (${createRes.status}): ${body.slice(0, 200)}`);
  }
  const { id: containerId } = await createRes.json();

  // Wait for container to be ready
  const maxWait = 30000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const statusRes = await fetch(
      `${THREADS_API}/${containerId}?fields=status&access_token=${token}`
    );
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (statusData.status === "FINISHED") break;
      if (statusData.status === "ERROR") throw new Error(`Threads reply container error: ${JSON.stringify(statusData)}`);
    }
    await sleep(2000);
  }

  // Publish
  const publishParams = new URLSearchParams({
    creation_id: containerId,
    access_token: token,
  });
  const publishRes = await fetch(`${THREADS_API}/${userId}/threads_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: publishParams.toString(),
  });
  if (!publishRes.ok) {
    const body = await publishRes.text();
    throw new Error(`Threads reply publish failed (${publishRes.status}): ${body.slice(0, 200)}`);
  }
  return true;
}

// ── Claude classification ────────────────────────────────────────────────

async function classifyReply(reply) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const prompt = `You are classifying a social media reply to a local news post from The South Bay Signal (a South Bay / San Jose area community news aggregator).

Original post title: "${reply.postTitle}"
Platform: ${reply.platform}
Reply author: ${reply.author}
Reply text: "${reply.text}"

Classify this reply into exactly ONE of these categories:

- positive_simple — simple positive response (thanks, great, love this, emoji-only, heart, etc.)
- factual_simple — reporting a broken link, cancelled event, typo, wrong time, factual correction
- question_simple — simple factual question we can answer (when is this? where exactly? is it free? how do I get there?)
- needs_human — anything ambiguous, negative, political, complex, sarcastic, off-topic, spam, or requiring judgment

Respond with ONLY the category name, nothing else.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 50,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude classification failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text?.trim().toLowerCase() || "needs_human";
  const valid = ["positive_simple", "factual_simple", "question_simple", "needs_human"];
  return valid.includes(text) ? text : "needs_human";
}

// ── Claude response generation ───────────────────────────────────────────

async function generateResponse(reply, originalPost) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const item = originalPost?.item || {};
  const context = [
    item.title && `Event: ${item.title}`,
    item.date && `Date: ${item.date}`,
    item.time && `Time: ${item.time}`,
    item.location && `Location: ${item.location}`,
    item.cityName && `City: ${item.cityName}`,
    item.cost && `Cost: ${item.cost}`,
    item.url && `URL: ${item.url}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `You are The South Bay Signal, a friendly local news aggregator for the South Bay / San Jose area. Someone replied to one of your posts.

Original post title: "${reply.postTitle}"
${context ? `\nEvent details:\n${context}\n` : ""}
Their reply (${reply.platform}): "${reply.text}"
Classification: ${reply.classified}

Write a brief, warm response (1-2 sentences max). Be helpful and friendly. Don't use hashtags or emojis. Keep it natural and conversational.

${reply.classified === "factual_simple" ? "If they're reporting an issue (broken link, wrong info, cancelled event), thank them for the heads up and say you'll look into it." : ""}
${reply.classified === "question_simple" ? "Answer their question using the event details above. If you don't have the info, suggest they check the link." : ""}

Respond with ONLY the reply text, nothing else.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude response gen failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
}

// ── Auto-actions ─────────────────────────────────────────────────────────

async function blueskyLike(replyUri, replyCid) {
  const session = await bskyCreateSession();
  const res = await fetch(`${BSKY_API}/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.like",
      record: {
        $type: "app.bsky.feed.like",
        subject: { uri: replyUri, cid: replyCid },
        createdAt: new Date().toISOString(),
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bluesky like failed (${res.status}): ${body}`);
  }
  return true;
}

async function blueskyReply(text, rootUri, rootCid, parentUri, parentCid) {
  const session = await bskyCreateSession();

  // Build facets for any URLs in the response
  const facets = [];
  const urlRegex = /https?:\/\/[^\s)]+/g;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[0];
    const byteStart = Buffer.byteLength(text.slice(0, match.index), "utf8");
    const byteEnd = byteStart + Buffer.byteLength(url, "utf8");
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
    });
  }

  const record = {
    $type: "app.bsky.feed.post",
    text,
    facets,
    reply: {
      root: { uri: rootUri, cid: rootCid },
      parent: { uri: parentUri, cid: parentCid },
    },
    createdAt: new Date().toISOString(),
  };

  const res = await fetch(`${BSKY_API}/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bluesky reply failed (${res.status}): ${body}`);
  }
  return true;
}

// ── Discord notification ─────────────────────────────────────────────────

async function sendDiscord(message) {
  const res = await fetch(process.env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });
  if (!res.ok) {
    console.log(`   discord webhook failed: ${res.status}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const ptTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const timeStr = ptTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  console.log(`\n💬 Reply monitor — ${ptTime.toISOString().split("T")[0]} ${timeStr}`);
  if (dryRun) console.log("   (dry run)\n");

  // Load published posts
  const published = loadRecentPublished();
  console.log(`   ${published.length} published post(s) in last ${LOOKBACK_DAYS} days`);

  if (published.length === 0) {
    console.log("   Nothing to monitor.");
    return;
  }

  // Load existing reply data
  const repliesData = loadReplies();
  const existingIds = new Set(repliesData.replies.map((r) => r.id));

  // Fetch replies from all platforms
  console.log("\n── Fetching replies ──");

  console.log("   bluesky...");
  const bskyReplies = await fetchBlueskyReplies(published);
  console.log(`   bluesky: ${bskyReplies.length} total replies`);
  await sleep(500);

  console.log("   threads...");
  const threadsReplies = await fetchThreadsReplies(published);
  console.log(`   threads: ${threadsReplies.length} total replies`);
  await sleep(500);

  console.log("   facebook...");
  const fbReplies = await fetchFacebookReplies(published);
  console.log(`   facebook: ${fbReplies.length} total replies`);
  await sleep(500);

  console.log("   x...");
  const xReplies = await fetchXMentions(published);
  console.log(`   x: ${xReplies.length} total replies`);

  // De-duplicate: only add new replies
  const allNew = [...bskyReplies, ...threadsReplies, ...fbReplies, ...xReplies];
  const newReplies = allNew.filter((r) => !existingIds.has(r.id));

  console.log(`\n   ${allNew.length} total fetched, ${newReplies.length} new`);

  if (newReplies.length === 0) {
    repliesData.lastChecked = now.toISOString();
    saveReplies(repliesData);
    console.log("   No new replies. Done.");
    return;
  }

  // Classify new replies
  console.log("\n── Classifying ──");
  for (const reply of newReplies) {
    try {
      reply.classified = await classifyReply(reply);
      console.log(`   [${reply.platform}] @${reply.author}: "${reply.text.slice(0, 60)}" → ${reply.classified}`);
    } catch (err) {
      console.log(`   classification error: ${err.message}`);
      reply.classified = "needs_human";
    }
    await sleep(200);
  }

  // Find original posts for context (used when generating responses)
  const postsByUri = new Map();
  for (const post of published) {
    for (const entry of post.publishedTo || []) {
      if (entry.ok) {
        const key = entry.uri || entry.postId || entry.id;
        if (key) postsByUri.set(key, post);
      }
    }
  }

  // Auto-act on classified replies
  console.log("\n── Auto-actions ──");
  const stats = { liked: 0, responded: 0, drafted: 0, escalated: 0 };

  for (const reply of newReplies) {
    const originalPost = postsByUri.get(reply.postId);

    switch (reply.classified) {
      case "positive_simple": {
        // Auto-like
        if (reply.platform === "bluesky" && reply.replyUri && reply.replyCid) {
          if (dryRun) {
            console.log(`   [bluesky] would like @${reply.author}'s reply`);
          } else {
            try {
              await blueskyLike(reply.replyUri, reply.replyCid);
              reply.liked = true;
              console.log(`   [bluesky] liked @${reply.author}'s reply`);
              stats.liked++;
            } catch (err) {
              console.log(`   [bluesky] like failed: ${err.message}`);
            }
          }
        } else if (reply.platform === "threads") {
          reply.actionNote = "would_like (no Threads like API)";
          console.log(`   [threads] skipped like (no API) for @${reply.author}`);
        } else if (reply.platform === "facebook") {
          reply.actionNote = "would_like (needs pages_manage_engagement)";
          console.log(`   [facebook] skipped like (needs permission) for @${reply.author}`);
        } else if (reply.platform === "x" && reply.tweetId) {
          const xCreds = getXCredentials();
          if (xCreds) {
            if (dryRun) {
              console.log(`   [x] would like @${reply.author}'s reply`);
            } else {
              try {
                const xUserId = await fetchXUserId(xCreds);
                await sleep(200);
                await xLikeTweet(xUserId, reply.tweetId, xCreds);
                reply.liked = true;
                console.log(`   [x] liked @${reply.author}'s reply`);
                stats.liked++;
              } catch (err) {
                console.log(`   [x] like failed: ${err.message}`);
              }
            }
          }
        }
        break;
      }

      case "factual_simple":
      case "question_simple": {
        // Generate response
        let responseText = "";
        try {
          responseText = await generateResponse(reply, originalPost);
        } catch (err) {
          console.log(`   response generation failed: ${err.message}`);
          reply.action = "needs_human";
          reply.actionNote = `Response generation failed: ${err.message}`;
          break;
        }

        if (reply.platform === "bluesky" && reply.replyUri && reply.replyCid) {
          // Find root post URI and CID for the reply chain
          const bskyEntry = originalPost?.publishedTo?.find(
            (e) => e.platform === "bluesky" && e.ok
          );
          const rootUri = bskyEntry?.uri || reply.postId;
          const rootCid = bskyEntry?.cid || reply.replyCid;

          if (dryRun) {
            console.log(`   [bluesky] would reply to @${reply.author}: "${responseText.slice(0, 80)}"`);
            stats.drafted++;
          } else {
            try {
              await blueskyReply(responseText, rootUri, rootCid, reply.replyUri, reply.replyCid);
              reply.responded = true;
              reply.actionNote = responseText;
              console.log(`   [bluesky] replied to @${reply.author}: "${responseText.slice(0, 80)}"`);
              stats.responded++;
            } catch (err) {
              console.log(`   [bluesky] reply failed: ${err.message}`);
              reply.actionNote = `Draft: ${responseText} (send failed: ${err.message})`;
              stats.drafted++;
            }
          }

          // Also like positive-leaning factual/question replies
          if (!dryRun && reply.replyUri && reply.replyCid) {
            try {
              await blueskyLike(reply.replyUri, reply.replyCid);
              reply.liked = true;
            } catch {}
          }
        } else if (reply.platform === "threads") {
          const threadsMediaId = reply.postId;
          if (dryRun) {
            console.log(`   [threads] would reply to @${reply.author}: "${responseText.slice(0, 80)}"`);
            stats.drafted++;
          } else {
            try {
              // reply_to_id should be the specific reply's thread ID, not the root post
              const replyToId = reply.id.replace("threads-", "");
              await threadsReply(responseText, replyToId);
              reply.responded = true;
              reply.actionNote = responseText;
              console.log(`   [threads] replied to @${reply.author}: "${responseText.slice(0, 80)}"`);
              stats.responded++;
            } catch (err) {
              console.log(`   [threads] reply failed: ${err.message}`);
              reply.actionNote = `draft: ${responseText} (send failed: ${err.message})`;
              stats.drafted++;
            }
          }
        } else if (reply.platform === "x" && reply.tweetId) {
          const xCreds = getXCredentials();
          if (xCreds) {
            if (dryRun) {
              console.log(`   [x] would reply to @${reply.author}: "${responseText.slice(0, 80)}"`);
              stats.drafted++;
            } else {
              try {
                await xReplyToTweet(responseText, reply.tweetId, xCreds);
                reply.responded = true;
                reply.actionNote = responseText;
                console.log(`   [x] replied to @${reply.author}: "${responseText.slice(0, 80)}"`);
                stats.responded++;
                await sleep(200);
                // Also like the reply
                try {
                  const xUserId = await fetchXUserId(xCreds);
                  await sleep(200);
                  await xLikeTweet(xUserId, reply.tweetId, xCreds);
                  reply.liked = true;
                } catch {}
              } catch (err) {
                console.log(`   [x] reply failed: ${err.message}`);
                reply.actionNote = `draft: ${responseText} (send failed: ${err.message})`;
                stats.drafted++;
              }
            }
          }
        } else if (reply.platform === "facebook") {
          reply.actionNote = `would_respond: ${responseText}`;
          console.log(`   [facebook] drafted reply to @${reply.author}: "${responseText.slice(0, 80)}"`);
          stats.drafted++;
        }

        // Flag actionable factual corrections for follow-up
        if (reply.classified === "factual_simple") {
          const lowerText = reply.text.toLowerCase();
          if (lowerText.includes("cancel") || lowerText.includes("postpone") || lowerText.includes("reschedule")) {
            reply.action = "verify_event";
          } else if (lowerText.includes("broken") || lowerText.includes("link") || lowerText.includes("404") || lowerText.includes("dead link")) {
            reply.action = "check_link";
          } else if (lowerText.includes("wrong") || lowerText.includes("incorrect") || lowerText.includes("typo")) {
            reply.action = "verify_info";
          }

          if (reply.action) {
            const msg =
              `🔔 **The South Bay Signal — Action Needed**\n` +
              `Platform: ${reply.platform}\n` +
              `Post: ${reply.postTitle}\n` +
              `Author: @${reply.author}\n` +
              `Reply: "${reply.text.slice(0, 300)}"\n` +
              `Action: ${reply.action}\n` +
              `${reply.permalink ? `Link: ${reply.permalink}` : ""}`;
            if (!dryRun) { await sendDiscord(msg); reply._discordSent = true; }
            else console.log(`   would DM: ${reply.action} for "${reply.postTitle}"`);
          }
        }
        break;
      }

      case "needs_human": {
        reply.action = "needs_human";
        const msg =
          `👤 **The South Bay Signal — Reply Needs Attention**\n` +
          `Platform: ${reply.platform}\n` +
          `Post: ${reply.postTitle}\n` +
          `Author: @${reply.author}\n` +
          `Reply: "${reply.text.slice(0, 300)}"\n` +
          `${reply.permalink ? `Link: ${reply.permalink}` : ""}`;
        if (!dryRun) {
          await sendDiscord(msg);
          reply._discordSent = true;
          console.log(`   [${reply.platform}] escalated @${reply.author}'s reply to Discord`);
        } else {
          console.log(`   [${reply.platform}] would escalate @${reply.author}'s reply`);
        }
        stats.escalated++;
        break;
      }
    }

    // Universal Discord DM for ALL replies (skip if already notified above)
    if (!reply._discordSent && !dryRun) {
      const actionSummary =
        reply.classified === "positive_simple"
          ? reply.liked ? "Auto-liked ✓" : "Positive (no like API)"
          : reply.classified === "question_simple"
            ? reply.responded ? `Auto-replied: "${(reply.actionNote || "").slice(0, 120)}"` : "Drafted response"
            : reply.classified === "factual_simple"
              ? reply.responded ? `Auto-replied: "${(reply.actionNote || "").slice(0, 120)}"` : "Drafted response"
              : "—";

      const emoji =
        reply.classified === "positive_simple" ? "💬" :
        reply.classified === "question_simple" ? "❓" :
        reply.classified === "factual_simple" ? "📝" : "💬";

      const msg =
        `${emoji} **New reply on ${reply.platform}**\n` +
        `Post: ${reply.postTitle || "(unknown)"}\n` +
        `Author: @${reply.author}\n` +
        `Reply: "${reply.text.slice(0, 300)}"\n` +
        `Classification: ${reply.classified}\n` +
        `Action: ${actionSummary}\n` +
        `${reply.permalink ? `Link: ${reply.permalink}` : ""}`;
      await sendDiscord(msg);
    }

    await sleep(200);
  }

  // Merge new replies into existing data
  repliesData.replies.push(...newReplies);
  repliesData.lastChecked = now.toISOString();

  // Prune replies older than 30 days to keep file manageable
  const pruneDate = Date.now() - 30 * 24 * 60 * 60 * 1000;
  repliesData.replies = repliesData.replies.filter(
    (r) => new Date(r.timestamp).getTime() >= pruneDate
  );

  saveReplies(repliesData);

  // Summary
  console.log("\n── Summary ──");
  console.log(`   New replies: ${newReplies.length}`);
  console.log(`   Liked: ${stats.liked}`);
  console.log(`   Auto-responded: ${stats.responded}`);
  console.log(`   Drafted (no API or dry-run): ${stats.drafted}`);
  console.log(`   Escalated to human: ${stats.escalated}`);
  console.log(`   Total tracked: ${repliesData.replies.length}`);
  console.log();
}

main().catch((err) => {
  console.error("Reply monitor error:", err);
  process.exit(1);
});
