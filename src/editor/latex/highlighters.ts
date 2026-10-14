/**
 * The six highlighters and what each one means. A highlighter is a paper
 * colour, not an interface one: it is printed under black text in the PDF, so
 * every tint keeps `#242426` above 11:1 and stays light in the dark theme.
 * Each carries a meaning the writer can rename (To check, Keep, …); the
 * Annotations panel lists highlights by it. Meanings, the last highlighter
 * and the custom colours are preferences of the writer, not of a project.
 */
import { useSyncExternalStore } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { persistSetting } from "../../settings/app-settings";

export type Highlighter = {
  hex: string;
  /** The colour's name, for screen readers and the tooltip. */
  name: MessageDescriptor;
  /** What the highlighter means until the writer renames it. */
  meaning: MessageDescriptor;
  /** The digit that applies it while the palette is open. */
  key: string;
};

/** The ink a highlight is printed under, in the PDF and on the palette's specimens. */
export const PAPER_INK = "#242426";

/**
 * Paper tones the custom picker offers: eight hues at three strengths (OKLCH
 * lightness 0.965, 0.925 and 0.88 at chroma 0.04, 0.07 and 0.095), each
 * keeping PAPER_INK above 10.5:1, as the six highlighters do (11.8 to 13.6:1),
 * so nothing offered prints as a dark block under black text.
 */
export const PAPER_TONES: readonly string[] = [
  "#F9F5D6", "#FFF1E5", "#FEF0ED", "#FEEFF4", "#F5F1FE", "#ECF4FE", "#DDF7F5", "#E4FBE3",
  "#F3E9B0", "#FFE0C6", "#FFDDD8", "#FEDBE8", "#EAE0FF", "#D7E8FF", "#C2EEEA", "#CAF3CA",
  "#EAD98A", "#FFCCA1", "#FFC9C1", "#FFC5DA", "#DECEFE", "#BEDAFF", "#9FE2DC", "#B0E9B1",
];

export const HIGHLIGHTERS: readonly Highlighter[] = [
  { hex: "#FFF1A6", name: msg`Yellow`, meaning: msg`To check`, key: "1" },
  { hex: "#CFEFC6", name: msg`Green`, meaning: msg`Keep`, key: "2" },
  { hex: "#D3E4FF", name: msg`Blue`, meaning: msg`Needs a citation`, key: "3" },
  { hex: "#FFD6E4", name: msg`Pink`, meaning: msg`Rewrite`, key: "4" },
  { hex: "#FFE2C2", name: msg`Orange`, meaning: msg`Question`, key: "5" },
  { hex: "#E6DBFF", name: msg`Purple`, meaning: msg`Idea`, key: "6" },
];

/** The highlighter drawn in `color`, if it is one of the six. */
export function highlighterOf(color: string | null | undefined): Highlighter | undefined {
  const hex = color?.toUpperCase();
  return HIGHLIGHTERS.find((item) => item.hex === hex);
}

const MEANINGS_KEY = "lattice.highlight-meanings.v1";
const LAST_KEY = "lattice.highlight-last.v1";
const CUSTOM_KEY = "lattice.highlight-custom.v1";
const CUSTOM_MAX = 4;

type Prefs = {
  /** Renamed meanings by highlighter hex; a meaning not here is the default, in the current language. */
  meanings: Readonly<Record<string, string>>;
  /** The colour the toolbar's pen applies. */
  last: string;
  /** Custom colours, newest first. */
  custom: readonly string[];
};

const isHex = (value: unknown): value is string => typeof value === "string" && /^#[0-9A-F]{6}$/.test(value);

function read<T>(key: string, parse: (value: unknown) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

function load(): Prefs {
  return {
    meanings: read(MEANINGS_KEY, (value) => Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([hex, meaning]) => highlighterOf(hex) && typeof meaning === "string" && meaning.trim())) as Record<string, string>, {}),
    last: read(LAST_KEY, (value) => isHex(value) ? value : HIGHLIGHTERS[0]!.hex, HIGHLIGHTERS[0]!.hex),
    custom: read(CUSTOM_KEY, (value) => Array.isArray(value) ? value.filter(isHex).slice(0, CUSTOM_MAX) : [], []),
  };
}

let prefs: Prefs | null = null;
const listeners = new Set<() => void>();
const snapshot = () => prefs ??= load();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function update(next: Partial<Prefs>) {
  prefs = { ...snapshot(), ...next };
  for (const listener of listeners) listener();
}

/** Remember `color` as the pen's, and among the custom colours when it is not a highlighter. */
export function rememberHighlight(color: string) {
  const hex = color.toUpperCase();
  if (!isHex(hex)) return;
  const custom = highlighterOf(hex) ? snapshot().custom : [hex, ...snapshot().custom.filter((item) => item !== hex)].slice(0, CUSTOM_MAX);
  update({ last: hex, custom });
  persistSetting(LAST_KEY, JSON.stringify(hex));
  persistSetting(CUSTOM_KEY, JSON.stringify(custom));
}

/** Rename the highlighters; a blank meaning goes back to the default. */
export function saveHighlightMeanings(meanings: Readonly<Record<string, string>>) {
  const kept = Object.fromEntries(Object.entries(meanings).map(([hex, meaning]) => [hex, meaning.trim()]).filter(([, meaning]) => meaning));
  update({ meanings: kept });
  persistSetting(MEANINGS_KEY, JSON.stringify(kept));
}

export type HighlightPrefs = {
  /** Each highlighter's meaning, as the writer named it or by default. */
  meaningOf: (item: Highlighter) => string;
  /** Whether the writer renamed it. */
  renamed: (item: Highlighter) => boolean;
  last: string;
  custom: readonly string[];
};

/** The highlighter preferences, kept current across the toolbar and the Annotations panel. */
export function useHighlightPrefs(): HighlightPrefs {
  const { i18n } = useLingui();
  const current = useSyncExternalStore(subscribe, snapshot);
  return {
    meaningOf: (item) => current.meanings[item.hex] ?? i18n._(item.meaning),
    renamed: (item) => item.hex in current.meanings,
    last: current.last,
    custom: current.custom,
  };
}

/** Whether black text stays readable on `hex` (#RRGGBB): an older document may carry a dark custom colour. */
export function readsDarkOn(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  // #242426 is about 0.018; 4.5:1 against it needs a luminance of 0.16 or more.
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! >= 0.16;
}
