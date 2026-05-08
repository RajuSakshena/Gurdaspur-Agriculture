import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { MapContainer, TileLayer, useMap, GeoJSON, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import * as GeoTIFF from "geotiff";
import L from "leaflet";
import {
  PieChart, Pie, Cell, Tooltip as ReTooltip,
} from "recharts";
import {
  Layers, Thermometer, Map,
  Activity, Satellite, Globe, Database,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type MapType   = "osm" | "satellite" | "hybrid";

// ─── Real analytics derived from GeoTIFF ─────────────────────────────────────

interface RealTempStats {
  avg:     number;   // mean °C
  min:     number;
  max:     number;
  hotPct:  number;   // % pixels > avg + 5
  modPct:  number;   // % pixels within avg ± 5
  coolPct: number;   // % pixels < avg - 5
  count:   number;   // total valid pixels
}

// Annual means (computed from all 52 weeks of bands)
interface AnnualMeans {
  ndvi: number;
  temp: number;
  rain: number;
  soil: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TEMPERATURE_META = {
  name:     "Temperature",
  desc:     "Land Surface Temp",
  dotColor: "#f97316",
};

const BASEMAPS: { id: MapType; label: string; icon: React.ElementType }[] = [
  { id: "osm",       label: "OSM", icon: Globe },
  { id: "satellite", label: "SAT", icon: Satellite },
  { id: "hybrid",    label: "HYB", icon: Map },
];

const TEMPERATURE_LEGEND = {
  gradient: "linear-gradient(to right,#3b82f6,#93c5fd,#fde047,#fb923c,#ef4444,#dc2626)",
  lowLabel: "Cool",
  highLabel: "Hot",
};

// Data sources used in GEE export
const DATA_SOURCES = [
  { label: "NDVI & EVI",    value: "Sentinel-2 SR Harmonized",   color: "#22c55e",  dot: "#16a34a" },
  { label: "LST (Temp)",    value: "MODIS MOD/MYD 11A1 + ERA5",  color: "#f97316",  dot: "#ea580c" },
  { label: "Rainfall",      value: "CHIRPS Daily",                color: "#38bdf8",  dot: "#0284c7" },
  { label: "Soil Moisture", value: "TerraClimate",                color: "#84cc16",  dot: "#65a30d" },
];

// ─── Shared styles ────────────────────────────────────────────────────────────

const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#374151",
  marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em",
};

const rechartTooltipStyle: React.CSSProperties = {
  background: "#fff", border: "1px solid #e5e7eb",
  borderRadius: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.08)", fontSize: 11,
};

// ─── Card ─────────────────────────────────────────────────────────────────────

function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #e5e7eb",
      borderRadius: 14, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", ...style,
    }}>
      {children}
    </div>
  );
}

// ─── SummaryGrid ──────────────────────────────────────────────────────────────

function SummaryGrid({ items }: {
  items: { label: string; value: string; accent: string; bg: string; icon: React.ElementType }[];
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: items.length > 2 ? "1fr 1fr" : "1fr", gap: 8 }}>
      {items.map(({ label, value, accent, bg, icon: Icon }) => (
        <Card key={label} style={{ padding: "10px 12px", background: bg }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <Icon size={11} color={accent} />
            <span style={{ fontSize: 9.5, color: accent, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {label}
            </span>
          </div>
          <p style={{ fontSize: 15, fontWeight: 800, color: "#111827", fontFamily: "monospace" }}>{value}</p>
        </Card>
      ))}
    </div>
  );
}

// ─── Annual Means Panel ───────────────────────────────────────────────────────

function AnnualMeansPanel({ means }: { means: AnnualMeans | null }) {
  if (!means) {
    return (
      <Card style={{ padding: "14px 16px" }}>
        <p style={sectionLabel}>2024 Annual Means</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{ height: 28, background: "#f1f5f9", borderRadius: 8, animation: "pulse 1.5s ease-in-out infinite" }} />
          ))}
          <p style={{ fontSize: 10, color: "#9ca3af", textAlign: "center" }}>Computing annual means…</p>
        </div>
      </Card>
    );
  }

  const rows = [
    { label: "🌿 NDVI",         value: means.ndvi.toFixed(3),                note: "avg greenness",  color: "#16a34a", bg: "#f0fdf4" },
    { label: "🌡️ Temperature",  value: `${means.temp.toFixed(1)} °C`,         note: "avg LST",        color: "#ea580c", bg: "#fff7ed" },
    { label: "🌧️ Rain",         value: `${means.rain.toFixed(1)} mm/wk`,      note: "avg weekly",     color: "#0284c7", bg: "#f0f9ff" },
    { label: "🌱 Soil Moisture", value: `${(means.soil * 100).toFixed(1)} %`, note: "avg fraction",   color: "#65a30d", bg: "#f7fee7" },
  ];

  return (
    <Card style={{ padding: "14px 16px" }}>
      <p style={sectionLabel}>2024 Annual Means</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {rows.map(r => (
          <div key={r.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: r.bg, borderRadius: 9, padding: "7px 10px" }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#111827" }}>{r.label}</span>
              <span style={{ fontSize: 9.5, color: "#9ca3af", marginLeft: 5 }}>{r.note}</span>
            </div>
            <span style={{ fontSize: 13, fontWeight: 800, color: r.color, fontFamily: "monospace" }}>{r.value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── Data Sources Panel ───────────────────────────────────────────────────────

function DataSourcesPanel() {
  return (
    <Card style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <Database size={12} color="#7c3aed" />
        <p style={{ ...sectionLabel, marginBottom: 0, color: "#7c3aed" }}>Data Sources · GEE</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {DATA_SOURCES.map(s => (
          <div key={s.label} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 8px", background: "#fafafa", borderRadius: 8, border: "1px solid #f1f5f9" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.dot, flexShrink: 0, marginTop: 3, display: "inline-block" }} />
            <div>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "#374151", display: "block" }}>{s.label}</span>
              <span style={{ fontSize: 9.5, color: "#9ca3af" }}>{s.value}</span>
            </div>
          </div>
        ))}
        <div style={{ marginTop: 4, padding: "5px 8px", background: "#f5f3ff", borderRadius: 7, border: "1px solid #ede9fe" }}>
          <span style={{ fontSize: 9, color: "#7c3aed", fontWeight: 600 }}>Scale: 500m · CRS: EPSG:4326</span>
          <br />
          <span style={{ fontSize: 9, color: "#9ca3af" }}>5 bands × 52 weeks = 260 total bands</span>
        </div>
      </div>
    </Card>
  );
}

// ─── Analytics Panel — REAL GeoTIFF stats ─────────────────────────────────────

function AnalyticsContent({ stats, week, annualMeans }: { stats: RealTempStats | null; week: number; annualMeans: AnnualMeans | null }) {
  const donutData = useMemo(() => {
    if (!stats) return null;
    return [
      { name: "Hot",      value: Math.round(stats.hotPct * 10) / 10,  color: "#ef4444" },
      { name: "Moderate", value: Math.round(stats.modPct * 10) / 10,  color: "#facc15" },
      { name: "Cool",     value: Math.round(stats.coolPct * 10) / 10, color: "#3b82f6" },
    ];
  }, [stats]);

  // Skeleton while loading
  if (!stats) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {[0, 1, 2].map(i => (
          <Card key={i} style={{ padding: "14px 16px", background: "#f8fafc" }}>
            <div style={{ height: 10, background: "#e5e7eb", borderRadius: 6, marginBottom: 8, width: "55%" }} />
            <div style={{ height: 26, background: "#e5e7eb", borderRadius: 6, width: "38%" }} />
          </Card>
        ))}
        <p style={{ fontSize: 11, color: "#9ca3af", textAlign: "center", marginTop: 4 }}>
          Computing real data…
        </p>
        <DataSourcesPanel />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* 4 stat cards — ALL from real GeoTIFF */}
      <SummaryGrid items={[
        { label: "Avg Temp",  value: `${stats.avg.toFixed(1)}°C`,   accent: "#f97316", bg: "#fff7ed", icon: Thermometer },
        { label: "Hot Zones", value: `${stats.hotPct.toFixed(1)}%`,  accent: "#dc2626", bg: "#fef2f2", icon: Activity },
        { label: "Moderate",  value: `${stats.modPct.toFixed(1)}%`,  accent: "#ca8a04", bg: "#fefce8", icon: Activity },
        { label: "Cool",      value: `${stats.coolPct.toFixed(1)}%`, accent: "#3b82f6", bg: "#eff6ff", icon: Activity },
      ]} />

      {/* Min / Max */}
      <SummaryGrid items={[
        { label: "Min Temp", value: `${stats.min.toFixed(1)}°C`, accent: "#3b82f6", bg: "#eff6ff", icon: Thermometer },
        { label: "Max Temp", value: `${stats.max.toFixed(1)}°C`, accent: "#dc2626", bg: "#fef2f2", icon: Thermometer },
      ]} />

      {/* Donut chart — real percentages */}
      {donutData && (
        <Card style={{ padding: "14px 16px" }}>
          <p style={sectionLabel}>Temperature Distribution</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 96, height: 96, flexShrink: 0 }}>
              <svg viewBox="0 0 96 96" width={96} height={96}>
                {(() => {
                  const total = donutData.reduce((s, d) => s + d.value, 0) || 100;
                  let cursor = -90; // start at top
                  const cx = 48, cy = 48, r = 38, ir = 22;
                  return donutData.map((d, idx) => {
                    const angle = (d.value / total) * 360;
                    const startRad = (cursor * Math.PI) / 180;
                    const endRad   = ((cursor + angle) * Math.PI) / 180;
                    const x1 = cx + r * Math.cos(startRad);
                    const y1 = cy + r * Math.sin(startRad);
                    const x2 = cx + r * Math.cos(endRad);
                    const y2 = cy + r * Math.sin(endRad);
                    const ix1 = cx + ir * Math.cos(startRad);
                    const iy1 = cy + ir * Math.sin(startRad);
                    const ix2 = cx + ir * Math.cos(endRad);
                    const iy2 = cy + ir * Math.sin(endRad);
                    const large = angle > 180 ? 1 : 0;
                    const path = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${ir} ${ir} 0 ${large} 0 ${ix1} ${iy1} Z`;
                    cursor += angle;
                    return <path key={idx} d={path} fill={d.color} />;
                  });
                })()}
              </svg>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {donutData.map(d => (
                <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: d.color, flexShrink: 0, display: "inline-block" }} />
                  <span style={{ fontSize: 11, color: "#475569" }}>{d.name}</span>
                  <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: "auto", paddingLeft: 8 }}>{d.value.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Data info card */}
      <Card style={{ padding: "12px 14px" }}>
        <p style={sectionLabel}>Data Info · Week {String(week).padStart(2, "0")}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            { label: "Valid Pixels", value: stats.count.toLocaleString() },
            { label: "Temp Range",   value: `${stats.min.toFixed(1)} – ${stats.max.toFixed(1)} °C` },
            { label: "Hot threshold",value: `> ${(stats.avg + 5).toFixed(1)} °C` },
            { label: "Cool threshold",value: `< ${(stats.avg - 5).toFixed(1)} °C` },
            { label: "Source",        value: "GeoTIFF Band +1" },
          ].map(r => (
            <div key={r.label} style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10.5, color: "#6b7280" }}>{r.label}</span>
              <span style={{ fontSize: 10.5, color: "#111827", fontWeight: 600, fontFamily: "monospace" }}>{r.value}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Layer overview bars — Temperature bar uses real data */}
      <Card style={{ padding: "14px 16px" }}>
        <p style={sectionLabel}>Layer Overview</p>
        {[
          { label: "NDVI",        pct: 58,                                                              color: "#22c55e" },
          { label: "Temperature", pct: Math.min(100, Math.round(stats.hotPct + stats.modPct)),          color: "#f97316" },
          { label: "Rain",        pct: 62,                                                              color: "#38bdf8" },
          { label: "Soil Moist.", pct: 41,                                                              color: "#84cc16" },
        ].map(r => (
          <div key={r.label} style={{ marginBottom: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 11, color: "#475569" }}>{r.label}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#111827" }}>{r.pct}%</span>
            </div>
            <div style={{ height: 5, background: "#f1f5f9", borderRadius: 99, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${r.pct}%`, background: r.color, borderRadius: 99, transition: "width 0.6s" }} />
            </div>
          </div>
        ))}
      </Card>

      {/* Annual means panel */}
      <AnnualMeansPanel means={annualMeans} />

      {/* Data sources panel */}
      <DataSourcesPanel />

    </div>
  );
}

// ─── Basemap Tiles ─────────────────────────────────────────────────────────────

function BasemapTiles({ mapType }: { mapType: MapType }) {
  if (mapType === "osm") return (
    <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
  );
  if (mapType === "satellite") return (
    <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxZoom={22} attribution="© Esri" />
  );
  return (
    <>
      <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxZoom={22} attribution="© Esri" />
      <TileLayer url="https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}" maxZoom={22} opacity={0.9} attribution="" />
    </>
  );
}

// ─── Map Controls ─────────────────────────────────────────────────────────────

function MapControls({ mapType, setMapType }: { mapType: MapType; setMapType: (m: MapType) => void }) {
  const map = useMap();
  return (
    <div style={{ position: "absolute", top: 16, right: 16, zIndex: 700, display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Zoom */}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.09)", overflow: "hidden" }}>
        {[{ label: "+", fn: () => map.zoomIn() }, { label: "−", fn: () => map.zoomOut() }].map(({ label, fn }) => (
          <button key={label} onClick={fn}
            style={{ display: "block", width: 36, height: 36, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: "#374151", lineHeight: 1, borderBottom: label === "+" ? "1px solid #f1f5f9" : "none" }}
            onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >{label}</button>
        ))}
      </div>
      {/* Basemap */}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.09)", overflow: "hidden" }}>
        {BASEMAPS.map(({ id, label, icon: Icon }) => {
          const active = mapType === id;
          return (
            <button key={id} onClick={() => setMapType(id)} title={label}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, border: "none", cursor: "pointer", background: active ? "#f0f9ff" : "transparent", borderBottom: id !== "hybrid" ? "1px solid #f1f5f9" : "none" }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "#f8fafc"; }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            ><Icon size={14} color={active ? "#0284c7" : "#9ca3af"} /></button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Heatmap Layer ────────────────────────────────────────────────────────────

// ─── Color scale: deep purple → red → orange → yellow ─────────────────────────
function tempToColor(t: number, minT: number, maxT: number): [number,number,number] {
  const ratio = Math.max(0, Math.min(1, (t - minT) / (maxT - minT || 1)));
  const stops: [number,number,number,number][] = [
    [0.00,  13,   2,  33],
    [0.15,  59,   7, 100],
    [0.30, 124,  13, 110],
    [0.46, 160,  30,  50],
    [0.60, 231,  76,  60],
    [0.74, 243, 156,  18],
    [0.87, 241, 196,  15],
    [1.00, 255, 253, 231],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (ratio >= stops[i][0] && ratio <= stops[i+1][0]) { lo = stops[i]; hi = stops[i+1]; break; }
  }
  const f = (ratio - lo[0]) / (hi[0] - lo[0] || 1);
  return [
    Math.round(lo[1] + f * (hi[1] - lo[1])),
    Math.round(lo[2] + f * (hi[2] - lo[2])),
    Math.round(lo[3] + f * (hi[3] - lo[3])),
  ];
}

// ─── Canvas pixel overlay — NO dots, solid color fill ──────────────────────
interface CanvasTempLayerProps {
  band: any; width: number; height: number;
  bbox: number[]; minTemp: number; maxTemp: number;
}

const CanvasTempLayer = React.memo(({ band, width, height, bbox, minTemp, maxTemp }: CanvasTempLayerProps) => {
  const map = useMap();
  useEffect(() => {
    if (!band || !width || !height || !bbox.length) return;
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const imgData = ctx.createImageData(width, height);
    const px = imgData.data;
    for (let i = 0; i < width * height; i++) {
      const v = band[i] as number;
      if (v == null || isNaN(v) || v < -100) { px[i*4+3] = 0; continue; }
      const [r,g,b] = tempToColor(v, minTemp, maxTemp);
      px[i*4]=r; px[i*4+1]=g; px[i*4+2]=b;
      px[i*4+3] = 168; // 66% opacity — city labels fully visible through it
    }
    ctx.putImageData(imgData, 0, 0);
    const bounds: L.LatLngBoundsExpression = [[bbox[1],bbox[0]],[bbox[3],bbox[2]]];
    const ov = L.imageOverlay(canvas.toDataURL(), bounds, { opacity: 1, zIndex: 250 });
    ov.addTo(map);
    // bring tile labels to front
    map.eachLayer((l: any) => { if (l._url && l._url.includes('Reference')) l.setZIndex(400); });
    return () => { map.removeLayer(ov); };
  }, [band, width, height, bbox, minTemp, maxTemp, map]);
  return null;
});

// ─── Hover Tooltip ────────────────────────────────────────────────────────────
// Shows on hover only. While left-click is held (dragging), tooltip is hidden.

interface HoverTooltipProps {
  allBands:    any[];
  width:       number;
  height:      number;
  bbox:        number[];
  week:        number;
  annualMeans: AnnualMeans | null;
}

const HoverTooltip = ({ allBands, width, height, bbox, week, annualMeans }: HoverTooltipProps) => {
  const popupRef  = React.useRef<L.Popup | null>(null);
  const isDragging = React.useRef(false);
  const map = useMap();

  // Use Leaflet's own drag events — most reliable way to know if map is being dragged
  React.useEffect(() => {
    const onDragStart = () => {
      isDragging.current = true;
      if (popupRef.current) {
        try { map.closePopup(popupRef.current); } catch (_) {}
      }
    };
    const onDragEnd = () => { isDragging.current = false; };
    map.on("dragstart", onDragStart);
    map.on("dragend",   onDragEnd);
    return () => {
      map.off("dragstart", onDragStart);
      map.off("dragend",   onDragEnd);
    };
  }, [map]);

  useMapEvents({
    mousemove(e) {
      if (isDragging.current) return;
      if (!allBands.length || !width || !height) return;

      const { lat, lng } = e.latlng;

      const x = Math.max(0, Math.min(width - 1,
        Math.floor(((lng - bbox[0]) / (bbox[2] - bbox[0])) * width)
      ));
      const y = Math.max(0, Math.min(height - 1,
        Math.floor(((bbox[3] - lat) / (bbox[3] - bbox[1])) * height)
      ));

      const baseIndex = (week - 1) * 5;

      const getVal = (bandOffset: number): number | null => {
        const band = allBands[baseIndex + bandOffset];
        if (!band) return null;
        const index = y * width + x;
        if (index < 0 || index >= band.length) return null;
        const val = band[index];
        if (val === undefined || val === null || isNaN(val as number)) return null;
        return val as number;
      };

      const detectTempBand = (): number => {
        for (let i = 0; i < 5; i++) {
          const sample = allBands[baseIndex + i]?.[1000];
          if (sample !== undefined && sample !== null && !isNaN(sample) && sample > 10 && sample < 60) return i;
        }
        return 1;
      };

      const tempBandOffset = detectTempBand();
      const ndvi = getVal(0);
      const temp = getVal(tempBandOffset);
      const rain = getVal(2);
      const soil = getVal(3);
      const am   = annualMeans;

      // ── Redesigned compact row ──────────────────────────────────────────────
      const row = (
        icon: string,
        label: string,
        val: number | null,
        fmt: (v: number) => string,
        annualVal: number | null,
        annualFmt: (v: number) => string,
        accent: string,
        iconBg: string,
      ) => {
        const valStr    = val !== null ? fmt(val) : "—";
        const diff      = (val !== null && annualVal !== null) ? val - annualVal : null;
        const diffSign  = diff !== null ? (diff >= 0 ? "▲" : "▼") : "";
        const diffColor = diff !== null ? (diff > 0 ? "#ef4444" : "#22c55e") : "#9ca3af";
        const diffAbs   = diff !== null ? Math.abs(diff) : null;
        const diffStr   = diffAbs !== null
          ? (diffAbs < 0.001 ? "0.0" : diffAbs < 1 ? diffAbs.toFixed(3) : diffAbs.toFixed(1))
          : "—";
        const avgStr    = annualVal !== null ? annualFmt(annualVal) : "—";

        return `
          <div style="display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:8px;padding:7px 10px;border-radius:10px;background:#f8fafc;margin-bottom:5px;border:1px solid #f1f5f9">
            <div style="width:28px;height:28px;border-radius:8px;background:${iconBg};display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">${icon}</div>
            <div style="min-width:0">
              <div style="font-size:10px;color:#9ca3af;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:1px">${label}</div>
              <div style="font-size:11px;color:#6b7280;font-weight:500">
                avg <span style="color:#374151;font-weight:700">${avgStr}</span>
                ${diff !== null ? `<span style="margin-left:5px;color:${diffColor};font-weight:700;font-size:10px">${diffSign} ${diffStr}</span>` : ""}
              </div>
            </div>
            <div style="font-size:17px;font-weight:900;color:${accent};font-family:monospace;white-space:nowrap">${valStr}</div>
          </div>`;
      };

      if (!popupRef.current) {
        popupRef.current = L.popup({
          closeButton: false,
          offset:      [0, -4],
          maxWidth:    300,
          className:   "guru-tooltip",
          autoPan:     false,
        });
      }

      const weekDate = new Date(2024, 0, 1 + (week - 1) * 7)
        .toLocaleDateString("en-IN", { day: "numeric", month: "short" });

      popupRef.current
        .setLatLng([lat, lng])
        .setContent(`
          <style>
            .guru-tooltip .leaflet-popup-content-wrapper {
              border-radius: 14px !important;
              box-shadow: 0 12px 40px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08) !important;
              padding: 0 !important;
              border: 1px solid #e5e7eb;
              overflow: hidden;
            }
            .guru-tooltip .leaflet-popup-content { margin: 0 !important; width: auto !important; }
            .guru-tooltip .leaflet-popup-tip-container { display: none; }
          </style>
          <div style="font-family:system-ui,-apple-system,sans-serif;width:272px;background:#fff">

            <!-- Header -->
            <div style="padding:10px 12px 8px;background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);display:flex;align-items:center;justify-content:space-between">
              <div style="display:flex;align-items:center;gap:7px">
                <span style="font-size:13px">📍</span>
                <div>
                  <div style="font-size:12px;font-weight:800;color:#fff;line-height:1.2">Gurdaspur</div>
                  <div style="font-size:9.5px;color:rgba(255,255,255,0.5);margin-top:1px">${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E</div>
                </div>
              </div>
              <div style="background:rgba(249,115,22,0.2);border:1px solid rgba(249,115,22,0.35);border-radius:6px;padding:3px 8px;text-align:center">
                <div style="font-size:9px;color:#fb923c;font-weight:700;letter-spacing:0.06em">WEEK</div>
                <div style="font-size:13px;font-weight:900;color:#f97316;font-family:monospace;line-height:1.1">${String(week).padStart(2,"0")}</div>
                <div style="font-size:8px;color:rgba(255,255,255,0.4)">${weekDate}</div>
              </div>
            </div>

            <!-- Rows -->
            <div style="padding:8px 8px 6px">
              ${row("🌿","NDVI · Vegetation",     ndvi, v=>v.toFixed(3),       am?am.ndvi:null,  v=>v.toFixed(3),         "#16a34a","#dcfce7")}
              ${row("🌡️","Temperature · LST",     temp, v=>v.toFixed(1)+"°C",  am?am.temp:null,  v=>v.toFixed(1)+"°C",    "#ea580c","#ffedd5")}
              ${row("🌧️","Rainfall · Weekly",     rain, v=>v.toFixed(1)+" mm", am?am.rain:null,  v=>v.toFixed(1)+" mm",   "#0284c7","#dbeafe")}
              ${row("🌱","Soil Moisture",          soil, v=>(v*100).toFixed(1)+"%", am?am.soil:null, v=>(v*100).toFixed(1)+"%","#65a30d","#ecfccb")}
            </div>

            <!-- Footer -->
            <div style="padding:4px 10px 7px;display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:9px;color:#d1d5db">▲▼ vs 2024 annual avg</span>
              <span style="font-size:9px;color:#e2e8f0;font-family:monospace">px(${x},${y})</span>
            </div>
          </div>
        `)
        .openOn(map);
    },

    mouseout() {
      if (popupRef.current) {
        try { map.closePopup(popupRef.current); } catch (_) {}
      }
    },
  });

  return null;
};

// ─── Week Dropdown ────────────────────────────────────────────────────────────

const MONTH_ABBR = ["Jan","Jan","Jan","Jan","Feb","Feb","Feb","Feb","Mar","Mar","Mar","Mar","Apr","Apr","Apr","Apr","May","May","May","May","Jun","Jun","Jun","Jun","Jul","Jul","Jul","Jul","Aug","Aug","Aug","Aug","Sep","Sep","Sep","Sep","Oct","Oct","Oct","Oct","Nov","Nov","Nov","Nov","Dec","Dec","Dec","Dec","Dec","Dec","Dec","Dec"];

function WeekSlider({ week, setWeek }: { week: number; setWeek: (w: number) => void }) {
  const [open, setOpen] = React.useState(false);
  const dropRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const month   = MONTH_ABBR[week - 1] ?? "";
  const weekStart = new Date(2024, 0, 1 + (week - 1) * 7);
  const dateStr = weekStart.toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  // Close on outside click
  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Scroll active week into view when dropdown opens
  React.useEffect(() => {
    if (open && listRef.current) {
      const activeEl = listRef.current.querySelector("[data-active='true']") as HTMLElement;
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [open]);

  const selectWeek = (w: number) => {
    setWeek(w);
    setOpen(false);
  };

  // Build all 52 week items
  const weeks = Array.from({ length: 52 }, (_, i) => {
    const w = i + 1;
    const ws = new Date(2024, 0, 1 + i * 7);
    const ds = ws.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    return { w, month: MONTH_ABBR[i], date: ds };
  });

  return (
    <div
      ref={dropRef}
      style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 700 }}
    >
      <style>{`
        .week-dropdown-list::-webkit-scrollbar { width: 4px; }
        .week-dropdown-list::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 4px; }
        .week-dropdown-list::-webkit-scrollbar-thumb { background: #f97316; border-radius: 4px; }
        .week-item-btn:hover { background: #fff7ed !important; }
      `}</style>

      {/* ── Tile / Trigger ── */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: "#ffffff",
          border: "1px solid #e5e7eb",
          borderRadius: 18,
          boxShadow: "0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)",
          padding: "10px 20px",
          display: "flex", alignItems: "center", gap: 14,
          cursor: "pointer", userSelect: "none",
          minWidth: 260,
        }}
      >
        {/* Week badge */}
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", minWidth: 46, flexShrink:0 }}>
          <span style={{ fontSize:26, fontWeight:900, color:"#111827", fontFamily:"monospace", lineHeight:1, letterSpacing:"-1px" }}>
            {String(week).padStart(2,"0")}
          </span>
          <span style={{ fontSize:9, color:"#f97316", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.12em", marginTop:2 }}>
            {month}
          </span>
          <span style={{ fontSize:8.5, color:"#9ca3af", marginTop:1 }}>{dateStr}</span>
        </div>

        {/* Divider */}
        <div style={{ width:1, height:38, background:"#e5e7eb", flexShrink:0 }} />

        {/* Label */}
        <div style={{ flex:1, textAlign:"left" }}>
          <span style={{ fontSize:11, color:"#9ca3af", display:"block", marginBottom:3, textTransform:"uppercase", letterSpacing:"0.08em" }}>Select Week</span>
          <span style={{ fontSize:13, fontWeight:700, color:"#111827" }}>Week {String(week).padStart(2,"0")} / 52</span>
        </div>

        {/* Arrow */}
        <svg
          width={16} height={16} viewBox="0 0 16 16" fill="none"
          style={{ flexShrink:0, transition:"transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          <path d="M4 6l4 4 4-4" stroke="#f97316" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* ── Dropdown list ── */}
      {open && (
        <div
          ref={listRef}
          className="week-dropdown-list"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            width: 260,
            maxHeight: 320,
            overflowY: "auto",
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            boxShadow: "0 -8px 40px rgba(0,0,0,0.15), 0 -2px 8px rgba(0,0,0,0.06)",
            padding: "6px",
          }}
        >
          {weeks.map(({ w, month: mo, date: dt }) => {
            const isActive = w === week;
            return (
              <button
                key={w}
                data-active={isActive}
                className="week-item-btn"
                onClick={() => selectWeek(w)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  width: "100%", padding: "7px 10px",
                  background: isActive ? "#fff7ed" : "transparent",
                  border: isActive ? "1px solid #fed7aa" : "1px solid transparent",
                  borderRadius: 9, cursor: "pointer",
                  marginBottom: 2,
                  transition: "background 0.12s",
                }}
              >
                <span style={{
                  fontSize:15, fontWeight:900, fontFamily:"monospace",
                  color: isActive ? "#f97316" : "#111827",
                  minWidth: 26, textAlign:"right",
                }}>
                  {String(w).padStart(2,"0")}
                </span>
                <span style={{ fontSize:9, color:"#f97316", fontWeight:700, textTransform:"uppercase", minWidth:24 }}>{mo}</span>
                <span style={{ fontSize:10, color:"#6b7280" }}>{dt}</span>
                {isActive && (
                  <svg width={10} height={10} viewBox="0 0 10 10" fill="none" style={{ marginLeft:"auto" }}>
                    <path d="M2 5l2.5 2.5L8 3" stroke="#f97316" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Layer Legend ─────────────────────────────────────────────────────────────

function LayerLegend() {
  const { gradient, lowLabel, highLabel } = TEMPERATURE_LEGEND;
  return (
    <div style={{ position: "absolute", bottom: 90, left: 16, zIndex: 500 }}>
      <Card style={{ padding: "8px 12px", minWidth: 170 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
          <Activity size={12} color="#0ea5e9" />
          <span style={{ fontSize: 9.5, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>Colour Legend</span>
        </div>
        <p style={{ fontSize: 11, fontWeight: 700, color: "#111827", marginBottom: 6 }}>Temperature</p>
        <div style={{ height: 10, borderRadius: 99, background: gradient, boxShadow: "inset 0 1px 3px rgba(0,0,0,0.12)", marginBottom: 4 }} />
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 9, color: "#6b7280", fontWeight: 500 }}>{lowLabel}</span>
          <span style={{ fontSize: 9, color: "#6b7280", fontWeight: 500 }}>{highLabel}</span>
        </div>
      </Card>
    </div>
  );
}

// ─── Map Instance helper ──────────────────────────────────────────────────────

function MapInstance({ setMap }: { setMap: (map: any) => void }) {
  const map = useMap();
  useEffect(() => { setMap(map); }, [map, setMap]);
  return null;
}

// MapDragFix removed — Leaflet's built-in drag handles panning correctly.
// Custom drag was causing instability by fighting with Leaflet internals.

// ─── GeoTIFF Heatmap Layer ────────────────────────────────────────────────────

interface GeoTiffHeatmapLayerProps {
  week:            number;
  onLoad:          () => void;
  onBandsReady:    (bands: any[], w: number, h: number, bbox: number[]) => void;
  onStatsReady:    (stats: RealTempStats) => void;
  onAnnualMeans:   (means: AnnualMeans) => void;
}

function GeoTiffHeatmapLayer({ week, onLoad, onBandsReady, onStatsReady, onAnnualMeans }: GeoTiffHeatmapLayerProps) {
  const [band,    setBand]    = useState<any>(null);
  const [tW,      setTW]      = useState(0);
  const [tH,      setTH]      = useState(0);
  const [tBbox,   setTBbox]   = useState<number[]>([]);
  const [minTemp, setMinTemp] = useState(5);
  const [maxTemp, setMaxTemp] = useState(50);

  // Track whether we've already computed annual means (only do once per session)
  const annualComputed = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const loadTiff = async () => {
      try {
        const response = await fetch("/Gurdaspur_Weekly_2025_Final.tif");
        const buffer   = await response.arrayBuffer();
        const tiff     = await GeoTIFF.fromArrayBuffer(buffer);
        const image    = await tiff.getImage();

        const width   = image.getWidth();
        const height  = image.getHeight();
        const rasters = (await image.readRasters()) as any[];
        const bbox    = image.getBoundingBox();

        console.log("TOTAL BANDS:", rasters.length);
        console.log("SAMPLE VALUES per band at pixel 1000:",
          rasters.map((b: any, i: number) => ({ band: i, val: b?.[1000] }))
        );

        if (cancelled) return;

        // Expose all bands for tooltip
        onBandsReady(rasters, width, height, bbox);

        // ── Compute annual means across ALL 52 weeks (once) ──────────────────
        if (!annualComputed.current) {
          annualComputed.current = true;

          // Auto-detect which band offset within each 5-band group is temperature
          // (same heuristic as the per-week detector)
          const detectTempOffset = (baseIdx: number): number => {
            for (let i = 0; i < 5; i++) {
              const s = rasters[baseIdx + i]?.[1000];
              if (s !== undefined && s !== null && !isNaN(s) && s > 10 && s < 60) return i;
            }
            return 1;
          };

          let sumNdvi = 0, sumTemp = 0, sumRain = 0, sumSoil = 0;
          let validWeeks = 0;

          for (let w = 0; w < 52; w++) {
            const base   = w * 5;
            const tOff   = detectTempOffset(base);

            const ndviB  = rasters[base + 0];
            const tempB  = rasters[base + tOff];
            const rainB  = rasters[base + 2];
            const soilB  = rasters[base + 3];

            if (!ndviB || !tempB || !rainB || !soilB) continue;

            // mean of valid pixels for this week
            const mean = (band: any, minV: number, maxV: number) => {
              let s = 0, c = 0;
              for (let i = 0; i < band.length; i++) {
                const v = band[i];
                if (v === null || v === undefined || isNaN(v)) continue;
                if (v < minV || v > maxV) continue; // filter obvious outliers
                s += v; c++;
              }
              return c > 0 ? s / c : null;
            };

            const mNdvi = mean(ndviB, -1, 1);
            const mTemp = mean(tempB, -20, 80);
            const mRain = mean(rainB, 0, 500);
            const mSoil = mean(soilB, 0, 1);

            if (mNdvi === null || mTemp === null || mRain === null || mSoil === null) continue;

            sumNdvi += mNdvi;
            sumTemp += mTemp;
            sumRain += mRain;
            sumSoil += mSoil;
            validWeeks++;
          }

          if (validWeeks > 0) {
            const means: AnnualMeans = {
              ndvi: sumNdvi / validWeeks,
              temp: sumTemp / validWeeks,
              rain: sumRain / validWeeks,
              soil: sumSoil / validWeeks,
            };
            console.log("ANNUAL MEANS:", means);
            if (!cancelled) onAnnualMeans(means);
          }
        }

        // ── Load current week's temperature band ──────────────────────────────
        const baseIndex = (week - 1) * 5;

        const detectTempBand = (): number => {
          for (let i = 0; i < 5; i++) {
            const sample = rasters[baseIndex + i]?.[1000];
            if (
              sample !== undefined &&
              sample !== null &&
              !isNaN(sample) &&
              sample > 10 &&
              sample < 60
            ) {
              console.log("✅ TEMP BAND FOUND at offset:", i, "| sample value:", sample);
              return i;
            }
          }
          console.warn("⚠️ No temp band auto-detected — using default offset 1");
          return 1;
        };

        const tempOffset = detectTempBand();
        const bandIndex  = baseIndex + tempOffset;
        console.log("USING BAND INDEX:", bandIndex, "| baseIndex:", baseIndex, "| tempOffset:", tempOffset);

        const band = rasters[bandIndex];
        if (!band) {
          console.error(`Band not found: bandIndex=${bandIndex} (week=${week}, total=${rasters.length})`);
          onLoad();
          return;
        }

        // ── Collect all valid temperature values ──────────────────────────────
        const tempValues: number[] = [];
        for (let i = 0; i < band.length; i++) {
          const v = band[i];
          if (v === null || v === undefined || isNaN(v as number)) continue;
          tempValues.push(v as number);
        }

        console.log("REAL TEMP — pixel count:", tempValues.length);
        console.log("REAL TEMP — first 10:", tempValues.slice(0, 10));

        // ── Compute real analytics ─────────────────────────────────────────────
        if (tempValues.length > 0) {
          const sum    = tempValues.reduce((a, b) => a + b, 0);
          const avg    = sum / tempValues.length;
          const minVal = Math.min(...tempValues);
          const maxVal = Math.max(...tempValues);

          console.log(`REAL AVG TEMP: ${avg.toFixed(2)} °C | MIN: ${minVal.toFixed(2)} | MAX: ${maxVal.toFixed(2)}`);

          const total   = tempValues.length;
          const hotCnt  = tempValues.filter(v => v > avg + 5).length;
          const coolCnt = tempValues.filter(v => v < avg - 5).length;
          const modCnt  = total - hotCnt - coolCnt;

          const realStats: RealTempStats = {
            avg,
            min:     minVal,
            max:     maxVal,
            hotPct:  (hotCnt  / total) * 100,
            modPct:  (modCnt  / total) * 100,
            coolPct: (coolCnt / total) * 100,
            count:   total,
          };

          if (!cancelled) {
            onStatsReady(realStats);
            setMinTemp(minVal);
            setMaxTemp(maxVal);
          }
        }

        // ── Pass band to CanvasTempLayer ────────────────────────────────────
        if (!cancelled) {
          setBand(band);
          setTW(width); setTH(height); setTBbox(bbox);
          onLoad();
        }
      } catch (err) {
        console.error("TIFF load error:", err);
        if (!cancelled) onLoad();
      }
    };

    loadTiff();
    return () => { cancelled = true; };
  }, [week, onLoad, onBandsReady, onStatsReady, onAnnualMeans]);

  return <CanvasTempLayer band={band} width={tW} height={tH} bbox={tBbox} minTemp={minTemp} maxTemp={maxTemp} />;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Gurdaspur() {
  const [week,        setWeek]        = useState<number>(1);
  const [loading,     setLoading]     = useState(true);
  const [mapType,     setMapType]     = useState<MapType>("osm");
  const [boundary,    setBoundary]    = useState<any>(null);

  // All bands for click tooltip
  const [allBands,   setAllBands]   = useState<any[]>([]);
  const [tiffWidth,  setTiffWidth]  = useState<number>(0);
  const [tiffHeight, setTiffHeight] = useState<number>(0);
  const [tiffBbox,   setTiffBbox]   = useState<number[]>([]);

  // Real analytics from GeoTIFF pixels
  const [realStats,    setRealStats]    = useState<RealTempStats | null>(null);
  const [annualMeans,  setAnnualMeans]  = useState<AnnualMeans | null>(null);

  const mapRef = useRef<any>(null);

  // Load GeoJSON boundary once
  useEffect(() => {
    fetch("/gurdaspur_boundary.geojson")
      .then(res => res.json())
      .then(data => setBoundary(data))
      .catch(err => console.warn("Boundary load failed:", err));
  }, []);

  const handleLayerLoad = useCallback(() => setLoading(false), []);

  const handleBandsReady = useCallback((bands: any[], w: number, h: number, bbox: number[]) => {
    setAllBands(bands);
    setTiffWidth(w);
    setTiffHeight(h);
    setTiffBbox(bbox);
  }, []);

  const handleStatsReady = useCallback((stats: RealTempStats) => {
    setRealStats(stats);
  }, []);

  const handleAnnualMeans = useCallback((means: AnnualMeans) => {
    setAnnualMeans(means);
  }, []);

  const handleWeekChange = useCallback((w: number) => {
    setWeek(w);
    setLoading(true);
    setRealStats(null);
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", width: "100%", fontFamily: "'Inter', system-ui, sans-serif", overflow: "hidden", background: "#f1f5f9" }}>

      {/* ── Map area ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: "relative", cursor: "crosshair" }}>

        <style>{`
          @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
          @keyframes spin    { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
          .layer-fade { animation: fadeIn 0.35s ease; }
        `}</style>

        {loading && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 1000,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            background: "rgba(248,250,252,0.84)", backdropFilter: "blur(6px)",
          }}>
            <div style={{ animation: "spin 1s linear infinite", display: "flex", marginBottom: 10 }}>
              <Layers size={32} color="#0ea5e9" />
            </div>
            <p style={{ color: "#475569", fontSize: 13, fontWeight: 500 }}>
              Loading Temperature · Week {String(week).padStart(2, "0")}…
            </p>
          </div>
        )}

        <MapContainer
          bounds={[[31.6, 74.9], [32.2, 75.5]]}
          zoom={10}
          style={{ width: "100%", height: "100vh" }}
          zoomControl={false}
          maxZoom={18}
          minZoom={7}
        >
          <MapInstance setMap={(map) => (mapRef.current = map)} />
          <BasemapTiles mapType={mapType} />

          {/* Temperature heatmap — remount on week change */}
          <GeoTiffHeatmapLayer
            key={`geotiff-${week}`}
            week={week}
            onLoad={handleLayerLoad}
            onBandsReady={handleBandsReady}
            onStatsReady={handleStatsReady}
            onAnnualMeans={handleAnnualMeans}
          />

          {/* District boundary */}
          {boundary && (
            <GeoJSON
              key={JSON.stringify(boundary)}
              data={boundary}
              style={{ color: "black", weight: 3, fillOpacity: 0 }}
            />
          )}

          {/* Hover tooltip — shows values + annual mean diff */}
          <HoverTooltip
            allBands={allBands}
            width={tiffWidth}
            height={tiffHeight}
            bbox={tiffBbox}
            week={week}
            annualMeans={annualMeans}
          />

          <MapControls mapType={mapType} setMapType={setMapType} />
        </MapContainer>

        {/* Active layer pill */}
        <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 600, pointerEvents: "none" }}>
          <div style={{
            background: "rgba(255,255,255,0.95)", border: "1px solid #e5e7eb",
            borderRadius: 999, padding: "5px 14px",
            boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: TEMPERATURE_META.dotColor, display: "inline-block" }} />
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "#374151" }}>{TEMPERATURE_META.name}</span>
            <span style={{ fontSize: 10, color: "#9ca3af" }}>· {TEMPERATURE_META.desc}</span>
            <span style={{ fontSize: 10, color: "#9ca3af" }}>· Wk {String(week).padStart(2, "0")}</span>
            {realStats && (
              <span style={{ fontSize: 10, color: "#f97316", fontWeight: 600 }}>
                · {realStats.avg.toFixed(1)}°C avg
              </span>
            )}
          </div>
        </div>

        <LayerLegend />
        <WeekSlider week={week} setWeek={handleWeekChange} />
      </div>

      {/* ── Right Analytics Panel ─────────────────────────────────────────── */}
      <aside style={{
        width: 272, flexShrink: 0, display: "flex", flexDirection: "column",
        background: "#f8fafc", borderLeft: "1px solid #e5e7eb", overflowY: "auto", zIndex: 10,
      }}>
        <div style={{ padding: "18px 16px 12px", borderBottom: "1px solid #e5e7eb", background: "#fff" }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Analytics</p>
          <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
            Gurdaspur District · 2024
            {realStats && <span style={{ color: "#22c55e", fontWeight: 700 }}> · Live ✓</span>}
          </p>
        </div>
        <div style={{ padding: "12px 12px 20px" }}>
          <AnalyticsContent stats={realStats} week={week} annualMeans={annualMeans} />
        </div>
      </aside>
    </div>
  );
}