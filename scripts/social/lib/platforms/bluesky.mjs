// ---------------------------------------------------------------------------
// South Bay Signal — Bluesky (AT Protocol) Client
// Session auth + rich text with link facets + image blob upload
// ---------------------------------------------------------------------------

const BSKY_API = "https://bsky.social/xrpc";

let _session = null;

function getCredentials() {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) {
    throw new Error("Missing BLUESKY_HANDLE or BLUESKY_APP_PASSWORD in environment");
  }
  return { handle, password };
}

async function createSession() {
  if (_session) return _session;
  const { handle, password } = getCredentials();

  const res = await fetch(`${BSKY_API}/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bluesky auth failed (${res.status}): ${text}`);
  }

  _session = await res.json();
  return _session;
}

/**
 * Parse text for URLs and create link facets for rich text.
 */
function detectFacets(text) {
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
  return facets;
}

/**
 * Upload an image blob to Bluesky.
 * Returns the blob reference for embedding.
 */
export async function uploadImage(imageBuffer, mimeType = "image/png") {
  const session = await createSession();

  const res = await fetch(`${BSKY_API}/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": mimeType,
    },
    body: imageBuffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bluesky image upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.blob;
}

/**
 * Fetch OG tags from a URL and return a link card embed object.
 * Returns null if fetching fails.
 */
async function fetchLinkCard(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "SouthBayTodayBot/1.0 (link preview)" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const og = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, "i"))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, "i"));
      return m ? m[1] : "";
    };
    const title = og("title") || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || url;
    const description = og("description") || "";
    const thumb = og("image") || "";

    let thumbBlob = null;
    if (thumb) {
      try {
        const imgRes = await fetch(thumb, {
          headers: { "User-Agent": "SouthBayTodayBot/1.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const mime = imgRes.headers.get("content-type") || "image/jpeg";
          thumbBlob = await uploadImage(buf, mime);
        }
      } catch { /* skip thumbnail */ }
    }

    const card = { uri: url, title, description };
    if (thumbBlob) card.thumb = thumbBlob;
    return { $type: "app.bsky.embed.external", external: card };
  } catch {
    return null;
  }
}

/**
 * Create a post on Bluesky with optional image embed or link card.
 */
export async function createPost(text, imageBlob = null, imageAlt = "") {
  const session = await createSession();
  const facets = detectFacets(text);

  const record = {
    $type: "app.bsky.feed.post",
    text,
    facets,
    createdAt: new Date().toISOString(),
  };

  if (imageBlob) {
    record.embed = {
      $type: "app.bsky.embed.images",
      images: [{ alt: imageAlt, image: imageBlob }],
    };
  } else {
    // No image — try to attach a link card from the first URL in the text
    const urlMatch = text.match(/https?:\/\/[^\s)]+/);
    if (urlMatch) {
      let cardUrl = urlMatch[0];
      let displayUrl = cardUrl;
      // For /go/ short links, fetch OG from the destination but display our URL
      const goMatch = cardUrl.match(/southbaytoday\.org\/go\/(\w+)/);
      if (goMatch) {
        try {
          const { readFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const shortUrls = JSON.parse(readFileSync(join(process.cwd(), "src/data/south-bay/short-urls.json"), "utf8"));
          const entry = shortUrls[goMatch[1]];
          const dest = typeof entry === "string" ? entry : entry?.url;
          if (dest) { displayUrl = cardUrl; cardUrl = dest; }
        } catch { /* fall through to fetching the short URL directly */ }
      }
      const linkEmbed = await fetchLinkCard(cardUrl);
      if (linkEmbed) {
        linkEmbed.external.uri = displayUrl;
        record.embed = linkEmbed;
      }
    }
  }

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
    const text = await res.text();
    throw new Error(`Bluesky post failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return { uri: data.uri, cid: data.cid };
}

/**
 * Delete a post by AT URI.
 */
export async function deletePost(uri) {
  const session = await createSession();
  // URI format: at://did:plc:xxx/app.bsky.feed.post/rkey
  const parts = uri.split("/");
  const rkey = parts[parts.length - 1];

  const res = await fetch(`${BSKY_API}/com.atproto.repo.deleteRecord`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      rkey,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bluesky delete failed (${res.status}): ${text}`);
  }

  return { deleted: true };
}

/**
 * Full post flow: upload image (if provided) then post.
 */
export async function publish(text, imageBuffer = null, imageAlt = "") {
  let blob = null;
  if (imageBuffer) {
    blob = await uploadImage(imageBuffer);
  }
  return createPost(text, blob, imageAlt);
}
