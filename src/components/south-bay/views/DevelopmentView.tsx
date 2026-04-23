import { useState, useMemo } from "react";
import PermitPulseCard from "../cards/PermitPulseCard";
import type { City } from "../../../lib/south-bay/types";
import {
  DEV_PROJECTS,
  STATUS_CONFIG,
  CATEGORY_LABELS,
  type DevStatus,
  type DevCategory,
  type DevProject,
} from "../../../data/south-bay/development-data";

// ── Category filter ──────────────────────────────────────────────────────────

const CATEGORY_FILTERS: { id: DevCategory | "all"; label: string }[] = [
  { id: "all",         label: "All"         },
  { id: "housing",     label: "Housing"     },
  { id: "mixed-use",   label: "Mixed-Use"   },
  { id: "transit",     label: "Transit"     },
  { id: "retail",      label: "Retail"      },
  { id: "tech-campus", label: "Tech Campus" },
  { id: "civic",       label: "Civic"       },
];

// ── Section config ───────────────────────────────────────────────────────────

const SECTIONS: {
  status: DevStatus;
  label: string;
  emoji: string;
  accentColor: string;
  accentBg: string;
  defaultCollapsed?: boolean;
}[] = [
  { status: "opening-soon",       label: "Opening Soon",       emoji: "🟢", accentColor: "#15803d", accentBg: "#f0fdf4" },
  { status: "under-construction", label: "Under Construction", emoji: "🏗️", accentColor: "#b45309", accentBg: "#fffbeb" },
  { status: "approved",           label: "Approved",           emoji: "📋", accentColor: "#1d4ed8", accentBg: "#eff6ff" },
  { status: "proposed",           label: "Proposed",           emoji: "💡", accentColor: "#6b7280", accentBg: "#f9fafb" },
  { status: "completed",          label: "Recently Completed", emoji: "✅", accentColor: "#065f46", accentBg: "#ecfdf5", defaultCollapsed: true },
];

const CITY_ACCENT: Record<string, string> = {
  "san-jose":      "#be123c",
  "mountain-view": "#0369a1",
  "sunnyvale":     "#0891b2",
  "santa-clara":   "#b45309",
  "cupertino":     "#6d28d9",
  "campbell":      "#1d4ed8",
  "milpitas":      "#4d7c0f",
  "los-gatos":     "#b45309",
  "palo-alto":     "#1d4ed8",
  "saratoga":      "#065F46",
  "los-altos":     "#7c3aed",
};

// ── Project card ─────────────────────────────────────────────────────────────

function ProjectCard({ project, accent, accentBg, featured }: {
  project: DevProject;
  accent: string;
  accentBg: string;
  featured?: boolean;
}) {
  const cityAccent = CITY_ACCENT[project.cityId] ?? accent;
  const statusCfg = STATUS_CONFIG[project.status];

  return (
    <div style={{
      background: "var(--sb-card)",
      border: featured ? `2px solid ${accent}` : "1px solid var(--sb-border-light)",
      borderLeft: `3px solid ${accent}`,
      borderRadius: "var(--sb-radius)",
      padding: "16px 18px",
      transition: "box-shadow 0.12s",
    }}
      className="dev-project-card">

      {/* Meta row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 3,
          background: statusCfg.bg, color: statusCfg.color,
          letterSpacing: "0.04em", textTransform: "uppercase",
        }}>
          {statusCfg.label}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 3,
          background: cityAccent + "15", color: cityAccent,
          letterSpacing: "0.04em",
        }}>
          {project.city}
        </span>
        <span style={{
          fontSize: 10, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace",
        }}>
          {CATEGORY_LABELS[project.category]}
        </span>
        {project.featured && (
          <span style={{ fontSize: 10, color: "#b45309", fontWeight: 700, marginLeft: "auto" }}>
            ★ Signature
          </span>
        )}
      </div>

      {/* Title */}
      <div style={{
        fontFamily: "var(--sb-serif)",
        fontWeight: 700,
        fontSize: 16,
        color: "var(--sb-ink)",
        lineHeight: 1.3,
        marginBottom: 6,
      }}>
        {project.name}
      </div>

      {/* Description */}
      <p style={{
        fontSize: 13,
        color: "var(--sb-muted)",
        lineHeight: 1.55,
        margin: "0 0 10px",
      }}>
        {project.description}
      </p>

      {/* Details */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {project.timeline && (
          <div>
            <span style={{ fontSize: 10, fontWeight: 700, color: accent, textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>
              Timeline
            </span>
            <span style={{ fontSize: 12, color: "var(--sb-ink)" }}>{project.timeline}</span>
          </div>
        )}
        {project.scale && (
          <div>
            <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>
              Scale
            </span>
            <span style={{ fontSize: 12, color: "var(--sb-ink)" }}>{project.scale}</span>
          </div>
        )}
        {project.developer && project.developer !== "Various" && (
          <div>
            <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>
              Developer
            </span>
            <span style={{ fontSize: 12, color: "var(--sb-ink)" }}>{project.developer}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

function DevSection({
  status, label, emoji, accentColor, accentBg, projects, defaultCollapsed,
}: {
  status: DevStatus;
  label: string;
  emoji: string;
  accentColor: string;
  accentBg: string;
  projects: DevProject[];
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  if (!projects.length) return null;

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Section header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: accentBg,
          border: `1px solid ${accentColor}30`,
          borderRadius: "var(--sb-radius)",
          cursor: "pointer",
          marginBottom: collapsed ? 0 : 14,
          textAlign: "left",
          fontFamily: "inherit",
        }}
      >
        <span style={{ fontSize: 14 }}>{emoji}</span>
        <span style={{
          fontFamily: "'Space Mono', monospace",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: accentColor,
          flex: 1,
        }}>
          {label}
        </span>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          background: accentColor + "20",
          color: accentColor,
          padding: "2px 8px",
          borderRadius: 100,
        }}>
          {projects.length}
        </span>
        <span style={{ fontSize: 11, color: accentColor, marginLeft: 4 }}>
          {collapsed ? "▾" : "▴"}
        </span>
      </button>

      {!collapsed && (
        <div style={{
          display: "grid",
          gridTemplateColumns: status === "opening-soon" ? "1fr" : "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 12,
        }}
          className="dev-section-grid">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              accent={accentColor}
              accentBg={accentBg}
              featured={p.featured}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────

export default function DevelopmentView() {
  const [categoryFilter, setCategoryFilter] = useState<DevCategory | "all">("all");

  const byStatus = useMemo(() => {
    const filtered = DEV_PROJECTS.filter((p) =>
      categoryFilter === "all" || p.category === categoryFilter
    );
    const map: Partial<Record<DevStatus, DevProject[]>> = {};
    for (const p of filtered) {
      (map[p.status] ??= []).push(p);
    }
    return map;
  }, [categoryFilter]);

  const activeCount = DEV_PROJECTS.filter(
    (p) => p.status === "under-construction" || p.status === "opening-soon" || p.status === "approved"
  ).length;

  return (
    <div className="dev-view">

      {/* Section header — this view is rendered inside GovernmentView */}
      <div className="sb-section-header" style={{ marginBottom: 4, marginTop: 24 }}>
        <span className="sb-section-title">What's Being Built</span>
      </div>
      <p
        style={{
          fontSize: 12,
          color: "var(--sb-muted)",
          marginTop: 0,
          marginBottom: 16,
          lineHeight: 1.5,
        }}
      >
        Projects proposed, approved, and under construction across the South Bay — curated from public records and city council decisions. {activeCount} projects actively in development.
      </p>

      {/* Category filter */}
      <div style={{ marginBottom: 20 }}>
        <div className="dev-filter-row">
          <span className="dev-filter-label">Type</span>
          <div className="dev-filter-pills">
            {CATEGORY_FILTERS.map((f) => (
              <button
                key={f.id}
                className={`dev-filter-pill${categoryFilter === f.id ? " dev-filter-pill--active" : ""}`}
                onClick={() => setCategoryFilter(f.id as DevCategory | "all")}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Sectioned project list */}
      {SECTIONS.map((section) => {
        const projects = byStatus[section.status] ?? [];
        return (
          <DevSection
            key={section.status}
            {...section}
            projects={projects}
          />
        );
      })}

      {/* Permit Pulse */}
      <PermitPulseCard />

      {/* Footer note */}
      <div className="dev-footer-note">
        South Bay Today tracks publicly announced development projects. Data is curated from city records, planning documents, and council decisions. Not all projects are included — focus is on developments with meaningful neighborhood impact.
      </div>

    </div>
  );
}
