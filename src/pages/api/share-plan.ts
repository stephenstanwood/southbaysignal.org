export const prerender = false;

// ---------------------------------------------------------------------------
// POST /api/share-plan — save a day plan and return a shareable URL
// GET  /api/share-plan?id=abc123 — retrieve a saved plan
// ---------------------------------------------------------------------------
// Plans stored in shared-plans.json (committed to git, deployed with the site).
// The social pipeline on Mini writes plans here and commits.
// The homepage share button also writes here (works in dev; on Vercel the
// POST writes to the in-memory fallback for same-session sharing).
// ---------------------------------------------------------------------------

import type { APIRoute } from "astro";
import { errJson, okJson } from "../../lib/apiHelpers";
import { rateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { canonicalizePlanCards } from "../../lib/south-bay/canonicalizeCard.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  planDate?: string;
  createdAt: string;
}

const PLANS_PATH = join(process.cwd(), "src/data/south-bay/shared-plans.json");

// In-memory fallback for Vercel (filesystem is read-only in production)
const memoryFallback = new Map<string, SharedPlan>();

function loadPlans(): Record<string, SharedPlan> {
  try {
    return JSON.parse(readFileSync(PLANS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function generateId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!rateLimit(clientAddress, 5)) return rateLimitResponse();

  let body: { cards: SharedPlanCard[]; city: string; kids: boolean; weather: string | null; planDate?: string };
  try {
    body = await request.json();
  } catch {
    return errJson("Invalid JSON body", 400);
  }

  if (!body.cards?.length || !body.city) {
    return errJson("Missing cards or city", 400);
  }

  const cards: SharedPlanCard[] = canonicalizePlanCards(body.cards.slice(0, 10)) as SharedPlanCard[];
  if (!cards.length) return errJson("No renderable cards", 400);

  const id = generateId();
  const plan: SharedPlan = {
    cards,
    city: body.city,
    kids: body.kids,
    weather: body.weather,
    planDate: body.planDate || undefined,
    createdAt: new Date().toISOString(),
  };

  // Try to write to disk (works locally + on Mini, fails silently on Vercel)
  try {
    const plans = loadPlans();
    plans[id] = plan;
    writeFileSync(PLANS_PATH, JSON.stringify(plans, null, 2));
  } catch {
    // Read-only filesystem (Vercel production) — use memory fallback
    memoryFallback.set(id, plan);
  }

  const baseUrl = import.meta.env.SITE || "https://southbaytoday.org";
  return okJson({ id, url: `${baseUrl}/plan/${id}` });
};

export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get("id");
  if (!id) return errJson("Missing id parameter", 400);

  // Check disk first (committed plans from social pipeline)
  const plans = loadPlans();
  if (plans[id]) return okJson(plans[id]);

  // Check memory fallback (share button on Vercel)
  const mem = memoryFallback.get(id);
  if (mem) return okJson(mem);

  return errJson("Plan not found or expired", 404);
};
