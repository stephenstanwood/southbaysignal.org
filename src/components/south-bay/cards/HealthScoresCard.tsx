import healthJson from "../../../data/south-bay/health-scores.json";

interface HealthFlag {
  business_id: string;
  name: string;
  city: string;
  address: string;
  date: string;
  score: number | null;
  result: "R" | "Y";
  type: string | null;
  summary: string | null;
}

interface HealthData {
  flags: HealthFlag[];
  generatedAt: string;
  source: string;
  sourceUrl: string;
}

const data = healthJson as HealthData;

function relativeDate(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  const now = new Date();
  const diffDays = Math.round((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.round(diffDays / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function HealthScoresCard() {
  const flags = data.flags;
  if (!flags || flags.length === 0) return null;

  // Separate reds from yellows
  const reds = flags.filter((f) => f.result === "R").slice(0, 6);
  const yellows = flags.filter((f) => f.result === "Y").slice(0, 6);

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Section header */}
      <div className="sb-section-header" style={{ marginBottom: 12 }}>
        <span className="sb-section-title" style={{ fontSize: 15 }}>
          🍽️ Food Safety Watch
        </span>
        <div className="sb-section-line" />
      </div>

      {/* Red placards */}
      {reds.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{
            fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.1em", textTransform: "uppercase",
            color: "var(--sb-muted)", marginBottom: 6,
          }}>
            Temporarily Closed ({reds.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {reds.map((f) => (
              <FlagRow key={`${f.business_id}-${f.date}`} flag={f} />
            ))}
          </div>
        </div>
      )}

      {/* Yellow placards */}
      {yellows.length > 0 && (
        <div>
          <div style={{
            fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.1em", textTransform: "uppercase",
            color: "var(--sb-muted)", marginBottom: 6,
          }}>
            Warning Issued ({yellows.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {yellows.map((f) => (
              <FlagRow key={`${f.business_id}-${f.date}`} flag={f} />
            ))}
          </div>
        </div>
      )}

      {/* Source */}
      <div style={{ marginTop: 10, fontSize: 10, color: "var(--sb-light)" }}>
        <a
          href={data.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}
        >
          {data.source}
        </a>
        {" · updated "}
        {relativeDate(data.generatedAt.split("T")[0])}
      </div>
    </div>
  );
}

function FlagRow({ flag }: { flag: HealthFlag }) {
  const isRed = flag.result === "R";
  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 10,
      padding: "8px 10px",
      borderRadius: 6,
      background: "var(--sb-card)",
      border: `1px solid ${isRed ? "#E5C4C4" : "#E5D9B5"}`,
    }}>
      {/* Score badge */}
      <div style={{
        flexShrink: 0,
        width: 34, height: 34,
        borderRadius: 6,
        background: isRed ? "#F5E8E8" : "#F5F0DC",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
      }}>
        {flag.score != null ? (
          <>
            <span style={{ fontSize: 14, fontWeight: 800, color: isRed ? "#8B3B3B" : "#7A6020" }}>
              {flag.score}
            </span>
            <span style={{ fontSize: 7, color: isRed ? "#8B3B3B" : "#7A6020", fontWeight: 600 }}>
              {flag.result === "R" ? "CLOSED" : "WARN"}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 14 }}>{isRed ? "⛔" : "⚠️"}</span>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 700, color: "var(--sb-ink)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {flag.name}
        </div>
        <div style={{ fontSize: 11, color: "var(--sb-muted)", marginBottom: flag.summary ? 3 : 0 }}>
          {flag.city}
          {flag.address && ` · ${flag.address}`}
          <span style={{ marginLeft: 6, opacity: 0.7 }}>{relativeDate(flag.date)}</span>
        </div>
        {flag.summary && (
          <div style={{
            fontSize: 11, color: isRed ? "#7F1D1D" : "#78350F",
            lineHeight: 1.4,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}>
            {flag.summary}
          </div>
        )}
      </div>
    </div>
  );
}
