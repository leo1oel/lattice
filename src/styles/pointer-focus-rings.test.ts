/**
 * No focus ring draws on focus a pointer caused (components/ui/pointer-focus.ts).
 *
 * The mark `data-pointer-focus` only helps where a ring rule honours it, and
 * the bug came back twice (#352, then #359 for 7 more surfaces) from rules
 * that did not. A `:focus-visible` rule that draws a ring passes when its
 * selector excludes the mark itself, or when the one shared override in
 * app-shell.css beats it: an outline-only ring less specific than that
 * override. A ring painted any other way (a fill, a shadow, an `!important`
 * outline), and every ring in the project tree's shadow root, which the
 * shared override cannot reach, has to exclude the mark itself.
 *
 * Vitest empties CSS imports, so the stylesheets are read off disk.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PIERRE_TREE_CSS } from "../project/project-tree-css";

const MARK = "[data-pointer-focus]";
const SHARED_OVERRIDE = `:root ${MARK}:focus-visible`;

type Rule = { file: string; selector: string; body: string };
type Specificity = [ids: number, classes: number, types: number];

/** Style rules, through @media/@supports/@layer and nesting; comments dropped. */
function styleRules(file: string, css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let start = 0;
  for (let at = 0; at < source.length; at += 1) {
    if (source[at] === ";" || source[at] === "}") start = at + 1;
    if (source[at] !== "{") continue;
    let depth = 1;
    let end = at + 1;
    for (; end < source.length && depth > 0; end += 1) {
      if (source[end] === "{") depth += 1;
      if (source[end] === "}") depth -= 1;
    }
    const prelude = source.slice(start, at).trim();
    const inner = source.slice(at + 1, end - 1);
    if (!prelude.startsWith("@")) rules.push({ file, selector: prelude, body: inner.replace(/[^;{}]*\{[^]*\}/g, "") });
    if (inner.includes("{")) rules.push(...styleRules(file, inner));
    at = end - 1;
    start = end;
  }
  return rules;
}

/** `list` split at the commas outside parentheses and brackets. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < list.length; at += 1) {
    if ("([".includes(list[at])) depth += 1;
    else if (")]".includes(list[at])) depth -= 1;
    else if (list[at] === "," && depth === 0) {
      parts.push(list.slice(start, at).trim());
      start = at + 1;
    }
  }
  return [...parts, list.slice(start).trim()];
}

const add = (a: Specificity, b: Specificity): Specificity => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const compare = (a: Specificity, b: Specificity) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Selectors Level 4 specificity of one complex selector. */
function specificity(selector: string): Specificity {
  let total: Specificity = [0, 0, 0];
  let rest = selector;
  // :is/:not/:has count their most specific argument; :where counts nothing.
  for (let match; (match = /:(is|not|has|where)\(/.exec(rest));) {
    let depth = 1;
    let end = match.index + match[0].length;
    for (; depth > 0; end += 1) depth += rest[end] === "(" ? 1 : rest[end] === ")" ? -1 : 0;
    const args = splitTopLevel(rest.slice(match.index + match[0].length, end - 1));
    if (match[1] !== "where") total = add(total, args.map(specificity).sort(compare).at(-1)!);
    rest = `${rest.slice(0, match.index)} ${rest.slice(end)}`;
  }
  rest = rest.replace(/\[[^\]]*\]/g, () => {
    total = add(total, [0, 1, 0]);
    return " ";
  });
  const count = (pattern: RegExp) => rest.match(pattern)?.length ?? 0;
  const elements = count(/::[\w-]+|:(?:before|after)\b/g);
  rest = rest.replace(/::?[\w-]+(?:\([^)]*\))?/g, (pseudo) => (pseudo.startsWith("::") || /^:(before|after)$/.test(pseudo) ? " " : " .p"));
  return add(total, [count(/#[\w-]+/g), count(/\.[\w-]+/g), elements + count(/(?:^|[\s>+~(])[a-z][\w-]*/gi)]);
}

/** The ring a rule draws: outline that shows, or anything painted in a focus-ring colour. */
function ringDeclarations(body: string): { name: string; value: string }[] {
  return body.split(";").map((declaration) => {
    const colon = declaration.indexOf(":");
    return { name: declaration.slice(0, colon).trim(), value: declaration.slice(colon + 1).trim() };
  }).filter(({ name, value }) =>
    (/^outline(?:-color|-style|-width)?$/.test(name) && !/^(?:none|0|transparent)\b/.test(value))
    || /--[\w-]*focus-ring\b(?!-width|-offset)/.test(value));
}

function cssFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "src"], { encoding: "utf8" });
  return output.split("\0").filter((path) => path.endsWith(".css"));
}

const lightRules = cssFiles().flatMap((file) => styleRules(file, readFileSync(file, "utf8")));
const shadowRules = styleRules("project-tree-css.ts (shadow root)", PIERRE_TREE_CSS);

/**
 * Whether the focused element is the one the rule styles: `:focus-visible` in
 * the last compound, not inside `:has()` or ahead of a combinator. Only then
 * does the shared override, which sits on the focused element, reach the ring.
 */
function ringsFocusedElement(complex: string): boolean {
  let flat = complex;
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, "");
  return /:focus-visible/.test(flat.replace(/\[[^\]]*\]/g, "").split(/[\s>+~]+/).at(-1)!);
}

/** Ring rules on `:focus-visible` that would draw on a pointer-focused element. */
function unguardedRings(rules: Rule[], bar: Specificity | null): string[] {
  return rules.flatMap(({ file, selector, body }) => {
    const ring = ringDeclarations(body);
    if (ring.length === 0) return [];
    const outlineOnly = ring.every(({ name, value }) => name.startsWith("outline") && !value.includes("!important"));
    const beaten = (complex: string) =>
      bar !== null && outlineOnly && ringsFocusedElement(complex) && compare(specificity(complex), bar) < 0;
    return splitTopLevel(selector)
      .filter((complex) => complex.includes(":focus-visible") && !complex.includes(MARK) && !beaten(complex))
      .map((complex) => `${file}: ${complex}`);
  });
}

describe("pointer-focus ring exclusion", () => {
  const override = lightRules.find((rule) => rule.file === "src/styles/app-shell.css" && rule.selector === SHARED_OVERRIDE);

  it("keeps the shared override hiding the outline on a pointer-focused element", () => {
    expect(override?.body).toMatch(/outline-color:\s*transparent/);
  });

  it("finds every app ring either excluding the mark or beaten by the shared override", () => {
    expect(
      unguardedRings(lightRules, specificity(SHARED_OVERRIDE)),
      `Add :not(${MARK}) to these rings, or draw them as a plain outline below ${SHARED_OVERRIDE}'s specificity.`,
    ).toEqual([]);
  });

  it("finds every ring in the project tree's shadow root excluding the mark itself", () => {
    expect(shadowRules.length).toBeGreaterThan(0);
    expect(unguardedRings(shadowRules, null)).toEqual([]);
  });

  it("computes specificity as the cascade does", () => {
    expect(specificity(SHARED_OVERRIDE)).toEqual([0, 3, 0]);
    expect(specificity(".latex-selection-tool button:focus-visible")).toEqual([0, 2, 1]);
    expect(specificity(":where(button, a):focus-visible")).toEqual([0, 1, 0]);
    expect(specificity('button[data-type="item"]:focus-visible:not([data-pointer-focus])::before')).toEqual([0, 3, 2]);
    expect(specificity("#id .a:is(.b, .c .d) > li::after")).toEqual([1, 3, 2]);
  });

  it("catches a ring that would draw under the pointer", () => {
    const rules = styleRules("fixture.css", `
      .a:focus-visible { outline: 2px solid var(--focus-ring); }
      .b .c button:focus-visible { outline: 2px solid red; }
      .d:focus-visible { box-shadow: 0 0 0 2px var(--focus-ring); }
      .e:focus-visible:not(${MARK}) { background: var(--focus-ring); }
      @media (forced-colors: active) { .f:focus-visible { outline: 1px solid !important; } }
      .g:focus-visible { outline-offset: 2px; text-decoration: underline; }
      .h:has(input:focus-visible) .thumb, .i:focus-visible .row { outline: 2px solid; }
    `);
    expect(unguardedRings(rules, specificity(SHARED_OVERRIDE))).toEqual([
      "fixture.css: .b .c button:focus-visible",
      "fixture.css: .d:focus-visible",
      "fixture.css: .f:focus-visible",
      "fixture.css: .h:has(input:focus-visible) .thumb",
      "fixture.css: .i:focus-visible .row",
    ]);
  });
});
