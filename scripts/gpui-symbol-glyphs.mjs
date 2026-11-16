#!/usr/bin/env node
/**
 * `node scripts/gpui-symbol-glyphs.mjs`: write the GPUI symbol palette's
 * glyph table (`gpui/crates/lattice-editor/src/latex/symbol_glyphs.rs`)
 * from the vocabulary's maths commands; `--check` fails instead when the
 * Rust file is not what they make.
 *
 * The Tauri palette (`src/editor/latex/symbol-palette.ts`) finds a symbol
 * by the text of KaTeX's drawing of it, so typing `α` finds `\alpha`: each
 * command's insert (its template, else its name), with an empty box where
 * an argument goes, is set by KaTeX, and the HTML's text without its
 * whitespace is the glyph; a command KaTeX cannot set has none. The GPUI app
 * draws the palette's cells with KaTeX too, but its pictures carry no text,
 * so the glyphs are worked out here, by the KaTeX the Tauri app ships, and
 * kept as data. The commands are read from the vocabulary's Rust port
 * (`latex/vocabulary.rs`, the entries marked `.math()`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import katex from "katex";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vocabularyPath = join(root, "gpui/crates/lattice-editor/src/latex/vocabulary.rs");
const outputPath = join(root, "gpui/crates/lattice-editor/src/latex/symbol_glyphs.rs");

/** A Rust string literal's value (the vocabulary uses `\\` and `\"` only). */
const unescape = (literal) => literal.replace(/\\(.)/g, "$1");

/** The maths entries: `e("\\name", …)` with an optional `.template("…")`, ending `.math(),`. */
function mathCommands(source) {
  const entry = /e\("((?:[^"\\]|\\.)*)",[^\n]*\.math\(\)/g;
  const templateOf = /\.template\("((?:[^"\\]|\\.)*)"\)/;
  const seen = new Set();
  const commands = [];
  for (const [line, name] of source.matchAll(entry)) {
    const template = templateOf.exec(line)?.[1];
    const command = unescape(name);
    if (seen.has(command)) continue;
    seen.add(command);
    commands.push({ name: command, insert: template === undefined ? command : unescape(template) });
  }
  return commands;
}

/** The text of KaTeX's drawing of `insert`, as `paletteSymbols` reads it. */
function glyph(insert) {
  try {
    const html = katex.renderToString(insert.replaceAll("{}", "{\\square}"), {
      output: "html",
      throwOnError: true,
      strict: "ignore",
    });
    return html.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
  } catch {
    return "";
  }
}

/** A Rust string literal for `text`: escapes for `\`, `"` and anything not printable ASCII or a letter. */
function rust(text) {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0);
    if (character === "\\" || character === '"') out += `\\${character}`;
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0) || (code >= 0x200b && code <= 0x200f) || code === 0xfeff) {
      out += `\\u{${code.toString(16)}}`;
    } else out += character;
  }
  return `"${out}"`;
}

const commands = mathCommands(readFileSync(vocabularyPath, "utf8"));
const rows = commands.map(({ name }, index) => `    (${rust(name)}, ${rust(glyph(commands[index].insert))}),`);
const output = `//! The symbol palette's glyphs: each maths command of the vocabulary and the
//! text of KaTeX's drawing of it (its template's arguments as empty boxes),
//! empty where KaTeX cannot set it, which the palette's search matches as
//! the Tauri app's does (\`matchSymbols\`). Written by
//! \`node scripts/gpui-symbol-glyphs.mjs\` with the KaTeX the Tauri app ships
//! (${katex.version}); run it again when the vocabulary's maths commands change.

pub(crate) const GLYPHS: &[(&str, &str)] = &[
${rows.join("\n")}
];
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== output) {
    console.error(`${outputPath} is not what the vocabulary's maths commands make; run node scripts/gpui-symbol-glyphs.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(outputPath, output);
  console.log(`wrote ${commands.length} glyphs to ${outputPath}`);
}
