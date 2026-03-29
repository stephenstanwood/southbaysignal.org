#!/usr/bin/env node
/**
 * generate-air-quality.mjs
 *
 * Fetches real-time US AQI for South Bay cities using Open-Meteo Air Quality API.
 * Free, no API key required.
 *
 * Source: https://air-quality-api.open-meteo.com
 * Run: node scripts/generate-air-quality.mjs
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "air-quality.json");

const CITIES = [
  { id: "san-jose",      name: "San Jose",      lat: 37.3382, lon: -121.8863 },
  { id: "sunnyvale",     name: "Sunnyvale",     lat: 37.3688, lon: -122.0363 },
  { id: "mountain-view", name: "Mountain View", lat: 37.3861, lon: -122.0839 },
  { id: "palo-alto",     name: "Palo Alto",     lat: 37.4419, lon: -122.1430 },
  { id: "santa-clara",   name: "Santa Clara",   lat: 37.3541, lon: -121.9552 },
  { id: "milpitas",      name: "Milpitas",      lat: 37.4323, lon: -121.8996 },
  { id: "campbell",      name: "Campbell",      lat: 37.2872, lon: -121.9500 },
  { id: "cupertino",     name: "Cupertino",     lat: 37.3230, lon: -122.0322 },
  { id: "los-gatos",     name: "Los Gatos",     lat: 37.2261, lon: -121.9822 },
  { id: "saratoga",      name: "Saratoga",      lat: 37.2638, lon: -122.0230 },
  { id: "los-altos",     name: "Los Altos",     lat: 37.3852, lon: -122.1141 },
];

/**
 * AQI levels per EPA standard
 */
function aqiLevel(aqi) {
  if (aqi <= 50)  return { level: "good",            label: "Good",            color: "#00E400", textColor: "#006400" };
  if (aqi <= 100) return { level: "moderate",        label: "Moderate",        color: "#FFFF00", textColor: "#9A6000" };
  if (aqi <= 150) return { level: "usg",             label: "Unhealthy for Sensitive Groups", color: "#FF7E00", textColor: "#7A3E00" };
  if (aqi <= 200) return { level: "unhealthy",       label: "Unhealthy",       color: "#FF0000", textColor: "#8B0000" };
  if (aqi <= 300) return { level: "very-unhealthy",  label: "Very Unhealthy",  color: "#8F3F97", textColor: "#4A1057" };
  return           { level: "hazardous",             label: "Hazardous",       color: "#7E0023", textColor: "#3F0012" };
}

/**
 * Outdoor activity recommendation
 */
function recommendation(aqi) {
  if (aqi <= 50)  return "Great day for outdoor activities.";
  if (aqi <= 100) return "Unusually sensitive people should limit prolonged outdoor exertion.";
  if (aqi <= 150) return "Sensitive groups (asthma, heart/lung conditions) should reduce outdoor activity.";
  if (aqi <= 200) return "Everyone should reduce prolonged outdoor exertion. Sensitive groups avoid outdoor activity.";
  if (aqi <= 300) return "Everyone should avoid prolonged outdoor exertion. Sensitive groups stay indoors.";
  return "Emergency conditions. Everyone should stay indoors with windows closed.";
}

/**
 * Identify primary pollutant from readings
 */
function primaryPollutant(pm25, pm10, ozone) {
  // Simplified: compare normalized values against EPA breakpoints
  const pm25Score = pm25 / 35.4;   // USG breakpoint
  const pm10Score = pm10 / 154;    // USG breakpoint
  const ozoneScore = ozone / 70;   // USG breakpoint in ppb (convert μg/m³: ÷ 2 approx)

  const max = Math.max(pm25Score, pm10Score, ozoneScore);
  if (max === pm25Score) return "PM2.5";
  if (max === ozoneScore) return "Ozone";
  return "PM10";
}

async function fetchCityAQI(city) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}&longitude=${city.lon}&current=us_aqi,pm2_5,pm10,ozone&timezone=America%2FLos_Angeles`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${city.name}`);
  const json = await res.json();

  const { us_aqi, pm2_5, pm10, ozone } = json.current;
  const { level, label, color, textColor } = aqiLevel(us_aqi);
  const pollutant = primaryPollutant(pm2_5, pm10, ozone);

  return {
    id: city.id,
    name: city.name,
    aqi: us_aqi,
    level,
    label,
    color,
    textColor,
    primaryPollutant: pollutant,
    pm25: pm2_5,
    pm10,
    ozone: Math.round(ozone * 0.5), // μg/m³ → approx ppb
    recommendation: recommendation(us_aqi),
  };
}

async function main() {
  console.log("🌬️  Fetching air quality data for South Bay cities...");

  const results = [];
  for (const city of CITIES) {
    try {
      const data = await fetchCityAQI(city);
      results.push(data);
      console.log(`  ✅ ${city.name}: AQI ${data.aqi} (${data.label})`);
      // Small delay to be respectful
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.warn(`  ⚠️  ${city.name}: ${err.message}`);
    }
  }

  if (results.length === 0) {
    console.error("❌ No data fetched.");
    process.exit(1);
  }

  // Compute South Bay average
  const avgAqi = Math.round(results.reduce((sum, c) => sum + c.aqi, 0) / results.length);
  const { level: avgLevel, label: avgLabel, color: avgColor, textColor: avgTextColor } = aqiLevel(avgAqi);

  const output = {
    generatedAt: new Date().toISOString(),
    source: "Open-Meteo Air Quality API",
    sourceUrl: "https://open-meteo.com",
    southBayAvg: {
      aqi: avgAqi,
      level: avgLevel,
      label: avgLabel,
      color: avgColor,
      textColor: avgTextColor,
      recommendation: recommendation(avgAqi),
    },
    cities: results,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✅ Done — ${results.length} cities → ${OUT_PATH}`);
  console.log(`   South Bay avg AQI: ${avgAqi} (${avgLabel})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
