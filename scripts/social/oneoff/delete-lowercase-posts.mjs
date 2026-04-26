// One-off: delete the 8 lowercase-start posts on X/Bluesky/Threads/Instagram.
// Mastodon (2) and Facebook (2) were edited in place via PUT/POST. The other
// four platforms have no edit API for published posts, so deletion is the
// only fix path. Used 2026-04-26 after the case-mangling rewriter bug fix.

import { readFileSync } from "node:fs";

// Hydrate process.env from .env.local — the platform clients read process.env
// directly and assume launchd injected the secrets. Manual runs need this.
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i <= 0) continue;
  const k = t.slice(0, i);
  const v = t.slice(i + 1).replace(/^"|"$/g, "");
  if (!process.env[k]) process.env[k] = v;
}

const { deletePost: deleteX } = await import("../lib/platforms/x.mjs");
const { deletePost: deleteBluesky } = await import("../lib/platforms/bluesky.mjs");
const { deletePost: deleteThreads } = await import("../lib/platforms/threads.mjs");
const { deletePost: deleteInstagram } = await import("../lib/platforms/instagram.mjs");

const TARGETS = [
  // X
  { platform: "x", id: "2048473452391350759", note: "2026-04-26 Vienna Teng" },
  { platform: "x", id: "2045936738099695715", note: "2026-04-19 Milpitas films" },
  // Bluesky
  { platform: "bluesky", id: "at://did:plc:x4f3xqmbhekcjeze33exlxjo/app.bsky.feed.post/3mkg7mu4crm2x", note: "2026-04-26 Vienna Teng" },
  { platform: "bluesky", id: "at://did:plc:x4f3xqmbhekcjeze33exlxjo/app.bsky.feed.post/3mjumehitzi2s", note: "2026-04-19 Milpitas films" },
  // Threads
  { platform: "threads", id: "18133266781557041", note: "2026-04-26 Vienna Teng" },
  { platform: "threads", id: "18406748797197072", note: "2026-04-19 Milpitas films" },
  // Instagram
  { platform: "instagram", id: "17866745709616344", note: "2026-04-26 Vienna Teng" },
  { platform: "instagram", id: "17961203103073328", note: "2026-04-19 Milpitas films" },
];

const HANDLERS = {
  x: deleteX,
  bluesky: deleteBluesky,
  threads: deleteThreads,
  instagram: deleteInstagram,
};

for (const t of TARGETS) {
  const fn = HANDLERS[t.platform];
  process.stdout.write(`[${t.platform}] ${t.id} (${t.note}) … `);
  try {
    const r = await fn(t.id);
    console.log("OK", JSON.stringify(r).slice(0, 100));
  } catch (e) {
    console.log("FAIL", e.message);
  }
}
