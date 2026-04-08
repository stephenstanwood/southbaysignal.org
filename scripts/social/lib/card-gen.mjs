// ---------------------------------------------------------------------------
// South Bay Signal — Social Card Generation
// Generates branded 1200x675 PNG cards using satori + sharp
// ---------------------------------------------------------------------------

import satori from "satori";
import sharp from "sharp";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, CITY_NAMES } from "./constants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// Card dimensions
const WIDTH = 1200;
const HEIGHT = 675;

// Brand colors
const COLORS = {
  bg: "#FAF9F6",
  ink: "#1A1A1A",
  muted: "#555555",
  light: "#888888",
  border: "#C8C4BC",
  accent: "#C0392B",
  accentLight: "#FDEEEC",
};

// Format labels and accent colors
const FORMAT_STYLES = {
  daily_pulse: { label: "DAILY PULSE", color: "#1A1A1A" },
  tonight: { label: "TONIGHT", color: "#C0392B" },
  weekend: { label: "WEEKEND ROUNDUP", color: "#2C6B4F" },
  civic: { label: "CIVIC SIGNAL", color: "#2B5C8C" },
};

// Load fonts for satori
let _fonts = null;
async function loadFonts() {
  if (_fonts) return _fonts;

  // Use system fonts or bundled fonts
  // Satori requires font buffers. We'll use Inter as the primary font.
  // Try to load from common system paths or use a fallback.
  const fontPaths = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
  ];

  let fontData;
  for (const p of fontPaths) {
    try {
      fontData = readFileSync(p);
      break;
    } catch {}
  }

  if (!fontData) {
    // Fetch Inter from Google Fonts CDN as fallback
    const res = await fetch(
      "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hjQ.ttf"
    );
    fontData = Buffer.from(await res.arrayBuffer());
  }

  _fonts = [
    { name: "Inter", data: fontData, weight: 400, style: "normal" },
  ];

  return _fonts;
}

/**
 * Build the card JSX structure for satori.
 * Satori uses a subset of CSS via inline styles on a JSX-like object tree.
 */
function buildCard(format, items, date) {
  const style = FORMAT_STYLES[format] || FORMAT_STYLES.daily_pulse;

  // Format date nicely
  const dateObj = new Date(date + "T12:00:00");
  const dateStr = dateObj.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Build item lines (max 5)
  const displayItems = items.slice(0, 5);

  return {
    type: "div",
    props: {
      style: {
        width: WIDTH,
        height: HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: COLORS.bg,
        padding: "48px 56px",
        fontFamily: "Inter",
      },
      children: [
        // Header: Logo + format label
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              marginBottom: "24px",
            },
            children: [
              // Logo
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "column" },
                  children: [
                    {
                      type: "div",
                      props: {
                        style: {
                          fontSize: "14px",
                          color: COLORS.muted,
                          fontStyle: "italic",
                          marginBottom: "2px",
                        },
                        children: "The",
                      },
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          fontSize: "32px",
                          fontWeight: 700,
                          color: COLORS.ink,
                          letterSpacing: "-0.5px",
                          lineHeight: "1",
                        },
                        children: "South Bay",
                      },
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          fontSize: "11px",
                          color: COLORS.muted,
                          letterSpacing: "6px",
                          textTransform: "uppercase",
                          marginTop: "4px",
                        },
                        children: "━━ SIGNAL ━━",
                      },
                    },
                  ],
                },
              },
              // Format label
              {
                type: "div",
                props: {
                  style: {
                    fontSize: "12px",
                    fontWeight: 700,
                    color: style.color,
                    letterSpacing: "3px",
                    textTransform: "uppercase",
                    paddingTop: "8px",
                  },
                  children: style.label,
                },
              },
            ],
          },
        },
        // Divider
        {
          type: "div",
          props: {
            style: {
              width: "100%",
              height: "1px",
              backgroundColor: COLORS.border,
              marginBottom: "28px",
            },
          },
        },
        // Items
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              flex: "1",
            },
            children: displayItems.map((item, i) => ({
              type: "div",
              props: {
                style: {
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "12px",
                },
                children: [
                  // Bullet
                  {
                    type: "div",
                    props: {
                      style: {
                        fontSize: "14px",
                        color: COLORS.light,
                        minWidth: "20px",
                        paddingTop: "2px",
                      },
                      children: `${i + 1}.`,
                    },
                  },
                  // Content
                  {
                    type: "div",
                    props: {
                      style: { display: "flex", flexDirection: "column", gap: "2px" },
                      children: [
                        {
                          type: "div",
                          props: {
                            style: {
                              fontSize: "20px",
                              fontWeight: 700,
                              color: COLORS.ink,
                              lineHeight: "1.3",
                            },
                            children: item.title.length > 55
                              ? item.title.slice(0, 52) + "..."
                              : item.title,
                          },
                        },
                        {
                          type: "div",
                          props: {
                            style: {
                              fontSize: "14px",
                              color: COLORS.muted,
                            },
                            children: [
                              item.cityName || "",
                              item.venue ? ` · ${item.venue}` : "",
                              item.time ? ` · ${item.time}` : "",
                            ]
                              .filter(Boolean)
                              .join(""),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            })),
          },
        },
        // Footer
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              marginTop: "auto",
              paddingTop: "20px",
              borderTop: `1px solid ${COLORS.border}`,
            },
            children: [
              {
                type: "div",
                props: {
                  style: { fontSize: "13px", color: COLORS.light },
                  children: dateStr,
                },
              },
              {
                type: "div",
                props: {
                  style: { fontSize: "13px", color: COLORS.muted },
                  children: "southbaytoday.org",
                },
              },
            ],
          },
        },
      ],
    },
  };
}

/**
 * Generate a PNG card for a social post.
 *
 * @param {string} format - Post format (daily_pulse, tonight, weekend, civic)
 * @param {Array} items - Selected items to display
 * @param {string} date - Date string (YYYY-MM-DD)
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function generateCard(format, items, date) {
  const fonts = await loadFonts();
  const card = buildCard(format, items, date);

  const svg = await satori(card, {
    width: WIDTH,
    height: HEIGHT,
    fonts,
  });

  const png = await sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer();
  return png;
}

/**
 * Generate and save a card to disk.
 * Returns the file path.
 */
export async function generateAndSaveCard(format, items, date) {
  const dir = CONFIG.CARD_OUTPUT_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const png = await generateCard(format, items, date);
  const filename = `sbs-${format}-${date}.png`;
  const filepath = join(dir, filename);

  const { writeFileSync } = await import("node:fs");
  writeFileSync(filepath, png);

  return filepath;
}
