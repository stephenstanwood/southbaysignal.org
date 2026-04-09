export const prerender = false;

// ---------------------------------------------------------------------------
// POST /api/share-plan — save a day plan and return a shareable URL
// GET  /api/share-plan?id=abc123 — retrieve a saved plan
// ---------------------------------------------------------------------------
// Plans stored in-memory with 48-hour TTL. They're ephemeral by design —
// today's plan is stale tomorrow. No database needed.
// ---------------------------------------------------------------------------

import type { APIRoute } from "astro";
import { errJson, okJson } from "../../lib/apiHelpers";
import { rateLimit, rateLimitResponse } from "../../lib/rateLimit";

interface SharedPlanCard {
  id: string;
  name: string;
  category: string;
  city: string;
  address: string;
  timeBlock: string;
  blurb: string;
  why: string;
  url?: string | null;
  mapsUrl?: string | null;
  cost?: string | null;
  costNote?: string | null;
  photoRef?: string | null;
  venue?: string | null;
  source: "event" | "place";
}

interface SharedPlan {
  cards: SharedPlanCard[];
  city: string;
  kids: boolean;
  weather: string | null;
  createdAt: string;
}

// In-memory store with TTL eviction
const planStore = new Map<string, { plan: SharedPlan; ts: number }>();
const PLAN_TTL = 48 * 60 * 60 * 1000; // 48 hours
const MAX_PLANS = 2000;

function evictExpired() {
  const now = Date.now();
  for (const [id, entry] of planStore) {
    if (now - entry.ts > PLAN_TTL) planStore.delete(id);
  }
}

function generateId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!rateLimit(clientAddress, 5)) return rateLimitResponse();

  let body: { cards: SharedPlanCard[]; city: string; kids: boolean; weather: string | null };
  try {
    body = await request.json();
  } catch {
    return errJson("Invalid JSON body", 400);
  }

  if (!body.cards?.length || !body.city) {
    return errJson("Missing cards or city", 400);
  }

  evictExpired();

  // Cap store size
  if (planStore.size >= MAX_PLANS) {
    const oldest = planStore.keys().next().value!;
    planStore.delete(oldest);
  }

  // Strip cards to essentials
  const cards: SharedPlanCard[] = body.cards.slice(0, 10).map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category,
    city: c.city,
    address: c.address,
    timeBlock: c.timeBlock,
    blurb: c.blurb,
    why: c.why,
    url: c.url || null,
    mapsUrl: c.mapsUrl || null,
    cost: c.cost || null,
    costNote: c.costNote || null,
    photoRef: c.photoRef || null,
    venue: c.venue || null,
    source: c.source,
  }));

  const id = generateId();
  const plan: SharedPlan = {
    cards,
    city: body.city,
    kids: body.kids,
    weather: body.weather,
    createdAt: new Date().toISOString(),
  };

  planStore.set(id, { plan, ts: Date.now() });

  const baseUrl = import.meta.env.SITE || "https://southbaytoday.org";
  return okJson({ id, url: `${baseUrl}/plan/${id}` });
};

export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get("id");
  if (!id) return errJson("Missing id parameter", 400);

  const entry = planStore.get(id);
  if (!entry || Date.now() - entry.ts > PLAN_TTL) {
    return errJson("Plan not found or expired", 404);
  }

  return okJson(entry.plan);
};
