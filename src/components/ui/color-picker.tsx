import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Check, CornerDownLeft, Pipette } from "lucide-react";
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import "./color-picker.css";

/**
 * A custom color on one surface, the way desktop editors draw it (Figma,
 * Framer, Confluence): a saturation × brightness field, a hue strip beside
 * the eyedropper, a hex field that is always there, and the colors that
 * matter as swatches below. HSV is the canonical draft, so a gray or black
 * keeps the hue it came from, and every brightness is one drag away.
 *
 * Two modes: with `onConfirm` the color is a draft until the footer commits
 * it (a highlight writes LaTeX source, so it is applied once); with only
 * `onChange` every change goes out at once, as Settings applies its choices.
 */

type Hsv = { h: number; s: number; v: number };
type Rgb = { r: number; g: number; b: number };

export type ColorSwatchGroup = { id: string; label: string; colors: readonly string[]; columns?: number };

/** How a color reads where it lands, for the one-line verdict under the preview. */
export type ColorLegibility = { ok: boolean; ratio: number; fix?: string };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** `#RRGGBB` for a typed or pasted color, with or without `#`, in three or six digits. */
function normalizeHex(value: string): string | null {
  const text = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(text)) return `#${[...text].map((digit) => digit + digit).join("")}`.toUpperCase();
  return /^[0-9a-f]{6}$/i.test(text) ? `#${text}`.toUpperCase() : null;
}

function hexToRgb(hex: string): Rgb {
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
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
  const chroma = (v / 100) * (s / 100);
  const section = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] = section < 1 ? [chroma, x, 0] : section < 2 ? [x, chroma, 0] : section < 3 ? [0, chroma, x]
    : section < 4 ? [0, x, chroma] : section < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const offset = v / 100 - chroma;
  return { r: (red + offset) * 255, g: (green + offset) * 255, b: (blue + offset) * 255 };
}

/** The draft for a color, keeping `hue` when the color itself has none (a gray). */
function hsvOf(hex: string, hue: number): Hsv {
  const next = rgbToHsv(hexToRgb(hex));
  return next.s === 0 ? { ...next, h: hue } : next;
}

const HUE_NAMES: MessageDescriptor[] = [
  msg`Red`, msg`Orange`, msg`Yellow`, msg`Lime`, msg`Green`, msg`Teal`,
  msg`Cyan`, msg`Azure`, msg`Blue`, msg`Indigo`, msg`Violet`, msg`Magenta`,
];

/** A short spoken name for a color: its hue, then how pale, soft or dark it is. */
function colorName(hex: string, i18n: I18n): string {
  const { h, s, v } = rgbToHsv(hexToRgb(hex));
  if (s < 8) {
    if (v > 96) return i18n._(msg`White`);
    if (v > 78) return i18n._(msg`Light Gray`);
    if (v > 42) return i18n._(msg`Gray`);
    if (v > 10) return i18n._(msg`Dark Gray`);
    return i18n._(msg`Black`);
  }
  const name = i18n._(HUE_NAMES[Math.round(h / 30) % HUE_NAMES.length]);
  if (v < 45) return i18n._(msg`Dark ${name}`);
  if (s < 30) return i18n._(msg`Pale ${name}`);
  if (s < 55 || (v > 94 && s < 75)) return i18n._(msg`Soft ${name}`);
  return name;
}

/** Sample a color from anywhere on screen: the macOS sampler, then the web's EyeDropper, then the native panel. */
async function sampleScreenColor(fallback: () => void): Promise<string | null> {
  try {
    return await invoke<string | null>("sample_screen_color");
  } catch {
    // Browser development has no native command; fall through to the web paths.
  }
  const EyeDropper = (window as typeof window & { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (!EyeDropper) {
    fallback();
    return null;
  }
  try {
    return (await new EyeDropper().open()).sRGBHex;
  } catch {
    // The platform rejects the promise when the sampling session is cancelled.
    return null;
  }
}

export function ColorPicker(props: {
  value: string;
  /** Every change, as it is made (live mode, no footer). */
  onChange?: (hex: string) => void;
  /** The footer's primary action commits the draft (draft mode). */
  onConfirm?: (hex: string) => void;
  onCancel?: () => void;
  confirmLabel?: string;
  /** Above the field: how the color will look where it is used. */
  preview?: (hex: string) => ReactNode;
  legibility?: (hex: string) => ColorLegibility;
  swatches: readonly ColorSwatchGroup[];
  /** After the swatches, for choices that are not colors (named presets). */
  after?: ReactNode;
  label: string;
}) {
  const { i18n, t } = useLingui();
  const [hsv, setHsv] = useState<Hsv>(() => hsvOf(normalizeHex(props.value) ?? "#FFF1A6", 0));
  const hex = rgbToHex(hsvToRgb(hsv));
  // What the hex field shows while it is being typed in; null shows the color.
  const [hexText, setHexText] = useState<string | null>(null);
  const hexInvalid = hexText !== null && normalizeHex(hexText) === null;
  const nativeInputRef = useRef<HTMLInputElement>(null);

  const setDraft = (next: Hsv) => {
    setHsv(next);
    props.onChange?.(rgbToHex(hsvToRgb(next)));
  };
  const setColor = (value: string) => {
    const normalized = normalizeHex(value);
    if (!normalized) return;
    setHexText(null);
    setDraft(hsvOf(normalized, hsv.h));
  };
  const legibility = props.legibility?.(hex);
  const confirm = () => {
    if (!hexInvalid) props.onConfirm?.(hex);
  };

  return (
    <div
      className="color-picker"
      role="group"
      aria-label={props.label}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !props.onConfirm || event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        confirm();
      }}
    >
      <input ref={nativeInputRef} type="color" className="sr-only" tabIndex={-1} aria-hidden="true" value={hex.toLowerCase()} onChange={(event) => setColor(event.target.value)} />
      {props.preview && <div className="cp-preview">{props.preview(hex)}</div>}
      {legibility && (
        <div className="cp-verdict" data-ok={legibility.ok || undefined} role="status">
          {legibility.ok
            ? <Check size={12} strokeWidth={2} aria-hidden="true" />
            : <AlertTriangle size={12} strokeWidth={1.8} aria-hidden="true" />}
          <span className="cp-verdict-text">
            {legibility.ok ? t`Black text reads clearly` : t`Too dark for black text`}
            <span className="cp-verdict-ratio">{legibility.ratio.toFixed(1)}:1</span>
          </span>
          {!legibility.ok && legibility.fix && (
            <button type="button" className="cp-verdict-fix" onClick={() => setColor(legibility.fix!)}>{t`Lighten`}</button>
          )}
        </div>
      )}
      <SaturationField hsv={hsv} onChange={(next) => {
        setHexText(null);
        setDraft(next);
      }} />
      <div className="cp-strip-row">
        <button
          type="button"
          className="cp-eyedropper"
          aria-label={t`Pick color from screen`}
          title={t`Pick color from screen`}
          onClick={() => void sampleScreenColor(() => nativeInputRef.current?.click()).then((color) => color && setColor(color))}
        >
          <Pipette size={14} strokeWidth={1.6} />
        </button>
        <HueStrip hsv={hsv} onChange={(next) => {
          setHexText(null);
          setDraft(next);
        }} />
      </div>
      <label className="cp-hex" data-invalid={hexInvalid || undefined}>
        <span className="cp-hex-chip" style={{ background: hex }} aria-hidden="true" />
        <span className="cp-hex-hash" aria-hidden="true">#</span>
        <input
          className="cp-hex-input"
          value={hexText ?? hex.slice(1)}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          aria-label={t`Hex color`}
          aria-invalid={hexInvalid || undefined}
          onChange={(event) => {
            const text = event.target.value;
            setHexText(text);
            const normalized = normalizeHex(text);
            // A complete code applies at once; three digits wait for blur, as
            // they are also the start of a six-digit one.
            if (normalized && text.replace(/^#/, "").length === 6) setDraft(hsvOf(normalized, hsv.h));
          }}
          onBlur={() => {
            if (hexText !== null && normalizeHex(hexText)) setColor(hexText);
            else setHexText(null);
          }}
        />
        <span className="cp-hex-name">{hexInvalid ? t`Enter 6 hex digits` : colorName(hex, i18n)}</span>
      </label>
      {props.swatches.filter((group) => group.colors.length > 0).map((group) => (
        <SwatchGrid key={group.id} group={group} value={hex} onPick={setColor} />
      ))}
      {props.after}
      {props.onConfirm && (
        <div className="cp-footer">
          <button type="button" className="cp-button" onClick={props.onCancel}>{t`Cancel`}</button>
          <button type="button" className="cp-button cp-button-primary" disabled={hexInvalid} onClick={confirm}>
            <span>{props.confirmLabel ?? t`Apply`}</span>
            <CornerDownLeft size={12} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Saturation across, brightness up: one thumb, which the arrow keys move (Shift for tens). */
function SaturationField(props: { hsv: Hsv; onChange: (hsv: Hsv) => void }) {
  const { t } = useLingui();
  const { hsv } = props;
  const update = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    props.onChange({
      h: hsv.h,
      s: clamp(((event.clientX - bounds.left) / bounds.width) * 100, 0, 100),
      v: clamp((1 - (event.clientY - bounds.top) / bounds.height) * 100, 0, 100),
    });
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const step = event.shiftKey ? 10 : 1;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
    if (!move) return;
    event.preventDefault();
    props.onChange({ h: hsv.h, s: clamp(hsv.s + move[0], 0, 100), v: clamp(hsv.v + move[1], 0, 100) });
  };
  return (
    <div
      className="cp-field"
      style={{ "--cp-hue": `hsl(${hsv.h} 100% 50%)` } as CSSProperties}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        update(event);
        event.currentTarget.querySelector<HTMLElement>(".cp-field-thumb")?.focus({ preventScroll: true });
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
    >
      <span
        className="cp-field-thumb"
        role="slider"
        tabIndex={0}
        aria-label={t`Saturation and brightness`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s)}
        aria-valuetext={t`Saturation ${Math.round(hsv.s)}%, brightness ${Math.round(hsv.v)}%`}
        style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, background: rgbToHex(hsvToRgb(hsv)) }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

function HueStrip(props: { hsv: Hsv; onChange: (hsv: Hsv) => void }) {
  const { t } = useLingui();
  return (
    <span className="cp-hue">
      <input
        type="range"
        min={0}
        max={359}
        step={1}
        aria-label={t`Hue`}
        value={Math.round(props.hsv.h)}
        onChange={(event) => props.onChange({ ...props.hsv, h: Number(event.target.value) })}
      />
      <span className="cp-hue-thumb" aria-hidden="true" style={{ left: `${(props.hsv.h / 359) * 100}%`, background: `hsl(${props.hsv.h} 100% 50%)` }} />
    </span>
  );
}

/** A labelled swatch set as one radio group: one tab stop, arrows move by one or by a row. */
function SwatchGrid(props: { group: ColorSwatchGroup; value: string; onPick: (hex: string) => void }) {
  const { i18n } = useLingui();
  const columns = props.group.columns ?? 8;
  const ref = useRef<HTMLDivElement>(null);
  const selected = props.group.colors.indexOf(props.value);
  const move = (event: ReactKeyboardEvent, index: number) => {
    const last = props.group.colors.length - 1;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns, Home: -index, End: last - index }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = clamp(index + step, 0, last);
    props.onPick(props.group.colors[next]!);
    ref.current?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus();
  };
  return (
    <section className="cp-swatches">
      <div className="cp-swatches-label">{props.group.label}</div>
      <div ref={ref} className="cp-swatch-grid" role="radiogroup" aria-label={props.group.label} style={{ "--cp-columns": columns } as CSSProperties}>
        {props.group.colors.map((color, index) => (
          <button
            key={color}
            type="button"
            role="radio"
            className="cp-swatch"
            style={{ background: color }}
            aria-checked={index === selected}
            aria-label={`${colorName(color, i18n)} ${color}`}
            title={color}
            tabIndex={index === (selected === -1 ? 0 : selected) ? 0 : -1}
            onClick={() => props.onPick(color)}
            onKeyDown={(event) => move(event, index)}
          >
            {index === selected && <Check size={12} strokeWidth={2.2} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </section>
  );
}
