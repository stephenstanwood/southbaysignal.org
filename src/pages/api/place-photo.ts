export const prerender = false;

// ---------------------------------------------------------------------------
// Google Places Photo Proxy
// ---------------------------------------------------------------------------
// GET /api/place-photo?ref=places/xxx/photos/yyy&w=400&h=300
// Proxies Google Places photos with API key server-side.
// Returns the image directly with caching headers.
// ---------------------------------------------------------------------------

import type { APIRoute } from "astro";
import { rateLimit, rateLimitResponse } from "../../lib/rateLimit";

export const GET: APIRoute = async ({ request, clientAddress }) => {
  if (!rateLimit(clientAddress, 60)) return rateLimitResponse();

  const url = new URL(request.url);
  const photoRef = url.searchParams.get("ref");
  const maxW = Math.min(Number(url.searchParams.get("w")) || 400, 800);
  const maxH = Math.min(Number(url.searchParams.get("h")) || 300, 600);

  if (!photoRef) {
    return new Response("Missing ref param", { status: 400 });
  }

  const apiKey = import.meta.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return new Response("Server config error", { status: 500 });
  }

  try {
    const photoUrl = `https://places.googleapis.com/v1/${photoRef}/media?maxWidthPx=${maxW}&maxHeightPx=${maxH}&key=${apiKey}`;
    const res = await fetch(photoUrl, {
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });

    if (!res.ok) {
      return new Response("Photo not found", { status: 404 });
    }

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const body = await res.arrayBuffer();

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, s-maxage=604800",
      },
    });
  } catch {
    return new Response("Photo fetch failed", { status: 502 });
  }
};
