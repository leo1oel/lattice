/**
 * What Visual mode reads from an editable figure's entry file
 * (docs/editable-figures.md): the graphic it draws, and the labels it sets
 * over it. A drawing program writes the labels as TikZ nodes in a scope whose
 * axes span the graphic, so `(0.5,0.1)` is halfway across and a tenth of the
 * way up:
 *
 *     \node[anchor=south west] (fig) at (0,0) {\includegraphics{scheme.pdf}};
 *     \begin{scope}[x={(fig.south east)},y={(fig.north west)}]
 *       \node at (0.17,0.11) {\fontsize{10}{12}\selectfont \textbf{\cmpd{ketone}}~(85\%)};
 *     \end{scope}
 *
 * The entry is any file in the project (a co-author's, a clone's), so it is
 * only read: nothing in it runs, and what is drawn is plain text.
 */

/** A run of a label: text, or the keys of compound numbers to print. */
type FigureLabelRun = { bold: boolean } & ({ text: string } | { compounds: string[] });

/** A label set over the graphic: where its baseline's middle is (0..1 from the bottom left), its size in points, and its runs. */
export type FigureLabel = { x: number; y: number; size: number | null; runs: FigureLabelRun[] };

/** The longest entry file read: a figure's entry is a few dozen lines. */
const ENTRY_LIMIT = 200_000;
/** The most labels drawn over one figure. */
const LABEL_LIMIT = 500;

const withoutComments = (text: string) => text.replace(/(?<!\\)%.*$/gm, "");

/** The first graphic the entry includes, as written (`scheme.pdf`), or null. */
export function figureEntryGraphic(entry: string): string | null {
  const match = /\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^{}\\]+)\}/.exec(withoutComments(entry.slice(0, ENTRY_LIMIT)));
  return match ? match[1].trim() : null;
}

/** The end of the braced group opening at `open`, past its `}`; -1 when it does not close. */
function groupEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

/**
 * The labels an entry sets over its graphic: each `\node … at (x,y) {…}` in a
 * scope whose axes are the graphic's corners. Coordinates outside 0..1 (a
 * label beside the drawing) are kept; anything not read for certain is left out.
 */
export function figureEntryLabels(entry: string): FigureLabel[] {
  const text = withoutComments(entry.slice(0, ENTRY_LIMIT));
  const scope = /\\begin\{scope\}\s*\[[^\]]*x\s*=\s*\{\(\s*[\w-]+\.south east\s*\)\}[^\]]*\]/.exec(text);
  if (!scope) return [];
  const close = text.indexOf("\\end{scope}", scope.index);
  const body = text.slice(scope.index + scope[0].length, close < 0 ? text.length : close);
  const labels: FigureLabel[] = [];
  const node = /\\node\s*(?:\[[^\]]*\]\s*)?(?:\([\w-]*\)\s*)?at\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)\s*\{/g;
  for (let match = node.exec(body); match && labels.length < LABEL_LIMIT; match = node.exec(body)) {
    const open = match.index + match[0].length - 1;
    const end = groupEnd(body, open);
    if (end < 0) break;
    node.lastIndex = end;
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const content = body.slice(open + 1, end - 1);
    const size = /\\fontsize\s*\{\s*([\d.]+)\s*\}/.exec(content);
    const runs = labelRuns(content, false);
    if (runs.length) labels.push({ x, y, size: size ? Number(size[1]) : null, runs });
  }
  return labels;
}

/** Commands whose arguments a label's text leaves out: font choices. */
const FONT_COMMANDS = new Set(["fontsize", "fontfamily", "reactiofigurefont", "usefont", "color", "textcolor"]);
const ESCAPES: Readonly<Record<string, string>> = { "%": "%", "&": "&", "#": "#", "_": "_", "$": "$", " ": " ", ",": " " };

/** A label's content as runs of text and compound numbers. */
function labelRuns(content: string, bold: boolean): FigureLabelRun[] {
  const runs: FigureLabelRun[] = [];
  let pending = "";
  let isBold = bold;
  const flush = () => {
    if (pending) runs.push({ bold: isBold, text: pending });
    pending = "";
  };
  for (let at = 0; at < content.length;) {
    const char = content[at];
    if (char === "~") {
      pending += " ";
      at++;
    } else if (char === "{" || char === "}") {
      at++;
    } else if (char === "\\") {
      const name = /^\\([A-Za-z@]+)\*?|^\\(.)/.exec(content.slice(at));
      if (!name) break;
      at += name[0].length;
      const command = name[1];
      if (!command) {
        pending += ESCAPES[name[2]] ?? "";
        continue;
      }
      while (content[at] === " ") at++;
      if (command === "bfseries") {
        flush();
        isBold = true;
      } else if (command === "textbf" || command === "cmpd" || command === "rcmpd" || command === "refcmpd" || FONT_COMMANDS.has(command)) {
        while (content[at] === "[") at = Math.max(at + 1, content.indexOf("]", at) + 1);
        const argumentCount = command === "fontsize" || command === "textcolor" ? 2 : 1;
        const args: string[] = [];
        for (let index = 0; index < argumentCount && content[at] === "{"; index++) {
          const end = groupEnd(content, at);
          if (end < 0) return runs;
          args.push(content.slice(at + 1, end - 1));
          at = end;
        }
        if (command === "textbf") {
          flush();
          runs.push(...labelRuns(args[0] ?? "", true));
        } else if (command === "textcolor") {
          flush();
          runs.push(...labelRuns(args[1] ?? "", isBold));
        } else if (!FONT_COMMANDS.has(command) && args[0]?.trim()) {
          flush();
          const keys = command === "rcmpd" ? [args[0].trim()] : args[0].split(",").map((key) => key.trim()).filter(Boolean);
          runs.push({ bold: isBold, compounds: keys });
        }
      }
      // Any other command (`\selectfont`, `\small`) prints nothing here.
    } else {
      pending += char === "\n" ? " " : char;
      at++;
    }
  }
  flush();
  return runs;
}
