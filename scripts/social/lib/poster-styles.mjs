// ---------------------------------------------------------------------------
// South Bay Today — Recraft Poster Style Pool
// 13 approved style categories + prompt templates per content type
// 80% approved styles, 20% novel/experimental
// ---------------------------------------------------------------------------

/**
 * Approved style categories — each has a design direction and optional color palette.
 * These were selected from 81 generated samples on 2026-04-12.
 */
export const APPROVED_STYLES = [
  {
    id: "rainbow-stripes",
    label: "Rainbow Stripes",
    style: `Rainbow horizontal color block stripes flowing vertically (coral header, golden yellow, teal, green, lavender, deep navy). Clean modern sans-serif typography. Playful confetti dots and small stars scattered in margins. Joyful festival lineup poster feel.`,
    colors: [{ rgb: [255, 107, 107] }, { rgb: [255, 195, 0] }, { rgb: [0, 184, 169] }, { rgb: [106, 76, 147] }, { rgb: [30, 55, 120] }],
  },
  {
    id: "sunset-gradient",
    label: "Sunset Gradient",
    style: `Smooth vertical gradient from warm peach/coral at top through golden amber, to deep magenta/purple at bottom. No hard color blocks — sections separated by subtle horizontal lines. Elegant modern serif + sans-serif mixed typography. Minimalist, sophisticated. Gold foil accent feel on the times.`,
    colors: [{ rgb: [255, 183, 148] }, { rgb: [255, 140, 66] }, { rgb: [219, 68, 117] }, { rgb: [128, 40, 145] }, { rgb: [45, 20, 80] }],
  },
  {
    id: "neon-dark",
    label: "Neon Dark",
    style: `Dark charcoal/near-black background. Neon glow text effects — electric cyan, hot pink, lime green, electric purple. Sections separated by thin neon lines. Modern condensed sans-serif type. Night market / cyberpunk poster aesthetic. Subtle grid pattern in background.`,
    colors: [{ rgb: [0, 255, 255] }, { rgb: [255, 20, 147] }, { rgb: [0, 255, 65] }, { rgb: [180, 0, 255] }, { rgb: [25, 25, 35] }],
  },
  {
    id: "tropical-botanical",
    label: "Tropical Botanical",
    style: `Tropical botanical poster. Lush illustrated palm leaves, monstera, tropical flowers in borders and corners. Deep emerald green background sections alternating with warm coral/pink. White and cream text. Bold modern sans-serif type. Hawaii travel poster meets festival lineup.`,
    colors: [{ rgb: [0, 100, 60] }, { rgb: [255, 107, 107] }, { rgb: [255, 255, 240] }, { rgb: [255, 182, 193] }, { rgb: [34, 139, 34] }],
  },
  {
    id: "memphis-80s",
    label: "Memphis 80s",
    style: `Memphis design movement aesthetic (1980s). Bright clashing colors: hot pink, electric blue, yellow, black, mint green. Random geometric shapes (triangles, circles, squiggly lines, zigzags) scattered around. Bold black sans-serif headlines on colored blocks. Energetic, chaotic, fun. Like a vintage MTV graphic.`,
    colors: [{ rgb: [255, 20, 147] }, { rgb: [0, 100, 255] }, { rgb: [255, 255, 0] }, { rgb: [0, 210, 180] }, { rgb: [0, 0, 0] }],
  },
  {
    id: "bauhaus",
    label: "Bauhaus",
    style: `Bauhaus design school aesthetic. Primary colors only: red, blue, yellow on white with black type. Strong geometric shapes (circles, rectangles, triangles) as section backgrounds. Grid-based layout. Clean modernist sans-serif type (like Futura). Structured, rational, iconic.`,
    colors: [{ rgb: [220, 40, 40] }, { rgb: [0, 50, 180] }, { rgb: [255, 210, 0] }, { rgb: [255, 255, 255] }, { rgb: [0, 0, 0] }],
  },
  {
    id: "risograph-zine",
    label: "Risograph Zine",
    style: `Risograph print aesthetic. Slightly misregistered two/three-color overprint look. Grainy textures. Colors: fluorescent pink, teal/blue, golden yellow overlapping with halftone dots. Hand-drawn feeling dividers and decorations. Zine/indie print shop vibe. Bold blocky sans-serif type with slight roughness.`,
    colors: [{ rgb: [255, 50, 120] }, { rgb: [0, 150, 170] }, { rgb: [255, 200, 0] }, { rgb: [240, 235, 225] }],
  },
  {
    id: "pastel-dreamy",
    label: "Pastel Dreamy",
    style: `Soft pastel color palette: baby pink, mint green, lavender, soft peach, powder blue. Gentle rounded sans-serif typography. Subtle cloud or bubble shapes as section backgrounds. Dreamy, calming, approachable. Like a modern wellness brand or gentle lifestyle poster. Slightly rounded corners on color blocks.`,
    colors: [{ rgb: [255, 182, 193] }, { rgb: [176, 224, 230] }, { rgb: [221, 160, 221] }, { rgb: [255, 218, 185] }, { rgb: [152, 251, 152] }],
  },
  {
    id: "wild-card-bold",
    label: "Wild Card Bold",
    style: `Bold contemporary graphic design poster mixing styles freely. Oversized typography overlapping with abstract painted brush strokes in bright colors. Mix of serif and sans-serif fonts at different scales. Collage-like energy. Sections feel hand-assembled. Confident, bold, arresting — like a Cooper Hewitt Design Museum exhibition poster.`,
    colors: [{ rgb: [255, 90, 0] }, { rgb: [0, 80, 200] }, { rgb: [255, 220, 0] }, { rgb: [0, 0, 0] }, { rgb: [255, 255, 255] }],
  },
  {
    id: "travel-guide",
    label: "Travel Guide",
    style: `Travel guidebook page layout. Clean white background, structured like a Lonely Planet city guide. Small illustrated icons next to each stop (coffee cup, art frame, fork/knife, microphone). Numbered stops with clean dotted timeline down the left side. Professional travel editorial design. Navy blue and warm orange accent colors.`,
    colors: [{ rgb: [20, 50, 100] }, { rgb: [255, 140, 50] }, { rgb: [255, 255, 255] }, { rgb: [60, 60, 60] }],
  },
  {
    id: "chalkboard-menu",
    label: "Chalkboard Menu",
    style: `Chalkboard cafe menu aesthetic. Dark charcoal/blackboard textured background. White and pastel chalk-style hand-lettered typography. Decorative chalk borders, small chalk illustrations (arrows, stars, underlines). Each stop formatted like a menu item with time as the price. Warm, artisanal, cozy coffee shop feeling.`,
    colors: [{ rgb: [40, 45, 50] }, { rgb: [255, 255, 255] }, { rgb: [255, 200, 100] }, { rgb: [200, 220, 255] }],
  },
  {
    id: "boarding-pass",
    label: "Boarding Pass",
    style: `Airline boarding pass or event ticket strip design. Each stop is its own perforated ticket section stacked vertically. Dotted tear-lines between sections. Monospace/typewriter font for times. Bold sans-serif for venue names. Subtle barcodes or QR code decorations. Color-coded ticket sections. Clever, design-forward, modern.`,
    colors: [{ rgb: [0, 80, 180] }, { rgb: [255, 80, 80] }, { rgb: [255, 200, 0] }, { rgb: [240, 240, 240] }, { rgb: [40, 40, 40] }],
  },
  {
    id: "scrapbook",
    label: "Scrapbook",
    style: `Scrapbook / mood board aesthetic. Warm kraft paper or corkboard textured background. Each stop presented as a tilted white card or polaroid frame pinned to the board. Handwritten-style captions beneath each card. Colorful washi tape strips, push pins, small sticker decorations. Warm, personal, tactile, DIY feeling.`,
    colors: [{ rgb: [180, 140, 100] }, { rgb: [255, 255, 255] }, { rgb: [255, 100, 100] }, { rgb: [100, 180, 220] }, { rgb: [255, 220, 50] }],
  },
];

/**
 * Novel style prompts for the 20% experimental slot.
 * These are broader creative directions the model can interpret freely.
 */
const NOVEL_DIRECTIONS = [
  `Japanese woodblock print (ukiyo-e) aesthetic with bold outlines, flat color areas, and nature motifs. Traditional meets modern typography.`,
  `Comic book / pop art panel layout with Ben-Day dots, speech bubbles for descriptions, bold black outlines, and primary colors.`,
  `Blueprint / technical drawing aesthetic with white lines on navy blue background, precise grid, and monospace type.`,
  `Watercolor wash aesthetic with soft bleeding edges between sections, hand-painted feel, elegant script headings.`,
  `Cut paper collage / Matisse-style with bold organic shapes, bright colors, layered paper textures.`,
  `Vintage travel poster (1930s-1950s) with art deco typography, flat illustrated landmarks, bold simplified shapes.`,
  `Psychedelic 1960s poster with swirling organic type, vibrant contrasting colors, optical illusions.`,
  `Minimalist Scandinavian design with lots of white space, thin sans-serif type, muted earth tones, simple line illustrations.`,
  `Street art / graffiti aesthetic with spray paint textures, stencil type, urban color palette, raw energy.`,
  `Stained glass window design with bold black leading lines, jewel-tone colored sections, gothic-inspired type.`,
  `Retro video game pixel art aesthetic with 8-bit style icons, neon colors on dark background, pixelated type.`,
  `Art nouveau poster with flowing organic lines, ornamental borders, elegant serif type, gold and deep green.`,
  `Brutalist graphic design with harsh type, raw concrete textures, stark black and white with one accent color.`,
  `Terrazzo / mid-century modern pattern background with atomic age typography, warm retro palette.`,
  `Origami / paper fold aesthetic with geometric faceted shapes, subtle shadows, clean modern type.`,
];

/**
 * Pick a style: 80% from approved pool, 20% novel/experimental.
 * @returns {{ style: string, colors: Array|null, id: string, isNovel: boolean }}
 */
export function pickStyle() {
  if (Math.random() < 0.2) {
    const dir = NOVEL_DIRECTIONS[Math.floor(Math.random() * NOVEL_DIRECTIONS.length)];
    return { style: dir, colors: null, id: "novel", isNovel: true };
  }
  const pick = APPROVED_STYLES[Math.floor(Math.random() * APPROVED_STYLES.length)];
  return { style: pick.style, colors: pick.colors, id: pick.id, isNovel: false };
}

// ── Prompt Templates ─────────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Build a Recraft prompt for a day plan poster.
 * @param {object} plan - Plan object with cards array
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} styleDirection - Design style description
 * @returns {string}
 */
export function dayPlanPrompt(plan, dateStr, styleDirection) {
  const date = new Date(dateStr + "T12:00:00");
  const dayName = DAY_NAMES[date.getDay()];

  const cities = [...new Set(plan.cards.map((c) => c.city).filter(Boolean))];
  const cityDisplay = cities.map((c) => c.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")).join(" + ");

  let stopsText = "";
  for (const card of plan.cards) {
    const time = card.timeBlock?.split(" - ")[0] || "";
    const blurb = card.blurb?.split("—")[0]?.trim() || card.blurb || "";
    stopsText += `\n${time} — ${card.name}\n${blurb.slice(0, 80)}\n`;
  }

  return `Design a portrait 4:5 Instagram poster showing a day plan for a local community guide. The poster must contain ALL of this text content, accurately spelled, in a clear readable hierarchy:

"${dayName.toUpperCase()} IN THE SOUTH BAY"
${cityDisplay}
${stopsText}
southbaytoday.org

DESIGN DIRECTION:
${styleDirection}

CRITICAL: All text must be spelled correctly and fully legible. This is a graphic design poster, NOT a photograph. The text content is the star — make it beautiful but readable. Do NOT include "STOP 1", "STOP 2" labels — just the times and venue names.`;
}

/**
 * Build a Recraft prompt for a tonight-pick single-item poster.
 * @param {object} item - Event/restaurant item
 * @param {string} styleDirection - Design style description
 * @returns {string}
 */
export function tonightPickPrompt(item, styleDirection) {
  const venue = item.venue || "";
  const city = item.cityName || item.city || "";
  const time = item.time || "";
  const cost = item.costNote || item.cost || "";

  return `Design a portrait 4:5 Instagram poster highlighting ONE evening event/activity. Bold, eye-catching, designed to make someone want to go tonight.

"TONIGHT IN THE SOUTH BAY"

${item.title || item.name}
${venue ? `at ${venue}` : ""}
${city}${time ? ` · ${time}` : ""}${cost ? ` · ${cost}` : ""}

${(item.blurb || item.summary || "").slice(0, 120)}

southbaytoday.org

DESIGN DIRECTION:
${styleDirection}

This is a SINGLE EVENT spotlight, not a multi-stop day plan. Make the event name large and prominent. Evening/night energy. NOT a photograph — graphic design poster. All text must be spelled correctly and fully legible.`;
}

/**
 * Build a Recraft prompt for a wildcard post.
 * @param {object} item - Content item
 * @param {string} subtype - "sv-history" | "restaurant" | "general"
 * @param {string} styleDirection - Design style description
 * @returns {string}
 */
export function wildcardPrompt(item, subtype, styleDirection) {
  if (subtype === "sv-history") {
    return `Design a portrait 4:5 Instagram poster for a "Silicon Valley History" feature. Retro-tech meets modern design.

"ON THIS DAY IN SILICON VALLEY"

${item.company || item.title || item.name}
${item.tagline || (item.blurb || "").slice(0, 100)}
${item.foundedYear ? `Est. ${item.foundedYear}` : ""}

southbaytoday.org

DESIGN DIRECTION:
${styleDirection}

Historic/nostalgic energy but with modern design sensibility. NOT a photograph — graphic design poster. All text must be spelled correctly and fully legible.`;
  }

  if (subtype === "restaurant") {
    return `Design a portrait 4:5 Instagram poster highlighting a new restaurant opening. Warm, appetizing, inviting energy.

"NOW OPEN"

${item.title || item.name}
${item.cityName || item.city || ""}
${(item.blurb || item.summary || "").slice(0, 120)}

southbaytoday.org

DESIGN DIRECTION:
${styleDirection}

Food/dining energy — warm, appetizing, inviting. NOT a photograph — graphic design poster. All text must be spelled correctly and fully legible.`;
  }

  // General wildcard
  return `Design a portrait 4:5 Instagram poster highlighting an interesting local item.

"SOUTH BAY TODAY"

${item.title || item.name}
${item.cityName || item.city || ""}
${(item.blurb || item.summary || "").slice(0, 120)}

southbaytoday.org

DESIGN DIRECTION:
${styleDirection}

NOT a photograph — graphic design poster. All text must be spelled correctly and fully legible.`;
}

// ── Abstract image prompts (no text, no people) ─────────────────────────
// Used for tonight-pick and wildcard slots — mood/concept imagery only.

/**
 * Build an abstract Recraft prompt from social post copy.
 * @param {string} postCopy - The social post text (X variant works well)
 * @param {string} category - Event category hint (arts, food, tech, etc.)
 * @returns {string}
 */
export function abstractImagePrompt(postCopy, category) {
  const moodHints = {
    arts: "sound waves, stage lighting, flowing rhythm, performance energy",
    music: "sound waves, equalizer bars, vinyl grooves, sonic ripples",
    food: "warm gradients, organic shapes, steam wisps, kitchen textures",
    tech: "circuit patterns, data streams, pixel grids, digital geometry",
    sports: "motion lines, dynamic angles, kinetic energy, arena lights",
    community: "interlocking shapes, gathering patterns, warm mosaic, connected forms",
    education: "book spines, knowledge trees, layered pages, discovery spirals",
  };
  const mood = moodHints[category] || "geometric patterns, color fields, bold shapes, visual rhythm";

  return `Abstract, graphic design illustration. NO PEOPLE — no faces, no hands, no human figures. NO TEXT — no words, no typography, no logos, no watermarks.

Inspired by this social post (for mood/concept only, do NOT render the words):
"${postCopy.slice(0, 200)}"

Create a bold, stylized composition using abstract shapes, color fields, and visual metaphors. Think: ${mood}. Modern editorial illustration — between a gig poster background and album art. Rich saturated colors, strong composition, visually striking at thumbnail size. 4:5 portrait ratio.`;
}
