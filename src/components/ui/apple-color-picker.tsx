"use client";

import { Check, Pipette, Plus, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { SegmentedControl } from "./segmented-control";

type Rgb = { r: number; g: number; b: number };
type Hsv = { h: number; s: number; v: number };
type PickerTab = "Grid" | "Spectrum" | "Sliders";

const PICKER_TABS: PickerTab[] = ["Grid", "Spectrum", "Sliders"];
const MAX_RECENT_COLORS = 8;

const APPLE_GRID_COLORS = [
  "#FFFFFF", "#E5E7EB", "#CBD5E1", "#94A3B8", "#64748B", "#475569", "#1E293B", "#000000",
  "#FEF9C3", "#FFFF66", "#FFFF00", "#FFCC00", "#FDE68A", "#FDBA74", "#FB923C", "#F97316",
  "#FEE2E2", "#FCA5A5", "#F87171", "#EF4444", "#DC2626", "#BE123C", "#FB7185", "#F9A8D4",
  "#DCFCE7", "#BBF7D0", "#86EFAC", "#4ADE80", "#22C55E", "#16A34A", "#14B8A6", "#5EEAD4",
  "#E0F2FE", "#BAE6FD", "#7DD3FC", "#38BDF8", "#0EA5E9", "#3B82F6", "#2563EB", "#1D4ED8",
  "#EDE9FE", "#C4B5FD", "#A78BFA", "#8B5CF6", "#7C3AED", "#A855F7", "#D946EF", "#EC4899",
] as const;

const DEFAULT_RECENT_COLORS = [
  "#FFFF00", "#FFCC00", "#FDBA74", "#FCA5A5", "#86EFAC",
  "#5EEAD4", "#7DD3FC", "#A78BFA",
];

function normalizeHex(value: string): string | null {
  const match = value.trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : null;
}

function hexToRgb(hex: string): Rgb {
  const normalized = normalizeHex(hex) ?? "#000000";
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { h: hue, s: max ? (delta / max) * 100 : 0, v: max * 100 };
}

function colorName(hex: string) {
  const { h, s, v } = rgbToHsv(hexToRgb(hex));
  if (s < 8) {
    if (v > 96) return "White";
    if (v > 78) return "Light Gray";
    if (v > 42) return "Gray";
    if (v > 10) return "Dark Gray";
    return "Black";
  }
  const names = ["Red", "Orange", "Yellow", "Lime", "Green", "Teal", "Cyan", "Azure", "Blue", "Indigo", "Violet", "Magenta"];
  const name = names[Math.round(h / 30) % names.length];
  if (v < 45) return `Dark ${name}`;
  if (s < 30) return `Muted ${name}`;
  if (s < 55 || (v > 94 && s < 75)) return `Soft ${name}`;
  return name;
}

function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const saturation = s / 100;
  const value = v / 100;
  const chroma = value * saturation;
  const section = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] = section < 1 ? [chroma, x, 0]
    : section < 2 ? [x, chroma, 0]
      : section < 3 ? [0, chroma, x]
        : section < 4 ? [0, x, chroma]
          : section < 5 ? [x, 0, chroma]
            : [chroma, 0, x];
  const offset = value - chroma;
  return { r: (red + offset) * 255, g: (green + offset) * 255, b: (blue + offset) * 255 };
}

function clampedNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function stepWithWheel(
  event: ReactWheelEvent<HTMLElement>,
  value: number,
  min: number,
  max: number,
  onChange: (value: number) => void,
) {
  if (event.deltaY === 0) return;
  event.preventDefault();
  onChange(clampedNumber(value + (event.deltaY < 0 ? 1 : -1), min, max));
}

function ColorGrid(props: {
  value: string;
  onChange: (color: string) => void;
  selectionId: string;
  reduceMotion: boolean;
}) {
  return (
    <div className="highlight-color-grid">
      {APPLE_GRID_COLORS.map((color, index) => (
        <button
          key={`${color}-${index}`}
          type="button"
          aria-label={`Select ${color}`}
          aria-pressed={props.value === color}
          className="highlight-color-swatch"
          style={{ backgroundColor: color }}
          onClick={() => props.onChange(color)}
        >
          {props.value === color && (
            <motion.span
              aria-hidden="true"
              className="highlight-color-selection"
              layout="position"
              layoutId={props.reduceMotion ? undefined : props.selectionId}
              transition={props.reduceMotion ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0 }}
            >
              <Check size={13} strokeWidth={2.2} />
            </motion.span>
          )}
        </button>
      ))}
    </div>
  );
}

function SpectrumPicker(props: { hsv: Hsv; onChange: (hsv: Hsv) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const update = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    props.onChange({ h: x * 360, s: (1 - y) * 100, v: props.hsv.v });
  };
  return (
    <div
      ref={ref}
      role="application"
      aria-label="Color spectrum"
      className="highlight-spectrum"
      style={{ "--spectrum-value": `${props.hsv.v}%` } as CSSProperties}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        update(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event);
      }}
    >
      <span
        className="highlight-spectrum-thumb"
        style={{
          "--spectrum-x": `${props.hsv.h / 3.6}%`,
          "--spectrum-y": `${100 - props.hsv.s}%`,
          backgroundColor: rgbToHex(hsvToRgb(props.hsv)),
        } as CSSProperties}
      />
    </div>
  );
}

function SliderPicker(props: {
  rgb: Rgb;
  value: string;
  onRgbChange: (rgb: Rgb) => void;
  onHexChange: (hex: string) => void;
}) {
  const [hexDraft, setHexDraft] = useState(() => ({
    source: props.value,
    text: props.value.slice(1),
  }));
  const resolvedHexDraft = hexDraft.source === props.value
    ? hexDraft.text
    : props.value.slice(1);
  const channels = [
    { label: "Red", shortLabel: "R", key: "r" as const, color: "#EF4444" },
    { label: "Green", shortLabel: "G", key: "g" as const, color: "#22C55E" },
    { label: "Blue", shortLabel: "B", key: "b" as const, color: "#3B82F6" },
  ];
  return (
    <div className="highlight-slider-panel">
      {channels.map((channel) => (
        <div key={channel.key} className="highlight-slider-row">
          <span className="highlight-slider-label">{channel.shortLabel}</span>
          <div className="highlight-slider-track" style={{ background: `linear-gradient(to right, #000, ${channel.color})` }}>
            <input
              type="range"
              min="0"
              max="255"
              aria-label={channel.label}
              value={props.rgb[channel.key]}
              className="highlight-range-input"
              onChange={(event) => props.onRgbChange({ ...props.rgb, [channel.key]: Number(event.target.value) })}
            />
            <span
              className="highlight-slider-thumb"
              style={{
                "--slider-position": `${props.rgb[channel.key] / 2.55}%`,
                backgroundColor: rgbToHex({
                  r: channel.key === "r" ? props.rgb.r : 0,
                  g: channel.key === "g" ? props.rgb.g : 0,
                  b: channel.key === "b" ? props.rgb.b : 0,
                }),
              } as CSSProperties}
            />
          </div>
          <input
            type="number"
            min="0"
            max="255"
            aria-label={`${channel.label} value`}
            value={props.rgb[channel.key]}
            className="highlight-number-input"
            onChange={(event) => {
              const value = Number(event.target.value);
              if (!Number.isNaN(value)) props.onRgbChange({ ...props.rgb, [channel.key]: clampedNumber(value, 0, 255) });
            }}
            onWheel={(event) => stepWithWheel(event, props.rgb[channel.key], 0, 255, (value) => {
              props.onRgbChange({ ...props.rgb, [channel.key]: value });
            })}
          />
        </div>
      ))}
      <label className="highlight-hex-row">
        <span>Hex</span>
        <span className="highlight-hex-input-wrap">
          <span aria-hidden="true">#</span>
          <input
            value={resolvedHexDraft}
            aria-label="Hex color"
            className="highlight-hex-input"
            onChange={(event) => {
              const next = event.target.value;
              if (!/^[0-9a-f]{0,6}$/i.test(next)) return;
              setHexDraft({ source: props.value, text: next });
              if (next.length === 6) props.onHexChange(`#${next}`);
            }}
          />
        </span>
      </label>
    </div>
  );
}

function OpacitySlider(props: {
  value: number;
  color: string;
  onChange: (opacity: number) => void;
}) {
  return (
    <section className="highlight-opacity">
      <div className="highlight-section-label">Opacity</div>
      <div className="highlight-opacity-row">
        <div
          className="highlight-opacity-track"
          style={{
            backgroundColor: "var(--surface-input)",
            backgroundImage:
              `linear-gradient(to right, transparent, ${props.color}), linear-gradient(45deg, #c8ced8 25%, transparent 25%), linear-gradient(135deg, #c8ced8 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #c8ced8 75%), linear-gradient(135deg, transparent 75%, #c8ced8 75%)`,
            backgroundSize: "100% 100%, 8px 8px, 8px 8px, 8px 8px, 8px 8px",
            backgroundPosition: "0 0, 0 0, 4px 0, 4px -4px, 0 4px",
          }}
        >
          <input
            type="range"
            min="0"
            max="100"
            aria-label="Opacity"
            value={props.value}
            className="highlight-range-input"
            onChange={(event) => props.onChange(Number(event.target.value))}
          />
          <span
            className="highlight-opacity-thumb"
            style={{
              "--slider-position": `${props.value}%`,
              backgroundColor: props.color,
            } as CSSProperties}
          />
        </div>
        <label
          className="highlight-opacity-value"
          onWheel={(event) => stepWithWheel(event, props.value, 0, 100, props.onChange)}
        >
          <input
            type="number"
            min="0"
            max="100"
            aria-label="Opacity value"
            value={props.value}
            className="highlight-number-input"
            onChange={(event) => {
              const value = Number(event.target.value);
              if (!Number.isNaN(value)) props.onChange(clampedNumber(value, 0, 100));
            }}
          />
          <span aria-hidden="true">%</span>
        </label>
      </div>
    </section>
  );
}

function RecentColors(props: {
  colors: string[];
  current: string;
  onSelect: (color: string) => void;
  onAdd: () => void;
}) {
  return (
    <section className="highlight-recents">
      <div className="highlight-section-label">Recent</div>
      <div className="highlight-recent-grid">
        {props.colors.map((color, index) => (
          <button key={`${color}-${index}`} type="button" aria-label={`Recent color ${color}`} aria-pressed={props.current === color} className="highlight-recent-swatch" style={{ backgroundColor: color }} onClick={() => props.onSelect(color)}>
            {props.current === color && <Check aria-hidden="true" size={10} strokeWidth={2.2} />}
          </button>
        ))}
        <button type="button" aria-label="Add current color" className="highlight-recent-add" onClick={props.onAdd}>
          <Plus size={11} />
        </button>
      </div>
    </section>
  );
}

export function AppleColorPicker(props: {
  value: string;
  opacity?: number;
  onConfirm: (color: string, opacity: number) => void;
  onCancel: () => void;
}) {
  const initialValue = normalizeHex(props.value) ?? "#007AFF";
  const [draftValue, setDraftValue] = useState(initialValue);
  const [draftOpacity, setDraftOpacity] = useState(props.opacity ?? 100);
  const [activeTab, setActiveTab] = useState<PickerTab>("Grid");
  const [tabDirection, setTabDirection] = useState(1);
  const [recentColors, setRecentColors] = useState(DEFAULT_RECENT_COLORS);
  const nativeColorInputRef = useRef<HTMLInputElement>(null);
  const gridSelectionId = `${useId()}-grid-selection`;
  const reduceMotion = useReducedMotion();
  const rgb = hexToRgb(draftValue);
  const hsv = rgbToHsv(rgb);
  const setColor = (value: string) => {
    const normalized = normalizeHex(value);
    if (normalized) setDraftValue(normalized);
  };
  const pickFromScreen = async () => {
    const EyeDropper = (window as typeof window & {
      EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
    }).EyeDropper;
    try {
      const color = await invoke<string | null>("sample_screen_color");
      if (color) setColor(color);
      return;
    } catch {
      // Browser development has no native command. Continue through the web
      // fallbacks; the desktop app always uses the system-wide NSColorSampler.
    }
    if (EyeDropper) {
      try {
        const result = await new EyeDropper().open();
        setColor(result.sRGBHex);
      } catch {
        // The platform rejects the promise when the sampling session is cancelled.
      }
      return;
    }
    nativeColorInputRef.current?.click();
  };
  return (
    <div className="apple-color-picker">
      <input
        ref={nativeColorInputRef}
        type="color"
        aria-label="Native color picker"
        value={draftValue}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => setColor(event.target.value)}
      />
      <div className="highlight-picker-header">
        <div className="highlight-picker-title">
          <span className="highlight-current-color" aria-hidden="true">
            <span style={{ backgroundColor: draftValue, opacity: draftOpacity / 100 }} />
          </span>
          <span>
            <strong>{colorName(draftValue)}</strong>
            <small>{draftValue} · {draftOpacity}%</small>
          </span>
        </div>
        <div className="highlight-picker-actions">
          <button type="button" aria-label="Pick color from screen" className="ui-icon-button" data-size="compact" onClick={() => void pickFromScreen()}>
            <Pipette size={14} strokeWidth={1.6} />
          </button>
          <button type="button" aria-label="Apply highlight color" className="ui-icon-button highlight-picker-confirm" data-size="compact" onClick={() => props.onConfirm(draftValue, draftOpacity)}>
            <Check size={14} strokeWidth={1.8} />
          </button>
          <button type="button" aria-label="Cancel color selection" className="ui-icon-button" data-size="compact" onClick={props.onCancel}>
            <X size={14} strokeWidth={1.6} />
          </button>
        </div>
      </div>
      <div className="highlight-picker-body">
        <SegmentedControl
          value={activeTab}
          onChange={(tab) => {
            setTabDirection(PICKER_TABS.indexOf(tab) > PICKER_TABS.indexOf(activeTab) ? 1 : -1);
            setActiveTab(tab);
          }}
          ariaLabel="Color selection mode"
          className="highlight-picker-tabs"
          tabClassName="highlight-picker-tab"
          items={PICKER_TABS.map((tab) => ({
            value: tab,
            label: tab === "Sliders" ? "Slider" : tab,
          }))}
        />
        <div className="highlight-picker-main">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={activeTab}
              className="highlight-picker-panel"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: tabDirection * 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: tabDirection * -8 }}
              transition={reduceMotion ? { duration: 0.1 } : { type: "spring", duration: 0.3, bounce: 0 }}
            >
              {activeTab === "Grid" && (
                <ColorGrid
                  value={draftValue}
                  onChange={setColor}
                  selectionId={gridSelectionId}
                  reduceMotion={Boolean(reduceMotion)}
                />
              )}
              {activeTab === "Spectrum" && <SpectrumPicker hsv={hsv} onChange={(next) => setColor(rgbToHex(hsvToRgb(next)))} />}
              {activeTab === "Sliders" && (
                <SliderPicker
                  rgb={rgb}
                  value={draftValue}
                  onRgbChange={(next) => setColor(rgbToHex(next))}
                  onHexChange={setColor}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <OpacitySlider
          value={draftOpacity}
          color={draftValue}
          onChange={setDraftOpacity}
        />
        <RecentColors
          colors={recentColors}
          current={draftValue}
          onSelect={setColor}
          onAdd={() => setRecentColors((current) => [
            draftValue,
            ...current.filter((color) => color !== draftValue),
          ].slice(0, MAX_RECENT_COLORS))}
        />
      </div>
    </div>
  );
}
