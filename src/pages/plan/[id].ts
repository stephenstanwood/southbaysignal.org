export const prerender = false;

// ---------------------------------------------------------------------------
// GET /plan/:id — shareable day plan preview page
// ---------------------------------------------------------------------------
// Renders a self-contained HTML page with OG tags and plan cards.
// Reads from the in-memory plan store via internal API.
// ---------------------------------------------------------------------------

import type { APIRoute } from "astro";
import { getCityName } from "../../lib/south-bay/cities";
import type { City } from "../../lib/south-bay/types";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CATEGORY_EMOJI: Record<string, string> = {
  food: "🍽️", outdoor: "🌿", museum: "🏛️", entertainment: "🎭",
  wellness: "💆", shopping: "🛍️", arts: "🎨", events: "📅",
  sports: "⚾", neighborhood: "🏘️",
};

export const GET: APIRoute = async ({ params, url }) => {
  const id = params.id;
  if (!id) return new Response("Not found", { status: 404 });

  // Fetch plan from the share-plan API (same server)
  const origin = url.origin;
  let plan: any;
  try {
    const res = await fetch(`${origin}/api/share-plan?id=${id}`);
    if (!res.ok) throw new Error("not found");
    plan = await res.json();
  } catch {
    // Plan expired or not found — redirect to homepage
    return Response.redirect(`${origin}/`, 302);
  }

  const cityName = getCityName(plan.city as City);
  const canonical = `${origin}/plan/${id}`;
  const ogImage = `${origin}/images/og-image.png`;

  // Filter out cards whose time block has already ended (PT timezone)
  const nowPT = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hour12: false });
  const [nowH, nowM] = nowPT.split(":").map(Number);
  const nowMinutes = nowH * 60 + (nowM || 0);

  function parseEndMinutes(timeBlock: string): number | null {
    // Parse "2:30 PM - 4:00 PM" → end time in minutes since midnight
    const parts = timeBlock.split(/\s*-\s*/);
    if (parts.length < 2) return null;
    const m = parts[1].match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
    if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
    return h * 60 + min;
  }

  const activeCards = plan.cards.filter((c: any) => {
    const endMin = parseEndMinutes(c.timeBlock);
    if (endMin === null) return true; // keep if unparseable
    return endMin > nowMinutes; // keep if end time is in the future
  });

  // If all cards are past, redirect to homepage with the city pre-selected
  if (activeCards.length === 0) {
    return Response.redirect(`${origin}/?city=${plan.city}`, 302);
  }

  // Determine if some cards were filtered
  const filteredCount = plan.cards.length - activeCards.length;
  const timeNote = filteredCount > 0
    ? `<div style="text-align:center;font-size:12px;color:#bbb;margin-bottom:12px;font-style:italic">Showing ${activeCards.length} upcoming stops${filteredCount > 0 ? ` (${filteredCount} earlier stops already passed)` : ""}</div>`
    : "";

  // Format date for the title (e.g. "Saturday, April 12")
  const planDate = new Date(plan.createdAt);
  const dateStr = planDate.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const title = `${dateStr} — South Bay Today`;
  const cardNames = activeCards.map((c: any) => c.name).slice(0, 4).join(", ");
  const description = activeCards.length > 4
    ? `${cardNames}, and more`
    : cardNames;

  // Build card HTML
  const cardsHtml = activeCards.map((card: any) => {
    const emoji = CATEGORY_EMOJI[card.category] || "📍";
    const photoHtml = card.photoRef
      ? `<img src="${esc(origin)}/api/place-photo?ref=${encodeURIComponent(card.photoRef)}&w=200&h=200" alt="${esc(card.name)}" style="width:72px;height:72px;object-fit:cover;border-radius:8px;flex-shrink:0">`
      : `<div style="width:72px;height:72px;border-radius:8px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0">${emoji}</div>`;
    const eventBadge = card.source === "event"
      ? `<span style="font-size:8px;font-weight:800;color:#fff;background:#E63946;padding:1px 5px;border-radius:3px;letter-spacing:0.5px">EVENT</span>`
      : "";
    const costBadge = card.costNote || card.cost
      ? `<span style="display:inline-block;margin-top:5px;font-size:10px;font-weight:700;color:#999;background:#f5f5f5;padding:2px 8px;border-radius:4px">${esc(card.costNote || card.cost)}</span>`
      : "";

    return `
      <div style="display:flex;gap:12px;padding:14px 16px;background:#fff;border-radius:10px;border:1px solid #e8e8e8;margin-bottom:8px">
        ${photoHtml}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span style="font-size:12px;font-weight:800;color:#000;letter-spacing:-0.2px">${esc(card.timeBlock)}</span>
            <span style="font-size:9px;font-weight:700;color:#bbb;text-transform:uppercase;letter-spacing:1px">${esc(card.category)}</span>
            ${eventBadge}
          </div>
          <h3 style="font-size:17px;font-weight:900;color:#111;margin:0 0 4px;line-height:1.25">${esc(card.name)}</h3>
          ${card.venue ? `<div style="font-size:11px;color:#999;margin-bottom:4px">📍 ${esc(card.venue)}</div>` : ""}
          <p style="font-size:13px;color:#555;margin:0 0 4px;line-height:1.45">${esc(card.blurb)}</p>
          <p style="font-size:12px;font-weight:600;color:#FF6B35;margin:0;line-height:1.35;font-style:italic">${esc(card.why)}</p>
          ${costBadge}
        </div>
      </div>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="South Bay Today">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', sans-serif; background: #FAF9F6; color: #1A1A1A; padding: 20px 16px 80px; }
  .container { max-width: 640px; margin: 0 auto; }
  .header { text-align: center; padding: 24px 0 20px; }
  .logo { font-size: 14px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #999; }
  h1 { font-size: 28px; font-weight: 900; margin: 8px 0 4px; letter-spacing: -0.5px; }
  .meta { font-size: 13px; color: #888; margin-bottom: 24px; }
  .cta { display: inline-block; margin-top: 24px; padding: 12px 28px; border-radius: 24px; border: 2.5px solid #000; background: linear-gradient(135deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC); background-size: 200% 200%; animation: rainbow 3s ease infinite; color: #fff; font-size: 14px; font-weight: 900; text-decoration: none; text-transform: uppercase; letter-spacing: 1px; }
  @keyframes rainbow { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
  .footer { text-align: center; margin-top: 32px; padding-top: 20px; border-top: 1px solid #e8e8e8; }
  .footer p { font-size: 12px; color: #bbb; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">South Bay Today</div>
    <h1>${esc(dateStr)}</h1>
    <div class="meta">
      ${plan.weather ? `🌤 ${esc(plan.weather)} · ` : ""}${plan.cards.length} stops${plan.kids ? " · Family-friendly" : ""}
    </div>
  </div>
  ${timeNote}
  ${cardsHtml}
  <div class="footer">
    <a href="${esc(origin)}/?city=${esc(plan.city)}" class="cta">Build Your Own Day →</a>
    <p style="margin-top:16px">Powered by <a href="${esc(origin)}/" style="color:#888">southbaytoday.org</a></p>
  </div>
</div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
