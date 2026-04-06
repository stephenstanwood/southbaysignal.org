export const prerender = false;
import type { APIRoute } from "astro";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug;
  if (!slug) {
    return new Response("Not found", { status: 404 });
  }

  // Read fresh from disk each time so new short URLs work without redeploy
  const filePath = join(process.cwd(), "src/data/south-bay/short-urls.json");
  let urls: Record<string, string | { url: string; title?: string; description?: string }>;
  try {
    urls = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const entry = urls[slug];
  if (!entry) {
    return new Response("Not found", { status: 404 });
  }

  // Support both old string format and new object format
  const target = typeof entry === "string" ? entry : entry.url;
  const title = (typeof entry === "object" && entry.title) || "The South Bay Signal";
  const description = (typeof entry === "object" && entry.description) || "";

  const canonical = `https://southbaysignal.org/go/${slug}`;

  // Serve HTML with OG tags for crawlers, instant redirect for humans
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="The South Bay Signal">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<link rel="canonical" href="${esc(target)}">
</head>
<body>
<p>Redirecting to <a href="${esc(target)}">${esc(title)}</a>&hellip;</p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
};
