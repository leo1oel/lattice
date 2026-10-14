import { type CSSProperties, type KeyboardEvent, useRef } from "react";
import { Check, Moon } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { SegmentedControl } from "../components/ui/segmented-control";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import type { AppearanceSettings, Theme } from "./app-settings";
import {
  type CodeTheme,
  type CodeThemeVariant,
  type SyntaxRole,
  CODE_THEMES,
  codeThemeKinds,
  codeThemeName,
  codeThemeProperties,
  resolveCodeThemeKind,
  syntaxProperty,
} from "./code-themes";

type CodeThemeSettingsProps = {
  appearance: AppearanceSettings;
  setAppearance: (appearance: AppearanceSettings) => void;
  /** The app's resolved appearance, which a two-variant theme follows on `auto`. */
  theme: Theme;
};

/** A token of the preview: its text and the `--syntax-*` role that colors it (none for prose). */
type PreviewToken = [text: string, role?: SyntaxRole];

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX source, the same in every language */
/**
 * What every card shows: one of each token LaTeX colors, as the editor
 * styles it (latex-editor.ts): sectioning, a comment, a citation, an
 * environment, math with an operator and a number, and a cross-reference.
 */
const PREVIEW: PreviewToken[][] = [
  [["\\section", "function"], ["{", "bracket"], ["Method"], ["}", "bracket"]],
  [["% two passes", "comment"]],
  [["As in "], ["\\cite", "citation"], ["{", "bracket"], ["he16", "citation"], ["}", "bracket"], ["."]],
  [["\\begin", "keyword"], ["{", "bracket"], ["equation", "type"], ["}", "bracket"]],
  [["  "], ["E", "variable"], [" "], ["=", "operator"], [" "], ["mc", "variable"], ["^", "operator"], ["2", "number"],
    [" "], ["\\label", "reference"], ["{", "bracket"], ["e", "reference"], ["}", "bracket"]],
  [["\\end", "keyword"], ["{", "bracket"], ["equation", "type"], ["}", "bracket"]],
];
/* eslint-enable lingui/no-unlocalized-strings */

/** How the highlight style sets each role apart beyond its color. */
const ROLE_FACE: Partial<Record<SyntaxRole, CSSProperties>> = {
  function: { fontWeight: 500 },
  keyword: { fontWeight: 500 },
  comment: { fontStyle: "italic" },
  reference: { fontStyle: "italic" },
};

/**
 * Settings → Appearance → Code theme: a card per theme, each a live preview
 * in its own colors, and for a theme with a light and a dark variant, which
 * one shows. The editor behind the dialog takes each choice as it is made.
 */
export function CodeThemeSettingsGroup(props: CodeThemeSettingsProps) {
  const { t } = useLingui();
  const { codeTheme, codeThemeVariant } = props.appearance;
  const patch = (next: Partial<AppearanceSettings>) => props.setAppearance({ ...props.appearance, ...next });
  const nameOf = (theme: CodeTheme) => codeThemeName(theme) ?? t`Weft & Warp`;
  const kinds = codeThemeKinds(codeTheme);
  const only = kinds.length === 1 ? kinds[0] : null;
  const variantsOf = (theme: CodeTheme) => {
    const [first, second] = codeThemeKinds(theme);
    if (second) return t`Light and dark`;
    return first === "dark" ? t`Dark only` : t`Light only`;
  };

  return (
    <SettingsGroup title={t`Code theme`}>
      <SettingsRow
        data-setting="code-theme-variant"
        label={t`Light or dark`}
        description={only === "dark"
          ? t`${nameOf(codeTheme)} comes in dark only`
          : only === "light" ? t`${nameOf(codeTheme)} comes in light only` : t`Themes with both variants follow this; dark-only themes stay dark`}
      >
        <SegmentedControl<CodeThemeVariant>
          ariaLabel={t`Light or dark`}
          value={codeThemeVariant}
          onChange={(next) => patch({ codeThemeVariant: next })}
          items={[
            { value: "auto", label: t`Match app` },
            { value: "light", label: t`Light` },
            { value: "dark", label: t`Dark` },
          ]}
        />
      </SettingsRow>
      <CodeThemeCards
        label={t`Code theme`}
        value={codeTheme}
        options={CODE_THEMES.map((id) => {
          const both = codeThemeKinds(id).length === 2;
          // Weft & Warp's colors are the app's own (--lattice-*), so each of
          // its variants is drawn in a theme-preview scope of that appearance.
          const layer = (kind: Theme): PreviewLayer => ({
            style: codeThemeProperties(id, kind, props.theme) as CSSProperties,
            scope: id === "lattice" ? { "data-theme-preview": kind, "data-tint-preview": props.appearance.tint } : undefined,
          });
          return {
            id,
            name: nameOf(id),
            variants: variantsOf(id),
            darkOnly: !both && codeThemeKinds(id)[0] === "dark",
            layers: both ? [layer("light"), layer("dark")] : [layer(resolveCodeThemeKind(id, codeThemeVariant, props.theme))],
          };
        })}
        onChange={(next) => patch({ codeTheme: next })}
      />
    </SettingsGroup>
  );
}

type PreviewLayer = { style: CSSProperties; scope?: Record<"data-theme-preview" | "data-tint-preview", string> };

type CodeThemeOption = { id: CodeTheme; name: string; variants: string; darkOnly: boolean; layers: PreviewLayer[] };

/**
 * The theme cards as one radio group: one tab stop, arrow keys move and
 * choose, as the swatches above do (theme-settings.tsx).
 */
function CodeThemeCards(props: {
  label: string;
  value: CodeTheme;
  options: CodeThemeOption[];
  onChange: (id: CodeTheme) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const selected = props.options.findIndex((option) => option.id === props.value);
  const choose = (index: number) => {
    const option = props.options[(index + props.options.length) % props.options.length];
    props.onChange(option.id);
    groupRef.current?.querySelector<HTMLElement>(`[data-code-theme-card="${option.id}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    choose(index + step);
  };
  return (
    <div ref={groupRef} className="code-theme-cards" data-setting="code-theme" role="radiogroup" aria-label={props.label}>
      {props.options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          className="code-theme-card"
          data-code-theme-card={option.id}
          aria-checked={index === selected}
          aria-label={option.name}
          aria-description={option.variants}
          tabIndex={index === (selected === -1 ? 0 : selected) ? 0 : -1}
          onClick={() => props.onChange(option.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          <span className="code-theme-preview-frame" aria-hidden="true">
            {option.layers.map((layer, index) => (
              <Preview key={index} layer={layer} className={index ? "code-theme-preview-second" : undefined} />
            ))}
            {option.darkOnly && <span className="code-theme-badge"><Moon size={10} strokeWidth={2} /></span>}
          </span>
          <span className="code-theme-card-name" aria-hidden="true">
            {index === selected && <Check size={12} strokeWidth={2.2} />}
            <span>{option.name}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** The specimen in one variant's colors; a second variant lies over the first, clipped to its diagonal. */
function Preview(props: { layer: PreviewLayer; className?: string }) {
  return (
    <span className={props.className ? `code-theme-preview ${props.className}` : "code-theme-preview"} style={props.layer.style} {...props.layer.scope}>
      {PREVIEW.map((line, row) => (
        <span key={row} className="code-theme-preview-line">
          {line.map(([text, role], column) => (role
            ? <span key={column} style={{ color: `var(${syntaxProperty(role)})`, ...ROLE_FACE[role] }}>{text}</span>
            : text))}
        </span>
      ))}
    </span>
  );
}
