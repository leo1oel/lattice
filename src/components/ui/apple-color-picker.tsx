"use client";

import { Pipette, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Rgb = { r: number; g: number; b: number };
type Hsv = { h: number; s: number; v: number };
type PickerTab = "Grid" | "Spectrum" | "Sliders";

const APPLE_GRID_COLORS = [
  "#FFFFFF", "#EBEBEB", "#D6D6D6", "#C2C2C2", "#ADADAD", "#999999", "#858585", "#707070", "#5C5C5C", "#474747", "#333333", "#000000",
  "#003366", "#336699", "#3366CC", "#003399", "#000099", "#0000CC", "#000066", "#333366", "#663399", "#660099", "#330066", "#330033",
  "#006699", "#0099CC", "#0066CC", "#0033CC", "#0000FF", "#3333FF", "#333399", "#6633CC", "#9933CC", "#9900CC", "#6600CC", "#660066",
  "#0099CC", "#00CCFF", "#0099FF", "#0066FF", "#3366FF", "#6666FF", "#6666CC", "#9966CC", "#CC66FF", "#CC33FF", "#9900FF", "#990099",
  "#33CCCC", "#66FFFF", "#33CCFF", "#3399FF", "#6699FF", "#9999FF", "#9999CC", "#CC99FF", "#FF99FF", "#FF66FF", "#CC00FF", "#CC00CC",
  "#66CCCC", "#99FFFF", "#66CCFF", "#6699FF", "#99CCFF", "#CCCCFF", "#CC99CC", "#FFCCFF", "#FF99FF", "#FF66FF", "#FF33FF", "#FF00FF",
  "#99CCCC", "#CCFFFF", "#99CCFF", "#9999FF", "#CCCCFF", "#FFFFFF", "#FFCCFF", "#FF99FF", "#FF66FF", "#FF00FF", "#CC00CC", "#990099",
  "#CCFFCC", "#FFFFCC", "#FFFF99", "#FFFF66", "#FFFF33", "#FFFF00", "#FFCC00", "#FF9900", "#FF6600", "#FF3300", "#FF0000", "#CC0000",
  "#99FF99", "#CCFF99", "#CCCC66", "#CCCC33", "#CCCC00", "#CC9900", "#CC6600", "#CC3300", "#CC0000", "#990000", "#660000", "#330000",
  "#66FF66", "#99FF66", "#99CC66", "#99CC33", "#999900", "#996600", "#993300", "#990000", "#660000", "#330000", "#000000", "#000000",
  "#33FF33", "#66FF33", "#66CC33", "#669933", "#666600", "#663300", "#660000", "#330000", "#000000", "#000000", "#000000", "#000000",
  "#00FF00", "#33FF00", "#33CC00", "#339900", "#336600", "#333300", "#330000", "#000000", "#000000", "#000000", "#000000", "#000000",
] as const;

const DEFAULT_RECENT_COLORS = [
  "#000000", "#FFFFFF", "#FF3B30", "#FF9500", "#FFCC00",
  "#34C759", "#5AC8FA", "#007AFF", "#5856D6", "#FF2D55",
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

function SegmentedControl(props: {
  selected: PickerTab;
  onChange: (tab: PickerTab) => void;
}) {
  return (
    <div className="flex h-7 items-center rounded-lg bg-[#E3E3E8] p-0.5 dark:bg-white/10">
      {(["Grid", "Spectrum", "Sliders"] as const).map((option) => (
        <button
          key={option}
          type="button"
          className={`relative h-6 flex-1 appearance-none border-0 p-0 text-[11px] font-medium leading-6 transition ${props.selected === option ? "rounded-md bg-white text-black shadow-[0_1px_3px_rgba(0,0,0,0.14)] dark:bg-white/90" : "bg-transparent text-[#707789] hover:text-gray-700 dark:text-white/55 dark:hover:text-white/80"}`}
          onClick={() => props.onChange(option)}
        >
          {option === "Sliders" ? "Slider" : option}
        </button>
      ))}
    </div>
  );
}

function ColorGrid(props: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="grid h-40 grid-cols-12 gap-px overflow-hidden rounded-lg bg-white p-0 dark:bg-white/10">
      {APPLE_GRID_COLORS.map((color, index) => (
        <button
          key={`${color}-${index}`}
          type="button"
          aria-label={`Select ${color}`}
          className="relative min-h-0 min-w-0 appearance-none rounded-none border-0 p-0 hover:z-10 hover:brightness-110 focus:z-20 focus:outline-none"
          style={{ backgroundColor: color }}
          onClick={() => props.onChange(color)}
        >
          {props.value === color && <span className="pointer-events-none absolute inset-0 border-2 border-white mix-blend-difference" />}
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
    props.onChange({ h: x * 360, s: (1 - y) * 100, v: 100 });
  };
  return (
    <div
      ref={ref}
      role="application"
      aria-label="Color spectrum"
      className="relative h-40 w-full touch-none cursor-crosshair overflow-hidden rounded-lg shadow-inner"
      style={{ background: "linear-gradient(to bottom, transparent, #000), linear-gradient(to right, #fff, transparent), linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)" }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        update(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event);
      }}
    >
      <span
        className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md"
        style={{ left: `${props.hsv.h / 3.6}%`, top: `${100 - props.hsv.s}%`, backgroundColor: rgbToHex(hsvToRgb(props.hsv)) }}
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
  const [hexDraft, setHexDraft] = useState(props.value.slice(1));
  useEffect(() => setHexDraft(props.value.slice(1)), [props.value]);
  const channels = [
    { label: "Red", key: "r" as const, color: "#FF3B30" },
    { label: "Green", key: "g" as const, color: "#34C759" },
    { label: "Blue", key: "b" as const, color: "#007AFF" },
  ];
  return (
    <div className="flex h-40 flex-col justify-between py-1">
      {channels.map((channel) => (
        <div key={channel.key} className="flex items-center gap-2">
          <span className="w-8 text-[8px] font-semibold uppercase text-gray-500 dark:text-white/50">{channel.label}</span>
          <div className="relative h-5 flex-1 rounded-full shadow-inner" style={{ background: `linear-gradient(to right, #000, ${channel.color})` }}>
            <input
              type="range"
              min="0"
              max="255"
              aria-label={channel.label}
              value={props.rgb[channel.key]}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              onChange={(event) => props.onRgbChange({ ...props.rgb, [channel.key]: Number(event.target.value) })}
            />
            <span className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-gray-200 bg-white shadow-md" style={{ left: `${props.rgb[channel.key] / 2.55}%` }} />
          </div>
          <input
            type="number"
            min="0"
            max="255"
            aria-label={`${channel.label} value`}
            value={props.rgb[channel.key]}
            className="h-6 w-10 rounded-md border border-black/10 bg-white/80 px-1 text-center text-[9px] text-black outline-none dark:border-white/10"
            onChange={(event) => props.onRgbChange({ ...props.rgb, [channel.key]: Math.max(0, Math.min(255, Number(event.target.value))) })}
          />
        </div>
      ))}
      <label className="flex items-center justify-between text-[9px] text-[#007AFF]">
        Hex Color #
        <input
          value={hexDraft}
          aria-label="Hex color"
          className="h-6 w-20 rounded-md border border-black/10 bg-white/80 px-2 text-right text-[10px] font-medium uppercase text-black outline-none focus:border-[#007AFF] dark:border-white/10"
          onChange={(event) => {
            const next = event.target.value;
            if (!/^[0-9a-f]{0,6}$/i.test(next)) return;
            setHexDraft(next);
            if (next.length === 6) props.onHexChange(`#${next}`);
          }}
        />
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
    <section className="border-t border-black/[0.07] pt-3 dark:border-white/10">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.03em] text-[#6E7788] dark:text-white/55">
        Opacity
      </div>
      <div className="flex items-center gap-3">
        <div
          className="relative h-5 min-w-0 flex-1 overflow-visible rounded-full shadow-inner"
          style={{
            backgroundColor: "#fff",
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
            className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
            onChange={(event) => props.onChange(Number(event.target.value))}
          />
          <span
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/10 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.22)]"
            style={{ left: `clamp(8px, ${props.value}%, calc(100% - 8px))` }}
          >
            <span className="absolute inset-0.5 rounded-full" style={{ backgroundColor: props.color, opacity: props.value / 100 }} />
          </span>
        </div>
        <label className="relative h-6 w-12 flex-none">
          <input
            type="text"
            inputMode="numeric"
            aria-label="Opacity value"
            value={`${props.value}%`}
            className="h-full w-full rounded-md border border-black/[0.07] bg-white/45 px-1 text-center text-[9px] font-medium text-black outline-none focus:border-[#007AFF]/60 dark:border-white/10 dark:bg-white/5 dark:text-white"
            onChange={(event) => {
              const value = Number.parseInt(event.target.value.replace("%", ""), 10);
              if (!Number.isNaN(value)) props.onChange(Math.max(0, Math.min(100, value)));
            }}
          />
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
    <div className="flex gap-3.5 border-t border-black/[0.07] pt-3 dark:border-white/10">
      <div className="h-10 w-10 flex-none rounded-lg border border-black/[0.06] shadow-inner dark:border-white/10" style={{ backgroundColor: props.current }} />
      <div className="grid flex-1 grid-cols-6 content-start gap-1.5">
        {props.colors.map((color, index) => (
          <button key={`${color}-${index}`} type="button" aria-label={`Recent color ${color}`} className="h-5 w-5 appearance-none rounded-full border border-black/10 p-0 shadow-sm transition-transform hover:scale-110 dark:border-white/10" style={{ backgroundColor: color }} onClick={() => props.onSelect(color)} />
        ))}
        {props.colors.length < 12 && (
          <button type="button" aria-label="Add current color" className="grid h-5 w-5 appearance-none place-items-center rounded-full border border-black/10 bg-black/5 p-0 text-gray-500 hover:bg-black/10 dark:border-white/10 dark:bg-white/10 dark:text-white/60" onClick={props.onAdd}>
            <Plus size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

export function AppleColorPicker(props: {
  value: string;
  opacity?: number;
  onValueChange: (color: string) => void;
  onOpacityChange?: (opacity: number) => void;
  onClose: () => void;
}) {
  const normalizedValue = normalizeHex(props.value) ?? "#007AFF";
  const [activeTab, setActiveTab] = useState<PickerTab>("Grid");
  const [recentColors, setRecentColors] = useState(DEFAULT_RECENT_COLORS);
  const nativeColorInputRef = useRef<HTMLInputElement>(null);
  const rgb = hexToRgb(normalizedValue);
  const hsv = rgbToHsv(rgb);
  const setColor = (value: string) => {
    const normalized = normalizeHex(value);
    if (normalized) props.onValueChange(normalized);
  };
  const pickFromScreen = async () => {
    const EyeDropper = (window as typeof window & {
      EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
    }).EyeDropper;
    if (!EyeDropper) {
      nativeColorInputRef.current?.click();
      return;
    }
    try {
      const result = await new EyeDropper().open();
      setColor(result.sRGBHex);
    } catch {
      // The platform rejects the promise when the sampling session is cancelled.
    }
  };
  return (
    <div className="apple-color-picker box-border w-60 select-none overflow-hidden rounded-[18px] border border-white/60 bg-[#F2F3F8]/95 p-3.5 [font-family:var(--ui-font)] text-black shadow-[0_14px_42px_rgba(21,31,55,0.20)] backdrop-blur-xl [&_*]:box-border [&_button]:font-[inherit] [&_input]:font-[inherit] dark:border-white/10 dark:bg-[#252527]/95 dark:text-white">
      <input
        ref={nativeColorInputRef}
        type="color"
        aria-label="Native color picker"
        value={normalizedValue}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => setColor(event.target.value)}
      />
      <div className="mb-3 flex h-6 items-center justify-between">
        <button type="button" aria-label="Pick color from screen" className="appearance-none rounded-full border-0 bg-transparent p-1.5 text-[#007AFF] transition-colors hover:bg-black/5 dark:hover:bg-white/10" onClick={() => void pickFromScreen()}>
          <Pipette size={16} />
        </button>
        <h2 className="m-0 text-[11px] font-semibold leading-none">Colors</h2>
        <button type="button" aria-label="Close color picker" className="appearance-none rounded-full border-0 bg-transparent p-1.5 text-gray-500 transition-colors hover:bg-black/5 dark:text-white/55 dark:hover:bg-white/10" onClick={props.onClose}>
          <X size={16} />
        </button>
      </div>
      <SegmentedControl selected={activeTab} onChange={setActiveTab} />
      <div className="mt-3 h-40">
        {activeTab === "Grid" && <ColorGrid value={normalizedValue} onChange={setColor} />}
        {activeTab === "Spectrum" && <SpectrumPicker hsv={hsv} onChange={(next) => setColor(rgbToHex(hsvToRgb(next)))} />}
        {activeTab === "Sliders" && <SliderPicker rgb={rgb} value={normalizedValue} onRgbChange={(next) => setColor(rgbToHex(next))} onHexChange={setColor} />}
      </div>
      <div className="mt-3">
        <OpacitySlider
          value={props.opacity ?? 100}
          color={normalizedValue}
          onChange={(opacity) => props.onOpacityChange?.(opacity)}
        />
      </div>
      <div className="mt-3">
        <RecentColors
          colors={recentColors}
          current={normalizedValue}
          onSelect={setColor}
          onAdd={() => setRecentColors((current) => current.includes(normalizedValue) ? current : [normalizedValue, ...current].slice(0, 12))}
        />
      </div>
    </div>
  );
}
