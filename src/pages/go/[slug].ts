export const prerender = false;
import type { APIRoute } from "astro";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug;
  if (!slug) {
    return new Response("Not found", { status: 404 });
  }

  // Read fresh from disk each time so new short URLs work without redeploy
  const filePath = join(process.cwd(), "src/data/south-bay/short-urls.json");
  let urls: Record<string, string>;
  try {
    urls = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const target = urls[slug];
  if (!target) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: target },
  });
};
