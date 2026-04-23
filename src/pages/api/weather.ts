export const prerender = false;
import type { APIRoute } from "astro";
import { wmoInfo, forecastEmoji, DEFAULT_WEATHER_LAT, DEFAULT_WEATHER_LON } from "../../lib/aestheticWeather";
import { CITY_MAP } from "../../lib/south-bay/cities";
import type { City } from "../../lib/south-bay/types";
import { rateLimit, rateLimitResponse } from "../../lib/rateLimit";
import { okJson } from "../../lib/apiHelpers";

/**
 * Weather proxy for South Bay Today.
 * Uses Open-Meteo (free, no key) — returns current conditions + 5-day daily forecast.
 * Accepts optional ?city=campbell query param; defaults to Campbell coords.
 * Cached 30 min via CDN.
 */

export const GET: APIRoute = async ({ request, clientAddress }) => {
  if (!rateLimit(clientAddress)) return rateLimitResponse();

  try {
    const cityId = new URL(request.url).searchParams.get("city") as City | null;
    const cityConfig = cityId ? CITY_MAP[cityId] : null;
    const lat = cityConfig?.lat ?? DEFAULT_WEATHER_LAT;
    const lon = cityConfig?.lon ?? DEFAULT_WEATHER_LON;

    const url = [
      `https://api.open-meteo.com/v1/forecast`,
      `?latitude=${lat}&longitude=${lon}`,
      `&current=temperature_2m,weather_code`,
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,cloud_cover_mean`,
      `&temperature_unit=fahrenheit`,
      `&timezone=America%2FLos_Angeles`,
      `&forecast_days=5`,
    ].join("");

    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);

    const data = await res.json();

    // Current conditions one-liner
    const temp = Math.round(data.current.temperature_2m);
    const code = data.current.weather_code as number;
    const [emoji, desc] = wmoInfo(code);
    const weather = `${emoji} ${temp}°F ${desc.toLowerCase()}`;

    // 5-day daily forecast
    const { time, weather_code, temperature_2m_max, temperature_2m_min, precipitation_probability_max, cloud_cover_mean } = data.daily;
    const forecast = (time as string[]).map((date: string, i: number) => {
      const rainPct = precipitation_probability_max[i] as number;
      const ccMean = cloud_cover_mean?.[i] as number | null | undefined;
      const [fe, fd] = forecastEmoji(weather_code[i] as number, ccMean, rainPct);
      return {
        date,
        emoji: fe,
        desc: fd,
        high: Math.round(temperature_2m_max[i] as number),
        low: Math.round(temperature_2m_min[i] as number),
        rainPct,
      };
    });

    return okJson({ weather, forecast }, { "Cache-Control": "public, s-maxage=1800, max-age=900" });
  } catch (err) {
    console.error("weather fetch error:", err);
    return okJson({ weather: null, forecast: null });
  }
};
