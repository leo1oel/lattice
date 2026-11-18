// A theme sets base CSS variables; theme.css and foundations.css derive every
// other role from them, and the GPUI app derives the same roles in Rust
// (lattice-ui Palette::with_theme). parity.json holds, for every bundled
// theme, appearance and kind of accent, the variables this app sets and what
// GPUI derived; this test evaluates the stylesheets' own declarations on
// those variables and must reach the same colors.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import parity from "../../design-system/themes/parity.json";

type Case = { theme: string; appearance: "light" | "dark"; accent: string; variables: Record<string, string>; derived: Record<string, string> };
type Rgba = [number, number, number, number];

const sheets = ["src/styles/theme.css", "src/styles/foundations.css"].map((path) =>
  readFileSync(resolve(__dirname, "../..", path), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
);

/** Top-level rules (and rules inside @media blocks, which are skipped): selector list and declarations. */
function rules(css: string): { selectors: string[]; declarations: [string, string][] }[] {
  const out: { selectors: string[]; declarations: [string, string][] }[] = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") {
      if (depth === 0) selector = css.slice(start, index).trim();
      depth += 1;
      start = index + 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && !selector.startsWith("@")) {
        const body = css.slice(start, index);
        const declarations = body.split(";").flatMap((part) => {
          const at = part.indexOf(":");
          const name = part.slice(0, at).trim();
          return at > 0 && name.startsWith("--") ? [[name, part.slice(at + 1).trim()] as [string, string]] : [];
        });
        out.push({ selectors: selector.split(",").map((one) => one.trim()), declarations });
      }
      start = index + 1;
    }
  }
  return out;
}

const RULES = sheets.flatMap(rules);

/** Whether a selector matches the root element of a window in this case. */
function matchesRoot(selector: string, dark: boolean, accent: string): boolean {
  const attributes = [...selector.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  const notGraphite = selector.includes(':not([data-accent="graphite"])');
  const base = selector.replace(/:not\(\[data-accent="graphite"\]\)/g, "").replace(/\[[^\]]+\]/g, "");
  if (base !== ":root" && base !== "") return false;
  if (base === "" && !attributes.some((attribute) => attribute.startsWith("data-accent") || attribute.startsWith("data-tint"))) return false;
  if (notGraphite && accent === "graphite") return false;
  for (const attribute of attributes) {
    if (attribute === 'data-accent="graphite"' && notGraphite) continue;
    if (attribute === 'data-theme="dark"') { if (!dark) return false; continue; }
    if (attribute === "data-accent") continue;
    if (attribute.startsWith("data-accent=")) { if (attribute !== `data-accent="${accent}"`) return false; continue; }
    if (attribute === 'data-tint="graphite"') continue;
    return false;
  }
  return true;
}

function variablesFor(testCase: Case): Map<string, string> {
  const dark = testCase.appearance === "dark";
  const values = new Map<string, string>();
  for (const rule of RULES) {
    if (!rule.selectors.some((selector) => matchesRoot(selector, dark, testCase.accent))) continue;
    for (const [name, value] of rule.declarations) values.set(name, value);
  }
  for (const [name, value] of Object.entries(testCase.variables)) values.set(name, value);
  return values;
}

function parseHex(value: string): Rgba {
  const short = value.slice(1);
  const digits = short.length === 3 ? [...short].map((digit) => digit + digit).join("") : short;
  const channel = (at: number) => parseInt(digits.slice(at, at + 2), 16);
  return [channel(0), channel(2), channel(4), digits.length === 8 ? channel(6) / 255 : 1];
}

/** Splits a function's arguments on top-level commas. */
function argumentsOf(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "(") depth += 1;
    else if (body[index] === ")") depth -= 1;
    else if (body[index] === "," && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts;
}

function evaluate(value: string, variables: Map<string, string>, seen = new Set<string>()): string {
  return value.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => {
    if (seen.has(name)) throw new Error(`cycle at ${name}`);
    const found = variables.get(name);
    if (found === undefined) throw new Error(`${name} is not declared`);
    return evaluate(found, variables, new Set([...seen, name]));
  });
}

function color(value: string): Rgba {
  value = value.trim();
  if (value === "transparent") return [0, 0, 0, 0];
  if (value.startsWith("#")) return parseHex(value);
  const rgba = /^rgba?\((.*)\)$/.exec(value);
  if (rgba) {
    const parts = rgba[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  const mix = /^color-mix\(in srgb,\s*([\s\S]*)\)$/.exec(value);
  if (mix) {
    const [first, second] = argumentsOf(mix[1]).map((part) => {
      const share = /\s(\d+(?:\.\d+)?)%$/.exec(part);
      return { color: color(share ? part.slice(0, share.index) : part), share: share ? Number(share[1]) / 100 : undefined };
    });
    const p = first.share ?? (second.share !== undefined ? 1 - second.share : 0.5);
    const q = second.share ?? 1 - p;
    const alpha = first.color[3] * p + second.color[3] * q;
    if (alpha <= 0) return [0, 0, 0, 0];
    const channel = (at: number) => (first.color[at] * first.color[3] * p + second.color[at] * second.color[3] * q) / alpha;
    return [channel(0), channel(1), channel(2), alpha];
  }
  throw new Error(`cannot evaluate ${value}`);
}

describe("theme parity with the GPUI palette", () => {
  const cases = (parity.cases as Case[]).flatMap((testCase) =>
    Object.entries(testCase.derived).map(([name, expected]) => [`${testCase.theme} ${testCase.appearance} ${testCase.accent} ${name}`, testCase, name, expected] as const));

  it.each(cases)("%s", (_, testCase, name, expected) => {
    const variables = variablesFor(testCase);
    const ours = color(evaluate(`var(${name})`, variables));
    const theirs = parseHex(expected);
    for (let at = 0; at < 3; at += 1) expect(Math.abs(ours[at] - theirs[at]), `channel ${at}`).toBeLessThanOrEqual(1.01);
    expect(Math.abs(ours[3] - theirs[3])).toBeLessThanOrEqual(0.006);
  });
});
