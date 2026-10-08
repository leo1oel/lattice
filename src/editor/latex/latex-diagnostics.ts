import type { Diagnostic } from "@codemirror/lint";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../../i18n";
import { environmentEvents, type EnvironmentEvent } from "./latex-environments";
import { uncommented } from "./latex-language";
import {
  CITATION, GRAPHICS, INCLUDE, REFERENCE, argumentsOf, keySpans, resolveProjectPath, unwrapLatexPath, type KeySpan,
} from "./latex-symbols";
import { LABEL, type ReferenceInfo } from "./latex-text";
import { unclosedMathDiagnostics } from "./math-region";

const BIB_ENTRY = /@\w+\s*\{\s*([^,\s}]+)/g;

/** The lint tooltip prints `source` under the message, so it is interface text too. */
type Source = "structure" | "paths" | "labels" | "bibliography";
const SOURCE_NAMES: Record<Source, MessageDescriptor> = {
  structure: msg`structure`,
  paths: msg`paths`,
  labels: msg`labels`,
  bibliography: msg`bibliography`,
};

const warning = (from: number, to: number, source: Source, message: string): Diagnostic =>
  ({ from, to, severity: "warning", message, source: i18n._(SOURCE_NAMES[source]) });
const error = (span: { from: number; to: number }, message: string): Diagnostic =>
  ({ from: span.from, to: span.to, severity: "error", message, source: i18n._(SOURCE_NAMES.structure) });

function labelSpans(text: string): KeySpan[] {
  return argumentsOf(text, LABEL).flatMap(({ from, content }) => {
    const key = content.trim();
    return key ? [{ from, to: from + content.length, key }] : [];
  });
}

function bibKeySpans(text: string): KeySpan[] {
  return [...text.matchAll(BIB_ENTRY)].map((match) => {
    const to = match.index + match[0].length;
    return { from: to - match[1].length, to, key: match[1] };
  });
}

/** Every repeat of a key after its first occurrence. */
function duplicateKeyWarnings(spans: KeySpan[], source: Source, message: (key: string) => string): Diagnostic[] {
  const seen = new Set<string>();
  return spans.flatMap(({ from, to, key }) => {
    const repeat = seen.has(key);
    seen.add(key);
    return repeat ? [warning(from, to, source, message(key))] : [];
  });
}

function missingIncludeCreatePath(raw: string): string | null {
  const path = unwrapLatexPath(raw);
  if (!path || path.startsWith("/") || path.includes("..") || path.includes(":")) return null;
  return path.endsWith(".tex") ? path : `${path}.tex`;
}

export function pathDiagnostics(
  text: string,
  projectPaths: string[],
  graphicsRoots: string[] = [],
  onCreateMissingFile?: (path: string) => void,
): Diagnostic[] {
  if (!projectPaths.length) return [];
  const diagnostics: Diagnostic[] = [];
  for (const { from, content } of argumentsOf(text, INCLUDE)) {
    const path = content.trim();
    if (!path || resolveProjectPath(path, projectPaths, "tex")) continue;
    const createPath = missingIncludeCreatePath(path);
    diagnostics.push({
      ...warning(from, from + content.length, "paths", i18n._(msg`Missing file “${path}”.`)),
      actions: createPath && onCreateMissingFile
        ? [{ name: i18n._(msg`Create file`), apply: () => onCreateMissingFile(createPath) }]
        : undefined,
    });
  }
  for (const { from, content } of argumentsOf(text, GRAPHICS)) {
    const raw = content.trim();
    if (!raw || resolveProjectPath(raw, projectPaths, "graphics", graphicsRoots)) continue;
    const figure = unwrapLatexPath(raw) || raw;
    diagnostics.push(warning(from, from + content.length, "paths", i18n._(msg`Missing figure “${figure}”.`)));
  }
  return diagnostics;
}

/**
 * Blank out `%` comments so they cannot open or close anything. Folding and
 * auto-close read comments through the same `uncommented` rule, so lint agrees
 * with them on `\\%` (a line break, then a comment) and on a `%` inside `$…$`,
 * which TeX also reads as a comment. Blanking keeps every offset in place.
 */
function stripLineComments(text: string): string {
  return text.split("\n").map((line) => uncommented(line).padEnd(line.length)).join("\n");
}

export function structureDiagnostics(text: string): Diagnostic[] {
  const source = stripLineComments(text);
  const diagnostics: Diagnostic[] = [];
  const stack: EnvironmentEvent[] = [];
  for (const event of environmentEvents(source)) {
    if (event.kind === "begin") {
      stack.push(event);
      continue;
    }
    const open = stack.pop();
    // The command goes in whole as a placeholder: literal braces inside a
    // message would read as ICU syntax.
    const found = `\\end{${event.name}}`;
    if (!open) diagnostics.push(error(event, i18n._(msg`Unmatched ${found}.`)));
    else if (open.name !== event.name) {
      const expected = `\\end{${open.name}}`;
      diagnostics.push(error(event, i18n._(msg`Expected ${expected}, found ${found}.`)));
    }
  }
  return [
    ...diagnostics,
    ...stack.map((open) => {
      const command = `\\begin{${open.name}}`;
      return error(open, i18n._(msg`Unclosed ${command}.`));
    }),
    ...duplicateKeyWarnings(labelSpans(source), "labels", (key) => i18n._(msg`Duplicate label “${key}”.`)),
    ...duplicateKeyWarnings(bibKeySpans(source), "bibliography", (key) => i18n._(msg`Duplicate bibliography key “${key}”.`)),
    ...unclosedMathDiagnostics(source),
  ];
}

/** What the project index knows; missing lists are treated as empty. */
export type LatexIndex = {
  citationKeys: string[];
  references: ReferenceInfo[];
  /** The keys and labels are not this project's yet: report nothing that depends on them. */
  indexPending?: boolean;
  unusedLabels?: string[];
  unusedCitations?: string[];
  projectPaths?: string[];
  graphicsRoots?: string[];
};

export function indexDiagnostics(
  text: string,
  index: LatexIndex,
  currentPath = "",
  onCreateMissingFile?: (path: string) => void,
): Diagnostic[] {
  const fileDiagnostics = [
    ...structureDiagnostics(text),
    ...pathDiagnostics(text, index.projectPaths ?? [], index.graphicsRoots, onCreateMissingFile),
  ];
  if (index.indexPending) return fileDiagnostics;
  const citationKeys = new Set(index.citationKeys);
  const labels = new Set(index.references.map((reference) => reference.label));
  const unusedLabels = new Set(index.unusedLabels);
  const unusedCitations = new Set(index.unusedCitations);
  const labelPaths = new Map<string, Set<string>>();
  for (const { label, path } of index.references) labelPaths.set(label, (labelPaths.get(label) ?? new Set()).add(path));
  const unknown = (pattern: RegExp, known: Set<string>, source: Source, message: (key: string) => string) =>
    argumentsOf(text, pattern).flatMap(({ from, content }) => keySpans(content, from)
      .filter(({ key }) => !known.has(key))
      .map(({ from, to, key }) => warning(from, to, source, message(key))));
  const labelDiagnostics = labelSpans(text).flatMap(({ from, to, key }) => {
    const others = currentPath ? [...labelPaths.get(key) ?? []].filter((path) => path !== currentPath) : [];
    const [path] = others;
    const more = others.length - 1;
    const message = !others.length
      ? unusedLabels.has(key) ? i18n._(msg`Unused label “${key}”.`) : null
      : more > 0
        ? i18n._(msg`Duplicate label “${key}” also defined in ${path} (+${more} more).`)
        : i18n._(msg`Duplicate label “${key}” also defined in ${path}.`);
    return message ? [warning(from, to, "labels", message)] : [];
  });
  return [
    ...fileDiagnostics,
    ...unknown(CITATION, citationKeys, "bibliography", (key) => i18n._(msg`Unknown citation key “${key}”.`)),
    ...unknown(REFERENCE, labels, "labels", (key) => i18n._(msg`Unknown label “${key}”.`)),
    ...labelDiagnostics,
    ...bibKeySpans(text)
      .filter(({ key }) => unusedCitations.has(key))
      .map(({ from, to, key }) => warning(from, to, "bibliography", i18n._(msg`Unused citation key “${key}”.`))),
  ];
}
