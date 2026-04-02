interface DigestData {
  city: string;
  cityName: string;
  body: string;
  meetingDate: string;
  title: string;
  summary: string;
  keyTopics: string[];
  nextMeeting?: string | null;
  schedule: string;
  sourceUrl: string;
  generatedAt?: string;
}

interface AgendaItem {
  title: string;
  sequence: number;
}

interface UpcomingMeetingInfo {
  date: string;
  displayDate: string;
  url: string;
  location?: string | null;
  agendaItems?: AgendaItem[];
}

interface Props {
  digest: DigestData;
  onRefresh?: () => void;
  upcomingMeeting?: UpcomingMeetingInfo | null;
}

export default function DigestCard({ digest, onRefresh, upcomingMeeting }: Props) {
  // Prefer real upcoming meeting data over AI-generated text
  const nextLabel = upcomingMeeting
    ? upcomingMeeting.displayDate
    : digest.nextMeeting || null;
  const nextUrl = upcomingMeeting?.url ?? null;
  return (
    <div className="sb-digest-card">
      <div className="sb-digest-header">
        <div className="sb-digest-city">{digest.cityName}</div>
        <div className="sb-digest-body">{digest.body}</div>
      </div>
      <div className="sb-digest-date">{digest.meetingDate}</div>
      {digest.keyTopics.length > 0 && (
        <ul className="sb-digest-topics">
          {digest.keyTopics.map((topic, i) => (
            <li key={i}>{topic}</li>
          ))}
        </ul>
      )}
      {upcomingMeeting?.agendaItems && upcomingMeeting.agendaItems.length > 0 && (
        <div style={{ marginTop: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--sb-muted)", marginBottom: 6 }}>
            On the agenda · {upcomingMeeting.displayDate}
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
            {upcomingMeeting.agendaItems.map((item, i) => (
              <li
                key={i}
                style={{
                  fontSize: 12,
                  color: "var(--sb-text)",
                  lineHeight: 1.4,
                  paddingLeft: 10,
                  borderLeft: "2px solid var(--sb-border-light)",
                }}
              >
                {item.title}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="sb-digest-footer">
        {nextLabel && (
          <span className="sb-digest-next">
            Next meeting:{" "}
            {nextUrl ? (
              <a href={nextUrl} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
                {nextLabel}
              </a>
            ) : nextLabel}
          </span>
        )}
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <a
            href={digest.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="sb-digest-source"
          >
            View agenda
          </a>
          {onRefresh && (
            <button
              onClick={onRefresh}
              style={{
                padding: "2px 8px",
                fontSize: 10,
                border: "1px solid var(--sb-border)",
                borderRadius: 3,
                background: "#fff",
                cursor: "pointer",
                fontFamily: "'Space Mono', monospace",
                color: "var(--sb-muted)",
              }}
              title="Refresh this digest from the latest agenda"
            >
              ↻ refresh
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export type { DigestData };
