// ---------------------------------------------------------------------------
// The Conversation — Reddit-driven local chatter
// ---------------------------------------------------------------------------
// Tile grid of curated discussions/news/restaurant chatter from regional subs.
// Recraft tiles when present, color-block fallback when not.
// ---------------------------------------------------------------------------

import pulseData from "../../../data/south-bay/reddit-pulse.json";

interface PulsePost {
  id: string;
  sub: string;
  title: string;
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

// Each category gets a distinctive 2-color gradient used as the placeholder
// when no Recraft image is available. Keeps the grid feeling colorful even
// before the Mini has had a chance to populate images.
const CATEGORY_GRADIENT: Record<string, string> = {
  restaurant_news: "linear-gradient(135deg, #f59e0b 0%, #ec4899 100%)",
  event:           "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)",
  discussion:      "linear-gradient(135deg, #06b6d4 0%, #10b981 100%)",
  news:            "linear-gradient(135deg, #6366f1 0%, #14b8a6 100%)",
  sports:          "linear-gradient(135deg, #22c55e 0%, #eab308 100%)",
};

function formatAge(hours: number): string {
  if (hours < 1) return "now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1d ago" : `${days}d ago`;
}

export default function RedditPulseTeaser() {
  const posts = (pulseData?.posts ?? []) as PulsePost[];
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
          const fallback = CATEGORY_GRADIENT[p.category] ?? "linear-gradient(135deg, #6366f1 0%, #14b8a6 100%)";
          return (
            <a
              key={p.id}
              href={p.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="rp-tile"
              style={{
                background: p.image ? `#000 url(${p.image}) center/cover no-repeat` : fallback,
              }}
            >
              {/* Bottom-up gradient for legibility under title */}
              <div className="rp-tile-shade" />

              {/* Top metadata */}
              <div className="rp-tile-top">
                <span className="rp-badge">r/{p.sub}</span>
              </div>

              {/* Bottom: title + footer metadata */}
              <div className="rp-tile-bottom">
                <div className="rp-title">{p.title}</div>
                <div className="rp-meta">
                  <span>↑ {p.score}</span>
                  <span>·</span>
                  <span>💬 {p.numComments}</span>
                  <span>·</span>
                  <span>{formatAge(p.ageHours)}</span>
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
