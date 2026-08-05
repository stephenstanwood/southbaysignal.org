import { useState } from "react";
import { track } from "@vercel/analytics";

type Status = "idle" | "submitting" | "success" | "error";

export default function NewsletterSignup({
  variant = "card",
}: {
  variant?: "card" | "inline" | "minimal";
}) {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website }),
      });
      const data = await res.json();
      if (data.ok) {
        setStatus("success");
        setEmail("");
        try {
          track("Newsletter signup", { placement: variant });
        } catch {
          // Analytics should never turn a successful subscription into an error.
        }
      } else {
        setStatus("error");
        setError(data.error || "Something went wrong");
      }
    } catch {
      setStatus("error");
      setError("Network error — try again");
    }
  }

  const isCard = variant === "card";
  const isMinimal = variant === "minimal";

  // Honeypot: off-screen rather than display:none, because some bots skip
  // hidden inputs. A person never reaches it (aria-hidden, tabIndex -1), so a
  // filled value means automation and the server silently drops the signup.
  const honeypot = (
    <input
      type="text"
      name="website"
      value={website}
      onChange={(e) => setWebsite(e.target.value)}
      tabIndex={-1}
      autoComplete="off"
      aria-hidden="true"
      style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
    />
  );

  if (status === "success") {
    if (isMinimal) {
      return (
        <div style={{ fontSize: 12, color: "#1a1a2e", fontFamily: "'Inter', sans-serif", textAlign: "center" }}>
          📬 Check your email to confirm.
        </div>
      );
    }
    return (
      <div
        style={{
          padding: isCard ? "22px 24px" : "10px 0",
          background: isCard ? "#f3f1f8" : "transparent",
          borderRadius: isCard ? 4 : 0,
          textAlign: "center",
          fontFamily: "'Inter', sans-serif",
        }}
      >
        <div style={{ fontWeight: 700, color: "#1a1a2e", marginBottom: 4, fontSize: 16 }}>
          Almost there. 📬
        </div>
        <div style={{ fontSize: 14, color: "#5b6478" }}>
          Check your inbox for a confirmation link. Click it and the first plan lands at 6:00&nbsp;AM.
        </div>
      </div>
    );
  }

  // ── Minimal: footer treatment. Compact but with a real headline so it
  //    reads as an offer, not a stray field. Stacks on mobile.
  if (isMinimal) {
    return (
      <>
        <form onSubmit={onSubmit} className="sbt-nl-min">
          {honeypot}
          <div className="sbt-nl-min-text">
            <div className="sbt-nl-min-headline">Start your day with us! ☀️</div>
            <div className="sbt-nl-min-tagline">One email with everything we know about.</div>
          </div>
          <div className="sbt-nl-min-fields">
            <input
              type="email"
              aria-label="Email address"
              required
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={status === "submitting"}
              className="sbt-nl-min-input"
            />
            <button
              type="submit"
              disabled={status === "submitting"}
              className="sbt-nl-min-button"
            >
              {status === "submitting" ? "…" : "Subscribe"}
            </button>
          </div>
          {error && <div className="sbt-nl-min-error">{error}</div>}
        </form>
        <style>{`
          .sbt-nl-min {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 14px;
            font-family: 'Inter', sans-serif;
            max-width: 480px;
            margin: 0 auto;
          }
          .sbt-nl-min-text { text-align: center; }
          .sbt-nl-min-headline {
            font-family: 'Playfair Display', Georgia, serif;
            font-size: 22px;
            font-weight: 800;
            color: #1a1a2e;
            line-height: 1.1;
            letter-spacing: -0.3px;
          }
          .sbt-nl-min-tagline {
            font-size: 12px;
            color: #5b6478;
            margin-top: 3px;
            line-height: 1.35;
          }
          .sbt-nl-min-fields {
            display: flex;
            gap: 6px;
            flex: 0 1 auto;
          }
          .sbt-nl-min-input {
            padding: 8px 12px;
            border: 1px solid #c8c4bc;
            border-radius: 3px;
            font-size: 13px;
            background: #fff;
            color: #1a1a2e;
            font-family: inherit;
            width: 200px;
          }
          .sbt-nl-min-button {
            padding: 8px 14px;
            background: #1a1a2e;
            color: #fff;
            border: none;
            border-radius: 3px;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.4px;
            text-transform: uppercase;
            cursor: ${status === "submitting" ? "wait" : "pointer"};
            opacity: ${status === "submitting" ? 0.7 : 1};
            font-family: inherit;
            white-space: nowrap;
          }
          .sbt-nl-min-error {
            width: 100%;
            font-size: 11px;
            color: #c0392b;
            text-align: center;
          }
          @media (max-width: 560px) {
            .sbt-nl-min { flex-direction: column; gap: 10px; }
            .sbt-nl-min-text { text-align: center; }
            .sbt-nl-min-headline { font-size: 20px; }
            .sbt-nl-min-fields { width: 100%; max-width: 320px; }
            .sbt-nl-min-input { flex: 1 1 auto; min-width: 0; width: auto; }
          }
        `}</style>
      </>
    );
  }

  if (isCard) {
    return (
      <div
        style={{
          padding: "22px 24px",
          background: "#f3f1f8",
          borderRadius: 4,
          fontFamily: "'Inter', sans-serif",
        }}
      >
        <div style={{ fontSize: 11, letterSpacing: 1.6, textTransform: "uppercase", color: "#5b54c9", fontWeight: 800 }}>
          Daily at 6:00&nbsp;AM
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#1a1a2e", marginTop: 4, lineHeight: 1.2, fontFamily: "'Playfair Display', Georgia, serif" }}>
          A fresh plan every morning.
        </div>
        <div style={{ fontSize: 14, color: "#5b6478", marginTop: 8, marginBottom: 14, lineHeight: 1.5 }}>
          One email: the day's plan, what's new, what's opening, what city hall did. Once a day — that's the whole deal.
        </div>
        {renderForm({ inputFontSize: 15, buttonPadding: "10px 22px", buttonFontSize: 14 })}
        {error && <div style={{ fontSize: 13, color: "#c0392b", marginTop: 8 }}>{error}</div>}
      </div>
    );
  }

  // Inline: full-width strip with serif headline on the left, compact form
  // on the right. The form is fixed-width so the email field doesn't balloon
  // when the card spans the bucket grid; the spare width carries display type.
  return (
    <>
      <div className="sbt-nl-inline">
        <div className="sbt-nl-inline-text">
          <div className="sbt-nl-inline-eyebrow">Daily at 6:00&nbsp;AM</div>
          <div className="sbt-nl-inline-headline">A fresh plan every morning.</div>
          <div className="sbt-nl-inline-tagline">
            Plus everything else we know about for the day.<br />
            One email. That's it.
          </div>
        </div>
        <div className="sbt-nl-inline-form">
          {renderForm({ inputFontSize: 14, buttonPadding: "9px 18px", buttonFontSize: 13 })}
          {error && <div style={{ fontSize: 12, color: "#c0392b", marginTop: 6 }}>{error}</div>}
        </div>
      </div>
      <style>{`
        .sbt-nl-inline {
          display: flex;
          align-items: center;
          gap: 24px;
          font-family: 'Inter', sans-serif;
        }
        .sbt-nl-inline-text { flex: 1 1 auto; min-width: 0; }
        .sbt-nl-inline-eyebrow {
          font-size: 10px;
          letter-spacing: 1.6px;
          text-transform: uppercase;
          color: #5b54c9;
          font-weight: 800;
        }
        .sbt-nl-inline-headline {
          font-size: 26px;
          line-height: 1.15;
          font-weight: 800;
          color: #1a1a2e;
          margin-top: 2px;
          font-family: 'Playfair Display', Georgia, serif;
          letter-spacing: -0.5px;
        }
        .sbt-nl-inline-tagline {
          font-size: 13px;
          color: #5b6478;
          margin-top: 6px;
          line-height: 1.45;
        }
        .sbt-nl-inline-form {
          flex: 0 0 auto;
          width: 320px;
        }
        @media (max-width: 720px) {
          .sbt-nl-inline { flex-direction: column; align-items: stretch; gap: 12px; }
          .sbt-nl-inline-headline { font-size: 22px; }
          .sbt-nl-inline-form { width: 100%; }
        }
      `}</style>
    </>
  );

  function renderForm({
    inputFontSize,
    buttonPadding,
    buttonFontSize,
  }: { inputFontSize: number; buttonPadding: string; buttonFontSize: number }) {
    return (
      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {honeypot}
        <input
          type="email"
          aria-label="Email address"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status === "submitting"}
          style={{
            flex: "1 1 180px",
            minWidth: 0,
            padding: "10px 14px",
            border: "1px solid #c8c4bc",
            borderRadius: 4,
            fontSize: inputFontSize,
            background: "#fff",
            color: "#1a1a2e",
            fontFamily: "inherit",
          }}
        />
        <button
          type="submit"
          disabled={status === "submitting"}
          style={{
            padding: buttonPadding,
            background: "#1a1a2e",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            fontSize: buttonFontSize,
            fontWeight: 700,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            cursor: status === "submitting" ? "wait" : "pointer",
            opacity: status === "submitting" ? 0.7 : 1,
            fontFamily: "inherit",
          }}
        >
          {status === "submitting" ? "…" : "Subscribe"}
        </button>
      </form>
    );
  }
}
