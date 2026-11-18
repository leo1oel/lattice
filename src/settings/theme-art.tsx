/**
 * The miniature Lattice windows Settings › Appearance draws its choices
 * with: an appearance of a tint, and a theme's variants (the Palette tiles
 * and the Browse themes rows).
 */
import type { CSSProperties } from "react";
import type { Theme, ThemePreference } from "./app-settings";
import type { ThemeTint } from "./theme-customization";

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
export function ModeArt(props: { mode: ThemePreference; tint: ThemeTint }) {
  if (props.mode !== "system") return <WindowArt kind={props.mode} tint={props.tint} />;
  return (
    <span className="theme-window-split">
      <WindowArt kind="light" tint={props.tint} />
      <WindowArt kind="dark" tint={props.tint} className="theme-window-second" />
    </span>
  );
}

/** The colors a variant's tile is drawn with; a role left out keeps Lattice's. */
export type ArtVariant = {
  appearance: Theme;
  chrome?: string;
  panel?: string;
  text?: string;
  accent?: string | null;
};

/**
 * A theme as the same miniature window, in the variant for each appearance it
 * would be used in. Its colors are set on the art itself, over the preview
 * scope's, so an appearance the theme leaves out shows Lattice's.
 */
export function ThemeArt(props: { variants: readonly ArtVariant[]; mode: ThemePreference }) {
  const art = (kind: Theme, className?: string) => (
    <WindowArt
      kind={kind}
      tint="graphite"
      className={className}
      style={variantStyle(props.variants.find((variant) => variant.appearance === kind))}
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

function variantStyle(variant: ArtVariant | undefined): CSSProperties | undefined {
  if (!variant) return undefined;
  const style: Record<string, string> = {};
  if (variant.chrome) style["--surface-chrome"] = variant.chrome;
  if (variant.panel) style["--surface-panel"] = variant.panel;
  if (variant.text) style["--text-tertiary"] = variant.text;
  if (variant.accent) style["--tile-accent"] = variant.accent;
  return style as CSSProperties;
}
