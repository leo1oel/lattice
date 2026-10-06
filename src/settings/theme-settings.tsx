import { Check } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { SegmentedControl } from "../components/ui/segmented-control";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SelectRow } from "./settings-controls";
import type { AppearanceSettings, ThemePreference } from "./app-settings";
import {
  type AccentPreset,
  type ThemeAccent,
  type ThemeTint,
  type Translucency,
  ACCENT_PRESETS,
  THEME_TINTS,
  isCustomAccent,
} from "./theme-customization";
import type { WindowBacking } from "./use-appearance";

type ThemeSettingsProps = {
  appearance: AppearanceSettings;
  setAppearance: (appearance: AppearanceSettings) => void;
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
  windowBacking: WindowBacking;
};

/**
 * Settings → Appearance → Theme: light or dark, then a tint, an accent and
 * the window's translucency. Every choice applies as it is made, so the app
 * behind the dialog is the preview.
 */
export function ThemeSettingsGroup(props: ThemeSettingsProps) {
  const { t } = useLingui();
  const { tint, accent, translucency } = props.appearance;
  const patch = (next: Partial<AppearanceSettings>) => props.setAppearance({ ...props.appearance, ...next });
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
  const translucencyNote: Record<WindowBacking, string> = {
    translucent: t`The desktop shows through the title bar and sidebars`,
    opaque: t`The desktop shows through the title bar and sidebars`,
    reducedTransparency: t`Off while Reduce transparency is on in System Settings`,
    unsupported: t`Only in the Lattice window on macOS`,
  };

  return (
    <SettingsGroup title={t`Theme`}>
      <SelectRow
        data-setting="color-theme"
        label={t`Color theme`}
        value={props.themePreference}
        options={{ system: t`Match system`, light: t`Light`, dark: t`Dark` }}
        onChange={props.setThemePreference}
      />
      <SettingsRow data-setting="theme-tint" label={t`Tint`} description={tintNames[tint]}>
        <SwatchGroup
          label={t`Tint`}
          value={tint}
          options={THEME_TINTS.map((id) => ({
            id,
            name: tintNames[id],
            preset: { "data-tint": id },
            fill: "theme-tint-fill",
          }))}
          onChange={(next) => patch({ tint: next })}
        />
      </SettingsRow>
      <SettingsRow
        data-setting="theme-accent"
        label={t`Accent`}
        description={isCustomAccent(accent) ? t`Custom` : accentNames[accent]}
      >
        <SwatchGroup
          label={t`Accent`}
          value={isCustomAccent(accent) ? null : accent}
          options={ACCENT_PRESETS.map((id) => ({
            id,
            name: accentNames[id],
            preset: { "data-accent": id },
            fill: "theme-accent-fill",
          }))}
          onChange={(next) => patch({ accent: next })}
        />
        <CustomAccent
          label={t`Custom accent color`}
          value={isCustomAccent(accent) ? accent : null}
          onChange={(next) => patch({ accent: next })}
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

type SwatchOption<Id extends string> = {
  id: Id;
  name: string;
  /** The preset attribute theme.css resolves on the swatch, so it shows the real color. */
  preset: Record<`data-${string}`, string>;
  fill: string;
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
          <span className={`theme-swatch-fill ${option.fill}`} />
          {index === selected && <Check className="theme-swatch-check" size={11} strokeWidth={2.4} aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

/**
 * The swatch after the presets opens the system color picker, which applies
 * as it is dragged. A color that would not read as text is fitted when it is
 * applied (theme-customization.ts), so any pick stays usable.
 */
function CustomAccent(props: { label: string; value: ThemeAccent | null; onChange: (accent: ThemeAccent) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = props.value !== null;
  return (
    <button
      type="button"
      className="theme-swatch theme-swatch-custom"
      aria-label={props.label}
      aria-pressed={selected}
      title={props.label}
      onClick={() => inputRef.current?.click()}
    >
      <span
        className="theme-swatch-fill theme-custom-fill"
        style={selected ? { background: props.value ?? undefined } : undefined}
      />
      {selected && <Check className="theme-swatch-check" size={11} strokeWidth={2.4} aria-hidden="true" />}
      <input
        ref={inputRef}
        type="color"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        // The picker opens on the editor's selection blue until a color is chosen.
        value={props.value ?? "#3d7af2"}
        onChange={(event) => props.onChange(event.target.value.toLowerCase() as ThemeAccent)}
      />
    </button>
  );
}
