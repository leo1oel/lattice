import { invoke } from "@tauri-apps/api/core";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorState } from "@codemirror/state";
import { hoverTooltip, type Tooltip } from "@codemirror/view";

const OPEN_CITATION = /\\(?:cite|citep|citet|citealp|citealt|citeauthor|parencite|textcite|autocite|footcite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/;
const OPEN_REFERENCE = /\\(?:ref|eqref|pageref|autoref|cref|Cref)\*?\{([^}]*)$/;

type TexlabCompletionItem = {
  label: string;
  detail?: string | null;
  kind?: string | null;
  insertText?: string | null;
  documentation?: string | null;
};

export type TexlabLocation = {
  path: string;
  line: number;
  column: number;
};

export function isCiteOrRefCompletionContext(textBefore: string): boolean {
  return OPEN_CITATION.test(textBefore) || OPEN_REFERENCE.test(textBefore);
}

/**
 * The TexLab request position in a `.tex` file, or null when TexLab should not
 * answer: citation and reference arguments belong to the bibliography sources.
 */
function texlabPosition(path: string, state: EditorState, pos: number) {
  if (!path.endsWith(".tex")) return null;
  if (isCiteOrRefCompletionContext(state.sliceDoc(Math.max(0, pos - 160), pos))) return null;
  const line = state.doc.lineAt(pos);
  return { line, request: { path, text: state.doc.toString(), line: line.number, character: pos - line.from + 1 } };
}

/** TexLab is optional help: any failure, in the request or its reply, means no answer. */
async function quietly<T>(answer: () => Promise<T | null>): Promise<T | null> {
  try {
    return await answer();
  } catch {
    return null;
  }
}

export function texlabCompletionSource(getPath: () => string) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const word = context.matchBefore(/\\?[A-Za-z@*]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const position = texlabPosition(getPath(), context.state, context.pos);
    if (!position) return null;
    return quietly(async () => {
      const items = await invoke<TexlabCompletionItem[]>("texlab_completion", position.request);
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
    });
  };
}

/** TexLab's hover card; `fallback` answers when TexLab is off, missing or has nothing to say. */
export function texlabHoverTooltip(
  getPath: () => string,
  fallback: (state: EditorState, pos: number) => Tooltip | null = () => null,
  texlab = true,
) {
  return hoverTooltip(async (view, pos) => {
    const position = texlab ? texlabPosition(getPath(), view.state, pos) : null;
    if (!position) return fallback(view.state, pos);
    const answer = await quietly<Tooltip>(async () => {
      const hover = await invoke<{ contents: string } | null>("texlab_hover", position.request);
      if (!hover?.contents.trim()) return null;
      return {
        pos: Math.max(position.line.from, pos - 40),
        end: Math.min(position.line.to, pos + 40),
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "texlab-hover-card";
          dom.textContent = hover.contents;
          return { dom };
        },
      };
    });
    return answer ?? fallback(view.state, pos);
  }, { hoverTime: 420 });
}

export async function resolveTexlabDefinition(path: string, text: string, line: number, character: number): Promise<TexlabLocation | null> {
  if (!path.endsWith(".tex")) return null;
  return quietly(() => invoke<TexlabLocation | null>("texlab_definition", { path, text, line, character }));
}

export async function formatLatexDocument(path: string, text: string): Promise<string> {
  return invoke<string>("format_latex", { path, text });
}
