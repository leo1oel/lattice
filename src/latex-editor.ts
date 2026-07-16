import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { latexCompletionSource } from "codemirror-lang-latex";

const CITATION_COMMANDS = "cite|citep|citet|citealp|citealt|citeauthor|parencite|textcite|autocite|footcite";
const BRACED_COMMANDS = new RegExp(`\\\\(?:${CITATION_COMMANDS}|ref|eqref|pageref|label|input|include)$`);
const OPEN_CITATION = new RegExp(`\\\\(?:${CITATION_COMMANDS})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*)$`);

export function shouldInsertCommandBraces(textBeforeCursor: string): boolean {
  return BRACED_COMMANDS.test(textBeforeCursor);
}

export function citationCompletionRange(textBeforeCursor: string, cursor: number): { from: number; query: string } | null {
  const match = OPEN_CITATION.exec(textBeforeCursor);
  if (!match) return null;
  const parts = match[1].split(",");
  const query = parts[parts.length - 1]?.trimStart() ?? "";
  return { from: cursor - query.length, query };
}

function citationCompletions(keys: string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const windowStart = Math.max(0, context.pos - 600);
    const before = context.state.sliceDoc(windowStart, context.pos);
    const range = citationCompletionRange(before, context.pos);
    if (!range || (!context.explicit && !range.query)) return null;
    return {
      from: range.from,
      options: keys.map((key) => ({ label: key, type: "reference", detail: "bibliography" })),
      validFor: /^[^,}\s]*$/,
    };
  };
}

export function latexEditorExtensions(citationKeys: string[]) {
  return [
    autocompletion({ override: [citationCompletions(citationKeys), latexCompletionSource(true)], activateOnTyping: true }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || !update.transactions.some((transaction) => transaction.isUserEvent("input.type"))) return;
      const selection = update.state.selection.main;
      if (!selection.empty) return;
      if (update.state.sliceDoc(selection.head, selection.head + 1) === "{") return;
      const before = update.state.sliceDoc(Math.max(0, selection.head - 80), selection.head);
      if (!shouldInsertCommandBraces(before)) return;
      update.view.dispatch({
        changes: { from: selection.head, insert: "{}" },
        selection: { anchor: selection.head + 1 },
      });
    }),
  ];
}
