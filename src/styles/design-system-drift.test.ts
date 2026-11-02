/**
 * The design system's exported tokens (design-system/tokens.json, generated
 * from the Paper file) against the values the app declares in theme.css and
 * foundations.css. Every token whose description names an app variable
 * (`app: --surface-chrome`) is resolved in the app's own CSS, in the right
 * theme and scope, and must match.
 *
 * A failure is drift between the two sources of truth. Fix it on purpose: when
 * the app changed, update the Paper file and re-export (design-system/README.md);
 * when Paper changed, change the app. Never edit tokens.json by hand.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Vitest runs from the repository root, as tokens.test.ts relies on.
const read = (path: string) => readFileSync(path, "utf8");

type Token = { type: string; value: string; dark?: string; app: string | null; appDark?: string | null };
const tokens: Record<string, Token> = JSON.parse(read("design-system/tokens.json")).tokens;

// ---------------------------------------------------------------- CSS blocks

type Block = { selectors: string[]; at: string | null; decls: Map<string, string> };

/** Flat list of rule blocks with their custom properties, comments removed. */
function parseBlocks(css: string): Block[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Block[] = [];
  const walk = (start: number, end: number, at: string | null) => {
    let i = start;
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= end) return;
      const prelude = text.slice(i, open).trim().split(";").pop()!.trim();
      let depth = 1;
      let j = open + 1;
      for (; j < end && depth > 0; j++) depth += text[j] === "{" ? 1 : text[j] === "}" ? -1 : 0;
      if (prelude.startsWith("@")) walk(open + 1, j - 1, prelude);
      else {
        const decls = new Map<string, string>();
        for (const match of text.slice(open + 1, j - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(match[1], match[2].replace(/\s+/g, " ").trim());
        blocks.push({ selectors: prelude.split(",").map((s) => s.trim().replace(/\s+/g, " ")), at, decls });
      }
      i = j;
    }
  };
  walk(0, text.length, null);
  return blocks;
}

const blocks = [...parseBlocks(read("src/styles/theme.css")), ...parseBlocks(read("src/styles/foundations.css"))];
const scope = (...pick: Array<(block: Block) => boolean>) => {
  const map = new Map<string, string>();
  for (const block of blocks) if (pick.some((test) => test(block))) for (const [k, v] of block.decls) map.set(k, v);
  return map;
};
const has = (selector: string, at: string | null = null) => (block: Block) => block.at === at && block.selectors.includes(selector);
const LIGHT = has(":root");
const DARK = has(':root[data-theme="dark"]');
const SPRINGS = has(":root", "@supports (transition-timing-function: linear(0, 1))");
const SETTINGS = has(".settings-modal");

function scopeFor(theme: "light" | "dark", app: string) {
  const base = theme === "light" ? [LIGHT] : [LIGHT, DARK];
  const tint = /^\[data-tint="(\w+)"\]/.exec(app)?.[1];
  const accent = /^\[data-accent="(\w+)"\]/.exec(app)?.[1];
  if (tint) base.push(theme === "light" ? has(`[data-tint="${tint}"]`) : has(`:root[data-theme="dark"][data-tint="${tint}"]`));
  if (accent) {
    base.push(has('[data-accent]:not([data-accent="graphite"])'), has(`[data-accent="${accent}"]`));
    if (theme === "dark") base.push(has(':root[data-theme="dark"][data-accent]:not([data-accent="graphite"])'), has(`:root[data-theme="dark"][data-accent="${accent}"]`));
  }
  if (app.startsWith(".settings-modal")) base.push(SETTINGS);
  return scope(...base);
}

// ---------------------------------------------------------------- values

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((ch) => ch + ch).join("") : hex;
    const n = (k: number) => parseInt(full.slice(k, k + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^(rgba?|color)\((.*)\)$/.exec(v);
  if (!fn) return null;
  const body = fn[2].replace(/^srgb\s+/, "");
  const [channels, alpha] = body.includes("/") ? body.split("/") : [body, undefined];
  const parts = channels.split(/[\s,]+/).filter(Boolean);
  const a = alpha ?? parts[3];
  const num = (s: string, scale: number) => (s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s) * (fn[1] === "color" ? scale : 1));
  const rgb = parts.slice(0, 3).map((s) => num(s, 255));
  const alphaValue = a === undefined ? 1 : a.trim().endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
  return [rgb[0], rgb[1], rgb[2], alphaValue];
}

/** color-mix(in srgb, A p%, B [q%]), interpolated premultiplied as CSS does. */
function mix(a: Rgba, p: number, b: Rgba): Rgba {
  const alpha = a[3] * p + b[3] * (1 - p);
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (k: number) => (a[k] * a[3] * p + b[k] * b[3] * (1 - p)) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(last, i).trim());
      last = i + 1;
    }
  }
  parts.push(text.slice(last).trim());
  return parts;
}

/** Substitutes var() from the scope, then evaluates color-mix() innermost first. */
function resolve(expr: string, map: Map<string, string>, depth = 0): string {
  if (depth > 20) throw new Error(`var() cycle in ${expr}`);
  let out = expr;
  for (let guard = 0; guard < 50 && out.includes("var("); guard++) {
    out = out.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/, (_, name: string, fallback?: string) => {
      const value = map.get(name) ?? fallback;
      if (value === undefined) throw new Error(`the app declares no ${name}`);
      return resolve(value, map, depth + 1);
    });
  }
  // Innermost first: the last color-mix( opened is one with no mix inside it.
  for (let start = out.lastIndexOf("color-mix("); start >= 0; start = out.lastIndexOf("color-mix(")) {
    let depth = 0;
    let end = start + "color-mix".length;
    for (; end < out.length; end++) {
      depth += out[end] === "(" ? 1 : out[end] === ")" ? -1 : 0;
      if (depth === 0) break;
    }
    const args = out.slice(start + "color-mix(".length, end).replace(/^\s*in srgb\s*,/, "");
    const [first, second] = splitTopLevel(args);
    const pa = /\s([\d.]+)%$/.exec(first);
    const pb = /\s([\d.]+)%$/.exec(second);
    const ca = parseColor(pa ? first.slice(0, pa.index) : first);
    const cb = parseColor(pb ? second.slice(0, pb.index) : second);
    if (!ca || !cb) throw new Error(`cannot mix ${args}`);
    const p = pa ? parseFloat(pa[1]) / 100 : pb ? 1 - parseFloat(pb[1]) / 100 : 0.5;
    const [r, g, b, a] = mix(ca, p, cb);
    out = `${out.slice(0, start)}rgba(${r}, ${g}, ${b}, ${a})${out.slice(end + 1)}`;
  }
  return out.trim();
}

const norm = (value: string) => value.replace(/\s+/g, " ").replace(/"/g, "").replace(/\s*,\s*/g, ", ").trim().toLowerCase();

function sameValue(type: string, expected: string, actual: string): boolean {
  if (type === "color" || type === "opacity") {
    const e = parseColor(expected);
    const a = parseColor(actual);
    if (e && a) return e.slice(0, 3).every((v, k) => Math.abs(v - a[k]) <= 1) && Math.abs(e[3] - a[3]) <= 0.006;
    if (type === "opacity") {
      const fraction = parseFloat(expected) / 100;
      return a ? Math.abs(a[3] - fraction) <= 0.006 : Math.abs(parseFloat(actual) - fraction) <= 0.001;
    }
  }
  const px = (v: string) => v.replace(/^min\(([\d.]+px),.*\)$/, "$1").replace(/^([\d.]+)rem$/, (_, n: string) => `${parseFloat(n) * 16}px`);
  return norm(px(expected)) === norm(px(actual));
}

// ---------------------------------------------------------------- the check

const tokenScope = new Map(Object.entries(tokens).map(([name, token]) => [name, token.value]));
const allCss = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? allCss(join(dir, entry.name)) : entry.name.endsWith(".css") ? [read(join(dir, entry.name))] : []);

/** `fallback` reads a curve's cubic declaration instead of the sampled spring that overrides it. */
function appValue(theme: "light" | "dark", app: string, fallback: boolean): string {
  const map = scopeFor(theme, app);
  if (app.startsWith("color-mix(")) return resolve(app, map);
  const name = /(--[\w-]+)$/.exec(app)?.[1];
  if (!name) throw new Error(`cannot read the mapping "${app}"`);
  const springs = scope(SPRINGS);
  const raw = springs.has(name) && !fallback ? springs.get(name)! : map.get(name);
  if (raw === undefined) throw new Error(`the app declares no ${name}`);
  return resolve(raw, map);
}

function drift(): string[] {
  const problems: string[] = [];
  const media = allCss("src").join("\n");
  for (const [name, token] of Object.entries(tokens)) {
    for (const theme of ["light", "dark"] as const) {
      const expected = theme === "light" ? token.value : token.dark;
      const app = theme === "light" ? token.app : (token.appDark ?? token.app);
      if (expected === undefined || !app) continue;
      if (app.startsWith("@media")) {
        if (!media.includes(app)) problems.push(`${name}: no stylesheet has ${app}`);
        continue;
      }
      try {
        const actual = appValue(theme, app, name.endsWith("-cubic"));
        const want = resolve(expected, tokenScope);
        if (!sameValue(token.type, want, actual)) problems.push(`${name} (${theme}): Paper ${want}, app ${app} = ${actual}`);
      } catch (error) {
        problems.push(`${name} (${theme}): ${(error as Error).message}`);
      }
    }
  }
  return problems;
}

describe("design system tokens", () => {
  it("map most tokens to an app value", () => {
    const mapped = Object.values(tokens).filter((token) => token.app).length;
    expect(mapped / Object.keys(tokens).length).toBeGreaterThan(0.85);
  });

  it("match the values the app declares", () => {
    expect(drift()).toEqual([]);
  });
});
