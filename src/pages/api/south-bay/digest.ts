import type { APIRoute } from "astro";
import { MiniClaude } from "../../../lib/miniClaude";
import { errJson, okJson } from "../../../lib/apiHelpers";
import { rateLimit, rateLimitResponse } from "../../../lib/rateLimit";
import { CLAUDE_SONNET, extractText, stripFences } from "../../../lib/models";
import {
  fetchCityAgenda,
  fetchAgendaContent,
  fetchLegistarContent,
  getConfiguredCities,
} from "../../../lib/south-bay/agendaScraperFactory";
import type { City } from "../../../lib/south-bay/types";

export const prerender = false;

// ── Types ──

export interface CityDigest {
  city: string;
  cityName: string;
  body: string;
  meetingDate: string;
  title: string;
  summary: string;
  keyTopics: string[];
  nextMeeting: string | null;
  schedule: string;
  sourceUrl: string;
  generatedAt: string;
}

// ── Cache ──
// Per-city cache with 24-hour TTL
const cache = new Map<string, { data: CityDigest; ts: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

const client = new MiniClaude();

// ── Handlers ──

/** GET: list configured cities or fetch a specific city's digest. */
export const GET: APIRoute = async ({ url, clientAddress }) => {
  if (!rateLimit(clientAddress, 20)) return rateLimitResponse();

  const city = url.searchParams.get("city") as City | null;

  // No city param → return list of configured cities
  if (!city) {
    return okJson({ cities: getConfiguredCities() });
  }

  // Check cache
  const cached = cache.get(city);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return okJson(cached.data);
  }

  if (!import.meta.env.MINI_CLAUDE_URL || !import.meta.env.MINI_CLAUDE_TOKEN) {
    return errJson("Service not configured", 503);
  }

  // 1. Scrape the latest agenda
  const agenda = await fetchCityAgenda(city);
  if (!agenda) {
    // Reached when the city has no scraper config, or when its agenda source
    // is stale enough that publishing it would misdate the meeting. The card
    // shows this string verbatim, so keep it plain English — the nightly digest
    // already on screen stays put.
    return errJson("Couldn't pull a fresh agenda from this city right now.", 404);
  }

  // 2. Get the agenda content
  // Legistar cities: use structured EventItems API (JSON, no PDF scraping needed)
  // CivicEngage cities: fall back to HTML agenda page scraping
  let content: string | null = null;

  if (agenda.legistarEventId != null && agenda.legistarClientId) {
    content = await fetchLegistarContent(
      agenda.legistarClientId,
      agenda.legistarEventId,
    );
  }

  if (!content) {
    // Fallback: HTML agenda page (works for CivicEngage; also tried if Legistar items come back empty)
    content = await fetchAgendaContent(agenda.pdfUrl);
  }

  if (!content) {
    return errJson("Could not read agenda content", 502);
  }

  // 3. Summarize with Claude
  const prompt = `You are summarizing a ${agenda.cityName}, CA ${agenda.body} meeting agenda for residents.

Given the following agenda text, produce a JSON object with these fields:
- "meetingDate": the date of the meeting (string)
- "title": a short title like "${agenda.cityName} ${agenda.body} — ${agenda.date}" (string)
- "summary": a 2-3 sentence plain-English summary of what this meeting covers (string)
- "keyTopics": an array of 3-6 short bullet points about the main agenda items (string[])
- "nextMeeting": when the next meeting likely is based on the ${agenda.schedule} pattern, or null (string|null)

Write for a general audience. No jargon. Be specific about what's being discussed.

Agenda text:
${content}`;

  try {
    const message = await client.messages.create({
      model: CLAUDE_SONNET,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = extractText(message.content);
    const parsed = JSON.parse(stripFences(raw));

    const digest: CityDigest = {
      city: agenda.city,
      cityName: agenda.cityName,
      body: agenda.body,
      meetingDate: parsed.meetingDate ?? agenda.date,
      title: parsed.title ?? agenda.title,
      summary: parsed.summary ?? "",
      keyTopics: parsed.keyTopics ?? [],
      nextMeeting: parsed.nextMeeting ?? null,
      schedule: agenda.schedule,
      sourceUrl: agenda.url,
      generatedAt: new Date().toISOString(),
    };

    cache.set(city, { data: digest, ts: Date.now() });

    return okJson(digest);
  } catch (e) {
    console.error(`Digest error for ${city}:`, e);
    return errJson("Failed to generate digest", 500);
  }
};
