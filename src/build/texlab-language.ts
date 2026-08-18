import { invoke } from "@tauri-apps/api/core";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { hoverTooltip } from "@codemirror/view";

const OPEN_CITATION = /\\(?:cite|citep|citet|citealp|citealt|citeauthor|parencite|textcite|autocite|footcite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/;
const OPEN_REFERENCE = /\\(?:ref|eqref|pageref|autoref|cref|Cref)\*?\{([^}]*)$/;

export type TexlabCompletionItem = {
  label: string;
  detail?: string | null;
  kind?: string | null;
  insertText?: string | null;
  documentation?: string | null;
};

export type TexlabHover = {
  contents: string;
};

export type TexlabLocation = {
  path: string;
  line: number;
  column: number;
};

export function isCiteOrRefCompletionContext(textBefore: string): boolean {
  return OPEN_CITATION.test(textBefore) || OPEN_REFERENCE.test(textBefore);
}

export function texlabCompletionSource(getPath: () => string) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const path = getPath();
    if (!path.endsWith(".tex")) return null;
    const textBefore = context.state.sliceDoc(Math.max(0, context.pos - 160), context.pos);
    if (isCiteOrRefCompletionContext(textBefore)) return null;
    const word = context.matchBefore(/\\?[A-Za-z@*]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const docLine = context.state.doc.lineAt(context.pos);
    try {
      const items = await invoke<TexlabCompletionItem[]>("texlab_completion", {
        path,
        text: context.state.doc.toString(),
        line: docLine.number,
        character: context.pos - docLine.from + 1,
      });
      if (!items.length) return null;
      return {
        from: word.from,
        options: items.map((item) => ({
          label: item.label,
          detail: item.detail ?? "TexLab",
          type: item.kind ?? "keyword",
          apply: item.insertText || item.label,
          info: item.documentation || undefined,
          boost: item.label.startsWith("\\") ? 2 : 0,
        })),
        validFor: /^\\?[A-Za-z@*]*$/,
      };
    } catch {
      return null;
    }
  };
}

export function texlabHoverTooltip(getPath: () => string) {
  return hoverTooltip(async (view, position) => {
    const path = getPath();
    if (!path.endsWith(".tex")) return null;
    const textBefore = view.state.sliceDoc(Math.max(0, position - 160), position);
    if (isCiteOrRefCompletionContext(textBefore)) return null;
    const line = view.state.doc.lineAt(position);
    try {
      const hover = await invoke<TexlabHover | null>("texlab_hover", {
        path,
        text: view.state.doc.toString(),
        line: line.number,
        character: position - line.from + 1,
      });
      if (!hover?.contents.trim()) return null;
      const start = Math.max(line.from, position - 40);
      const end = Math.min(line.to, position + 40);
      return {
        pos: start,
        end,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "texlab-hover-card";
          dom.textContent = hover.contents;
          return { dom };
        },
      };
    } catch {
      return null;
    }
  }, { hoverTime: 420 });
}

export async function resolveTexlabDefinition(
  path: string,
  text: string,
  line: number,
  character: number,
): Promise<TexlabLocation | null> {
  if (!path.endsWith(".tex")) return null;
  try {
    return await invoke<TexlabLocation | null>("texlab_definition", {
      path,
      text,
      line,
      character,
    });
  } catch {
    return null;
  }
}

export async function formatLatexDocument(path: string, text: string): Promise<string> {
  return invoke<string>("format_latex", { path, text });
}
