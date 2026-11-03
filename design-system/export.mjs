#!/usr/bin/env node
// Exports the Lattice design system from its Paper file into this folder:
// paper-export.json (the pull: tokens, spec blocks and the guidelines as
// Markdown), tokens.json, tokens.css and DESIGN.md.
// Those four files are generated; edit the Paper file and run this again.
//
//   node design-system/export.mjs                    pull from Paper, then render
//   node design-system/export.mjs --from <json>      render from a saved pull
//
// The pull talks to the Paper desktop app's MCP server over stdio
// (`paper mcp`, the same server an agent connects to). PAPER_BIN overrides the
// binary; it defaults to `paper` on PATH, then ~/.paper/bin/paper.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_ID = "01M6EKRMTWZ2JD6ZHKF830MAVP";
const FILE_URL = `https://app.paper.design/file/${FILE_ID}`;
const here = dirname(fileURLToPath(import.meta.url));
const out = (name) => join(here, name);

// ---------------------------------------------------------------- the pull

function paperBinary() {
  if (process.env.PAPER_BIN) return process.env.PAPER_BIN;
  const local = join(homedir(), ".paper/bin/paper");
  return existsSync(local) ? local : "paper";
}

/** A minimal MCP client: newline-delimited JSON-RPC over the server's stdio. */
async function connect() {
  const child = spawn(paperBinary(), ["mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lattice-design-system-export", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  /** Every Paper tool answers a file header object, then its payload. */
  const call = async (name, args) => {
    const result = await send("tools/call", { name, arguments: { fileId: FILE_ID, ...args } });
    const texts = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
    if (result.isError) throw new Error(`${name}: ${texts.join(" ")}`);
    const payload = (texts.length > 1 ? texts.slice(1).join("\n") : texts[0].slice(texts[0].indexOf("\n}\n") + 3)).trim();
    return payload.startsWith("{") || payload.startsWith("[") ? JSON.parse(payload) : payload;
  };
  return { call, close: () => child.kill() };
}

async function pull() {
  const paper = await connect();
  try {
    const { tokens } = await paper.call("get_tokens", { format: "json" });
    const spec = async (firstLine) => {
      const { nodes } = await paper.call("find_nodes", { textValue: `${firstLine}*` });
      if (nodes.length !== 1) throw new Error(`expected one spec block starting ${firstLine}, found ${nodes.length}`);
      return (await paper.call("get_node_info", { nodeId: nodes[0].id })).textContent;
    };
    const info = await paper.call("get_basic_info", {});
    const page = info.pages.find((entry) => entry.type === "page" && entry.name === "Guidelines");
    if (!page) throw new Error("no Guidelines page in the Paper file");
    const { artboards } = await paper.call("get_basic_info", { pageId: page.id });
    const artboard = async (name) => {
      const board = artboards.find((entry) => entry.name === name);
      if (!board) throw new Error(`no ${name} artboard on the Guidelines page`);
      return paper.call("get_jsx", { nodeId: board.id, includeNodeIds: false });
    };
    return {
      fileId: FILE_ID,
      tokens,
      specs: { motion: await spec("--duration-fast:"), shadow: await spec("--shadow-raised:") },
      guidelines: { start: guidelineMarkdown(await artboard("Start here")), rules: guidelineMarkdown(await artboard("Guidelines")) },
    };
  } finally {
    paper.close();
  }
}

// ---------------------------------------------------------------- tokens

/** `--color-dark-x` is the dark twin of `--color-x`; `--shadow-dark-x` of `--shadow-x`. */
const DARK = /^--(color|shadow)-dark-/;
const lightName = (name) => name.replace(DARK, "--$1-");

/** Description fields: `<usage> · stack: <font stack> · app: <what it mirrors>`. */
function describe(description = "") {
  const parts = description.split(" · ");
  const field = (key) => parts.find((part) => part.startsWith(`${key}: `))?.slice(key.length + 2);
  const app = field("app")?.replace(/ \((light|dark)\)$/, "");
  return {
    usage: parts.filter((part) => !/^(stack|app): /.test(part)).join(" · "),
    stack: field("stack"),
    app: app === undefined || app.startsWith("none") ? null : app,
  };
}

function specTokens(text, type) {
  return [...text.matchAll(/^(--[\w-]+):\s*(.+?);\s*$/gm)].map(([, name, value]) => {
    const kind = type ?? (name.startsWith("--duration") ? "duration" : "easing");
    // A sampled spring needs linear(); --ease-*-cubic is its fallback for
    // WebKit before Safari 17.2, which the app declares first and overrides.
    const app = name.endsWith("-cubic") ? name.replace(/-cubic$/, "") : name.replace(DARK, "--$1-");
    return { name, type: kind, value, description: name.endsWith("-cubic") ? "Fallback curve where linear() is unsupported" : "", app };
  });
}

function collect(source) {
  const all = [
    ...source.tokens,
    ...specTokens(source.specs.motion),
    ...specTokens(source.specs.shadow, "shadow"),
  ];
  const tokens = {};
  for (const token of all) {
    const name = lightName(token.name);
    const isDark = name !== token.name;
    const meta = token.app === undefined ? describe(token.description) : { usage: token.description, stack: undefined, app: token.app };
    const entry = (tokens[name] ??= { type: token.type });
    const value = meta.stack ?? token.value;
    if (isDark) {
      entry.dark = value;
      entry.appDark ??= meta.app;
    } else {
      entry.value = value;
      if (meta.stack) entry.paperValue = token.value;
      entry.description = meta.usage;
      entry.app = meta.app;
    }
  }
  return tokens;
}

function tokensJson(tokens) {
  return JSON.stringify({
    $comment: "Generated by design-system/export.mjs from the Paper file below. Do not edit; change Paper and re-export.",
    source: FILE_URL,
    tokens,
  }, null, 2) + "\n";
}

function tokensCss(tokens) {
  const entries = Object.entries(tokens);
  const line = (name, value) => `  ${name}: ${value};`;
  const light = entries.filter(([name]) => !name.endsWith("-cubic")).map(([name, token]) =>
    line(name, name.startsWith("--ease-") && tokens[`${name}-cubic`] ? tokens[`${name}-cubic`].value : token.value));
  const dark = entries.filter(([, token]) => token.dark !== undefined).map(([name, token]) => line(name, token.dark));
  const springs = entries.filter(([name]) => name.startsWith("--ease-") && tokens[`${name}-cubic`]).map(([name, token]) => line(name, token.value));
  return [
    `/* Generated by design-system/export.mjs from ${FILE_URL}. Do not edit. */`,
    "/* Light by default; data-theme=\"dark\" (or .dark) switches every colour and shadow. */",
    ":root {", ...light, "}",
    ":root[data-theme=\"dark\"], .dark {", "  color-scheme: dark;", ...dark, "}",
    "/* The spring tiers sampled into linear(); older WebKit keeps the cubic curves above. */",
    "@supports (transition-timing-function: linear(0, 1)) {", "  :root {", ...springs.map((l) => `  ${l}`), "  }", "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- DESIGN.md

const decode = (text) => text.replace(/\{["'](.*?)["']\}/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"");

/** Reads a Guidelines artboard's JSX: each text node's role follows from its style. */
function guidelineMarkdown(jsx) {
  const lines = jsx.split("\n");
  const md = [];
  let lattice = false;
  for (let i = 1; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text || /^[<()]/.test(text) || text === "}") continue;
    const style = lines[i - 1];
    const size = /fontSize: '([^']+)'/.exec(style)?.[1];
    const content = decode(text);
    if (size === "56px") md.push(`## ${content}`, "");
    else if (size === "32px") md.push(`### ${content}`, "");
    else if (size === "var(--text-micro)" && /letterSpacing/.test(style)) continue;
    else if (size === "var(--text-micro)") lattice = content === "Lattice";
    else if (size === "var(--text-typeset)") {
      md.push(`- ${lattice ? "**[Lattice]** " : ""}${content}`);
      lattice = false;
    } else if (size === "var(--text-body)") md.push("", content, "");
  }
  return md.join("\n").replace(/\n{3,}/g, "\n\n").replace(/(- .+)\n(#)/g, "$1\n\n$2");
}

function tokenTables(tokens) {
  const groups = new Map();
  for (const [name, token] of Object.entries(tokens)) {
    const group = name.match(/^--(color-tint|color-syntax|color-glyph|color-accent-|color|spacing|container|breakpoint|opacity|font-weight|font|text|leading|tracking|radius|duration|ease|shadow)/)?.[1] ?? "other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([name, token]);
  }
  const titles = { color: "Colour", "color-accent-": "Accent presets", "color-glyph": "File glyphs", "color-syntax": "Weft & Warp syntax", "color-tint": "Tints", spacing: "Spacing and sizes", container: "Containers", breakpoint: "Breakpoints", opacity: "Opacity", font: "Font families", "font-weight": "Font weights", text: "Font sizes", leading: "Line heights", tracking: "Letter spacing", radius: "Radius", duration: "Durations", ease: "Easing", shadow: "Shadows" };
  const cell = (value) => (value === undefined ? "" : `\`${String(value).replace(/\|/g, "\\|")}\``);
  return [...groups].map(([group, rows]) => {
    const hasDark = rows.some(([, token]) => token.dark !== undefined);
    const head = hasDark ? "| Token | Light | Dark | Use |\n| --- | --- | --- | --- |" : "| Token | Value | Use |\n| --- | --- | --- |";
    const body = rows.map(([name, token]) => hasDark
      ? `| \`${name}\` | ${cell(token.value)} | ${cell(token.dark)} | ${token.description ?? ""} |`
      : `| \`${name}\` | ${cell(token.value)} | ${token.description ?? ""} |`);
    return `### ${titles[group] ?? group}\n\n${head}\n${body.join("\n")}`;
  }).join("\n\n");
}

function designMd(source, tokens) {
  return [
    "<!-- Generated by design-system/export.mjs from the Paper file. Do not edit; change Paper and re-export. -->",
    "",
    "# Lattice design system",
    "",
    `Source of truth: the Paper file [Lattice design system](${FILE_URL}). This file is its exported copy for agents that cannot reach Paper: the written rules (from the Guidelines page) and every token (from Paper's design tokens and the spec blocks on Foundations). The visuals live only in Paper.`,
    "",
    "Use `tokens.css` (or `tokens.json`) for every value. Light is the default; `data-theme=\"dark\"` on the root, or a `.dark` ancestor, switches colours and shadows. Rules marked **[Lattice]** are specific to Lattice; the rest carry to a new product.",
    "",
    "The Lattice app itself does not import `tokens.css`: its own CSS (`src/styles/theme.css`, `foundations.css`) stays its source, and `src/styles/design-system-drift.test.ts` keeps the two equal.",
    "",
    source.guidelines.start,
    "",
    source.guidelines.rules,
    "",
    "## Composing elevation",
    "",
    "A raised, popover, floating or dialog surface stands on `--color-raised` with `box-shadow: 0 0 0 1px var(--color-ring), var(--shadow-<level>)`. A docked panel takes only `0 0 0 1px` of `--color-line` at 70%.",
    "",
    "## Tokens",
    "",
    tokenTables(tokens),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- main

const fromIndex = process.argv.indexOf("--from");
const source = fromIndex >= 0
  ? JSON.parse(readFileSync(process.argv[fromIndex + 1], "utf8"))
  : await pull();
if (fromIndex < 0) writeFileSync(out("paper-export.json"), JSON.stringify(source, null, 2) + "\n");
const tokens = collect(source);
writeFileSync(out("tokens.json"), tokensJson(tokens));
writeFileSync(out("tokens.css"), tokensCss(tokens));
writeFileSync(out("DESIGN.md"), designMd(source, tokens));
console.log(`Exported ${Object.keys(tokens).length} tokens and the guidelines from ${FILE_URL}`);
