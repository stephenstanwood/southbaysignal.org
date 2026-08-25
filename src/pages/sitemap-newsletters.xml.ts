export const prerender = false;

import type { APIRoute } from "astro";
import { list, type ListBlobResultBlob } from "@vercel/blob";

const SITE_URL = "https://southbaytoday.org";
const NEWSLETTER_PATH = /^newsletters\/(\d{4}-\d{2}-\d{2})\.html$/;

async function listNewsletterBlobs(token: string): Promise<ListBlobResultBlob[]> {
  const blobs: ListBlobResultBlob[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({ prefix: "newsletters/", limit: 1000, cursor, token });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return blobs;
}

function newsletterEntries(blobs: ListBlobResultBlob[]): Array<{ date: string; lastmod: string }> {
  const byDate = new Map<string, Date>();

  for (const blob of blobs) {
    const date = blob.pathname.match(NEWSLETTER_PATH)?.[1];
    if (!date) continue;
    const previous = byDate.get(date);
    if (!previous || blob.uploadedAt.getTime() > previous.getTime()) byDate.set(date, blob.uploadedAt);
  }

  return [...byDate]
    .map(([date, uploadedAt]) => ({ date, lastmod: uploadedAt.toISOString() }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function renderSitemap(entries: Array<{ date: string; lastmod: string }>): string {
  const urls = entries.map(({ date, lastmod }) => [
    "  <url>",
    `    <loc>${SITE_URL}/newsletters/${date}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    "  </url>",
  ].join("\n"));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

export const GET: APIRoute = async () => {
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return new Response("Newsletter sitemap temporarily unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const xml = renderSitemap(newsletterEntries(await listNewsletterBlobs(token)));
    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=86400",
      },
    });
  } catch {
    return new Response("Newsletter sitemap temporarily unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
};
