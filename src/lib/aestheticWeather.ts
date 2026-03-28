// WMO weather codes → emoji + description
const WMO: Record<number, [string, string]> = {
  0: ["☀️", "Clear sky"],
  1: ["🌤", "Mostly clear"],
  2: ["⛅", "Partly cloudy"],
  3: ["☁️", "Overcast"],
  45: ["🌫", "Fog"],
  48: ["🌫", "Freezing fog"],
  51: ["🌦", "Light drizzle"],
  53: ["🌦", "Drizzle"],
  55: ["🌧", "Heavy drizzle"],
  61: ["🌧", "Light rain"],
  63: ["🌧", "Rain"],
  65: ["🌧", "Heavy rain"],
  71: ["🌨", "Light snow"],
  73: ["🌨", "Snow"],
  75: ["🌨", "Heavy snow"],
  80: ["🌦", "Rain showers"],
  81: ["🌧", "Rain showers"],
  82: ["⛈", "Heavy showers"],
  95: ["⛈", "Thunderstorm"],
  96: ["⛈", "Thunderstorm + hail"],
  99: ["⛈", "Thunderstorm + hail"],
};

export function wmoInfo(code: number): [string, string] {
  return WMO[code] ?? ["🌡", "Unknown"];
}

/** Default location for weather features (Campbell, CA). */
export const DEFAULT_WEATHER_LAT = 37.2872;
export const DEFAULT_WEATHER_LON = -121.95;
export const DEFAULT_WEATHER_LOCATION = "Campbell, CA";

// --- Types ---

export interface WeatherInput {
  weatherCode: number;
  temp: number; // °F
  feelsLike: number; // °F
  humidity: number; // 0-100
  windSpeedKmh: number;
  cloudCover: number; // 0-100
  uvIndex: number;
  isDay: boolean;
  precipitation: number; // mm
  currentHour: number; // 0-23
  sunriseHour: number; // decimal, e.g. 6.7
  sunsetHour: number; // decimal, e.g. 18.3
}

export interface DayType {
  id: string;
  title: string;
  subtitle: string;
  emoji: string;
  gradient: [string, string];
  accent: string;
  isDark: boolean; // true = light text needed
  prose: string[];
  bestUse: string[];
}

export interface AestheticWeatherResponse {
  location: string;
  timestamp: string;
  dayType: string;
  title: string;
  subtitle: string;
  emoji: string;
  prose: string;
  bestUse: string;
  gradient: [string, string];
  accent: string;
  isDark: boolean;
  temp: number;
  feelsLike: number;
  humidity: number;
  windMph: number;
  cloudCover: number;
  uvIndex: number;
  weatherDesc: string;
  weatherEmoji: string;
  isDay: boolean;
  sunrise: string;
  sunset: string;
  laterToday: string | null;
  bestWindow: string | null;
}

// --- Day-Type Definitions ---

const DAY_TYPES: DayType[] = [
  {
    id: "night-rain",
    title: "Night Rain",
    subtitle: "White noise from the sky",
    emoji: "🌧",
    gradient: ["#1a237e", "#283593"],
    accent: "#7986cb",
    isDark: true,
    prose: [
      "Rain on the roof, dark outside. The kind of night that makes you feel like the only person awake.",
      "The city sounds different when it's wet. A good night to wind down with something warm.",
    ],
    bestUse: [
      "Wind-down time — journal, tea, ambient playlists",
      "Sleep prep — the rain is doing all the work",
    ],
  },
  {
    id: "night-mode",
    title: "Night Mode",
    subtitle: "Stars or streetlights overhead",
    emoji: "🌙",
    gradient: ["#263238", "#37474f"],
    accent: "#80cbc4",
    isDark: true,
    prose: [
      "Clear and quiet. The kind of night where ideas sneak up on you if you let them.",
      "The sky is open. A good night for a short walk or a long thought.",
    ],
    bestUse: [
      "Late-night tinkering, side projects, stargazing",
      "Evening walk, reading, or just sitting with the quiet",
    ],
  },
  {
    id: "golden-hour",
    title: "Golden Hour",
    subtitle: "Go outside right now",
    emoji: "🌅",
    gradient: ["#fff3e0", "#ffccbc"],
    accent: "#bf360c",
    isDark: false,
    prose: [
      "The light is doing that thing. Everything looks better for the next forty-five minutes.",
      "Warm light, long shadows. The day is handing you its best moment — don't waste it indoors.",
    ],
    bestUse: [
      "Walk, patio, photos — anything that puts you in the light",
      "Step outside. The light won't last but the feeling will",
    ],
  },
  {
    id: "early-quiet",
    title: "Early Quiet",
    subtitle: "The world hasn't started yet",
    emoji: "🌅",
    gradient: ["#fce4ec", "#f8bbd0"],
    accent: "#ad1457",
    isDark: false,
    prose: [
      "That rare window before the noise starts. Coffee hits different when no one's asking you anything yet.",
      "Morning light, empty streets. You've got a head start on everyone else today.",
    ],
    bestUse: [
      "Deep work before the world wakes up",
      "Morning pages, first coffee, gentle start",
    ],
  },
  {
    id: "marine-layer",
    title: "Marine Layer",
    subtitle: "The coast is thinking it over",
    emoji: "🌫",
    gradient: ["#e8eaf6", "#c5cae9"],
    accent: "#5c6bc0",
    isDark: false,
    prose: [
      "Fog rolled in like it owns the place. The sun will burn through eventually — or it won't. Either way works.",
      "Classic Bay Area ambiguity. Not quite sunny, not quite gray. A day that doesn't commit but still delivers.",
    ],
    bestUse: [
      "Coffee shop, creative work, cozy productivity",
      "Studio day — the fog is permission to stay focused",
    ],
  },
  {
    id: "rain-cocoon",
    title: "Rain Cocoon",
    subtitle: "Hot drink mandatory",
    emoji: "🌧",
    gradient: ["#e3f2fd", "#bbdefb"],
    accent: "#1565c0",
    isDark: false,
    prose: [
      "It's raining. The universal excuse to cancel everything and nest. Use it wisely.",
      "Wet outside, warm inside. A day that practically begs you to make soup and build something.",
    ],
    bestUse: [
      "Indoor day — cook, build, read, repeat",
      "Deep focus with rain as your soundtrack",
    ],
  },
  {
    id: "wind-engine",
    title: "Wind Engine",
    subtitle: "Nature's doing the pushing",
    emoji: "💨",
    gradient: ["#e0f2f1", "#b2dfdb"],
    accent: "#00897b",
    isDark: false,
    prose: [
      "Breezy with intent. The kind of wind that makes trees interesting and hair irrelevant.",
      "The air is moving and so should you. Good energy day — ride it.",
    ],
    bestUse: [
      "Active day — walk, bike, let the wind move you",
      "High-energy tasks, brainstorming, fresh air breaks",
    ],
  },
  {
    id: "gray-cave",
    title: "Gray Cave Day",
    subtitle: "Permission to stay in",
    emoji: "☁️",
    gradient: ["#eceff1", "#cfd8dc"],
    accent: "#546e7a",
    isDark: false,
    prose: [
      "The sky pulled the covers up. A day built for deep work, long playlists, and forgetting what time it is.",
      "Overcast and unbothered. The kind of day where your best ideas show up unannounced.",
    ],
    bestUse: [
      "Deep focus work, reading, cooking something slow",
      "Studio day — headphones on, world off",
    ],
  },
  {
    id: "golden-burn",
    title: "Golden Burn",
    subtitle: "The sun has opinions today",
    emoji: "☀️",
    gradient: ["#fff8e1", "#ffe0b2"],
    accent: "#e65100",
    isDark: false,
    prose: [
      "Hot and bright. The kind of day that makes shade a personality trait and cold drinks a lifestyle.",
      "The sun is fully committed. Respect it with sunscreen and hydration, then go enjoy it.",
    ],
    bestUse: [
      "Pool, patio, iced everything — embrace it",
      "Morning or evening plans — midday belongs to the shade",
    ],
  },
  {
    id: "soft-glow",
    title: "Soft Glow",
    subtitle: "Easy day, no asterisks",
    emoji: "🌤",
    gradient: ["#fffde7", "#fff9c4"],
    accent: "#f9a825",
    isDark: false,
    prose: [
      "Mild and pleasant. No weather drama, no wardrobe crisis. Just a good, calm day.",
      "The kind of day that doesn't make headlines but quietly makes everything a little better.",
    ],
    bestUse: [
      "Anything — the weather isn't getting in the way",
      "Walk, work outside, errands without complaint",
    ],
  },
];

// --- Classification ---

function isFogCode(code: number): boolean {
  return code === 45 || code === 48;
}

function isPrecipCode(code: number): boolean {
  return code >= 51 && code <= 99;
}

function kmhToMph(kmh: number): number {
  return Math.round(kmh * 0.621371);
}

function dayOfYear(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  return Math.floor(diff / 86400000);
}

export function classifyDayType(input: WeatherInput): DayType {
  const windMph = kmhToMph(input.windSpeedKmh);
  const hasPrecip = input.precipitation > 0 || isPrecipCode(input.weatherCode);
  const hoursUntilSunset = input.sunsetHour - input.currentHour;

  // Night + rain
  if (!input.isDay && hasPrecip) return findType("night-rain");
  // Night
  if (!input.isDay) return findType("night-mode");
  // Golden hour: within 1.5 hours of sunset, clear-ish
  if (hoursUntilSunset > 0 && hoursUntilSunset <= 1.5 && input.cloudCover < 60) return findType("golden-hour");
  // Early quiet: before 8am
  if (input.currentHour < 8) return findType("early-quiet");
  // Fog
  if (isFogCode(input.weatherCode)) return findType("marine-layer");
  // Precipitation
  if (hasPrecip) return findType("rain-cocoon");
  // Wind
  if (windMph > 15) return findType("wind-engine");
  // Heavy overcast
  if (input.cloudCover > 80) return findType("gray-cave");
  // Hot and clear
  if (input.temp >= 80 && input.cloudCover < 50) return findType("golden-burn");
  // Fallback
  return findType("soft-glow");
}

function findType(id: string): DayType {
  return DAY_TYPES.find((t) => t.id === id) ?? DAY_TYPES[DAY_TYPES.length - 1];
}

// --- Response Builder ---

export interface HourlyForecast {
  temperatures: number[]; // °F, next 12 hours
  weatherCodes: number[];
  cloudCovers: number[];
  precipProbs: number[];
}

export function computeLaterToday(
  currentTemp: number,
  currentHour: number,
  forecast: HourlyForecast
): string | null {
  // Look 4-6 hours ahead
  const lookAhead = Math.min(6, forecast.temperatures.length);
  if (lookAhead < 4) return null;

  const futureTemps = forecast.temperatures.slice(3, lookAhead);
  if (futureTemps.length === 0) return null;

  const avgFuture = futureTemps.reduce((a, b) => a + b, 0) / futureTemps.length;
  const delta = avgFuture - currentTemp;

  if (Math.abs(delta) >= 8) {
    const dir = delta > 0 ? "Warming" : "Cooling";
    return `${dir} to ${Math.round(avgFuture)}°F by evening`;
  }

  // Check for precipitation incoming
  const futurePrecip = forecast.precipProbs.slice(2, lookAhead);
  const maxPrecipProb = Math.max(...futurePrecip, 0);
  if (maxPrecipProb >= 50) {
    const hoursOut = futurePrecip.findIndex((p) => p >= 50) + 2;
    return `Rain likely in ~${hoursOut} hours`;
  }

  return null;
}

export function computeBestWindow(
  currentHour: number,
  forecast: HourlyForecast
): string | null {
  // Find a stretch of clear weather in next 8 hours
  const lookAhead = Math.min(8, forecast.cloudCovers.length);
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i < lookAhead; i++) {
    if (forecast.cloudCovers[i] < 40 && forecast.precipProbs[i] < 30) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen >= 2 && bestStart > 0) {
    const startHour = (currentHour + bestStart) % 24;
    const endHour = (currentHour + bestStart + bestLen) % 24;
    const fmt = (h: number) => {
      const h12 = h % 12 || 12;
      return `${h12}${h < 12 ? "am" : "pm"}`;
    };
    return `Best light: ${fmt(startHour)}–${fmt(endHour)}`;
  }

  return null;
}

export function buildResponse(
  input: WeatherInput,
  forecast: HourlyForecast,
  location: string,
  sunriseStr: string,
  sunsetStr: string
): AestheticWeatherResponse {
  const dayType = classifyDayType(input);
  const doy = dayOfYear();
  const prose = dayType.prose[doy % dayType.prose.length];
  const bestUse = dayType.bestUse[doy % dayType.bestUse.length];
  const windMph = kmhToMph(input.windSpeedKmh);
  const [weatherEmoji, weatherDesc] = wmoInfo(input.weatherCode);

  return {
    location,
    timestamp: new Date().toISOString(),
    dayType: dayType.id,
    title: dayType.title,
    subtitle: dayType.subtitle,
    emoji: dayType.emoji,
    prose,
    bestUse,
    gradient: dayType.gradient,
    accent: dayType.accent,
    isDark: dayType.isDark,
    temp: Math.round(input.temp),
    feelsLike: Math.round(input.feelsLike),
    humidity: Math.round(input.humidity),
    windMph,
    cloudCover: Math.round(input.cloudCover),
    uvIndex: Math.round(input.uvIndex),
    weatherDesc,
    weatherEmoji,
    isDay: input.isDay,
    sunrise: sunriseStr,
    sunset: sunsetStr,
    laterToday: computeLaterToday(input.temp, input.currentHour, forecast),
    bestWindow: computeBestWindow(input.currentHour, forecast),
  };
}

