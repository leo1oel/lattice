/** Conservative inventory of literal LaTeX graphics; offsets always refer to the original source. */
import { t } from "@lingui/core/macro";
import { LABEL, parseGraphicsPaths } from "../editor/latex/latex-text";
import { REFERENCE, resolveProjectPath } from "../editor/latex/latex-symbols";

export type FigureUse = {
  source: string; line: number; from: number; to: number; raw: string;
  asset: string | null; dynamic: boolean; caption: string; labels: string[];
  duplicateLabels: string[]; references: { source: string; line: number }[];
  widthInches: number | null;
};
type FigureInventory = { uses: FigureUse[]; limited: string[] };
export const isFigureAsset = (path: string) => /\.(pdf|svg|png|jpe?g|webp|eps)$/i.test(path);

/** Blank ignored text instead of deleting it, preserving both offsets and line numbers. */
function visibleTex(text: string): string {
  const blank = (value: string) => value.replace(/[^\n]/g, " ");
  return text.replace(/\\begin\{(verbatim\*?|lstlisting|minted|comment)\}[\s\S]*?\\end\{\1\}|\\verb\*?([^\w\s])[\s\S]*?\2|(?<!\\)(?:\\\\)*%[^\n]*/g, blank);
}

function group(text: string, start: number, open = "{", close = "}") {
  while (/\s/.test(text[start] ?? "") && start < text.length) start++;
  if (text[start] !== open) return null;
  let depth = 1;
  for (let end = start + 1; end < text.length; end++) {
    if (text[end] === "\\") { end++; continue; }
    if (text[end] === open) depth++;
    if (text[end] === close && --depth === 0) return { from: start + 1, to: end, value: text.slice(start + 1, end) };
  }
  return null;
}

function argument(text: string, afterCommand: number) {
  let at = afterCommand;
  if (text[at] === "*") at++;
  while (/\s/.test(text[at] ?? "") && at < text.length) at++;
  const option = group(text, at, "[", "]");
  if (option) at = option.to + 1;
  const value = group(text, at);
  return value ? { ...value, options: option?.value ?? "" } : null;
}

/** Physical widths only; textwidth, macros, scale and transforms cannot establish raster DPI. */
export function figureWidthInches(options: string): number | null {
  if (/(?:^|,)\s*(?:scale|angle|trim|viewport|height|totalheight)\s*=/.test(options)) return null;
  const width = options.match(/(?:^|,)\s*width\s*=\s*(\d+(?:\.\d+)?)\s*(in|cm|mm|pt|bp)\s*(?:,|$)/);
  if (!width) return null;
  const inches = Number(width[1]) / ({ in: 1, cm: 2.54, mm: 25.4, pt: 72.27, bp: 72 }[width[2]] ?? 1);
  return inches > 0 ? inches : null;
}

export function scanFigureInventory(sources: Record<string, string>, paths: string[]): FigureInventory {
  const texts = Object.fromEntries(Object.entries(sources).map(([path, text]) => [path, visibleTex(text)]));
  const roots = parseGraphicsPaths(Object.values(texts));
  const labels = new Map<string, number>();
  const references = new Map<string, { source: string; line: number }[]>();
  const lineAt = (text: string, at: number) => text.slice(0, at).split("\n").length;
  const limited = new Set<string>();
  for (const [source, text] of Object.entries(texts)) {
    if (/\\(?:def|[egx]def|newcommand|renewcommand|providecommand|if\w*|DeclareGraphicsExtensions|graphicspath)\b/.test(text)) limited.add(source);
    for (const match of text.matchAll(LABEL)) labels.set(match[1], (labels.get(match[1]) ?? 0) + 1);
    for (const match of text.matchAll(REFERENCE)) for (const label of match[1].split(",").map((key) => key.trim())) {
      references.set(label, [...(references.get(label) ?? []), { source, line: lineAt(text, match.index) }]);
    }
  }
  const uses: FigureUse[] = [];
  for (const [source, text] of Object.entries(texts)) {
    const figures = [...text.matchAll(/\\begin\{figure\*?\}[\s\S]*?\\end\{figure\*?\}/g)];
    for (const command of text.matchAll(/\\includegraphics\b/g)) {
      const arg = argument(text, command.index + command[0].length);
      if (!arg) { limited.add(source); continue; }
      const raw = sources[source].slice(arg.from, arg.to);
      const literal = raw.trim().replace(/^\\detokenize\{([^{}]*)\}$/, "$1");
      const dynamic = /[\\#{}]/.test(literal) || /^https?:/.test(literal);
      // Reuse navigation's extension/root resolver, but forbid its suffix fallback:
      // two different folders with the same basename must never silently pick one.
      const candidates = paths.filter((path) => ["", ...roots.map((root) => `${root}/`)].some((root) => {
        const base = `${root}${literal}`.replace(/^\.\//, "").replace(/\/+/g, "/");
        return path === base || (!/\.[^/]+$/.test(literal) && path.startsWith(`${base}.`) && isFigureAsset(path));
      }));
      const asset = dynamic || candidates.length !== 1 ? null : resolveProjectPath(candidates[0], candidates, "graphics", roots);
      if (dynamic || candidates.length > 1) limited.add(source);
      const figure = figures.find((item) => item.index <= command.index && item.index + item[0].length > command.index)?.[0] ?? "";
      const captionCommand = /\\caption\b/.exec(figure);
      const caption = captionCommand ? argument(figure, captionCommand.index + captionCommand[0].length)?.value.trim() ?? "" : "";
      const ownLabels = [...figure.matchAll(LABEL)].map((match) => match[1]);
      uses.push({ source, line: lineAt(text, command.index), from: arg.from, to: arg.to, raw, asset,
        dynamic: dynamic || candidates.length > 1, caption, labels: ownLabels,
        duplicateLabels: ownLabels.filter((label) => (labels.get(label) ?? 0) > 1),
        references: ownLabels.flatMap((label) => references.get(label) ?? []), widthInches: figureWidthInches(arg.options) });
    }
  }
  return { uses, limited: [...limited] };
}

/** Replace only the previewed arguments, in reverse offset order; comments and captions stay intact. */
export function figureReplacement(sources: Record<string, string>, uses: FigureUse[], target: string) {
  if (!isFigureAsset(target) || /[\\{}%#\r\n]/.test(target)) throw new Error(t`This figure path cannot be inserted safely.`);
  return [...new Set(uses.map((use) => use.source))].map((path) => {
    const before = sources[path];
    let after = before;
    for (const use of uses.filter((use) => use.source === path).sort((a, b) => b.from - a.from)) {
      if (before.slice(use.from, use.to) !== use.raw) throw new Error(t`The figure source changed. Refresh and preview again.`);
      after = after.slice(0, use.from) + `\\detokenize{${target}}` + after.slice(use.to);
    }
    return { path, before, after };
  });
}
