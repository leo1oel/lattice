import { existsSync, readFileSync } from "node:fs";
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
 * the license module, the text of the download's LICENSE.pdf, which Settings ›
 * About › Acknowledgements shows: the license lets the fonts go to no one
 * without a copy of it. Without the fonts both are empty, and
 * `src/styles/theme.css`'s tokens stand as they always did.
 *
 * Release builds fetch the fonts from a private repository and set
 * `LATTICE_PRIVATE_FONTS_REQUIRED=1`, which turns a missing or incomplete copy
 * into a build error instead of a quiet fallback.
 */

export const PRIVATE_FONTS_ENV = "LATTICE_PRIVATE_FONTS_DIR";
export const PRIVATE_FONTS_REQUIRED_ENV = "LATTICE_PRIVATE_FONTS_REQUIRED";
export const PRIVATE_FONTS_MODULE = "virtual:lattice-private-fonts.css";
export const PRIVATE_FONTS_LICENSE_MODULE = "virtual:lattice-private-fonts-license";
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

/** A run of text on a page of the license, in PDF points (y grows upward). */
export type LicenseTextItem = { str: string; x: number; y: number; width: number; height: number };

/** What the license module exports: null when the build has no fonts. */
export type FontLicense = { title: string; text: string };

/**
 * The license's paragraphs, in reading order. The PDF (printed from a web page)
 * draws each page's headings after its body text, so runs are put back in
 * place by position: top to bottom, then left to right. A line follows the one
 * above it in the same paragraph when it sits within 1.75 lines of
 * it (by the smaller of the two, so a wrapped heading holds together but the
 * body under it does not join it). A paragraph indented past the body text is
 * a list item, whose bullet the PDF draws as a shape rather than text. A page
 * break ends a paragraph.
 */
export function licenseParagraphs(pages: readonly (readonly LicenseTextItem[])[]): string[] {
  type Line = { text: string; x: number; y: number; height: number };
  const pageLines = pages.map((items) => {
    const sorted = items.filter((item) => item.str.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: LicenseTextItem[][] = [];
    for (const item of sorted) {
      const row = rows.at(-1);
      if (row && Math.abs(row[0].y - item.y) < Math.min(row[0].height, item.height) / 2) row.push(item);
      else rows.push([item]);
    }
    return rows.map((row): Line => {
      const runs = [...row].sort((a, b) => a.x - b.x);
      let text = "";
      runs.forEach((run, index) => {
        const previous = runs[index - 1];
        // Runs that touch are one word ("hello@timeless.co" and its "."); a
        // visible gap is a space.
        const touching = previous && run.x - (previous.x + previous.width) < run.height * 0.15;
        text += (previous && !touching ? " " : "") + run.str;
      });
      return {
        text: text.replace(/\s+/g, " ").trim(),
        x: runs[0].x,
        y: runs[0].y,
        height: Math.max(...runs.map((run) => run.height)),
      };
    });
  });
  // The body text's left edge: the most common one.
  const edges = new Map<number, number>();
  for (const line of pageLines.flat()) edges.set(Math.round(line.x), (edges.get(Math.round(line.x)) ?? 0) + 1);
  const bodyX = [...edges].reduce((best, entry) => (entry[1] > best[1] ? entry : best), [0, 0])[0];

  const paragraphs: string[] = [];
  for (const lines of pageLines) {
    let previous: Line | null = null;
    for (const line of lines) {
      const continues = previous && previous.y - line.y <= 1.75 * Math.min(previous.height, line.height);
      if (continues) {
        const last = paragraphs.length - 1;
        // A line broken after a hyphen ("custom-" / "business") keeps it and
        // takes no space.
        paragraphs[last] += (/\w-$/.test(paragraphs[last]) ? "" : " ") + line.text;
      } else {
        paragraphs.push((line.x - bodyX > line.height / 2 ? "• " : "") + line.text);
      }
      previous = line;
    }
  }
  return paragraphs;
}

/** The license's title and text, read from the download's LICENSE.pdf. */
export async function readFontLicense(directory: string): Promise<FontLicense> {
  const file = path.join(directory, LICENSE_FILE);
  // The legacy build is the one PDF.js supports in Node; it is only loaded by
  // a build that embeds the fonts.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: new Uint8Array(readFileSync(file)), isEvalSupported: false });
  try {
    const pdf = await loading.promise;
    const { info } = await pdf.getMetadata();
    const title = typeof (info as { Title?: unknown }).Title === "string" ? (info as { Title: string }).Title.trim() : "";
    const pages: LicenseTextItem[][] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const content = await (await pdf.getPage(number)).getTextContent();
      pages.push(content.items.flatMap((item) => ("str" in item
        ? [{ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height }]
        : [])));
    }
    const text = licenseParagraphs(pages).join("\n\n");
    // The version shipped with the fonts is the one that applies to them, so
    // an unreadable or unexpected license stops the build rather than shipping
    // the fonts without it.
    if (!/^Timeless Free Font License \d/.test(title) || !text.includes("Timeless Free Font License")) {
      throw new Error(`${file} did not read as the Timeless Free Font License (title: ${JSON.stringify(title)})`);
    }
    return { title, text };
  } finally {
    await loading.destroy();
  }
}

/** The license module: the license, or null when the build has no fonts. */
export function privateFontsLicenseModule(license: FontLicense | null): string {
  return `export const fontLicense = ${JSON.stringify(license)};\n`;
}

/**
 * `directory` overrides the environment, so a test runner can build without
 * whatever fonts the machine happens to have.
 */
export function privateFontsPlugin(options: { directory?: string | null } = {}): Plugin {
  const directory = options.directory !== undefined ? options.directory : privateFontsDirectory();
  let license: Promise<FontLicense> | null = null;
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
    load: {
      // Only this plugin's modules reach the hook, so the async license read
      // costs the other thousands of modules nothing.
      filter: { id: /^(?:\/__lattice-private-fonts\.css|\0lattice-private-fonts-license)$/ },
      async handler(id) {
        if (id === RESOLVED_MODULE) return privateFontsStylesheet(directory !== null);
        if (!directory) return privateFontsLicenseModule(null);
        license ??= readFontLicense(directory);
        return privateFontsLicenseModule(await license);
      },
    },
  };
}
