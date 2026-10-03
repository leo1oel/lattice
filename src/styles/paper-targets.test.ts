// Vitest empties CSS imports and jsdom lays nothing out, so these read the
// stylesheets off disk and do the box arithmetic the browser would.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const appShell = stylesheet("src/styles/app-shell.css");
const editorWorkspace = stylesheet("src/styles/editor-workspace.css");
/** The chrome's tokens: its document-wide `:root` blocks. */
const tokens = declarations(stylesheet("src/styles/foundations.css"), ":root");

/** The declarations of every rule whose selector list is exactly `selector`, later ones winning. */
function declarations(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bodies = [...css.matchAll(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((match) => match[1]);
  if (!bodies.length) throw new Error(`no rule for ${selector}`);
  return new Map(bodies.flatMap((body) => body.split(";")).map((part) => part.split(/:(.*)/s).map((piece) => piece.trim()))
    .filter(([name]) => name).map(([name, value]) => [name, value]));
}

/** A px length after resolving `var()`s against `scope` and the chrome's :root tokens. */
function px(value: string, scope: Map<string, string>): number {
  const resolved = value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const token = scope.get(name) ?? tokens.get(name);
    if (token === undefined) throw new Error(`unresolved ${name}`);
    return `(${px(token, scope)})`;
  });
  return evaluate(resolved.replace(/calc\(/g, "(").replace(/(\d)px\b/g, "$1"));
}

/** `+ - * /` over numbers and parentheses — all a length's calc() uses here. */
function evaluate(expression: string): number {
  const tokens = expression.match(/\d*\.?\d+|[-+*/()]|\S/g) ?? [];
  let index = 0;
  const factor = (): number => {
    const token = tokens[index++];
    if (token === "-") return -factor();
    if (token === "(") {
      const value = sum();
      if (tokens[index++] !== ")") throw new Error(`unbalanced: ${expression}`);
      return value;
    }
    if (!/^\d*\.?\d+$/.test(token ?? "")) throw new Error(`not a length: ${expression}`);
    return Number(token);
  };
  const product = (): number => {
    let value = factor();
    while (tokens[index] === "*" || tokens[index] === "/") value = tokens[index++] === "*" ? value * factor() : value / factor();
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (tokens[index] === "+" || tokens[index] === "-") value = tokens[index++] === "+" ? value + product() : value - product();
    return value;
  };
  const value = sum();
  if (index !== tokens.length) throw new Error(`not a length: ${expression}`);
  return value;
}

/** `inset` as [top, right, bottom, left]; its parts are split outside parentheses. */
function inset(value: string, scope: Map<string, string>): number[] {
  const parts: string[] = [""];
  let depth = 0;
  for (const character of value.trim()) {
    depth += character === "(" ? 1 : character === ")" ? -1 : 0;
    if (/\s/.test(character) && depth === 0) {
      if (parts.at(-1)) parts.push("");
    } else parts[parts.length - 1] += character;
  }
  const [top, right = top, bottom = top, left = right] = parts.map((part) => px(part, scope));
  return [top, right, bottom, left];
}

describe("paper pointer targets", () => {
  // A one-line title is the tightest row: the byline starts right under it.
  it.each([1, 2, 3])("keeps %i row action hit area(s) off a row's title and byline", (count) => {
    const row = declarations(appShell, ".paper-row");
    row.set("--paper-row-actions", String(count));
    const actions = declarations(appShell, ".paper-row-actions");
    const face = 22;
    const [insetTop, insetRight, insetBottom, insetLeft] = inset(
      declarations(appShell, ".row-delete::after, .row-edit-bib::after, .row-citation-health::after").get("inset")!, row,
    );
    expect(declarations(appShell, ".row-delete, .row-edit-bib").get("height")).toBe(`${face}px !important`);

    // Measured down from the row's top.
    const laneTop = px(actions.get("inset-block-start")!, row);
    const laneHeight = px(actions.get("height") ?? `${face}px`, row);
    const slack = { "flex-end": laneHeight - face, center: (laneHeight - face) / 2 }[actions.get("align-items") ?? ""] ?? 0;
    const faceTop = laneTop + slack;
    // A negative inset reaches past the face.
    const hitTop = faceTop + insetTop;
    const hitBottom = faceTop + face - insetBottom;
    const padding = px(declarations(appShell, ".paper-open").get("padding")!, row);
    const titleLine = px(declarations(appShell, ".paper-list strong").get("line-height")!, row);
    const bylineTop = padding + titleLine + px(declarations(appShell, ".paper-list small").get("margin-top")!, row);
    expect(hitTop).toBeGreaterThanOrEqual(0);
    expect(hitBottom).toBeLessThanOrEqual(bylineTop);
    // The face sits on the title's first line.
    expect(Math.abs(faceTop + face / 2 - (padding + titleLine / 2))).toBeLessThanOrEqual(1);

    // Measured in from the row's end edge: the title's text stops before the
    // leftmost hit area begins, and the last one stays inside the row's gutter.
    const end = px(actions.get("inset-inline-end")!, row);
    const hitStart = end + count * face - insetLeft;
    const titleEnd = padding + px(declarations(appShell, ".paper-list strong").get("padding-inline-end")!, row);
    expect(titleEnd).toBeGreaterThanOrEqual(hitStart);
    expect(end + insetRight).toBeGreaterThanOrEqual(-px("var(--space-6)", row));
  });

  it("never lets the reader's source action shrink away beside a long title", () => {
    // The strip ellipsizes the title; the source keeps its natural width up to
    // a share of the strip and only its label truncates past that, so its
    // icon and pointer target always remain.
    const source = declarations(editorWorkspace, ".paper-identity-source");
    expect(source.get("flex")).toBe("none");
    expect(source.get("max-width")).toMatch(/^\d+%$/);
    expect(declarations(editorWorkspace, ".paper-identity-title").get("flex")).toBe("0 1 auto");
    expect(declarations(editorWorkspace, ".paper-identity-source > span").get("min-width")).toBe("0");
    expect(declarations(editorWorkspace, ".paper-identity-source > svg").get("flex")).toBe("none");
  });
});
