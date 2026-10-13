/**
 * The source editors' code theme (Settings → Appearance → Code theme): which
 * palette paints LaTeX, BibTeX, Markdown and every other CodeMirror source.
 *
 * Each named theme carries its editor's own colors, ground included, as it
 * ships upstream. Those colors are the source of truth here, and a token only
 * moves where it would read below 4.5:1 on its ground or its current line:
 * then it takes the nearest lightness with its own hue that does
 * (`fitContrast`), so Solarized's accents stay Solarized's and its comments
 * become legible.
 *
 * A variant in the app's own appearance draws on the window's editor
 * surface (`--editor-bg`), the sheet the other panels stand on, so the
 * editor, its tab and the panels beside it read as one surface under every
 * tint; Weft & Warp, Lattice's own palette
 * (styles/theme.css), always does. A theme with a light and a dark variant
 * can follow the app's appearance; a theme with one variant stays as chosen,
 * as a dark editor in a light app, and that one keeps its own ground.
 */

import type { Theme } from "./app-settings";
import { compositeHex, fitContrast } from "./theme-customization";

export const CODE_THEMES = [
  "github", "lattice", "one", "solarized", "catppuccin", "tokyo-night", "dracula", "nord", "monokai",
] as const;
export type CodeTheme = typeof CODE_THEMES[number];

/** Which variant of a two-variant theme: the app's own appearance, or one fixed. */
export const CODE_THEME_VARIANTS = ["auto", "light", "dark"] as const;
export type CodeThemeVariant = typeof CODE_THEME_VARIANTS[number];

/**
 * The token roles a palette colors, one `--syntax-*` property each. The
 * highlight styles (latex-editor.ts, editor-languages.ts) map CodeMirror's
 * tags onto them; LaTeX's own are commands (keyword), sectioning (function),
 * environment names (type), math (variable, with its delimiters in
 * variable-special), citations and cross-references.
 */
const SYNTAX_ROLES = [
  "keyword", "operator", "function", "type", "variable", "variable-special", "property", "attribute", "string",
  "comment", "comment-doc", "number", "constant", "bracket", "citation", "reference",
] as const;
export type SyntaxRole = typeof SYNTAX_ROLES[number];

/** The custom property that colors `role`. */
export const syntaxProperty = (role: SyntaxRole) => `--syntax-${role}` as const;

type Palette = {
  ground: string;
  ink: string;
  lineNumber: string;
  caret: string;
  /** `#rrggbb`, or `#rrggbbaa` over the ground. */
  selection: string;
  tokens: Record<SyntaxRole, string>;
};

type ThemeSource = { name: string; light?: Palette; dark?: Palette };

/* eslint-disable lingui/no-unlocalized-strings -- theme names are proper names; colors are data */
const THEMES: Record<Exclude<CodeTheme, "lattice">, ThemeSource> = {
  // Primer's GitHub Light Default and GitHub Dark Default.
  github: {
    name: "GitHub",
    light: {
      ground: "#ffffff", ink: "#1f2328", lineNumber: "#8c959f", caret: "#0969da", selection: "#0969da33",
      tokens: {
        keyword: "#cf222e", operator: "#cf222e", function: "#8250df", type: "#116329", variable: "#0550ae",
        "variable-special": "#0550ae", property: "#0550ae", attribute: "#0550ae", string: "#0a3069",
        comment: "#59636e", "comment-doc": "#0a3069", number: "#0550ae", constant: "#0550ae", bracket: "#1f2328",
        citation: "#0a3069", reference: "#953800",
      },
    },
    dark: {
      ground: "#0d1117", ink: "#e6edf3", lineNumber: "#6e7681", caret: "#2f81f7", selection: "#388bfd33",
      tokens: {
        keyword: "#ff7b72", operator: "#ff7b72", function: "#d2a8ff", type: "#7ee787", variable: "#79c0ff",
        "variable-special": "#79c0ff", property: "#79c0ff", attribute: "#79c0ff", string: "#a5d6ff",
        comment: "#8b949e", "comment-doc": "#a5d6ff", number: "#79c0ff", constant: "#79c0ff", bracket: "#e6edf3",
        citation: "#a5d6ff", reference: "#ffa657",
      },
    },
  },
  // Atom's One Light and One Dark.
  one: {
    name: "One",
    light: {
      ground: "#fafafa", ink: "#383a42", lineNumber: "#9d9d9f", caret: "#526fff", selection: "#e5e5e6",
      tokens: {
        keyword: "#a626a4", operator: "#0184bc", function: "#4078f2", type: "#c18401", variable: "#e45649",
        "variable-special": "#e45649", property: "#e45649", attribute: "#986801", string: "#50a14f",
        comment: "#a0a1a7", "comment-doc": "#50a14f", number: "#986801", constant: "#986801", bracket: "#383a42",
        citation: "#50a14f", reference: "#0184bc",
      },
    },
    dark: {
      ground: "#282c34", ink: "#abb2bf", lineNumber: "#495162", caret: "#528bff", selection: "#3e4451",
      tokens: {
        keyword: "#c678dd", operator: "#56b6c2", function: "#61afef", type: "#e5c07b", variable: "#e06c75",
        "variable-special": "#e06c75", property: "#e06c75", attribute: "#d19a66", string: "#98c379",
        comment: "#5c6370", "comment-doc": "#98c379", number: "#d19a66", constant: "#d19a66", bracket: "#abb2bf",
        citation: "#98c379", reference: "#56b6c2",
      },
    },
  },
  // Ethan Schoonover's Solarized: base3/base03 grounds, the shared accents.
  solarized: {
    name: "Solarized",
    light: {
      ground: "#fdf6e3", ink: "#657b83", lineNumber: "#93a1a1", caret: "#657b83", selection: "#eee8d5",
      tokens: {
        keyword: "#859900", operator: "#859900", function: "#268bd2", type: "#b58900", variable: "#6c71c4",
        "variable-special": "#6c71c4", property: "#268bd2", attribute: "#b58900", string: "#2aa198",
        comment: "#93a1a1", "comment-doc": "#2aa198", number: "#d33682", constant: "#cb4b16", bracket: "#657b83",
        citation: "#2aa198", reference: "#cb4b16",
      },
    },
    dark: {
      ground: "#002b36", ink: "#839496", lineNumber: "#586e75", caret: "#839496", selection: "#274642",
      tokens: {
        keyword: "#859900", operator: "#859900", function: "#268bd2", type: "#b58900", variable: "#6c71c4",
        "variable-special": "#6c71c4", property: "#268bd2", attribute: "#b58900", string: "#2aa198",
        comment: "#586e75", "comment-doc": "#2aa198", number: "#d33682", constant: "#cb4b16", bracket: "#839496",
        citation: "#2aa198", reference: "#cb4b16",
      },
    },
  },
  // Catppuccin Latte and Mocha, by the style guide's roles.
  catppuccin: {
    name: "Catppuccin",
    light: {
      ground: "#eff1f5", ink: "#4c4f69", lineNumber: "#8c8fa1", caret: "#dc8a78", selection: "#7c7f9340",
      tokens: {
        keyword: "#8839ef", operator: "#04a5e5", function: "#1e66f5", type: "#df8e1d", variable: "#179299",
        "variable-special": "#ea76cb", property: "#7287fd", attribute: "#df8e1d", string: "#40a02b",
        comment: "#7c7f93", "comment-doc": "#40a02b", number: "#fe640b", constant: "#fe640b", bracket: "#7c7f93",
        citation: "#40a02b", reference: "#e64553",
      },
    },
    dark: {
      ground: "#1e1e2e", ink: "#cdd6f4", lineNumber: "#7f849c", caret: "#f5e0dc", selection: "#9399b240",
      tokens: {
        keyword: "#cba6f7", operator: "#89dceb", function: "#89b4fa", type: "#f9e2af", variable: "#94e2d5",
        "variable-special": "#f5c2e7", property: "#b4befe", attribute: "#f9e2af", string: "#a6e3a1",
        comment: "#9399b2", "comment-doc": "#a6e3a1", number: "#fab387", constant: "#fab387", bracket: "#9399b2",
        citation: "#a6e3a1", reference: "#eba0ac",
      },
    },
  },
  "tokyo-night": {
    name: "Tokyo Night",
    dark: {
      ground: "#1a1b26", ink: "#a9b1d6", lineNumber: "#363b54", caret: "#c0caf5", selection: "#515c7e4d",
      tokens: {
        keyword: "#bb9af7", operator: "#89ddff", function: "#7aa2f7", type: "#2ac3de", variable: "#e0af68",
        "variable-special": "#89ddff", property: "#73daca", attribute: "#bb9af7", string: "#9ece6a",
        comment: "#565f89", "comment-doc": "#9ece6a", number: "#ff9e64", constant: "#ff9e64", bracket: "#a9b1d6",
        citation: "#9ece6a", reference: "#73daca",
      },
    },
  },
  dracula: {
    name: "Dracula",
    dark: {
      ground: "#282a36", ink: "#f8f8f2", lineNumber: "#6272a4", caret: "#f8f8f0", selection: "#44475a",
      tokens: {
        keyword: "#ff79c6", operator: "#ff79c6", function: "#50fa7b", type: "#8be9fd", variable: "#bd93f9",
        "variable-special": "#bd93f9", property: "#8be9fd", attribute: "#50fa7b", string: "#f1fa8c",
        comment: "#6272a4", "comment-doc": "#f1fa8c", number: "#bd93f9", constant: "#bd93f9", bracket: "#f8f8f2",
        citation: "#f1fa8c", reference: "#ffb86c",
      },
    },
  },
  nord: {
    name: "Nord",
    dark: {
      ground: "#2e3440", ink: "#d8dee9", lineNumber: "#4c566a", caret: "#d8dee9", selection: "#434c5e",
      tokens: {
        keyword: "#81a1c1", operator: "#81a1c1", function: "#88c0d0", type: "#8fbcbb", variable: "#b48ead",
        "variable-special": "#ebcb8b", property: "#88c0d0", attribute: "#8fbcbb", string: "#a3be8c",
        comment: "#616e88", "comment-doc": "#a3be8c", number: "#b48ead", constant: "#b48ead", bracket: "#d8dee9",
        citation: "#a3be8c", reference: "#d08770",
      },
    },
  },
  monokai: {
    name: "Monokai",
    dark: {
      ground: "#272822", ink: "#f8f8f2", lineNumber: "#90908a", caret: "#f8f8f0", selection: "#49483e",
      tokens: {
        keyword: "#f92672", operator: "#f92672", function: "#a6e22e", type: "#66d9ef", variable: "#ae81ff",
        "variable-special": "#ae81ff", property: "#66d9ef", attribute: "#a6e22e", string: "#e6db74",
        comment: "#75715e", "comment-doc": "#e6db74", number: "#ae81ff", constant: "#ae81ff", bracket: "#f8f8f2",
        citation: "#e6db74", reference: "#fd971f",
      },
    },
  },
};
/* eslint-enable lingui/no-unlocalized-strings */

/** A theme's proper name, or undefined for Weft & Warp, which the interface names in its language. */
export function codeThemeName(theme: CodeTheme): string | undefined {
  return theme === "lattice" ? undefined : THEMES[theme].name;
}

/** The variants a theme has: both, or its one. */
export function codeThemeKinds(theme: CodeTheme): Theme[] {
  if (theme === "lattice") return ["light", "dark"];
  return (["light", "dark"] as const).filter((kind) => THEMES[theme][kind]);
}

/** Light or dark: what the editor shows for this choice while the app is `appTheme`. */
export function resolveCodeThemeKind(theme: CodeTheme, variant: CodeThemeVariant, appTheme: Theme): Theme {
  const kinds = codeThemeKinds(theme);
  const wanted = variant === "auto" ? appTheme : variant;
  return kinds.includes(wanted) ? wanted : kinds[0];
}

/**
 * `--editor-bg` in each tint (styles/theme.css), the ground a variant in the
 * app's appearance stands on: its tokens are fitted on every one of them, so
 * they read whichever tint is chosen.
 */
const EDITOR_GROUNDS: Record<Theme, readonly string[]> = {
  light: ["#fafafa", "#fcf9f4", "#f6fbf6", "#f4faff", "#faf8ff"],
  dark: ["#1f1f22", "#1d1b18", "#191c1a", "#181c1f", "#1c1a1f"],
};
const EDITOR_GROUND = "var(--editor-bg)";

/** The current line's wash: the ink at the strength Lattice's own editor uses. */
const LINE_ALPHA = 0.05;
/** An unfocused editor keeps its selection at this share of the focused one. */
const UNFOCUSED_SELECTION = 0.6;

/** `color` at `alpha` over the window's editor ground, as CSS. */
function overEditorGround(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${+(alpha * 100).toFixed(2)}%, ${EDITOR_GROUND})`;
}

/** Every `--code-*` property codeThemeProperties sets; styles/foundations.css declares each. */
const CODE_PROPERTIES = [
  "--code-ground", "--code-ink", "--code-line-number", "--code-line-number-contrast", "--code-caret", "--code-line",
  "--code-selection", "--code-selection-focused",
] as const;

const cache = new Map<string, Record<string, string>>();

/**
 * The custom properties that paint a source editor in `theme`'s `kind` while
 * the app is `appTheme`: `--syntax-*` for tokens and `--code-*` for the
 * ground, ink, gutter, caret, current line and selection (their defaults are
 * Weft & Warp's, in styles/foundations.css). Set on the root they dress every
 * source editor; set on an element they dress a preview of the theme.
 */
export function codeThemeProperties(theme: CodeTheme, kind: Theme, appTheme: Theme): Record<string, string> {
  const key = `${theme}:${kind}:${appTheme}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let properties: Record<string, string>;
  if (theme === "lattice") {
    // The palette's own declarations, so a preview inside a root that wears
    // another theme still shows Weft & Warp in the app's appearance.
    properties = Object.fromEntries([...SYNTAX_ROLES.map(syntaxProperty), ...CODE_PROPERTIES]
      .map((name) => [name, `var(${name.replace("--", "--lattice-")})`]));
  } else {
    const palette = THEMES[theme][kind] ?? THEMES[theme][codeThemeKinds(theme)[0]]!;
    const onWindow = kind === appTheme;
    const grounds = onWindow ? EDITOR_GROUNDS[kind] : [palette.ground];
    const lines = grounds.map((ground) => compositeHex(palette.ink, LINE_ALPHA, ground));
    // Every token reads at 4.5:1 on the ground and the current line. Not on
    // the selection: the strong ones some themes ship (Monokai's, One Dark's)
    // would wash every token toward white, and a selection is read as a
    // span, not word by word.
    const fit = (color: string, ratio = 4.5, on: readonly string[] = [...grounds, ...lines]) => fitContrast(color, on, ratio, kind);
    // `#rrggbbaa` selections lie over the ground at their alpha.
    const [selection, alpha] = palette.selection.length === 9
      ? [palette.selection.slice(0, 7), parseInt(palette.selection.slice(7), 16) / 255]
      : [palette.selection, 1];
    const surface = onWindow
      ? {
          "--code-ground": EDITOR_GROUND,
          "--code-line": overEditorGround(palette.ink, LINE_ALPHA),
          "--code-selection": overEditorGround(selection, alpha * UNFOCUSED_SELECTION),
          "--code-selection-focused": overEditorGround(selection, alpha),
        }
      : {
          "--code-ground": palette.ground,
          "--code-line": lines[0],
          "--code-selection": compositeHex(selection, alpha * UNFOCUSED_SELECTION, palette.ground),
          "--code-selection-focused": compositeHex(selection, alpha, palette.ground),
        };
    properties = {
      ...Object.fromEntries(SYNTAX_ROLES.map((role) => [syntaxProperty(role), fit(palette.tokens[role])])),
      ...surface,
      "--code-ink": fit(palette.ink),
      // Line numbers are not read as text, so they hold the 3:1 of a UI
      // mark; the More Contrast setting raises them to text's 4.5:1.
      "--code-line-number": fit(palette.lineNumber, 3, grounds),
      "--code-line-number-contrast": fit(palette.lineNumber, 4.5, grounds),
      "--code-caret": fit(palette.caret, 3),
    };
  }
  cache.set(key, properties);
  return properties;
}

