import type { APIRoute } from "astro";
import Anthropic from "@anthropic-ai/sdk";
import { errJson, okJson, fetchWithTimeout, toErrMsg, devErrJson } from "../../../lib/apiHelpers";
import { rateLimit, rateLimitResponse } from "../../../lib/rateLimit";
import { CLAUDE_HAIKU, extractText } from "../../../lib/models";
import { CITIES } from "../../../lib/south-bay/cities";
import type { City } from "../../../lib/south-bay/types";

export const prerender = false;

interface StoaRecord {
  id: string | number;
  city: string;
  date: string;
  meetingType: string;
  topic: string;
  title: string;
  excerpt: string;
}

interface Citation {
  city: string;
  date: string;
  meetingType: string;
  topic: string;
  excerpt: string;
}

const VALID_CITY_IDS = new Set<City>(CITIES.map((c) => c.id));
const CITY_ID_TO_NAME: Record<string, string> = Object.fromEntries(
  CITIES.map((c) => [c.id, c.name]),
);

// Tiny in-memory cache so identical follow-up queries (same city + question)
// don't re-pay the Claude call. 30-min TTL is plenty for civic data.
const cache = new Map<string, { ts: number; payload: AskResponse }>();
const CACHE_TTL = 30 * 60 * 1000;

interface AskResponse {
  answer: string;
  followups: string[];
  citations: Citation[];
  totalRecords: number;
}

const client = new Anthropic({
  apiKey: import.meta.env.ANTHROPIC_API_KEY,
});

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!rateLimit(clientAddress, 15)) return rateLimitResponse();
  if (!import.meta.env.ANTHROPIC_API_KEY) return errJson("Service not configured", 503);

  let body: { city?: string; query?: string };
  try {
    body = await request.json();
  } catch {
    return errJson("Invalid JSON body", 400);
  }

  const cityId = (body.city ?? "").trim().toLowerCase();
  const query = (body.query ?? "").trim();

  if (!cityId || !VALID_CITY_IDS.has(cityId as City)) {
    return errJson("Pick a city to search.", 400);
  }
  if (query.length < 2) return errJson("Query too short.", 400);
  if (query.length > 200) return errJson("Query too long.", 400);

  const cityName = CITY_ID_TO_NAME[cityId];
  const cacheKey = `${cityId}::${query.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return okJson(hit.payload);
  }

  // 1. Pull recent records from Stoa, scoped to the picked city.
  // Send the user query verbatim — Stoa AND-matches keywords, so a single
  // search may miss good context. Try a couple of fallback queries for
  // multi-word natural-language questions to widen recall.
  const records = await searchStoa(cityName, query);
  if (records.length === 0) {
    const payload: AskResponse = {
      answer: `I dug through every recent ${cityName} council meeting and didn't see anything specific about that. Try a different angle — e.g. one of the suggestions below — or ask in plain English about a topic you'd expect council to weigh in on.`,
      followups: ["What's been the biggest housing decision recently?", "Any new park or trail funding?", "What's in the latest budget?"],
      citations: [],
      totalRecords: 0,
    };
    cache.set(cacheKey, { ts: Date.now(), payload });
    return okJson(payload);
  }

  // 2. Build a short, friendly Claude prompt with the records as context.
  const recordsContext = records
    .slice(0, 8)
    .map(
      (r, i) =>
        `[${i + 1}] ${r.date} · ${r.meetingType}${r.topic ? ` (${r.topic})` : ""}\n${truncate(r.excerpt, 800)}`,
    )
    .join("\n\n---\n\n");

  const prompt = `You're a friendly, plain-spoken local guide for South Bay Today. A reader is asking about ${cityName}, CA city government. They asked: "${query}"

I pulled ${records.length} relevant records from recent ${cityName} council meetings, agendas, and transcripts. Read them and answer like a friend who actually attended:

RECORDS:
${recordsContext}

Write a JSON object:
- "answer": 3-5 sentences. Specific (dates, dollar amounts, project names, votes if you see them). Conversational. No "based on the records" preamble. No corporate hedging. If the records only tangentially answer, say so honestly and pivot to what they DO show. Don't invent facts.
- "followups": exactly 3 short follow-up questions a curious resident might ask next, based on what's in the records. Each under 60 chars. Specific, not generic.

Output ONLY the JSON. No markdown fences, no preamble.`;

  try {
    const message = await client.messages.create({
      model: CLAUDE_HAIKU,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = extractText(message.content);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Claude returned non-JSON");
    const parsed = JSON.parse(jsonMatch[0]) as { answer?: string; followups?: string[] };

    const payload: AskResponse = {
      answer: (parsed.answer ?? "").trim() || `Found ${records.length} ${cityName} records that touch on this — see the sources below.`,
      followups: Array.isArray(parsed.followups)
        ? parsed.followups.filter((f) => typeof f === "string" && f.length > 0).slice(0, 3)
        : [],
      citations: records.slice(0, 5).map((r) => ({
        city: r.city,
        date: r.date,
        meetingType: r.meetingType,
        topic: r.topic,
        excerpt: truncate(r.excerpt, 220),
      })),
      totalRecords: records.length,
    };

    cache.set(cacheKey, { ts: Date.now(), payload });
    return okJson(payload);
  } catch (e) {
    console.error("ask-records:", e);
    return devErrJson("Couldn't generate an answer right now.", toErrMsg(e));
  }
};

async function searchStoa(cityName: string, query: string): Promise<StoaRecord[]> {
  // Try the verbatim query first; Stoa AND-matches, so a multi-word question
  // often returns 0. If empty, retry with the longest word from the query as a
  // single keyword fallback so we still surface something relevant.
  const params = new URLSearchParams({ city: cityName, q: query, limit: "12" });
  const primary = await stoaFetch(params);
  if (primary.length > 0) return primary;

  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .sort((a, b) => b.length - a.length);

  for (const word of tokens.slice(0, 3)) {
    const fp = new URLSearchParams({ city: cityName, q: word, limit: "12" });
    const r = await stoaFetch(fp);
    if (r.length > 0) return r;
  }
  return [];
}

async function stoaFetch(params: URLSearchParams): Promise<StoaRecord[]> {
  try {
    const res = await fetchWithTimeout(
      `https://www.stoa.works/api/council-meetings?${params.toString()}`,
      { headers: { "User-Agent": "SouthBayToday/1.0 (ask-records)" } },
      8000,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { records?: StoaRecord[] };
    return data.records ?? [];
  } catch {
    return [];
  }
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

const STOPWORDS = new Set([
  "what", "when", "where", "which", "whose", "about", "any", "the", "are", "have", "with",
  "city", "council", "meeting", "meetings", "this", "that", "from", "into", "they", "them",
  "their", "there", "been", "being", "doing", "going", "would", "should", "could", "tell",
  "show", "give", "find", "look", "know", "want", "need", "make", "made", "much", "many",
  "more", "less", "most", "least", "anything", "something", "nothing",
]);
