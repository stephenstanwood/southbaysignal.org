// ---------------------------------------------------------------------------
// Reddit Pulse — "What the South Bay is Saying"
// ---------------------------------------------------------------------------
// Curated discussions/news/restaurant chatter from regional subreddits.
// Build-time JSON, link out to permalinks. No fetch, no auth.
// ---------------------------------------------------------------------------

import pulseData from "../../../data/south-bay/reddit-pulse.json";

interface PulsePost {
  id: string;
  sub: string;
  title: string;
  summary: string;
  category: string;
  score: number;
  numComments: number;
  ageHours: number;
  createdUtc: number;
  permalink: string;
  externalUrl: string | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  restaurant_news: "Food",
  event: "Event",
  discussion: "Talk",
  news: "News",
};

const CATEGORY_TINT: Record<string, string> = {
  restaurant_news: "#7c3aed", // purple
  event: "#2563eb",            // blue
  discussion: "#0891b2",       // teal
  news: "#475569",             // slate
};

function formatAge(hours: number): string {
  if (hours < 1) return "now";
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export default function RedditPulseTeaser() {
  const posts = (pulseData?.posts ?? []) as PulsePost[];
  if (posts.length === 0) return null;

  return (
    <section
      aria-label="What the South Bay is saying"
      style={{
        marginTop: 32,
        paddingTop: 24,
        borderTop: "1px solid #eee",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, gap: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 900, margin: 0, letterSpacing: -0.3, color: "#000" }}>
          What the South Bay&apos;s saying
        </h2>
        <span style={{ fontSize: 11, color: "#888", fontWeight: 600 }}>via Reddit</span>
      </header>

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {posts.map((p) => {
          const tint = CATEGORY_TINT[p.category] ?? "#475569";
          const label = CATEGORY_LABEL[p.category] ?? null;
          return (
            <li key={p.id}>
              <a
                href={p.permalink}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "block",
                  padding: "12px 14px",
                  background: "#fff",
                  border: "1px solid #eee",
                  borderRadius: 10,
                  textDecoration: "none",
                  color: "inherit",
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#ccc"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#eee"; }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 11, fontWeight: 700, color: "#888", letterSpacing: 0.2, textTransform: "uppercase" }}>
                  {label && (
                    <span style={{ color: tint }}>{label}</span>
                  )}
                  {label && <span style={{ color: "#ddd" }}>·</span>}
                  <span>r/{p.sub}</span>
                  <span style={{ color: "#ddd" }}>·</span>
                  <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
                    ↑ {p.score} &nbsp;·&nbsp; 💬 {p.numComments} &nbsp;·&nbsp; {formatAge(p.ageHours)}
                  </span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#000", lineHeight: 1.3, marginBottom: p.summary && p.summary.toLowerCase() !== p.title.toLowerCase() ? 4 : 0 }}>
                  {p.title}
                </div>
                {p.summary && p.summary.toLowerCase() !== p.title.toLowerCase() && (
                  <div style={{ fontSize: 13, color: "#555", lineHeight: 1.4 }}>{p.summary}</div>
                )}
              </a>
            </li>
          );
        })}
      </ul>

      <p style={{ marginTop: 10, fontSize: 11, color: "#aaa", textAlign: "right" }}>
        Posts surfaced from regional subreddits. Click through to read on Reddit.
      </p>
    </section>
  );
}
