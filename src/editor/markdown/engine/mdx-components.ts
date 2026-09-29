/**
 * MDX component syntax for the visual engine: reading a component's opening
 * tag, finding its closing tag, and writing an opening tag back after its
 * properties change (spec R-FMT-5, §11.11).
 *
 * Only the components Lattice renders are modelled (the keep list: Callout,
 * Accordion and the converter's paper figures); every other component, and
 * any tag this reader cannot fully account for, stays a byte-preserved raw
 * block (R-RT-17, R-BLK-16).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";

/** Components with a rich view. Everything else is kept as its source. */
export const MODELLED_COMPONENTS = new Set(["Callout", "Accordion", "PaperFigure", "PaperFigureRow", "PaperFigurePanel"]);

/**
 * One property as written. `string` values were quoted or a string
 * expression, `boolean` values a bare name (`defaultOpen`) or `{true}` /
 * `{false}`, `number` values `{223}`; anything else is an `expression` kept as
 * its source text.
 */
export type ComponentProp =
  | { name: string; kind: "string"; value: string }
  | { name: string; kind: "boolean"; value: boolean }
  | { name: string; kind: "number"; value: number }
  | { name: string; kind: "expression"; value: string };

export type OpenTag = { name: string; props: ComponentProp[]; selfClosing: boolean; end: number };

const NAME_START = /[A-Za-z_$]/;
const NAME_CHAR = /[\w$.:-]/;
const SPACE = /[ \t\n]/;

/**
 * Read a JSX opening tag at `from` (which holds `<`). Returns null for
 * anything that is not a complete, plainly written tag, such as a spread
 * (`{...props}`), so the caller keeps that source as it is.
 */
export function readOpenTag(source: string, from: number): OpenTag | null {
  if (source[from] !== "<") return null;
  let index = from + 1;
  if (!NAME_START.test(source[index] ?? "")) return null;
  const nameStart = index;
  while (NAME_CHAR.test(source[index] ?? "")) index += 1;
  const name = source.slice(nameStart, index);
  const props: ComponentProp[] = [];
  for (;;) {
    const beforeSpace = index;
    while (SPACE.test(source[index] ?? "")) index += 1;
    const char = source[index];
    if (char === undefined) return null;
    if (char === ">") return { name, props, selfClosing: false, end: index + 1 };
    if (char === "/") return source[index + 1] === ">" ? { name, props, selfClosing: true, end: index + 2 } : null;
    // Attributes are separated by whitespace.
    if (index === beforeSpace || !NAME_START.test(char)) return null;
    const attributeStart = index;
    while (NAME_CHAR.test(source[index] ?? "")) index += 1;
    const attribute = source.slice(attributeStart, index);
    if (source[index] !== "=") {
      props.push({ name: attribute, kind: "boolean", value: true });
      continue;
    }
    index += 1;
    const quote = source[index];
    if (quote === "\"" || quote === "'") {
      const close = source.indexOf(quote, index + 1);
      if (close < 0) return null;
      props.push({ name: attribute, kind: "string", value: decodeEntities(source.slice(index + 1, close)) });
      index = close + 1;
      continue;
    }
    if (quote !== "{") return null;
    const close = expressionEnd(source, index);
    if (close < 0) return null;
    const expression = source.slice(index + 1, close).trim();
    const prop = expressionProp(attribute, expression);
    if (!prop) return null;
    props.push(prop);
    index = close + 1;
  }
}

/** Index of the `}` that closes the expression opened at `from`, or -1. */
function expressionEnd(source: string, from: number): number {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "\"" || char === "'" || char === "`") {
      const close = stringEnd(source, index);
      if (close < 0) return -1;
      index = close;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stringEnd(source: string, from: number): number {
  const quote = source[from];
  for (let index = from + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === quote) return index;
  }
  return -1;
}

function expressionProp(name: string, expression: string): ComponentProp | null {
  if (expression.startsWith("...")) return null;
  if (expression === "true" || expression === "false") return { name, kind: "boolean", value: expression === "true" };
  if (/^-?\d+(?:\.\d+)?$/.test(expression)) return { name, kind: "number", value: Number(expression) };
  if (/^"(?:[^"\\\n]|\\.)*"$/.test(expression)) {
    try {
      return { name, kind: "string", value: JSON.parse(expression) as string };
    } catch {
      return { name, kind: "expression", value: expression };
    }
  }
  return { name, kind: "expression", value: expression };
}

/** JSX string attributes decode HTML character references. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/g, (reference, decimal?: string, hex?: string, named?: string) => {
    if (decimal) return decodeNumericCharacterReference(decimal, 10);
    if (hex) return decodeNumericCharacterReference(hex, 16);
    const decoded = decodeNamedCharacterReference(named!);
    return typeof decoded === "string" ? decoded : reference;
  });
}

/** A string that reads back unchanged inside `"…"`: no quote, no reference, no brace. */
const PORTABLE = /^[^"&{}<>\n]*$/;

/** Write one property the way Lattice writes them (spec §11.11). */
function writeProp(prop: ComponentProp): string {
  switch (prop.kind) {
    case "boolean":
      return prop.value ? prop.name : `${prop.name}={false}`;
    case "number":
      return `${prop.name}={${String(prop.value)}}`;
    case "expression":
      return `${prop.name}={${prop.value}}`;
    default:
      return PORTABLE.test(prop.value) ? `${prop.name}="${prop.value}"` : `${prop.name}={${JSON.stringify(prop.value)}}`;
  }
}

export function writeOpenTag(name: string, props: readonly ComponentProp[], selfClosing = false): string {
  const attributes = props.map(writeProp).join(" ");
  return `<${name}${attributes ? ` ${attributes}` : ""}${selfClosing ? " />" : ">"}`;
}

/** A property's value by name, or undefined. */
export function propValue(props: readonly ComponentProp[], name: string): ComponentProp["value"] | undefined {
  return props.find((prop) => prop.name === name)?.value;
}

/** `props` with `name` set to `value` (in place when present, else appended), or removed when `value` is null. */
export function withProp(props: readonly ComponentProp[], name: string, value: string | boolean | number | null): ComponentProp[] {
  if (value === null) return props.filter((prop) => prop.name !== name);
  const next: ComponentProp = typeof value === "boolean" ? { name, kind: "boolean", value }
    : typeof value === "number" ? { name, kind: "number", value }
      : { name, kind: "string", value };
  const index = props.findIndex((prop) => prop.name === name);
  if (index < 0) return [...props, next];
  return props.map((prop, position) => (position === index ? next : prop));
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Start and end of the `</name>` that closes the component whose opening tag
 * ends at `from`, counting nested components of the same name and skipping
 * fenced code. The closing tag must end its line. Null when there is none.
 */
export function findClosingTag(source: string, name: string, from: number): { start: number; end: number } | null {
  const escaped = name.replace(/[.$]/g, "\\$&");
  const tag = new RegExp(`<${escaped}(?=[\\s/>])|</${escaped}\\s*>`, "g");
  let depth = 1;
  let fence: string | null = null;
  let lineStart = source.lastIndexOf("\n", from - 1) + 1;
  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd);
    const fenceMatch = line.match(FENCE);
    if (fence) {
      if (fenceMatch && fenceMatch[1]!.charAt(0) === fence.charAt(0) && fenceMatch[1]!.length >= fence.length && !line.slice(fenceMatch[0].length).trim()) fence = null;
    } else if (fenceMatch && lineStart >= from) {
      fence = fenceMatch[1]!;
    } else {
      const offset = Math.max(lineStart, from);
      tag.lastIndex = 0;
      for (const match of source.slice(offset, lineEnd).matchAll(tag)) {
        const at = offset + match.index;
        if (match[0].startsWith("</")) {
          depth -= 1;
          if (depth === 0) {
            const end = at + match[0].length;
            return source.slice(end, lineEnd).trim() ? null : { start: at, end };
          }
          continue;
        }
        const open = readOpenTag(source, at);
        if (!open) return null;
        if (!open.selfClosing) depth += 1;
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return null;
}
