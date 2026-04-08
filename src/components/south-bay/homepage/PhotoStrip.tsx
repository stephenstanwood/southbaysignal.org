// ---------------------------------------------------------------------------
// Photo strip — auto-scrolling marquee of curated South Bay photos
// ---------------------------------------------------------------------------

import { memo } from "react";
import curatedPhotosJson from "../../../data/south-bay/curated-photos.json";

type CuratedPhoto = {
  id: string; thumb: string; full: string;
  title: string; photographer: string; photoPage: string;
  license: string; source: string;
};

const ALL_PHOTOS = (curatedPhotosJson as unknown as { photos: CuratedPhoto[] }).photos ?? [];

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    s = (s ^ (s >>> 14)) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export default memo(function PhotoStrip() {
  if (ALL_PHOTOS.length < 4) return null;
  const LOAD_SEED = Math.floor(Math.random() * 1_000_000);
  const strip = seededShuffle(ALL_PHOTOS, LOAD_SEED).slice(0, Math.min(20, ALL_PHOTOS.length));

  const tile = (p: CuratedPhoto, keySuffix: string) => (
    <a
      key={p.id + keySuffix}
      href={p.photoPage}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${p.title} — ${p.photographer} — ${p.license}`}
      style={{
        flexShrink: 0, display: "block", position: "relative",
        height: 200, width: 280, overflow: "hidden", background: "#ccc",
        borderRadius: 6,
      }}
    >
      <img
        src={p.thumb}
        alt={p.title}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        onError={(e) => { (e.currentTarget.closest("a") as HTMLElement).style.display = "none"; }}
      />
      <div className="ps-caption">
        <span style={{ fontSize: 9, color: "#fff", fontFamily: "'Space Mono', monospace", lineHeight: 1.5 }}>
          {p.photographer ? `${p.photographer} · ` : ""}{p.license}
        </span>
      </div>
    </a>
  );

  return (
    <div style={{ overflow: "hidden", borderRadius: 4, marginTop: 4, marginBottom: 4 }}>
      <div className="photo-strip-track">
        {strip.map(p => tile(p, "-a"))}
        {strip.map(p => tile(p, "-b"))}
      </div>
    </div>
  );
});
