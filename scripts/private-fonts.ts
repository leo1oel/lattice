import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Plugin, searchForWorkspaceRoot } from "vite";

/**
 * Embeds the Timeless type family (timeless.co) into a local build when the
 * person building has a copy of it, and leaves the build exactly as it was when
 * they do not. See docs/design-system.md, "Private interface fonts".
 *
 * The Timeless Free Font License allows embedding the fonts in an application
 * but forbids putting them on a public repository or redistributing them, so
 * they are never in this repository: the build reads them, unmodified, from
 * `LATTICE_PRIVATE_FONTS_DIR` (default: the download's folder in ~/Downloads)
 * and Vite emits them as hashed assets of the built app only. Set the variable
 * to an empty string to build without them. `src/platform/font-license-guard.test.ts`
 * fails if a Timeless file is ever tracked.
 *
 * Everything the app sees is two virtual modules: the stylesheet below
 * (`@font-face` rules and the font-role tokens that put the faces first) and
 * the license module, the URL of the download's LICENSE.pdf, emitted unmodified
 * beside the fonts, which Settings › About › Acknowledgements opens: the
 * license lets the fonts go to no one without a copy of it. Without the fonts
 * the stylesheet is empty, the URL is null, and `src/styles/theme.css`'s
 * tokens stand as they always did.
 *
 * Release builds fetch the fonts from a private repository and set
 * `LATTICE_PRIVATE_FONTS_REQUIRED=1`, which turns a missing or incomplete copy
 * into a build error instead of a quiet fallback.
 */

export const PRIVATE_FONTS_ENV = "LATTICE_PRIVATE_FONTS_DIR";
export const PRIVATE_FONTS_REQUIRED_ENV = "LATTICE_PRIVATE_FONTS_REQUIRED";
const PRIVATE_FONTS_MODULE = "virtual:lattice-private-fonts.css";
const PRIVATE_FONTS_LICENSE_MODULE = "virtual:lattice-private-fonts-license";
// A path-like id that ends in .css, so Vite's CSS pipeline (url() rewriting,
// asset emission, bundling into the app stylesheet) handles it like a file.
const RESOLVED_MODULE = "/__lattice-private-fonts.css";
const RESOLVED_LICENSE_MODULE = "\0lattice-private-fonts-license";
/** The license, beside the fonts in the download's root folder. */
export const LICENSE_FILE = "LICENSE.pdf";
// The alias the stylesheet's url()s go through; Vite resolves CSS url()s with
// aliases, so the faces become ordinary emitted assets.
const FONT_ALIAS = "@lattice-private-fonts";

const DEFAULT_DIRECTORY = path.join(os.homedir(), "Downloads", "Timeless-Type-Family-1.094");

/**
 * Timeless runs about 3.5% narrower than Inter with a smaller x-height. Scaling
 * by these factors (measured over every English UI string, regular to
 * semibold, and over the OS/2 x-heights) keeps line widths, truncation and
 * wrapping where the Inter build has them, and keeps Latin the same size beside
 * PingFang SC as before. The vertical overrides are Inter's ascent and descent
 * divided by the factor, because size-adjust also scales them: line boxes and
 * baselines stay where they were too.
 */
const SANS_SIZE_ADJUST = 1.04;
const SERIF_SIZE_ADJUST = 1.05;
const INTER_ASCENT = 0.969;
const INTER_DESCENT = 0.241;

type Face = {
  family: "Timeless Sans" | "Timeless Serif Text" | "Timeless Serif";
  /** Relative to the Timeless download's root folder. */
  file: string;
  weight: string;
  style: "normal" | "italic";
  sizeAdjust: number;
};

const sans = (file: string, weight: string, style: Face["style"] = "normal"): Face =>
  ({ family: "Timeless Sans", file, weight, style, sizeAdjust: SANS_SIZE_ADJUST });
const serifText = (file: string, weight: string, style: Face["style"] = "normal"): Face =>
  ({ family: "Timeless Serif Text", file, weight, style, sizeAdjust: SERIF_SIZE_ADJUST });

/**
 * The interface face is Timeless Sans in its Grotesk style, which is the
 * variable font's default style: one file covers every weight the interface
 * uses (including the 650 roles) with no font-variation-settings, which
 * components that animate `wght` would otherwise override. Its italic axis is
 * not CSS's 0–1 range, so italics come from the static cuts.
 *
 * Reading surfaces use the Text cut of Timeless Serif, drawn for body sizes.
 * The display cut sets only the welcome title.
 */
export const FACES: readonly Face[] = [
  sans("Sans-Grotesk/TimelessSansVF.woff2", "300 800"),
  sans("Sans-Grotesk/static/woff2/TimelessSans-GroteskRegularItalic.woff2", "400", "italic"),
  sans("Sans-Grotesk/static/woff2/TimelessSans-GroteskSemiboldItalic.woff2", "600", "italic"),
  serifText("Serif-Text/static/woff2/TimelessSerif-TextRegular.woff2", "400"),
  serifText("Serif-Text/static/woff2/TimelessSerif-TextMedium.woff2", "500"),
  serifText("Serif-Text/static/woff2/TimelessSerif-TextSemibold.woff2", "600"),
  serifText("Serif-Text/static/woff2/TimelessSerif-TextBold.woff2", "700"),
  serifText("Serif-Text/TimelessSerifItalicVF.woff2", "300 700", "italic"),
  { family: "Timeless Serif", file: "Serif-Text/static/woff2/TimelessSerif-Regular.woff2", weight: "400", style: "normal", sizeAdjust: 1 },
];

/**
 * The fonts' folder, or null when this build goes without them. Throws when
 * the build requires them (`LATTICE_PRIVATE_FONTS_REQUIRED=1`) and they are
 * not all there.
 */
export function privateFontsDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[PRIVATE_FONTS_ENV];
  const required = env[PRIVATE_FONTS_REQUIRED_ENV] === "1";
  const directory = configured === "" ? null : path.resolve(configured ?? DEFAULT_DIRECTORY);
  // All or nothing: a partial copy would mix faces and metrics, and fonts
  // without their license may not be shipped at all.
  const complete = directory !== null
    && [LICENSE_FILE, ...FACES.map((face) => face.file)].every((file) => existsSync(path.join(directory, file)));
  if (complete) return directory;
  if (required) {
    throw new Error(`${PRIVATE_FONTS_REQUIRED_ENV}=1, but ${PRIVATE_FONTS_ENV} (${configured ?? DEFAULT_DIRECTORY}) does not hold ${LICENSE_FILE} and every embedded face`);
  }
  return null;
}

const percent = (value: number) => `${+(value * 100).toFixed(2)}%`;

function fontFace(face: Face): string {
  const descriptors = [
    `font-family: "${face.family}"`,
    `src: url("${FONT_ALIAS}/${face.file}") format("woff2")`,
    `font-weight: ${face.weight}`,
    `font-style: ${face.style}`,
    "font-display: swap",
  ];
  if (face.sizeAdjust !== 1) {
    descriptors.push(
      `size-adjust: ${percent(face.sizeAdjust)}`,
      `ascent-override: ${percent(INTER_ASCENT / face.sizeAdjust)}`,
      `descent-override: ${percent(INTER_DESCENT / face.sizeAdjust)}`,
      "line-gap-override: 0%",
    );
  }
  return `@font-face { ${descriptors.join("; ")}; }`;
}

/** The virtual stylesheet: empty unless the fonts are embedded. */
export function privateFontsStylesheet(embedded: boolean): string {
  if (!embedded) return "";
  return [
    ...FACES.map(fontFace),
    // `html:root` outranks theme.css's `:root`, so the override does not
    // depend on where the bundler puts this sheet.
    "html:root {",
    '  --ui-font: "Timeless Sans", var(--ui-font-fallback);',
    '  --reading-font: "Timeless Serif Text", var(--ui-font-fallback);',
    '  --display-font: "Timeless Serif", var(--display-font-fallback);',
    "}",
    "",
  ].join("\n");
}

/**
 * The license module: the URL of the download's LICENSE.pdf, emitted unmodified
 * as a hashed asset of the app (never inlined, so the shipped copy stays
 * byte-identical), or null when the build has no fonts.
 */
function privateFontsLicenseModule(embedded: boolean): string {
  return embedded
    ? `export { default as fontLicenseUrl } from "${FONT_ALIAS}/${LICENSE_FILE}?url&no-inline";\n`
    : "export const fontLicenseUrl = null;\n";
}

/**
 * `directory` overrides the environment, so a test runner can build without
 * whatever fonts the machine happens to have.
 */
export function privateFontsPlugin(options: { directory?: string | null } = {}): Plugin {
  const directory = options.directory !== undefined ? options.directory : privateFontsDirectory();
  return {
    name: "lattice:private-fonts",
    config: () => ({
      resolve: directory ? { alias: { [FONT_ALIAS]: directory } } : undefined,
      // The dev server serves files outside the workspace only from allowed
      // roots; setting the list replaces the default, so it is restated.
      server: directory ? { fs: { allow: [searchForWorkspaceRoot(process.cwd()), directory] } } : undefined,
    }),
    configResolved(config) {
      config.logger.info(directory
        ? `Timeless fonts: embedding from ${directory}`
        : `Timeless fonts: not found (set ${PRIVATE_FONTS_ENV}); using the open-licensed interface fonts`);
    },
    resolveId(id) {
      if (id === PRIVATE_FONTS_MODULE) return RESOLVED_MODULE;
      if (id === PRIVATE_FONTS_LICENSE_MODULE) return RESOLVED_LICENSE_MODULE;
      return undefined;
    },
    load(id) {
      if (id === RESOLVED_MODULE) return privateFontsStylesheet(directory !== null);
      if (id === RESOLVED_LICENSE_MODULE) return privateFontsLicenseModule(directory !== null);
      return undefined;
    },
  };
}
