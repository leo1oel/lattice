import { Check, Moon, Plus, Sun } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { ColorPicker } from "../components/ui/color-picker";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { SegmentedControl } from "../components/ui/segmented-control";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import type { AppearanceSettings, Theme, ThemePreference } from "./app-settings";
import {
  type AccentPreset,
  type ThemeAccent,
  type ThemeTint,
  type Translucency,
  ACCENT_PRESETS,
  THEME_TINTS,
  isCustomAccent,
} from "./theme-customization";
import { ThemeFileActions } from "./theme-file-actions";
import { type ThemeInfo, type ThemeVariantInfo, useFittedAccent, useThemeList } from "./themes";
import type { WindowBacking } from "./use-appearance";
import "./theme-settings.css";

type ThemeSettingsProps = {
  appearance: AppearanceSettings;
  setAppearance: (appearance: AppearanceSettings) => void;
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
  /** The appearance the window wears now, which a custom accent is fitted to. */
  theme: Theme;
  windowBacking: WindowBacking;
};

/**
 * Settings → Appearance → Theme: light or dark, then a palette (Lattice's own
 * or a theme, docs/themes.md), a tint, an accent and the window's
 * translucency. Every choice applies as it is made. The dialog
 * covers most of the window, so the choices draw what they change: the
 * appearances as miniature windows, each tint as both of its appearances.
 */
export function ThemeSettingsGroup(props: ThemeSettingsProps) {
  const { t } = useLingui();
  const { tint, accent, translucency } = props.appearance;
  const patch = (next: Partial<AppearanceSettings>) => props.setAppearance({ ...props.appearance, ...next });
  const { themes, error: themesError } = useThemeList();
  const chosen = themes?.find((theme) => theme.id === props.appearance.theme);
  // A theme brings its own accent: the default Graphite gives way to it, and
  // an accent the writer picked stays and wins (L13).
  const chooseTheme = (id: string) => patch(id && accent === "graphite" ? { theme: id, accent: "theme" } : { theme: id });
  const themeAccent = chosen?.variants.find((variant) => variant.appearance === props.theme)?.accent;
  const tintNames: Record<ThemeTint, string> = {
    graphite: t`Graphite`,
    paper: t({ message: "Paper", context: "theme tint" }),
    sage: t`Sage`,
    mist: t`Mist`,
    dusk: t`Dusk`,
  };
  const accentNames: Record<AccentPreset, string> = {
    graphite: t`Graphite`,
    blue: t`Blue`,
    purple: t`Purple`,
    pink: t`Pink`,
    orange: t`Orange`,
    green: t`Green`,
    teal: t`Teal`,
  };
  // Off/Subtle/Strong applies live behind the dialog, so only a backing
  // that ignores the choice says why.
  const translucencyNote: Partial<Record<WindowBacking, string>> = {
    reducedTransparency: t`Off while Reduce transparency is on in System Settings`,
    unsupported: t`Only in the Lattice window on macOS`,
  };
  const accentOptions: SwatchOption<AccentPreset | "theme">[] = ACCENT_PRESETS.map((id) => ({
    id,
    name: accentNames[id],
    preset: { "data-accent": id },
    fill: "theme-accent-fill",
  }));
  if (chosen) {
    accentOptions.unshift({
      id: "theme",
      name: t`Theme default`,
      preset: { "data-accent": "graphite" },
      fill: "theme-accent-fill",
      color: themeAccent ?? undefined,
    });
  }
  const pickedAccent = isCustomAccent(accent) || (accent === "theme" && !chosen) ? null : accent;

  return (
    <SettingsGroup title={t`Theme`}>
      <SettingsRow data-setting="color-theme" label={t`Color theme`}>
        <TileGroup
          label={t`Color theme`}
          value={props.themePreference}
          className="theme-tiles-mode"
          options={([["system", t`Match system`], ["light", t`Light`], ["dark", t`Dark`]] as const).map(([id, name]) => ({
            id,
            name,
            art: <ModeArt mode={id} tint={tint} />,
          }))}
          onChange={props.setThemePreference}
        />
      </SettingsRow>
      {themes && (
        <SettingsRow data-setting="theme-palette" label={t`Palette`} description={chosen?.description || undefined}>
          <TileGroup
            label={t`Palette`}
            value={chosen?.id ?? ""}
            className="theme-tiles-mode"
            options={[
              { id: "", name: t`Lattice`, art: <ModeArt mode={props.themePreference} tint={tint} /> },
              ...themes.map((theme) => ({ id: theme.id, name: theme.name, art: <ThemeArt theme={theme} mode={props.themePreference} /> })),
            ]}
            onChange={chooseTheme}
          />
        </SettingsRow>
      )}
      <SettingsRow
        data-setting="theme-files"
        label={t`Theme files`}
        description={themesError ?? t`Install a .lattice-theme.json file. Lattice keeps its own copy.`}
      >
        <ThemeFileActions chosen={chosen} onInstalled={chooseTheme} onRemoved={() => patch({ theme: "" })} />
      </SettingsRow>
      <SettingsRow data-setting="theme-tint" label={t`Tint`} description={chosen ? t`Set by the theme` : undefined}>
        <TileGroup
          label={t`Tint`}
          value={tint}
          className="theme-tiles-tint"
          disabled={chosen !== undefined}
          options={THEME_TINTS.map((id) => ({ id, name: tintNames[id], art: <TintArt tint={id} /> }))}
          onChange={(next) => patch({ tint: next })}
        />
      </SettingsRow>
      <SettingsRow
        data-setting="theme-accent"
        label={t`Accent`}
        description={isCustomAccent(accent) ? <CustomAccentNote accent={accent} theme={props.theme} /> : accent === "theme" ? t`Theme default` : accentNames[accent]}
      >
        <SwatchGroup
          label={t`Accent`}
          value={pickedAccent}
          options={accentOptions}
          onChange={(next) => patch({ accent: next })}
        />
        <CustomAccent
          label={t`Custom accent color`}
          value={isCustomAccent(accent) ? accent : null}
          theme={props.theme}
          onChange={(next) => patch({ accent: next })}
          presets={(close) => (
            <SwatchGroup
              label={t`Presets`}
              value={pickedAccent}
              options={accentOptions.filter((option) => option.id !== "graphite" && option.id !== "theme")}
              onChange={(next) => {
                patch({ accent: next });
                close();
              }}
            />
          )}
        />
      </SettingsRow>
      <SettingsRow data-setting="translucency" label={t`Translucency`} description={translucencyNote[props.windowBacking]}>
        <SegmentedControl<Translucency>
          ariaLabel={t`Translucency`}
          value={translucency}
          onChange={(next) => patch({ translucency: next })}
          items={[
            { value: "off", label: t`Off` },
            { value: "subtle", label: t`Subtle` },
            { value: "strong", label: t`Strong` },
          ]}
          className="theme-translucency"
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * A miniature Lattice window in one appearance of a tint: the title bar, the
 * project, the editor with a heading in the accent, the PDF. It is drawn in a
 * theme-preview scope (theme.css), so it takes that appearance's real palette
 * whatever the window wears.
 */
function WindowArt(props: { kind: Theme; tint: ThemeTint; className?: string; style?: CSSProperties }) {
  return (
    <span className={props.className ? `theme-window ${props.className}` : "theme-window"} data-theme-preview={props.kind} data-tint-preview={props.tint} style={props.style}>
      <svg className="theme-window-art" viewBox="0 0 84 52" aria-hidden="true">
        <rect className="theme-art-chrome" width="84" height="52" />
        <circle className="theme-art-ink" cx="6" cy="5" r="1.4" /><circle className="theme-art-ink" cx="10.5" cy="5" r="1.4" /><circle className="theme-art-ink" cx="15" cy="5" r="1.4" />
        <rect className="theme-art-sheet" x="3" y="10" width="18" height="39" rx="2.5" />
        <rect className="theme-art-ink" x="6" y="14" width="10" height="2" rx="1" /><rect className="theme-art-ink" x="6" y="19" width="12" height="2" rx="1" /><rect className="theme-art-ink" x="6" y="24" width="8" height="2" rx="1" />
        <rect className="theme-art-sheet" x="23" y="10" width="34" height="39" rx="2.5" />
        <rect className="theme-art-accent" x="27" y="15" width="15" height="2.4" rx="1.2" />
        <rect className="theme-art-ink" x="27" y="21" width="24" height="2" rx="1" /><rect className="theme-art-ink" x="27" y="26" width="20" height="2" rx="1" /><rect className="theme-art-ink" x="27" y="31" width="25" height="2" rx="1" /><rect className="theme-art-ink" x="27" y="36" width="14" height="2" rx="1" />
        <rect className="theme-art-sheet" x="59" y="10" width="22" height="39" rx="2.5" />
        <rect className="theme-art-page" x="62" y="13" width="16" height="22" rx="1" />
        <rect className="theme-art-print" x="64.5" y="16.5" width="9" height="1.4" rx="0.7" /><rect className="theme-art-print" x="64.5" y="20" width="11" height="1" rx="0.5" /><rect className="theme-art-print" x="64.5" y="22.5" width="10" height="1" rx="0.5" /><rect className="theme-art-print" x="64.5" y="25" width="11" height="1" rx="0.5" />
      </svg>
    </span>
  );
}

/** "Match system" is both appearances, split on a diagonal, as macOS draws Auto. */
function ModeArt(props: { mode: ThemePreference; tint: ThemeTint }) {
  if (props.mode !== "system") return <WindowArt kind={props.mode} tint={props.tint} />;
  return (
    <span className="theme-window-split">
      <WindowArt kind="light" tint={props.tint} />
      <WindowArt kind="dark" tint={props.tint} className="theme-window-second" />
    </span>
  );
}

/**
 * A theme as the same miniature window, in the variant for each appearance it
 * would be used in. Its colors are set on the art itself, over the preview
 * scope's, so an appearance the theme leaves out shows Lattice's.
 */
function ThemeArt(props: { theme: ThemeInfo; mode: ThemePreference }) {
  const art = (kind: Theme, className?: string) => (
    <WindowArt
      kind={kind}
      tint="graphite"
      className={className}
      style={variantStyle(props.theme.variants.find((variant) => variant.appearance === kind))}
    />
  );
  if (props.mode !== "system") return art(props.mode);
  return (
    <span className="theme-window-split">
      {art("light")}
      {art("dark", "theme-window-second")}
    </span>
  );
}

function variantStyle(variant: ThemeVariantInfo | undefined): CSSProperties | undefined {
  if (!variant) return undefined;
  return {
    "--surface-chrome": variant.chrome,
    "--surface-panel": variant.panel,
    "--text-tertiary": variant.text,
    ...(variant.accent ? { "--tile-accent": variant.accent } : {}),
  } as CSSProperties;
}

/* eslint-disable lingui/no-unlocalized-strings -- a type specimen in each appearance, not copy */
/** A tint as both of its appearances, side by side, each with "Aa" in its own ink. */
function TintArt(props: { tint: ThemeTint }) {
  return (
    <span className="theme-tint-art">
      <span className="theme-tint-half" data-theme-preview="light" data-tint-preview={props.tint}>Aa</span>
      <span className="theme-tint-half" data-theme-preview="dark" data-tint-preview={props.tint}>Aa</span>
      <i className="theme-tint-mark" data-theme-preview="light" data-tint-preview={props.tint} />
    </span>
  );
}
/* eslint-enable lingui/no-unlocalized-strings */

/**
 * Pictured options as one radio group: one tab stop, arrow keys move and
 * choose, as the swatches below do. Each option is named, so tints that look
 * alike at a glance still read apart.
 */
function TileGroup<Id extends string>(props: {
  label: string;
  value: Id;
  options: { id: Id; name: string; art: ReactNode }[];
  onChange: (id: Id) => void;
  className: string;
  disabled?: boolean;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const selected = props.options.findIndex((option) => option.id === props.value);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const option = props.options[(index + step + props.options.length) % props.options.length];
    props.onChange(option.id);
    groupRef.current?.querySelector<HTMLElement>(`[data-tile="${option.id}"]`)?.focus();
  };
  return (
    <div ref={groupRef} className={`theme-tiles ${props.className}`} role="radiogroup" aria-label={props.label}>
      {props.options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          className="theme-tile"
          data-tile={option.id}
          aria-checked={index === selected}
          aria-label={option.name}
          tabIndex={index === (selected === -1 ? 0 : selected) ? 0 : -1}
          disabled={props.disabled}
          onClick={() => props.onChange(option.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          <span className="theme-tile-art">
            {option.art}
            {index === selected && <span className="theme-tile-check" aria-hidden="true"><Check size={9} strokeWidth={3} /></span>}
          </span>
          <span className="theme-tile-name" aria-hidden="true" title={option.name}>{option.name}</span>
        </button>
      ))}
    </div>
  );
}

type SwatchOption<Id extends string> = {
  id: Id;
  name: string;
  /** The preset attribute theme.css resolves on the swatch, so it shows the real color. */
  preset: Record<`data-${string}`, string>;
  fill: string;
  /** A color the swatch shows instead of its preset's (the theme's accent). */
  color?: string;
};

/**
 * A row of color swatches that behaves as one radio group: one tab stop,
 * arrow keys move and choose, as the system's own accent picker does.
 */
function SwatchGroup<Id extends string>(props: {
  label: string;
  value: Id | null;
  options: SwatchOption<Id>[];
  onChange: (id: Id) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const selected = props.options.findIndex((option) => option.id === props.value);
  const choose = (index: number) => {
    const option = props.options[(index + props.options.length) % props.options.length];
    props.onChange(option.id);
    groupRef.current?.querySelector<HTMLElement>(`[data-swatch="${option.id}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    choose(index + step);
  };
  return (
    <div ref={groupRef} className="theme-swatches" role="radiogroup" aria-label={props.label}>
      {props.options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          className="theme-swatch"
          data-swatch={option.id}
          aria-checked={index === selected}
          aria-label={option.name}
          title={option.name}
          tabIndex={index === (selected === -1 ? 0 : selected) ? 0 : -1}
          onClick={() => props.onChange(option.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
          {...option.preset}
        >
          <span className={`theme-swatch-fill ${option.fill}`} style={option.color ? { background: option.color } : undefined} />
          {index === selected && <Check className="theme-swatch-check" size={11} strokeWidth={2.4} aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

/**
 * The accent row's note for a custom color: what was picked and, when the
 * theme darkened it, the color drawn beside it that it uses instead (the
 * popover says why).
 */
function CustomAccentNote(props: { accent: `#${string}`; theme: Theme }) {
  const { t } = useLingui();
  const applied = useFittedAccent(props.accent, props.theme).color;
  const adjusted = applied.toLowerCase() !== props.accent.toLowerCase();
  return (
    <span className="theme-accent-note">
      <span className="theme-accent-pair" aria-hidden="true">
        <i style={{ background: props.accent }} />
        {adjusted && <><span>→</span><i style={{ background: applied }} /></>}
      </span>
      <span>{t`Custom ${props.accent.toUpperCase()}`}</span>
    </span>
  );
}

/**
 * The swatch after the presets opens Lattice's own picker beside it, applied
 * as it moves like every other choice here. It shows the color picked and,
 * when that would not read as text, the color the theme uses instead and why
 * (the app's own fitting, useFittedAccent); the stored value stays the one picked.
 */
function CustomAccent(props: {
  label: string;
  value: ThemeAccent | null;
  theme: Theme;
  onChange: (accent: ThemeAccent) => void;
  presets: (close: () => void) => ReactNode;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const selected = props.value !== null;
  // The picker opens on the editor's selection blue until a color is chosen.
  const picked = (props.value ?? "#3d7af2").toUpperCase();
  const fitted = useFittedAccent(picked, props.theme);
  const applied = fitted.color.toUpperCase();
  const adjusted = applied !== picked;
  const ratio = fitted.ratio.toFixed(1);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="theme-swatch theme-swatch-custom"
          aria-label={props.label}
          aria-pressed={selected}
          title={props.label}
        >
          <span className="theme-swatch-fill theme-custom-fill" style={selected ? { background: props.value ?? undefined } : undefined} />
          {selected
            ? <Check className="theme-swatch-check" size={11} strokeWidth={2.4} aria-hidden="true" />
            : <Plus className="theme-swatch-plus" size={11} strokeWidth={2.2} aria-hidden="true" />}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={8} className="theme-accent-popover">
        <div className="theme-accent-head">
          <span className="theme-accent-title">{t`Custom accent`}</span>
          {/* Only an adjusted color needs telling apart from the picker's own
              hex field, and only then is there something to say. The status
              region stays mounted so the change is announced. */}
          {adjusted && (
            <span className="theme-accent-chips">
              <span className="theme-accent-chip"><i style={{ background: picked }} />{t`Picked`}<code>{picked}</code></span>
              <span className="theme-accent-chip"><i style={{ background: applied }} />{t`In use`}<code>{applied}</code></span>
            </span>
          )}
          <span className="theme-accent-why" role="status">
            {adjusted && (
              <>
                {props.theme === "dark" ? <Moon size={11} strokeWidth={1.8} aria-hidden="true" /> : <Sun size={11} strokeWidth={1.8} aria-hidden="true" />}
                <span>{t`Adjusted so links and selected text read at ${ratio}:1`}</span>
              </>
            )}
          </span>
        </div>
        <ColorPicker
          label={props.label}
          value={picked}
          onChange={(hex) => props.onChange(hex.toLowerCase() as ThemeAccent)}
          swatches={[]}
          after={<div className="theme-accent-presets">{props.presets(() => setOpen(false))}</div>}
        />
      </PopoverContent>
    </Popover>
  );
}
