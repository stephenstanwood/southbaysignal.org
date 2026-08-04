// ---------------------------------------------------------------------------
// The Conversation — Reddit-driven local chatter
// ---------------------------------------------------------------------------
// Tile grid of curated discussions/news/restaurant chatter from regional subs.
// Generator guarantees every shipped post has a Recraft image — posts that
// fail image generation get swapped out for reserve candidates upstream.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";

import pulseData from "../../../data/south-bay/reddit-pulse.json";
import { formatAge, resolvePostAgeHours } from "../../../lib/south-bay/postAge";

interface PulsePost {
  id: string;
  sub: string;
  title: string;
  /** Light-touch grammar/punctuation/casing cleanup of `title`. Falls back to
   *  `title` if absent. UI should always render `displayTitle ?? title`. */
  displayTitle?: string;
  summary: string;
  category: string;
  topic?: string;
  image?: string | null;
  score: number;
  numComments: number;
  ageHours: number;
  createdUtc: number;
  permalink: string;
  externalUrl: string | null;
}

/**
 * Reads the clock only after mount. A static Astro build can't know the
 * visitor's current time, so computing during render would freeze the
 * build-time value into the HTML and mismatch on hydration. Same shape as
 * useLiveTodayLabel. Until then `resolvePostAgeHours` falls back to the
 * generator's stored value.
 */
function useNowMs(): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    // Tiles are minute-granular only at the low end; an hourly refresh keeps a
    // long-lived tab honest without churning the whole grid.
    const id = window.setInterval(tick, 3_600_000);
    return () => window.clearInterval(id);
  }, []);
  return nowMs;
}

// The grid is a fixed 4-column layout (2-col at mobile). Generator targets 12
// (4×3), but if it underdelivers we keep the grid clean by trimming to a
// multiple of 4 so the bottom row is never short. Mobile (2-col) is always
// happy because every multiple of 4 is also a multiple of 2.
const PULSE_TILE_COUNT = 12;
const PULSE_COLS = 4;

export default function RedditPulseTeaser() {
  const nowMs = useNowMs();

  // Defensive: drop any post without a real image. Generator guarantees images
  // upstream, but if a stale data file slips through we'd rather show fewer
  // tiles than a gradient placeholder.
  const withImages = ((pulseData?.posts ?? []) as PulsePost[]).filter((p) => !!p.image);
  const trimCount =
    withImages.length >= PULSE_TILE_COUNT
      ? PULSE_TILE_COUNT
      : Math.floor(withImages.length / PULSE_COLS) * PULSE_COLS;
  const posts = withImages.slice(0, trimCount);
  if (posts.length === 0) return null;

  return (
    <section
      aria-label="The Conversation"
      style={{
        marginTop: 36,
        paddingTop: 28,
        borderTop: "1px solid #eee",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: 0, letterSpacing: -1, color: "#000", lineHeight: 1.05 }}>
          The Conversation
        </h2>
        <p style={{ fontSize: 13, color: "#666", margin: "4px 0 0", fontWeight: 500 }}>
          What people are talking about across the South Bay
        </p>
      </header>

      <div className="rp-grid">
        {posts.map((p) => {
          return (
            <a
              key={p.id}
              href={p.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="rp-tile"
              style={{ background: "#000" }}
            >
              {/* Real <img> (not CSS background-image) so the browser's native
                  lazy-loading actually defers offscreen tiles — a
                  background-image never enters the loading="lazy" pipeline. */}
              <img
                className="rp-tile-img"
                src={p.image ?? undefined}
                alt=""
                loading="lazy"
                decoding="async"
                width={400}
                height={400}
              />

              {/* Bottom-up gradient for legibility under title */}
              <div className="rp-tile-shade" />

              {/* Top metadata */}
              <div className="rp-tile-top">
                <span className="rp-badge">r/{p.sub}</span>
              </div>

              {/* Bottom: title + footer metadata */}
              <div className="rp-tile-bottom">
                <div className="rp-title">{p.displayTitle || p.title}</div>
                <div className="rp-meta">
                  {p.score > 0 && <><span>↑ {p.score}</span><span>·</span></>}
                  {p.numComments > 0 && <><span>💬 {p.numComments}</span><span>·</span></>}
                  <span>{formatAge(resolvePostAgeHours(p.createdUtc, p.ageHours, nowMs))}</span>
                </div>
              </div>
            </a>
          );
        })}
      </div>

      <p style={{ marginTop: 12, fontSize: 11, color: "#aaa", textAlign: "right" }}>
        Tap any post to jump into the thread on Reddit
      </p>

      <style>{`
        .rp-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
        }
        .rp-tile {
          position: relative;
          display: block;
          aspect-ratio: 1 / 1;
          border-radius: 14px;
          overflow: hidden;
          text-decoration: none;
          color: #fff;
          transition: transform 0.18s ease-out, box-shadow 0.18s ease-out;
          box-shadow: 0 1px 2px rgba(0,0,0,0.05);
          cursor: pointer;
        }
        .rp-tile:hover {
          transform: translateY(-2px) scale(1.02);
          box-shadow: 0 8px 20px rgba(0,0,0,0.18);
        }
        .rp-tile-img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center;
        }
        .rp-tile-shade {
          position: absolute;
          inset: 0;
          background: linear-gradient(to bottom, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.0) 30%, rgba(0,0,0,0.55) 75%, rgba(0,0,0,0.85) 100%);
          pointer-events: none;
        }
        .rp-tile-top {
          position: absolute;
          top: 8px;
          left: 8px;
          right: 8px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          z-index: 2;
        }
        .rp-badge {
          background: rgba(255,255,255,0.95);
          color: #111;
          padding: 4px 8px;
          border-radius: 999px;
          line-height: 1;
          white-space: nowrap;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .rp-tile-bottom {
          position: absolute;
          left: 12px;
          right: 12px;
          bottom: 10px;
          z-index: 2;
        }
        .rp-title {
          font-size: 14px;
          font-weight: 800;
          line-height: 1.2;
          color: #fff;
          text-shadow: 0 1px 2px rgba(0,0,0,0.5);
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
          margin-bottom: 4px;
        }
        .rp-meta {
          display: flex;
          gap: 6px;
          font-size: 10px;
          font-weight: 600;
          color: rgba(255,255,255,0.85);
          text-shadow: 0 1px 1px rgba(0,0,0,0.4);
        }
        @media (max-width: 760px) {
          .rp-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
          }
          .rp-title {
            font-size: 13px;
          }
        }
      `}</style>
    </section>
  );
}
