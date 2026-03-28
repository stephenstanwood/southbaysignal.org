export const prerender = false;
import type { APIRoute } from "astro";
import { wmoInfo, DEFAULT_WEATHER_LAT, DEFAULT_WEATHER_LON } from "../../lib/aestheticWeather";
import { rateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { okJson } from "../../lib/apiHelpers";

/**
 * Lightweight weather proxy for the homepage terminal card.
 * Uses Open-Meteo (free, no key) for Campbell, CA coords.
 * Returns a one-liner like "☀️ 72°F clear sky".
 *
 * Cached for 30 minutes via CDN headers.
 */

export const GET: APIRoute = async ({ clientAddress }) => {
  if (!rateLimit(clientAddress)) return rateLimitResponse();

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${DEFAULT_WEATHER_LAT}&longitude=${DEFAULT_WEATHER_LON}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America/Los_Angeles`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) throw new Error(`open-meteo ${res.status}`);

    const data = await res.json();
    const temp = Math.round(data.current.temperature_2m);
    const code = data.current.weather_code as number;
    const [emoji, desc] = wmoInfo(code);

    const weather = `${emoji} ${temp}°F ${desc.toLowerCase()}`;

    return okJson({ weather }, { "Cache-Control": "public, s-maxage=1800, max-age=900" });
  } catch (err) {
    console.error("weather fetch error:", err);
    // status 200 intentional — CDN caches this; null signals the UI to show nothing
    return okJson({ weather: null });
  }
};
