import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { latexCompletionSource } from "codemirror-lang-latex";

const CITATION_COMMANDS = "cite|citep|citet|citealp|citealt|citeauthor|parencite|textcite|autocite|footcite";
const BRACED_COMMANDS = new RegExp(`\\\\(?:${CITATION_COMMANDS}|ref|eqref|pageref|label|input|include)$`);
const OPEN_CITATION = new RegExp(`\\\\(?:${CITATION_COMMANDS})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*)$`);

export const luxLatexHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.definitionKeyword], color: "var(--syntax-keyword)", fontWeight: "600", fontStyle: "oblique" },
  { tag: tags.operator, color: "var(--syntax-operator)" },
  { tag: [tags.heading, tags.function(tags.variableName), tags.macroName], color: "var(--syntax-function)", fontWeight: "600" },
  { tag: [tags.typeName, tags.className], color: "var(--syntax-type)" },
  { tag: tags.variableName, color: "var(--syntax-variable)" },
  { tag: [tags.special(tags.variableName), tags.labelName, tags.processingInstruction], color: "var(--syntax-variable-special)", fontStyle: "italic" },
  { tag: tags.propertyName, color: "var(--syntax-property)" },
  { tag: tags.attributeName, color: "var(--syntax-attribute)" },
  { tag: [tags.string, tags.quote], color: "var(--syntax-string)" },
  { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.docComment, tags.meta], color: "var(--syntax-comment-doc)", fontStyle: "italic" },
  { tag: tags.bool, color: "var(--syntax-number)", fontWeight: "600" },
  { tag: tags.number, color: "var(--syntax-number)" },
  { tag: tags.constant(tags.name), color: "var(--syntax-constant)" },
  { tag: tags.bracket, color: "var(--syntax-bracket)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.invalid, color: "inherit", textDecoration: "none" },
]);

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
    if (!range) return null;
    return {
      from: range.from,
      options: keys.map((key) => ({ label: key, type: "reference" })),
      validFor: /^[^,}\s]*$/,
    };
  };
}

export function latexEditorExtensions(citationKeys: string[]) {
  return [
    EditorView.contentAttributes.of({
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
    }),
    syntaxHighlighting(luxLatexHighlightStyle),
    autocompletion({
      override: [citationCompletions(citationKeys), latexCompletionSource(true)],
      activateOnTyping: true,
      activateOnTypingDelay: 0,
      icons: false,
    }),
    EditorView.updateListener.of((update) => {
      const insertedCommand = update.transactions.some((transaction) =>
        transaction.isUserEvent("input.type") || transaction.isUserEvent("input.complete"),
      );
      if (!update.docChanged || !insertedCommand) return;
      const selection = update.state.selection.main;
      if (!selection.empty) return;
      if (update.state.sliceDoc(selection.head, selection.head + 1) === "{") return;
      const before = update.state.sliceDoc(Math.max(0, selection.head - 80), selection.head);
      if (!shouldInsertCommandBraces(before)) return;
      update.view.dispatch({
        changes: { from: selection.head, insert: "{}" },
        selection: { anchor: selection.head + 1 },
        annotations: Transaction.userEvent.of("input.type"),
      });
    }),
  ];
}
