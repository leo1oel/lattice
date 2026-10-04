import { invoke } from "@tauri-apps/api/core";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorState, Text } from "@codemirror/state";
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
  return { line, request: { path, doc: state.doc, line: line.number, character: pos - line.from + 1 } };
}

/** What `texlab.rs` answers a text-less request when TexLab does not hold that revision. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- matched against texlab.rs's NEEDS_TEXT, never shown
const NEEDS_TEXT = "TexLab needs the document text.";

// Each document text the editor has gets a revision number; a text is
// immutable, so an edit is a new text and a new revision.
const revisions = new WeakMap<Text, number>();
let lastRevision = 0;
function revisionOf(doc: Text) {
  let revision = revisions.get(doc);
  if (revision === undefined) {
    revision = ++lastRevision;
    revisions.set(doc, revision);
  }
  return revision;
}
/** The revision of each path TexLab was last sent. */
const sentRevisions = new Map<string, number>();

/**
 * Ask TexLab at a position, sending the whole text only when TexLab may not
 * hold this revision of it. A request at the revision last sent goes without
 * it; should TexLab hold another text by then (a diagnostics sync, a restart),
 * it refuses and the request goes again with the text.
 */
async function askTexlab<T>(command: string, { path, doc, line, character }: {
  path: string; doc: Text; line: number; character: number;
}): Promise<T> {
  const revision = revisionOf(doc);
  const request = { path, revision, line, character };
  if (sentRevisions.get(path) === revision) {
    try {
      return await invoke<T>(command, { ...request, text: null });
    } catch (error) {
      if (error !== NEEDS_TEXT) throw error;
    }
  }
  const answer = await invoke<T>(command, { ...request, text: doc.toString() });
  sentRevisions.set(path, revision);
  return answer;
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
      const items = await askTexlab<TexlabCompletionItem[]>("texlab_completion", position.request);
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
      const hover = await askTexlab<{ contents: string } | null>("texlab_hover", position.request);
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
