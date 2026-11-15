#!/usr/bin/env node
/**
 * `node scripts/gpui-host-errors.mjs`: write the GPUI app's host error
 * catalog (`gpui/crates/lattice-gpui/src/host_errors/catalog.rs`) from the
 * Tauri app's (`src/platform/host-errors-*.ts`); `--check` fails instead
 * when the Rust file is not what the catalog makes.
 *
 * Both apps show lattice-core's English errors in the interface language by
 * matching each message against the Rust `format!` literal that wrote it
 * (see `src/platform/host-error-text.ts`). The Tauri catalog stays the one
 * list: each entry's translation is a Lingui message, and the GPUI app reads
 * the same messages from the same `messages.po` (`lattice_i18n`), so what
 * the Rust table needs from an entry is its literal, the message's id (and
 * context), and where each of the message's placeholders comes from.
 *
 * An entry's translation is read from its TypeScript syntax, not run:
 * - t`…${name}…` is the message whose id Lingui writes, a placeholder named
 *   after a bare identifier and numbered for anything else;
 * - a placeholder is one of the literal's arguments, or a helper of the
 *   catalog's (`unnamedPath`, `symbolName`, …) applied to one, directly or
 *   through a `const` in the entry's body; the Rust module has each helper;
 * - `param ? A : B` chooses on whether that argument is empty;
 * - an entry whose text is not a message (the standard library's
 *   "(os error N)", which `osErrorText` words) is written by hand in Rust
 *   and named in HAND_WRITTEN below.
 * Anything else stops the script, naming the entry, so the catalog cannot
 * grow a shape the Rust side would get wrong.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = ["project", "workspace", "overleaf", "papers", "setup"].map(
  (area) => `src/platform/host-errors-${area}.ts`,
);
const OUTPUT = "gpui/crates/lattice-gpui/src/host_errors/catalog.rs";
/** The catalog's helpers, by their Rust names in `host_errors.rs`. */
const HELPERS = {
  unnamedPath: "UnnamedPath",
  symbolName: "SymbolName",
  checklistField: "ChecklistField",
  bundledPart: "BundledPart",
};
/** Literals the Rust module words by hand: the standard library's own text. */
const HAND_WRITTEN = new Set(["{} (os error {})"]);

/** A string-ish node's text: a literal, or STD_ERRORS_FILE. */
function stringValue(node, constants) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node) && constants.has(node.text)) return constants.get(node.text);
  return null;
}

function fail(where, message) {
  throw new Error(`${where}: ${message}`);
}

/** Where a placeholder's value comes from. */
function argument(node, params, locals, where) {
  if (ts.isIdentifier(node)) {
    if (params.includes(node.text)) return { param: params.indexOf(node.text) };
    if (locals.has(node.text)) return locals.get(node.text);
    fail(where, `unknown name ${node.text}`);
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HELPERS[node.expression.text]) {
    const [inner] = node.arguments;
    if (node.arguments.length !== 1 || !ts.isIdentifier(inner) || !params.includes(inner.text)) {
      fail(where, `${node.expression.text} must take one of the entry's arguments`);
    }
    return { param: params.indexOf(inner.text), helper: HELPERS[node.expression.text] };
  }
  fail(where, `unsupported placeholder ${node.getText()}`);
}

/** A t`…` message: its id as Lingui writes it, and its placeholders. */
function message(node, params, locals, where) {
  if (!ts.isTaggedTemplateExpression(node) || node.tag.getText() !== "t") {
    fail(where, `unsupported translation ${node.getText().slice(0, 60)}`);
  }
  const template = node.template;
  if (ts.isNoSubstitutionTemplateLiteral(template)) return { id: template.text, args: [] };
  let id = template.head.text;
  let positional = 0;
  const args = [];
  for (const span of template.templateSpans) {
    const name = ts.isIdentifier(span.expression) ? span.expression.text : String(positional++);
    args.push({ name, ...argument(span.expression, params, locals, where) });
    id += `{${name}}${span.literal.text}`;
  }
  return { id, args };
}

/** An entry's translation, from its arrow function. */
function translation(arrow, where) {
  const params = [];
  for (const parameter of arrow.parameters) {
    if (ts.isArrayBindingPattern(parameter.name)) {
      for (const element of parameter.name.elements) params.push(element.name?.getText() ?? "_");
    } else if (arrow.parameters.length) {
      fail(where, "arguments must be destructured");
    }
  }
  const locals = new Map();
  let body = arrow.body;
  if (ts.isBlock(body)) {
    let returned = null;
    for (const statement of body.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          locals.set(declaration.name.getText(), argument(declaration.initializer, params, locals, where));
        }
      } else if (ts.isReturnStatement(statement)) {
        returned = statement.expression;
      } else {
        fail(where, "unsupported statement");
      }
    }
    body = returned;
  }
  return expression(body, params, locals, where);
}

function expression(node, params, locals, where) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isConditionalExpression(node)) {
    if (!ts.isIdentifier(node.condition) || !params.includes(node.condition.text)) {
      fail(where, "a choice must test one of the entry's arguments");
    }
    return {
      ifParam: params.indexOf(node.condition.text),
      then: expression(node.whenTrue, params, locals, where),
      otherwise: expression(node.whenFalse, params, locals, where),
    };
  }
  return message(node, params, locals, where);
}

/** Every entry of one area's file. */
function entries(path) {
  const text = readFileSync(join(ROOT, path), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const constants = new Map();
  const found = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      constants.set(node.name.getText(), node.initializer.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText().endsWith("_HOST_ERRORS") &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        const [file, literal, arrow] = element.elements;
        const where = `${path}:${source.getLineAndCharacterOfPosition(element.getStart()).line + 1}`;
        const rustFile = stringValue(file, constants);
        const rustLiteral = stringValue(literal, constants);
        if (rustFile === null || rustLiteral === null) fail(where, "entry must name its file and literal");
        if (HAND_WRITTEN.has(rustLiteral)) continue;
        found.push({ file: rustFile, literal: rustLiteral, text: translation(arrow, where) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** A Rust string literal. */
function rust(text) {
  return JSON.stringify(text).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");
}

function rustText(text, indent) {
  const pad = " ".repeat(indent);
  if ("ifParam" in text) {
    return `Text::IfParam(\n${pad}    ${text.ifParam},\n${pad}    &${rustText(text.then, indent + 4)},\n${pad}    &${rustText(text.otherwise, indent + 4)},\n${pad})`;
  }
  const args = text.args
    .map(({ name, param, helper }) => `(${rust(name)}, ${helper ? `Arg::Helper(Helper::${helper}, ${param})` : `Arg::Param(${param})`})`)
    .join(", ");
  return `Text::Message(${rust(text.id)}, &[${args}])`;
}

function generate() {
  const all = SOURCES.flatMap(entries);
  const lines = all.map(
    ({ file, literal, text }) => `    Entry {\n        file: ${rust(file)},\n        literal: ${rust(literal)},\n        text: ${rustText(text, 8)},\n    },`,
  );
  return `// Generated by \`node scripts/gpui-host-errors.mjs\` from the Tauri app's
// \`src/platform/host-errors-*.ts\`; do not edit. Run it again after changing
// that catalog (\`pnpm gate:changed\` checks it is current).

use super::{Arg, Entry, Helper, Text};

pub(super) static ENTRIES: &[Entry] = &[
${lines.join("\n")}
];
`;
}

const output = generate();
const target = join(ROOT, OUTPUT);
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // No file yet: it is not current.
  }
  if (current !== output) {
    console.error(`${OUTPUT} is not current: run node scripts/gpui-host-errors.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(target, output);
  console.log(`wrote ${OUTPUT}`);
}
