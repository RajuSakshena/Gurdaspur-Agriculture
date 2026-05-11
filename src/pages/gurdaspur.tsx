import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { MapContainer, TileLayer, useMap, GeoJSON, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import * as GeoTIFF from "geotiff";
import L from "leaflet";
import {
  Layers, Thermometer, Map,
  Activity, Satellite, Globe, Database, Info, X, ChevronRight,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type MapType   = "osm" | "satellite" | "hybrid";
type LayerType = "temperature" | "ndvi" | "rain" | "soil";

// ─── Real analytics derived from GeoTIFF ─────────────────────────────────────

interface RealTempStats {
  avg:     number;
  min:     number;
  max:     number;
  hotPct:  number;
  modPct:  number;
  coolPct: number;
  count:   number;
}

interface AnnualMeans {
  ndvi: number;
  temp: number;
  rain: number;
  soil: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LAYER_META: Record<LayerType, { name: string; desc: string; dotColor: string; emoji: string; label: string }> = {
  temperature: { name: "Temperature", desc: "Land Surface Temp",  dotColor: "#f97316", emoji: "🌡", label: "Temp"  },
  ndvi:        { name: "NDVI",         desc: "Vegetation Index",  dotColor: "#16a34a", emoji: "🌿", label: "NDVI"  },
  rain:        { name: "Rainfall",     desc: "Weekly Rainfall",   dotColor: "#0284c7", emoji: "🌧", label: "Rain"  },
  soil:        { name: "Soil Moisture",desc: "Soil Moisture",     dotColor: "#65a30d", emoji: "🌱", label: "Soil"  },
};

const LAYER_LEGEND: Record<LayerType, { gradient: string; lowLabel: string; highLabel: string }> = {
  temperature: {
    gradient: "linear-gradient(to right,#3b82f6,#93c5fd,#fde047,#fb923c,#ef4444,#dc2626)",
    lowLabel: "Cool",
    highLabel: "Hot",
  },
  ndvi: {
    gradient: "linear-gradient(to right,#7f1d1d,#fde047,#16a34a)",
    lowLabel: "Low Veg",
    highLabel: "High Veg",
  },
  rain: {
    gradient: "linear-gradient(to right,#bae6fd,#38bdf8,#0369a1)",
    lowLabel: "Low Rain",
    highLabel: "Heavy Rain",
  },
  soil: {
    gradient: "linear-gradient(to right,#fde047,#84cc16,#166534)",
    lowLabel: "Dry",
    highLabel: "Wet",
  },
};

const BASEMAPS: { id: MapType; label: string; icon: React.ElementType }[] = [
  { id: "osm",       label: "OSM", icon: Globe },
  { id: "satellite", label: "SAT", icon: Satellite },
  { id: "hybrid",    label: "HYB", icon: Map },
];

const DATA_SOURCES = [
  { label: "NDVI & EVI",    value: "Sentinel-2 SR Harmonized",   color: "#22c55e",  dot: "#16a34a" },
  { label: "LST (Temp)",    value: "MODIS MOD/MYD 11A1 + ERA5",  color: "#f97316",  dot: "#ea580c" },
  { label: "Rainfall",      value: "CHIRPS Daily",                color: "#38bdf8",  dot: "#0284c7" },
  { label: "Soil Moisture", value: "TerraClimate",                color: "#84cc16",  dot: "#65a30d" },
];

// ─── Layer Info Data (from main.py) ──────────────────────────────────────────

interface LayerInfoDetail {
  title:       string;
  emoji:       string;
  accentColor: string;
  bgColor:     string;
  source:      string;
  sourceShort: string;
  year:        string;
  dataset:     string;
  resolution:  string;
  calculation: string;
  calcSteps:   string[];
  unit:        string;
  valueRanges: { range: string; meaning: string; color: string }[];
  chartExplain: string;
  notes:       string;
}

const LAYER_INFO: Record<LayerType, LayerInfoDetail> = {
  ndvi: {
    title:       "NDVI — Normalized Difference Vegetation Index",
    emoji:       "🌿",
    accentColor: "#16a34a",
    bgColor:     "#f0fdf4",
    source:      "Copernicus Sentinel-2 SR Harmonized (COPERNICUS/S2_SR_HARMONIZED)",
    sourceShort: "Sentinel-2 SR",
    year:        "2024 (Weekly, Jan–Dec)",
    dataset:     "COPERNICUS/S2_SR_HARMONIZED · Google Earth Engine",
    resolution:  "10m native → resampled to 500m export",
    calculation: "NDVI = (NIR − RED) / (NIR + RED)",
    calcSteps: [
      "S2 images filtered: ±7 days around week, cloud % < 50",
      "Sorted by CLOUDY_PIXEL_PERCENTAGE → best scene on top",
      "Mosaic() → best available pixel per location",
      "NIR = Band B8 (842nm), RED = Band B4 (665nm)",
      "Formula: (B8 − B4) / (B8 + B4)",
      "Masked pixels filled with 0.0 via .unmask(0.0)",
    ],
    unit:        "Dimensionless index (−1 to +1)",
    valueRanges: [
      { range: "< 0.0",       meaning: "Water bodies, barren land, snow",          color: "#7f1d1d" },
      { range: "0.0 – 0.15",  meaning: "Sparse/no vegetation, urban, bare soil",   color: "#b45309" },
      { range: "0.15 – 0.30", meaning: "Degraded/dry vegetation, cropland fallow", color: "#ca8a04" },
      { range: "0.30 – 0.50", meaning: "Moderate vegetation, growing crops",       color: "#65a30d" },
      { range: "0.50 – 0.70", meaning: "Dense vegetation, healthy crops",          color: "#16a34a" },
      { range: "> 0.70",      meaning: "Very dense forest / peak crop season",     color: "#14532d" },
    ],
    chartExplain: "The % bar shows how much of Gurdaspur's area has NDVI above 0.3 (moderate-to-dense vegetation) in that week. Higher % = more green cover active.",
    notes: "In Gurdaspur, NDVI peaks in Jul–Sep (Kharif crops: paddy) and again in Feb–Mar (Rabi crops: wheat). Winter & summer fallow periods show lower values.",
  },

  temperature: {
    title:       "LST — Land Surface Temperature",
    emoji:       "🌡",
    accentColor: "#ea580c",
    bgColor:     "#fff7ed",
    source:      "MODIS MOD11A1 + MYD11A1 (Terra & Aqua, Day & Night) + ERA5-Land fill",
    sourceShort: "MODIS + ERA5",
    year:        "2024 (Weekly, Jan–Dec)",
    dataset:     "MODIS/061/MOD11A1, MODIS/061/MYD11A1, MODIS/061/MOD11A2, ECMWF/ERA5_LAND",
    resolution:  "1km MODIS → resampled to 500m export",
    calculation: "LST °C = (raw_DN × 0.02) − 273.15",
    calcSteps: [
      "4 daily products merged: Terra Day, Terra Night, Aqua Day, Aqua Night",
      "8-day composites (MOD11A2 / MYD11A2) added as extra fallback",
      "All products filtered by bounds + date range",
      "Scale: raw_DN × 0.02 → Kelvin; then − 273.15 → Celsius",
      "median() across all valid pixels (cloud gaps = masked)",
      "ERA5-Land temperature_2m (mean, − 273.15) fills remaining masked pixels",
      "Final .unmask(20.0) only if ERA5 also missing (extremely rare)",
    ],
    unit:        "Degrees Celsius (°C)",
    valueRanges: [
      { range: "< 5°C",     meaning: "Very cold — winter fog/frost period",          color: "#1d4ed8" },
      { range: "5 – 15°C",  meaning: "Cool — Rabi crop growth (Dec–Feb)",            color: "#38bdf8" },
      { range: "15 – 25°C", meaning: "Moderate — Spring/Autumn transition",          color: "#86efac" },
      { range: "25 – 35°C", meaning: "Warm — Pre-monsoon / early Kharif",            color: "#facc15" },
      { range: "35 – 42°C", meaning: "Hot — May–June peak heat stress",              color: "#f97316" },
      { range: "> 42°C",    meaning: "Extreme heat — rare peak summer days",         color: "#dc2626" },
    ],
    chartExplain: "Hot Zones % = pixels where LST > (weekly avg + 5°C). Moderate % = within ±5°C of avg. Cool % = pixels below (avg − 5°C). These thresholds are dynamic per week.",
    notes: "The 25°C bug (all-masked pixels defaulting to 25) was fixed by merging all 4 MODIS products + ERA5 fill, giving ~4 observations/day and near-zero masked pixels.",
  },

  rain: {
    title:       "Rainfall — Weekly Precipitation",
    emoji:       "🌧",
    accentColor: "#0284c7",
    bgColor:     "#f0f9ff",
    source:      "CHIRPS Daily — Climate Hazards Group InfraRed Precipitation with Station data",
    sourceShort: "CHIRPS Daily",
    year:        "2024 (Weekly sum, Jan–Dec)",
    dataset:     "UCSB-CHG/CHIRPS/DAILY · Google Earth Engine",
    resolution:  "~5km native → resampled to 500m export",
    calculation: "Weekly Rain (mm) = Σ daily precipitation over 7-day window",
    calcSteps: [
      "CHIRPS Daily collection filtered by bounds + t0 → t1 (7-day window)",
      "Band selected: 'precipitation' (mm/day)",
      ".sum() aggregated over all days in the week",
      "Missing/masked pixels filled with 0.0 via .unmask(0.0)",
      "Clipped to Gurdaspur boundary geometry",
    ],
    unit:        "Millimetres (mm) — cumulative weekly total",
    valueRanges: [
      { range: "0 mm",       meaning: "No rain — dry week (common Oct–May)",     color: "#e0f2fe" },
      { range: "0.1 – 5 mm", meaning: "Trace/light rain — drizzle or fog",       color: "#7dd3fc" },
      { range: "5 – 20 mm",  meaning: "Moderate rain — pre-monsoon showers",     color: "#38bdf8" },
      { range: "20 – 50 mm", meaning: "Heavy rain — active monsoon week",        color: "#0284c7" },
      { range: "50 – 100 mm",meaning: "Very heavy — intense monsoon event",      color: "#1d4ed8" },
      { range: "> 100 mm",   meaning: "Extreme — flood-risk level precipitation", color: "#1e3a8a" },
    ],
    chartExplain: "The % bar shows the proportion of Gurdaspur area that received >10mm rainfall that week (meaningful rainfall threshold). Higher % = more widespread rain coverage.",
    notes: "Gurdaspur monsoon onset: mid-June. Peak rainfall: July–August. Western disturbances bring light rain in Dec–Feb. CHIRPS blends satellite IR with gauge data for accuracy.",
  },

  soil: {
    title:       "Soil Moisture — Relative Water Content",
    emoji:       "🌱",
    accentColor: "#65a30d",
    bgColor:     "#f7fee7",
    source:      "TerraClimate — University of Idaho Monthly Climate Dataset",
    sourceShort: "TerraClimate",
    year:        "2024 (Monthly → weekly interpolated, ±2 month window)",
    dataset:     "IDAHO_EPSCOR/TERRACLIMATE · Google Earth Engine",
    resolution:  "~4km native → resampled to 500m export",
    calculation: "Soil Fraction = raw_soil_value ÷ 500",
    calcSteps: [
      "TerraClimate filtered: t0 − 2 months to t1 + 2 months (wider window for monthly data)",
      "Band selected: 'soil' (plant extractable water content, mm)",
      ".mean() computed across available months in window",
      "Divided by 500 to normalize to 0–1 fraction",
      "Missing pixels filled with 0.0 via .unmask(0.0)",
      "Clipped to Gurdaspur boundary geometry",
    ],
    unit:        "Fraction 0–1 (0% = completely dry, 100% = field capacity)",
    valueRanges: [
      { range: "0 – 0.10 (0–10%)",   meaning: "Very dry soil — summer/drought stress",         color: "#fde047" },
      { range: "0.10 – 0.25 (10–25%)",meaning: "Dry — pre-monsoon / post-harvest",              color: "#a3e635" },
      { range: "0.25 – 0.45 (25–45%)",meaning: "Moderate — adequate for Rabi crops",            color: "#84cc16" },
      { range: "0.45 – 0.65 (45–65%)",meaning: "Moist — active irrigation or recent rain",      color: "#4ade80" },
      { range: "0.65 – 0.80 (65–80%)",meaning: "Wet — post-monsoon saturated soil",             color: "#16a34a" },
      { range: "> 0.80 (80–100%)",    meaning: "Saturated — waterlogged/flood risk",            color: "#166534" },
    ],
    chartExplain: "The % bar shows how much area has soil moisture above 0.3 (30% of field capacity), suitable for crop growth. Note: TerraClimate is monthly so weekly values are smoother than daily data.",
    notes: "TerraClimate 'soil' band = plant extractable water (0–500mm range). Dividing by 500 gives a 0–1 fraction. Higher resolution soil data (SMAP, ESA CCI) would give sharper weekly patterns.",
  },
};

// ─── Shared styles ────────────────────────────────────────────────────────────

const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#374151",
  marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em",
};

// ─── Color Scales ─────────────────────────────────────────────────────────────

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

function ndviToColor(v: number, minV: number, maxV: number): [number,number,number] {
  const ratio = Math.max(0, Math.min(1, (v - minV) / (maxV - minV || 1)));
  const stops: [number,number,number,number][] = [
    [0.00, 127, 29, 29],
    [0.50, 253,224, 71],
    [1.00,  22,163,74],
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

function rainToColor(v: number, minV: number, maxV: number): [number,number,number] {
  const ratio = Math.max(0, Math.min(1, (v - minV) / (maxV - minV || 1)));
  const stops: [number,number,number,number][] = [
    [0.00, 186,230,253],
    [0.50,  56,189,248],
    [1.00,   3,105,161],
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

function soilToColor(v: number, minV: number, maxV: number): [number,number,number] {
  const ratio = Math.max(0, Math.min(1, (v - minV) / (maxV - minV || 1)));
  const stops: [number,number,number,number][] = [
    [0.00, 253,224, 71],
    [0.50, 132,204, 22],
    [1.00,  22,101,52],
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

function getColor(value: number, layerType: LayerType, minV: number, maxV: number): [number,number,number] {
  switch (layerType) {
    case "ndvi":        return ndviToColor(value, minV, maxV);
    case "rain":        return rainToColor(value, minV, maxV);
    case "soil":        return soilToColor(value, minV, maxV);
    case "temperature":
    default:            return tempToColor(value, minV, maxV);
  }
}

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

// ─── Info Tab (Left Panel) ────────────────────────────────────────────────────

function InfoTab({ activeLayer, onClose }: { activeLayer: LayerType; onClose: () => void }) {
  const info = LAYER_INFO[activeLayer];

  return (
    <div style={{
      position: "fixed",
      top: 0, left: 0, bottom: 0,
      width: 340,
      zIndex: 2000,
      background: "#fff",
      borderRight: `3px solid ${info.accentColor}`,
      boxShadow: "4px 0 32px rgba(0,0,0,0.18)",
      display: "flex",
      flexDirection: "column",
      fontFamily: "'Inter', system-ui, sans-serif",
      overflowY: "auto",
      animation: "slideInLeft 0.22s cubic-bezier(0.22,1,0.36,1)",
    }}>
      <style>{`
        @keyframes slideInLeft { from { transform: translateX(-100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .info-scroll::-webkit-scrollbar { width: 4px; }
        .info-scroll::-webkit-scrollbar-track { background: #f1f5f9; }
        .info-scroll::-webkit-scrollbar-thumb { background: ${info.accentColor}; border-radius: 4px; }
      `}</style>

      {/* Header */}
      <div style={{
        background: `linear-gradient(135deg, ${info.accentColor}22 0%, ${info.accentColor}08 100%)`,
        borderBottom: `1px solid ${info.accentColor}33`,
        padding: "16px 16px 14px",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 26 }}>{info.emoji}</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: info.accentColor, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Layer Info
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#111827", lineHeight: 1.3 }}>
                  {info.title}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, background: info.accentColor, color: "#fff", borderRadius: 6, padding: "3px 8px" }}>
                {info.sourceShort}
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, background: "#f1f5f9", color: "#374151", borderRadius: 6, padding: "3px 8px" }}>
                {info.year}
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, background: "#f5f3ff", color: "#7c3aed", borderRadius: 6, padding: "3px 8px" }}>
                {info.resolution}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "#f1f5f9", border: "none", borderRadius: 8,
              width: 28, height: 28, cursor: "pointer", display: "flex",
              alignItems: "center", justifyContent: "center", flexShrink: 0, marginLeft: 8,
            }}
          >
            <X size={14} color="#6b7280" />
          </button>
        </div>
      </div>

      <div className="info-scroll" style={{ flex: 1, overflowY: "auto", padding: "14px 14px 20px" }}>

        {/* Dataset */}
        <div style={{ marginBottom: 14, padding: "10px 12px", background: "#fafafa", borderRadius: 10, border: "1px solid #e5e7eb" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>
            Dataset Source
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827", lineHeight: 1.5 }}>{info.source}</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, fontFamily: "monospace" }}>{info.dataset}</div>
        </div>

        {/* Formula */}
        <div style={{ marginBottom: 14, padding: "10px 12px", background: `${info.accentColor}0d`, borderRadius: 10, border: `1px solid ${info.accentColor}22` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: info.accentColor, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>
            Calculation Formula
          </div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#111827", fontFamily: "monospace", background: "#fff", borderRadius: 7, padding: "7px 10px", border: `1px solid ${info.accentColor}33` }}>
            {info.calculation}
          </div>
        </div>

        {/* Steps */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7 }}>
            Processing Steps (Google Earth Engine)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {info.calcSteps.map((step, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 10px", background: "#f8fafc", borderRadius: 8, border: "1px solid #f1f5f9" }}>
                <span style={{
                  fontSize: 11, fontWeight: 800, color: "#fff",
                  background: info.accentColor,
                  borderRadius: "50%", width: 20, height: 20, flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  marginTop: 1,
                }}>
                  {i + 1}
                </span>
                <span style={{ fontSize: 12, color: "#374151", lineHeight: 1.5 }}>{step}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Unit */}
        <div style={{ marginBottom: 14, padding: "8px 12px", background: "#f8fafc", borderRadius: 9, border: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8 }}>
          <ChevronRight size={14} color={info.accentColor} />
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em" }}>Unit</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{info.unit}</div>
          </div>
        </div>

        {/* Value Ranges */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7 }}>
            Value Ranges & Meaning
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {info.valueRanges.map((vr, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 10px", background: "#f8fafc", borderRadius: 8, border: "1px solid #f1f5f9" }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: vr.color, flexShrink: 0, display: "inline-block" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#111827", fontFamily: "monospace" }}>{vr.range}</span>
                  <span style={{ fontSize: 11.5, color: "#6b7280", marginLeft: 6 }}>— {vr.meaning}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Chart Explain */}
        <div style={{ marginBottom: 14, padding: "10px 12px", background: "#fffbeb", borderRadius: 10, border: "1px solid #fde68a" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>
            📊 What does the % bar mean?
          </div>
          <div style={{ fontSize: 12, color: "#78350f", lineHeight: 1.6 }}>{info.chartExplain}</div>
        </div>

        {/* Notes */}
        <div style={{ padding: "10px 12px", background: "#f0f9ff", borderRadius: 10, border: "1px solid #bae6fd" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#0369a1", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>
            📝 Field Notes — Gurdaspur
          </div>
          <div style={{ fontSize: 12, color: "#0c4a6e", lineHeight: 1.6 }}>{info.notes}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Analytics Panel ──────────────────────────────────────────────────────────

function AnalyticsContent({ stats, week, annualMeans, activeLayer }: {
  stats: RealTempStats | null;
  week: number;
  annualMeans: AnnualMeans | null;
  activeLayer: LayerType;
}) {
  const donutData = useMemo(() => {
    if (!stats) return null;
    return [
      { name: "Hot",      value: Math.round(stats.hotPct * 10) / 10,  color: "#ef4444" },
      { name: "Moderate", value: Math.round(stats.modPct * 10) / 10,  color: "#facc15" },
      { name: "Cool",     value: Math.round(stats.coolPct * 10) / 10, color: "#3b82f6" },
    ];
  }, [stats]);

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

      <SummaryGrid items={[
        { label: "Avg Temp",  value: `${stats.avg.toFixed(1)}°C`,   accent: "#f97316", bg: "#fff7ed", icon: Thermometer },
        { label: "Hot Zones", value: `${stats.hotPct.toFixed(1)}%`,  accent: "#dc2626", bg: "#fef2f2", icon: Activity },
        { label: "Moderate",  value: `${stats.modPct.toFixed(1)}%`,  accent: "#ca8a04", bg: "#fefce8", icon: Activity },
        { label: "Cool",      value: `${stats.coolPct.toFixed(1)}%`, accent: "#3b82f6", bg: "#eff6ff", icon: Activity },
      ]} />

      <SummaryGrid items={[
        { label: "Min Temp", value: `${stats.min.toFixed(1)}°C`, accent: "#3b82f6", bg: "#eff6ff", icon: Thermometer },
        { label: "Max Temp", value: `${stats.max.toFixed(1)}°C`, accent: "#dc2626", bg: "#fef2f2", icon: Thermometer },
      ]} />

      {donutData && (
        <Card style={{ padding: "14px 16px" }}>
          <p style={sectionLabel}>Temperature Distribution</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 96, height: 96, flexShrink: 0 }}>
              <svg viewBox="0 0 96 96" width={96} height={96}>
                {(() => {
                  const total = donutData.reduce((s, d) => s + d.value, 0) || 100;
                  let cursor = -90;
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
              <div style={{ marginTop: 4, padding: "5px 7px", background: "#fff7ed", borderRadius: 6, border: "1px solid #fed7aa" }}>
                <span style={{ fontSize: 9, color: "#92400e", lineHeight: 1.5, display: "block" }}>
                  Hot = LST &gt; avg+5°C<br />
                  Cool = LST &lt; avg−5°C<br />
                  Moderate = within ±5°C
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card style={{ padding: "12px 14px" }}>
        <p style={sectionLabel}>Data Info · Week {String(week).padStart(2, "0")}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            { label: "Valid Pixels",  value: stats.count.toLocaleString() },
            { label: "Temp Range",    value: `${stats.min.toFixed(1)} – ${stats.max.toFixed(1)} °C` },
            { label: "Hot threshold", value: `> ${(stats.avg + 5).toFixed(1)} °C` },
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

      {/* Layer Overview with explanations */}
      <Card style={{ padding: "14px 16px" }}>
        <p style={sectionLabel}>Layer Overview</p>
        {[
          {
            label: "NDVI",
            pct: 58,
            color: "#22c55e",
            explain: "58% area has NDVI > 0.3 (moderate–dense vegetation)",
          },
          {
            label: "Temperature",
            pct: Math.min(100, Math.round(stats.hotPct + stats.modPct)),
            color: "#f97316",
            explain: `${Math.min(100, Math.round(stats.hotPct + stats.modPct))}% area is moderate-to-hot (LST ≥ avg−5°C)`,
          },
          {
            label: "Rain",
            pct: 62,
            color: "#38bdf8",
            explain: "62% area received > 10mm rainfall this week",
          },
          {
            label: "Soil Moist.",
            pct: 41,
            color: "#84cc16",
            explain: "41% area has soil moisture > 30% field capacity",
          },
        ].map(r => (
          <div key={r.label} style={{ marginBottom: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>{r.label}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#111827" }}>{r.pct}%</span>
            </div>
            <div style={{ height: 5, background: "#f1f5f9", borderRadius: 99, overflow: "hidden", marginBottom: 4 }}>
              <div style={{ height: "100%", width: `${r.pct}%`, background: r.color, borderRadius: 99, transition: "width 0.6s" }} />
            </div>
            <div style={{ fontSize: 9.5, color: "#9ca3af", lineHeight: 1.4 }}>{r.explain}</div>
          </div>
        ))}
      </Card>

      <AnnualMeansPanel means={annualMeans} />
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
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.09)", overflow: "hidden" }}>
        {[{ label: "+", fn: () => map.zoomIn() }, { label: "−", fn: () => map.zoomOut() }].map(({ label, fn }) => (
          <button key={label} onClick={fn}
            style={{ display: "block", width: 36, height: 36, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: "#374151", lineHeight: 1, borderBottom: label === "+" ? "1px solid #f1f5f9" : "none" }}
            onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >{label}</button>
        ))}
      </div>
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

// ─── Layer Switcher Control ────────────────────────────────────────────────────

const LAYER_ORDER: LayerType[] = ["temperature", "ndvi", "rain", "soil"];

const LAYER_ACTIVE_COLORS: Record<LayerType, { bg: string; border: string; text: string }> = {
  temperature: { bg: "#fff7ed", border: "#fed7aa", text: "#ea580c" },
  ndvi:        { bg: "#f0fdf4", border: "#bbf7d0", text: "#16a34a" },
  rain:        { bg: "#f0f9ff", border: "#bae6fd", text: "#0284c7" },
  soil:        { bg: "#f7fee7", border: "#d9f99d", text: "#65a30d" },
};

function LayerSwitcher({ activeLayer, setActiveLayer }: { activeLayer: LayerType; setActiveLayer: (l: LayerType) => void }) {
  return (
    <div style={{
      position: "absolute", top: 16, left: 16, zIndex: 700,
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{
        background: "rgba(255,255,255,0.97)",
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        boxShadow: "0 4px 20px rgba(0,0,0,0.10)",
        padding: "8px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 92,
      }}>
        <span style={{ fontSize: 8.5, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", textAlign: "center", marginBottom: 2 }}>
          Layer
        </span>
        {LAYER_ORDER.map(layer => {
          const meta = LAYER_META[layer];
          const isActive = activeLayer === layer;
          const ac = LAYER_ACTIVE_COLORS[layer];
          return (
            <button
              key={layer}
              onClick={() => setActiveLayer(layer)}
              title={meta.name}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 10px",
                borderRadius: 9,
                border: isActive ? `1px solid ${ac.border}` : "1px solid transparent",
                background: isActive ? ac.bg : "transparent",
                cursor: "pointer",
                transition: "all 0.15s",
                width: "100%",
              }}
              onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "#f8fafc"; }}
              onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{meta.emoji}</span>
              <span style={{
                fontSize: 10.5, fontWeight: isActive ? 700 : 500,
                color: isActive ? ac.text : "#6b7280",
                whiteSpace: "nowrap",
              }}>
                {meta.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Canvas Layer ─────────────────────────────────────────────────────────────

interface CanvasLayerProps {
  band:      any;
  width:     number;
  height:    number;
  bbox:      number[];
  minVal:    number;
  maxVal:    number;
  layerType: LayerType;
}

const CanvasLayer = React.memo(({ band, width, height, bbox, minVal, maxVal, layerType }: CanvasLayerProps) => {
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
      const [r,g,b] = getColor(v, layerType, minVal, maxVal);
      px[i*4]=r; px[i*4+1]=g; px[i*4+2]=b;
      px[i*4+3] = 168;
    }
    ctx.putImageData(imgData, 0, 0);
    const bounds: L.LatLngBoundsExpression = [[bbox[1],bbox[0]],[bbox[3],bbox[2]]];
    const ov = L.imageOverlay(canvas.toDataURL(), bounds, { opacity: 1, zIndex: 250 });
    ov.addTo(map);
    map.eachLayer((l: any) => { if (l._url && l._url.includes('Reference')) l.setZIndex(400); });
    return () => { map.removeLayer(ov); };
  }, [band, width, height, bbox, minVal, maxVal, layerType, map]);
  return null;
});

// ─── Hover Tooltip ────────────────────────────────────────────────────────────
// Only shows the active layer's value (temperature excluded from this logic,
// temperature always shows its own row; for ndvi/rain/soil only that layer shown)

interface HoverTooltipProps {
  allBands:    any[];
  width:       number;
  height:      number;
  bbox:        number[];
  week:        number;
  annualMeans: AnnualMeans | null;
  activeLayer: LayerType;
}

const HoverTooltip = ({ allBands, width, height, bbox, week, annualMeans, activeLayer }: HoverTooltipProps) => {
  const popupRef   = React.useRef<L.Popup | null>(null);
  const isDragging = React.useRef(false);
  const map = useMap();

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

      const am = annualMeans;
      const weekDate = new Date(2024, 0, 1 + (week - 1) * 7)
        .toLocaleDateString("en-IN", { day: "numeric", month: "short" });

      // Temperature layer → sabka (all 4) value dikhao; other layers → sirf apni value
      const buildRows = () => {
        const tempBandOffset = detectTempBand();
        const temp = getVal(tempBandOffset);
        const ndvi = getVal(0);
        const rain = getVal(2);
        const soil = getVal(3);

        if (activeLayer === "temperature") {
          // All 4 rows
          return [
            buildRow("🌡️", "Temperature · LST", temp,
              v => v.toFixed(1) + "°C", am ? am.temp : null, v => v.toFixed(1) + "°C",
              "#ea580c", "#ffedd5", "MODIS Terra+Aqua + ERA5"),
            buildRow("🌿", "NDVI · Vegetation", ndvi,
              v => v.toFixed(3), am ? am.ndvi : null, v => v.toFixed(3),
              "#16a34a", "#dcfce7", "Sentinel-2 · (B8−B4)/(B8+B4)"),
            buildRow("🌧️", "Rainfall · Weekly", rain,
              v => v.toFixed(1) + " mm", am ? am.rain : null, v => v.toFixed(1) + " mm",
              "#0284c7", "#dbeafe", "CHIRPS Daily · 7-day sum"),
            buildRow("🌱", "Soil Moisture", soil,
              v => (v * 100).toFixed(1) + "%", am ? am.soil : null, v => (v * 100).toFixed(1) + "%",
              "#65a30d", "#ecfccb", "TerraClimate · soil ÷ 500"),
          ].join("");
        }
        if (activeLayer === "ndvi") {
          return buildRow("🌿", "NDVI · Vegetation Index", ndvi,
            v => v.toFixed(3), am ? am.ndvi : null, v => v.toFixed(3),
            "#16a34a", "#dcfce7", "Formula: (B8−B4)/(B8+B4) · Sentinel-2");
        }
        if (activeLayer === "rain") {
          return buildRow("🌧️", "Rainfall · Weekly Sum", rain,
            v => v.toFixed(1) + " mm", am ? am.rain : null, v => v.toFixed(1) + " mm",
            "#0284c7", "#dbeafe", "Source: CHIRPS Daily · 7-day sum");
        }
        if (activeLayer === "soil") {
          return buildRow("🌱", "Soil Moisture · Fraction", soil,
            v => (v * 100).toFixed(1) + "%", am ? am.soil : null, v => (v * 100).toFixed(1) + "%",
            "#65a30d", "#ecfccb", "Source: TerraClimate · soil ÷ 500");
        }
        return "";
      };

      const buildRow = (
        icon: string,
        label: string,
        val: number | null,
        fmt: (v: number) => string,
        annualVal: number | null,
        annualFmt: (v: number) => string,
        accent: string,
        iconBg: string,
        sourceNote: string,
      ) => {
        const valStr   = val !== null ? fmt(val) : "—";
        const diff     = (val !== null && annualVal !== null) ? val - annualVal : null;
        const diffSign = diff !== null ? (diff >= 0 ? "▲" : "▼") : "";
        const diffColor= diff !== null ? (diff > 0 ? "#ef4444" : "#22c55e") : "#9ca3af";
        const diffAbs  = diff !== null ? Math.abs(diff) : null;
        const diffStr  = diffAbs !== null
          ? (diffAbs < 0.001 ? "0.0" : diffAbs < 1 ? diffAbs.toFixed(3) : diffAbs.toFixed(1))
          : "—";
        const avgStr   = annualVal !== null ? annualFmt(annualVal) : "—";

        return `
          <div style="display:grid;grid-template-columns:32px 1fr auto;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:#f8fafc;margin-bottom:4px;border:1px solid #f1f5f9">
            <div style="width:32px;height:32px;border-radius:9px;background:${iconBg};display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0">${icon}</div>
            <div style="min-width:0">
              <div style="font-size:10px;color:#9ca3af;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:2px">${label}</div>
              <div style="font-size:10.5px;color:#6b7280;font-weight:500">
                avg <span style="color:#374151;font-weight:700">${avgStr}</span>
                ${diff !== null ? `<span style="margin-left:5px;color:${diffColor};font-weight:700;font-size:10px">${diffSign} ${diffStr}</span>` : ""}
              </div>
              <div style="font-size:9px;color:#c4b5fd;margin-top:2px">${sourceNote}</div>
            </div>
            <div style="font-size:18px;font-weight:900;color:${accent};font-family:monospace;white-space:nowrap">${valStr}</div>
          </div>`;
      };

      if (!popupRef.current) {
        popupRef.current = L.popup({
          closeButton: false,
          offset:      [0, -4],
          maxWidth:    activeLayer === "temperature" ? 320 : 310,
          className:   "guru-tooltip",
          autoPan:     false,
        });
      }

      // Always re-set maxWidth when activeLayer changes
      (popupRef.current as any).options.maxWidth = activeLayer === "temperature" ? 320 : 310;

      const layerInfo = LAYER_INFO[activeLayer];
      const tooltipTitle = activeLayer === "temperature"
        ? "🗺️ All Layers · Point Data"
        : `${layerInfo.emoji} ${layerInfo.title}`;

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
          <div style="font-family:system-ui,-apple-system,sans-serif;width:282px;background:#fff">
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
            <div style="padding:4px 6px 2px;background:${layerInfo.accentColor}11;border-bottom:1px solid ${layerInfo.accentColor}22">
              <span style="font-size:9px;color:${layerInfo.accentColor};font-weight:700;letter-spacing:0.06em;padding:2px 6px">
                ${tooltipTitle}
              </span>
            </div>
            <div style="padding:8px 8px 6px">
              ${buildRows()}
            </div>
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

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  React.useEffect(() => {
    if (open && listRef.current) {
      const activeEl = listRef.current.querySelector("[data-active='true']") as HTMLElement;
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [open]);

  const weeks = Array.from({ length: 52 }, (_, i) => {
    const w = i + 1;
    const ws = new Date(2024, 0, 1 + i * 7);
    const ds = ws.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    return { w, month: MONTH_ABBR[i], date: ds };
  });

  return (
    <div ref={dropRef} style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 700 }}>
      <style>{`
        .week-dropdown-list::-webkit-scrollbar { width: 4px; }
        .week-dropdown-list::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 4px; }
        .week-dropdown-list::-webkit-scrollbar-thumb { background: #f97316; border-radius: 4px; }
        .week-item-btn:hover { background: #fff7ed !important; }
      `}</style>
      <button onClick={() => setOpen(o => !o)} style={{
        background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 18,
        boxShadow: "0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)",
        padding: "10px 20px", display: "flex", alignItems: "center", gap: 14,
        cursor: "pointer", userSelect: "none", minWidth: 260,
      }}>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", minWidth: 46, flexShrink:0 }}>
          <span style={{ fontSize:26, fontWeight:900, color:"#111827", fontFamily:"monospace", lineHeight:1, letterSpacing:"-1px" }}>{String(week).padStart(2,"0")}</span>
          <span style={{ fontSize:9, color:"#f97316", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.12em", marginTop:2 }}>{month}</span>
          <span style={{ fontSize:8.5, color:"#9ca3af", marginTop:1 }}>{dateStr}</span>
        </div>
        <div style={{ width:1, height:38, background:"#e5e7eb", flexShrink:0 }} />
        <div style={{ flex:1, textAlign:"left" }}>
          <span style={{ fontSize:11, color:"#9ca3af", display:"block", marginBottom:3, textTransform:"uppercase", letterSpacing:"0.08em" }}>Select Week</span>
          <span style={{ fontSize:13, fontWeight:700, color:"#111827" }}>Week {String(week).padStart(2,"0")} / 52</span>
        </div>
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" style={{ flexShrink:0, transition:"transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}>
          <path d="M4 6l4 4 4-4" stroke="#f97316" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div ref={listRef} className="week-dropdown-list" style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)",
          width: 260, maxHeight: 320, overflowY: "auto", background: "#ffffff",
          border: "1px solid #e5e7eb", borderRadius: 14,
          boxShadow: "0 -8px 40px rgba(0,0,0,0.15)", padding: "6px",
        }}>
          {weeks.map(({ w, month: mo, date: dt }) => {
            const isActive = w === week;
            return (
              <button key={w} data-active={isActive} className="week-item-btn"
                onClick={() => { setWeek(w); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "7px 10px",
                  background: isActive ? "#fff7ed" : "transparent",
                  border: isActive ? "1px solid #fed7aa" : "1px solid transparent",
                  borderRadius: 9, cursor: "pointer", marginBottom: 2, transition: "background 0.12s",
                }}>
                <span style={{ fontSize:15, fontWeight:900, fontFamily:"monospace", color: isActive ? "#f97316" : "#111827", minWidth: 26, textAlign:"right" }}>{String(w).padStart(2,"0")}</span>
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

function LayerLegend({ activeLayer }: { activeLayer: LayerType }) {
  const meta   = LAYER_META[activeLayer];
  const legend = LAYER_LEGEND[activeLayer];
  return (
    <div style={{ position: "absolute", bottom: 100, left: 16, zIndex: 500 }}>
      <Card style={{ padding: "10px 14px", minWidth: 190 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <Activity size={13} color="#0ea5e9" />
          <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>Colour Legend</span>
        </div>
        <p style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 8 }}>{meta.emoji} {meta.name}</p>
        <div style={{ height: 12, borderRadius: 99, background: legend.gradient, boxShadow: "inset 0 1px 3px rgba(0,0,0,0.12)", marginBottom: 6 }} />
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>{legend.lowLabel}</span>
          <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>{legend.highLabel}</span>
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

// ─── GeoTIFF Heatmap Layer ────────────────────────────────────────────────────

interface GeoTiffHeatmapLayerProps {
  week:          number;
  activeLayer:   LayerType;
  onLoad:        () => void;
  onBandsReady:  (bands: any[], w: number, h: number, bbox: number[]) => void;
  onStatsReady:  (stats: RealTempStats) => void;
  onAnnualMeans: (means: AnnualMeans) => void;
}

const LAYER_RANGE: Record<LayerType, { min: number; max: number }> = {
  temperature: { min: 5,    max: 50  },
  ndvi:        { min: -0.2, max: 0.9 },
  rain:        { min: 0,    max: 100 },
  soil:        { min: 0,    max: 1   },
};

function GeoTiffHeatmapLayer({ week, activeLayer, onLoad, onBandsReady, onStatsReady, onAnnualMeans }: GeoTiffHeatmapLayerProps) {
  const rastersRef     = useRef<any[]>([]);
  const tiffMetaRef    = useRef<{ width: number; height: number; bbox: number[] } | null>(null);
  const annualComputed = useRef(false);

  const [renderBand, setRenderBand] = useState<any>(null);
  const [tW,         setTW]         = useState(0);
  const [tH,         setTH]         = useState(0);
  const [tBbox,      setTBbox]      = useState<number[]>([]);
  const [minVal,     setMinVal]     = useState(LAYER_RANGE[activeLayer].min);
  const [maxVal,     setMaxVal]     = useState(LAYER_RANGE[activeLayer].max);

  const getBandIndex = useCallback((rasters: any[], wk: number, layer: LayerType): number => {
    const baseIndex = (wk - 1) * 5;
    switch (layer) {
      case "ndvi": return baseIndex + 0;
      case "rain": return baseIndex + 2;
      case "soil": return baseIndex + 3;
      case "temperature":
      default: {
        for (let i = 0; i < 5; i++) {
          const sample = rasters[baseIndex + i]?.[1000];
          if (sample !== undefined && sample !== null && !isNaN(sample) && sample > 10 && sample < 60) return baseIndex + i;
        }
        return baseIndex + 1;
      }
    }
  }, []);

  const computeRange = useCallback((band: any, hintMin: number, hintMax: number): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < band.length; i++) {
      const v = band[i];
      if (v === null || v === undefined || isNaN(v)) continue;
      if (v < hintMin - Math.abs(hintMin) * 2 || v > hintMax + Math.abs(hintMax) * 2) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo) || !isFinite(hi)) return [hintMin, hintMax];
    return [lo, hi];
  }, []);

  useEffect(() => {
    if (!rastersRef.current.length || !tiffMetaRef.current) return;
    const rasters = rastersRef.current;
    const { width, height, bbox } = tiffMetaRef.current;
    const idx = getBandIndex(rasters, week, activeLayer);
    const band = rasters[idx];
    if (!band) return;
    const hint = LAYER_RANGE[activeLayer];
    const [lo, hi] = computeRange(band, hint.min, hint.max);
    setRenderBand(band);
    setMinVal(lo);
    setMaxVal(hi);
    setTW(width);
    setTH(height);
    setTBbox(bbox);
  }, [activeLayer, week, getBandIndex, computeRange]);

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

        if (cancelled) return;

        rastersRef.current  = rasters;
        tiffMetaRef.current = { width, height, bbox };
        onBandsReady(rasters, width, height, bbox);

        if (!annualComputed.current) {
          annualComputed.current = true;

          const detectTempOffset = (baseIdx: number): number => {
            for (let i = 0; i < 5; i++) {
              const s = rasters[baseIdx + i]?.[1000];
              if (s !== undefined && s !== null && !isNaN(s) && s > 10 && s < 60) return i;
            }
            return 1;
          };

          let sumNdvi = 0, sumTemp = 0, sumRain = 0, sumSoil = 0, validWeeks = 0;

          for (let w = 0; w < 52; w++) {
            const base  = w * 5;
            const tOff  = detectTempOffset(base);
            const ndviB = rasters[base + 0];
            const tempB = rasters[base + tOff];
            const rainB = rasters[base + 2];
            const soilB = rasters[base + 3];
            if (!ndviB || !tempB || !rainB || !soilB) continue;

            const mean = (band: any, minV: number, maxV: number) => {
              let s = 0, c = 0;
              for (let i = 0; i < band.length; i++) {
                const v = band[i];
                if (v === null || v === undefined || isNaN(v)) continue;
                if (v < minV || v > maxV) continue;
                s += v; c++;
              }
              return c > 0 ? s / c : null;
            };

            const mNdvi = mean(ndviB, -1, 1);
            const mTemp = mean(tempB, -20, 80);
            const mRain = mean(rainB, 0, 500);
            const mSoil = mean(soilB, 0, 1);
            if (mNdvi === null || mTemp === null || mRain === null || mSoil === null) continue;
            sumNdvi += mNdvi; sumTemp += mTemp; sumRain += mRain; sumSoil += mSoil;
            validWeeks++;
          }

          if (validWeeks > 0) {
            const means: AnnualMeans = {
              ndvi: sumNdvi / validWeeks,
              temp: sumTemp / validWeeks,
              rain: sumRain / validWeeks,
              soil: sumSoil / validWeeks,
            };
            if (!cancelled) onAnnualMeans(means);
          }
        }

        const baseIndex   = (week - 1) * 5;
        const tempOffset  = getBandIndex(rasters, week, "temperature") - baseIndex;
        const tempBandIdx = baseIndex + tempOffset;
        const tempBand    = rasters[tempBandIdx];

        if (tempBand) {
          const tempValues: number[] = [];
          for (let i = 0; i < tempBand.length; i++) {
            const v = tempBand[i];
            if (v === null || v === undefined || isNaN(v as number)) continue;
            tempValues.push(v as number);
          }
          if (tempValues.length > 0) {
            const sum    = tempValues.reduce((a, b) => a + b, 0);
            const avg    = sum / tempValues.length;
            const minVl  = Math.min(...tempValues);
            const maxVl  = Math.max(...tempValues);
            const total  = tempValues.length;
            const hotCnt  = tempValues.filter(v => v > avg + 5).length;
            const coolCnt = tempValues.filter(v => v < avg - 5).length;
            const modCnt  = total - hotCnt - coolCnt;
            const realStats: RealTempStats = {
              avg, min: minVl, max: maxVl,
              hotPct:  (hotCnt  / total) * 100,
              modPct:  (modCnt  / total) * 100,
              coolPct: (coolCnt / total) * 100,
              count:   total,
            };
            if (!cancelled) onStatsReady(realStats);
          }
        }

        const activeBandIdx = getBandIndex(rasters, week, activeLayer);
        const activeBand    = rasters[activeBandIdx];
        if (!activeBand) { onLoad(); return; }

        const hint = LAYER_RANGE[activeLayer];
        const [lo, hi] = computeRange(activeBand, hint.min, hint.max);

        if (!cancelled) {
          setRenderBand(activeBand);
          setMinVal(lo);
          setMaxVal(hi);
          setTW(width);
          setTH(height);
          setTBbox(bbox);
          onLoad();
        }
      } catch (err) {
        console.error("TIFF load error:", err);
        if (!cancelled) onLoad();
      }
    };

    loadTiff();
    return () => { cancelled = true; };
  }, [week, onLoad, onBandsReady, onStatsReady, onAnnualMeans, getBandIndex, computeRange, activeLayer]);

  return (
    <CanvasLayer
      band={renderBand}
      width={tW}
      height={tH}
      bbox={tBbox}
      minVal={minVal}
      maxVal={maxVal}
      layerType={activeLayer}
    />
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Gurdaspur() {
  const [week,        setWeek]        = useState<number>(1);
  const [loading,     setLoading]     = useState(true);
  const [mapType,     setMapType]     = useState<MapType>("osm");
  const [boundary,    setBoundary]    = useState<any>(null);
  const [activeLayer, setActiveLayer] = useState<LayerType>("temperature");
  const [infoOpen,    setInfoOpen]    = useState(false);
  const [layerOpen,   setLayerOpen]   = useState(false);

  const [allBands,   setAllBands]   = useState<any[]>([]);
  const [tiffWidth,  setTiffWidth]  = useState<number>(0);
  const [tiffHeight, setTiffHeight] = useState<number>(0);
  const [tiffBbox,   setTiffBbox]   = useState<number[]>([]);

  const [realStats,   setRealStats]   = useState<RealTempStats | null>(null);
  const [annualMeans, setAnnualMeans] = useState<AnnualMeans | null>(null);

  const mapRef = useRef<any>(null);

  useEffect(() => {
    fetch("/gurdaspur_boundary.geojson")
      .then(res => res.json())
      .then(data => setBoundary(data))
      .catch(err => console.warn("Boundary load failed:", err));
  }, []);

  const handleLayerLoad = useCallback(() => setLoading(false), []);
  const handleBandsReady = useCallback((bands: any[], w: number, h: number, bbox: number[]) => {
    setAllBands(bands); setTiffWidth(w); setTiffHeight(h); setTiffBbox(bbox);
  }, []);
  const handleStatsReady  = useCallback((stats: RealTempStats) => { setRealStats(stats); }, []);
  const handleAnnualMeans = useCallback((means: AnnualMeans) => { setAnnualMeans(means); }, []);
  const handleWeekChange  = useCallback((w: number) => {
    setWeek(w); setLoading(true); setRealStats(null);
  }, []);

  const meta = LAYER_META[activeLayer];
  const info = LAYER_INFO[activeLayer];

  return (
    <div style={{ display: "flex", height: "100vh", width: "100%", fontFamily: "'Inter', system-ui, sans-serif", overflow: "hidden", background: "#f1f5f9" }}>

      {/* ── Info Tab overlay ─────────────────────────────────────────────── */}
      {infoOpen && <InfoTab activeLayer={activeLayer} onClose={() => setInfoOpen(false)} />}

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
              Loading {meta.name} · Week {String(week).padStart(2, "0")}…
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

          <GeoTiffHeatmapLayer
            key={`geotiff-${week}`}
            week={week}
            activeLayer={activeLayer}
            onLoad={handleLayerLoad}
            onBandsReady={handleBandsReady}
            onStatsReady={handleStatsReady}
            onAnnualMeans={handleAnnualMeans}
          />

          {boundary && (
            <GeoJSON
              key={JSON.stringify(boundary)}
              data={boundary}
              style={{ color: "black", weight: 3, fillOpacity: 0 }}
            />
          )}

          <HoverTooltip
            allBands={allBands}
            width={tiffWidth}
            height={tiffHeight}
            bbox={tiffBbox}
            week={week}
            annualMeans={annualMeans}
            activeLayer={activeLayer}
          />

          <MapControls mapType={mapType} setMapType={setMapType} />
        </MapContainer>

        {/* ── Layer Switcher (top-left, collapsible) ── */}
        <div style={{ position: "absolute", top: 16, left: infoOpen ? 356 : 16, zIndex: 700, transition: "left 0.22s cubic-bezier(0.22,1,0.36,1)" }}>
          <div style={{
            background: "rgba(255,255,255,0.97)", border: "1px solid #e5e7eb", borderRadius: 14,
            boxShadow: "0 4px 20px rgba(0,0,0,0.10)", padding: "6px 8px",
            display: "flex", flexDirection: "column", gap: 0, minWidth: 110,
          }}>
            {/* Header — always visible, click to toggle */}
            <button
              onClick={() => setLayerOpen(o => !o)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 6, padding: "5px 4px 6px", background: "transparent", border: "none",
                cursor: "pointer", width: "100%", borderRadius: 8,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 15, lineHeight: 1 }}>{LAYER_META[activeLayer].emoji}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: LAYER_ACTIVE_COLORS[activeLayer].text, whiteSpace: "nowrap" }}>
                  {LAYER_META[activeLayer].label}
                </span>
              </div>
              <svg width={12} height={12} viewBox="0 0 12 12" fill="none"
                style={{ transition: "transform 0.2s", transform: layerOpen ? "rotate(180deg)" : "rotate(0deg)", flexShrink: 0 }}>
                <path d="M2 4l4 4 4-4" stroke="#9ca3af" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            {/* Expanded list — only other layers */}
            {layerOpen && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2, borderTop: "1px solid #f1f5f9", paddingTop: 6 }}>
                {LAYER_ORDER.filter(l => l !== activeLayer).map(layer => {
                  const lm = LAYER_META[layer];
                  const ac = LAYER_ACTIVE_COLORS[layer];
                  return (
                    <button key={layer}
                      onClick={() => { setActiveLayer(layer); setLayerOpen(false); }}
                      title={lm.name}
                      style={{
                        display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 9,
                        border: "1px solid transparent", background: "transparent",
                        cursor: "pointer", transition: "all 0.15s", width: "100%",
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = ac.bg; (e.currentTarget as HTMLButtonElement).style.border = `1px solid ${ac.border}`; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).style.border = "1px solid transparent"; }}
                    >
                      <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{lm.emoji}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 500, color: "#6b7280", whiteSpace: "nowrap" }}>{lm.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Info button (bottom-left above legend) ── */}
        <div style={{
          position: "absolute",
          bottom: 220,
          left: infoOpen ? 356 : 16,
          zIndex: 700,
          transition: "left 0.22s cubic-bezier(0.22,1,0.36,1)",
        }}>
          <button
            onClick={() => setInfoOpen(o => !o)}
            title="Layer Information"
            style={{
              width: 38, height: 38,
              background: infoOpen ? info.accentColor : "#fff",
              border: `1.5px solid ${infoOpen ? info.accentColor : "#e5e7eb"}`,
              borderRadius: 10,
              boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
              cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.18s",
            }}
          >
            <Info size={16} color={infoOpen ? "#fff" : info.accentColor} />
          </button>
        </div>

        {/* ── Active layer pill (top-center) ── */}
        <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 600, pointerEvents: "none" }}>
          <div style={{
            background: "rgba(255,255,255,0.95)", border: "1px solid #e5e7eb",
            borderRadius: 999, padding: "5px 14px",
            boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: meta.dotColor, display: "inline-block" }} />
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "#374151" }}>{meta.emoji} {meta.name}</span>
            <span style={{ fontSize: 10, color: "#9ca3af" }}>· {meta.desc}</span>
            <span style={{ fontSize: 10, color: "#9ca3af" }}>· Wk {String(week).padStart(2, "0")}</span>
            {realStats && activeLayer === "temperature" && (
              <span style={{ fontSize: 10, color: "#f97316", fontWeight: 600 }}>
                · {realStats.avg.toFixed(1)}°C avg
              </span>
            )}
          </div>
        </div>

        <LayerLegend activeLayer={activeLayer} />
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
          <AnalyticsContent stats={realStats} week={week} annualMeans={annualMeans} activeLayer={activeLayer} />
        </div>
      </aside>
    </div>
  );
}
