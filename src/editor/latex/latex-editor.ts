/** The CodeMirror extension sets for source editors: shared text editing, and LaTeX on top of it. */
import { autocompletion, insertBracket } from "@codemirror/autocomplete";
import { insertNewlineKeepIndent } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { highlightSelectionMatches, openSearchPanel, replaceAll, search, searchKeymap } from "@codemirror/search";
import { Prec, Transaction, type Extension } from "@codemirror/state";
import { EditorView, keymap, tooltips, type Command } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { resolveTexlabDefinition, texlabCompletionSource, texlabHoverTooltip } from "../../build/texlab-language";
import { floatingSurfaceClassName } from "../../components/ui/menu-surface";
import { harperSpellcheck } from "../harper-spellcheck";
import { latexCommandCompletions, latexCommandHover } from "./latex-command-completions";
import {
  citationCompletions, citationIcon, includeCompletions, macroCompletions, openCitationAtCursor, referenceCompletions,
  textBefore,
} from "./latex-completions";
import { indexDiagnostics } from "./latex-diagnostics";
import {
  sortSelectedLines, toggleLineComments, transformCase, wrapCommentRegion, wrapEnvironment, wrapRange,
  type CaseMode, type SelectionEdit, type TextEdit,
} from "./latex-edits";
import {
  beginEnvironmentClose, enclosingEnvironment, enclosingEnvironmentRange, environmentAt, matchingEnvironmentTarget,
} from "./latex-environments";
import { citationTooltips, citationTooltipSpace, referenceTooltips } from "./latex-hover-cards";
import {
  CITATION_COMMANDS, citationCompletionRange, definitionTargetAt, shouldInsertCommandBraces, symbolAt,
} from "./latex-symbols";
import type { CitationInfo, DefinitionTarget, LocalMacro, ReferenceInfo, SymbolTarget } from "./latex-text";
import { matchingMathDelimiter } from "./math-region";
import { compactSearchPanel } from "./search-panel";

const CITATION_COMMAND_END = new RegExp(`\\\\(?:${CITATION_COMMANDS})$`);

const luxLatexHighlightStyle = HighlightStyle.define([
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

/** Project data the editor reads at use time, so extensions need not be rebuilt as it changes. */
export type LatexEditorLiveData = {
  citationKeys: string[];
  citations: CitationInfo[];
  references: ReferenceInfo[];
  unusedLabels: string[];
  unusedCitations: string[];
  localMacros: LocalMacro[];
  graphicsRoots: string[];
  projectPaths: string[];
  onOpenCitation?: (key: string) => void;
  canOpenCitation?: (key: string) => boolean;
  spellingWords: string[];
  onAddSpellingWord?: (word: string) => boolean | Promise<boolean>;
};

export type LatexEditorOptions = {
  live: { current: LatexEditorLiveData };
  /** Project path of the edited file; enables cross-file label lint and TexLab. */
  currentPath?: string;
  spellcheck?: boolean;
  /** TexLab hover, completion, and go-to-definition fallback (needs a `.tex` currentPath). */
  texlab?: boolean;
  loadReferenceImage?: (path: string) => Promise<string | null>;
  onGotoDefinition?: (target: DefinitionTarget) => void;
  onFindReferences?: (target: SymbolTarget) => void;
  onRenameSymbol?: (target: SymbolTarget) => void;
  onRenameEnvironment?: (currentName: string) => void;
  onWrapEnvironment?: () => void;
  onPasteImage?: (file: File) => boolean | void;
  onCreateMissingFile?: (path: string) => void;
  onTexlabGoto?: (path: string, line: number, column?: number) => void;
};

/**
 * Enter keeps the current line's indent rather than adding an indent unit:
 * that suits a programming language, not LaTeX prose inside
 * `\begin{document}`. Right after a `\begin{env}` it opens an indented body
 * line and writes the matching `\end{env}`, unless the environment is already
 * closed there, in which case it only indents the new line.
 */
export function insertLatexNewline(view: EditorView): boolean {
  const { main } = view.state.selection;
  const line = view.state.doc.lineAt(main.from);
  const before = line.text.slice(0, main.from - line.from).replace(/[ \t]+$/, "");
  if (!main.empty || !/\\begin\{[^}]+\}$/.test(before)) return insertNewlineKeepIndent(view);
  const indent = /^\s*/.exec(line.text)?.[0] ?? "";
  const close = beginEnvironmentClose(before, view.state.sliceDoc(main.from), indent)
    ?? { insert: `\n${indent}  `, cursorOffset: indent.length + 3 };
  // Trailing blanks after the `\begin{…}` would otherwise end up after the `\end{…}`.
  const from = line.from + before.length;
  view.dispatch({
    changes: { from, to: main.from, insert: close.insert },
    selection: { anchor: from + close.cursorOffset },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/** A command that applies a text edit to the main selection and selects its result. */
function editCommand(edit: (text: string, from: number, to: number) => SelectionEdit | TextEdit | null): Command {
  return (view) => {
    const { from, to } = view.state.selection.main;
    const result = edit(view.state.doc.toString(), from, to);
    if (!result) return false;
    view.dispatch({
      changes: { from: result.from, to: result.to, insert: result.insert },
      selection: "cursorFrom" in result
        ? { anchor: result.cursorFrom, head: result.cursorTo }
        : { anchor: result.from, head: result.from + result.insert.length },
      scrollIntoView: true,
    });
    return true;
  };
}

const wrapCommand = (before: string, after: string) =>
  editCommand((text, from, to) => wrapRange(text, from, to, before, after));
const caseCommand = (mode: CaseMode) =>
  editCommand((text, from, to) => transformCase(text, from, to, mode));

function selectRange(view: EditorView, range: { from: number; to: number } | null): boolean {
  if (!range) return false;
  view.dispatch({ selection: { anchor: range.from, head: range.to }, scrollIntoView: true });
  return true;
}

function dollarPairCommand(view: EditorView): boolean {
  const { empty, head } = view.state.selection.main;
  if (!empty) return wrapCommand("$", "$")(view);
  const before = view.state.sliceDoc(Math.max(0, head - 1), head);
  const after = view.state.sliceDoc(head, head + 1);
  view.dispatch({
    // `$|$` becomes display math `$$|$$`; a closing `$` is stepped over.
    changes: after !== "$"
      ? { from: head, insert: "$$" }
      : before === "$" ? { from: head - 1, to: head + 1, insert: "$$$$" } : undefined,
    selection: { anchor: head + 1 },
    scrollIntoView: true,
  });
  return true;
}

function bracedCommandContentBeforeCursor(view: EditorView): string | null {
  const range = view.state.selection.main;
  if (!range.empty || view.state.sliceDoc(range.head, range.head + 1) !== "}") return null;
  const before = textBefore(view.state, range.head, 120);
  const openingBrace = before.lastIndexOf("{");
  if (openingBrace < 0 || !shouldInsertCommandBraces(before.slice(0, openingBrace))) return null;
  const content = before.slice(openingBrace + 1);
  return /[{}]/.test(content) ? null : content;
}

function skipExistingCommandCloseBrace(view: EditorView): boolean {
  if (bracedCommandContentBeforeCursor(view) === null) return false;
  view.dispatch({ selection: { anchor: view.state.selection.main.head + 1 }, scrollIntoView: true });
  return true;
}

/**
 * CodeMirror paints the selection layer *behind* line content. A filled
 * `.cm-activeLine` background therefore hides local selection on the current
 * line. Toggle a class so CSS can clear that fill while a range is selected.
 */
export function selectionVisibilityExtension(): Extension {
  const sync = (view: EditorView) => {
    view.dom.classList.toggle("cm-lattice-has-selection", !view.state.selection.main.empty);
  };
  return [
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) sync(update.view);
    }),
    // Ensure the class is correct on first focus / mount.
    EditorView.domEventHandlers({ focus: (_event, view) => void sync(view) }),
  ];
}

/** Editing behavior shared by LaTeX, Markdown, BibTeX, and plain-text files. */
export function textEditorExtensions(
  spellcheck = false,
  live?: { current: LatexEditorLiveData },
  onPasteImage?: (file: File) => boolean | void,
): Extension[] {
  return [
    EditorView.lineWrapping,
    selectionVisibilityExtension(),
    EditorView.contentAttributes.of({
      // Harper owns prose diagnostics, so WebKit spellcheck stays disabled for
      // every source language instead of duplicating underlines.
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
    }),
    syntaxHighlighting(luxLatexHighlightStyle),
    search({ top: true }),
    compactSearchPanel,
    highlightSelectionMatches(),
    tooltips({ tooltipSpace: (view) => citationTooltipSpace(view.dom.getBoundingClientRect()) }),
    ...(spellcheck ? [harperSpellcheck(live)] : []),
    ...(onPasteImage ? [EditorView.domEventHandlers({
      paste(event) {
        const file = [...event.clipboardData?.items ?? []].find((item) => item.type.startsWith("image/"))?.getAsFile();
        if (!file || onPasteImage(file) === false) return false;
        event.preventDefault();
        return true;
      },
    })] : []),
  ];
}

export function latexEditorExtensions(options: LatexEditorOptions): Extension[] {
  const {
    currentPath = "",
    onGotoDefinition,
    onFindReferences,
    onRenameSymbol,
    onRenameEnvironment,
    onWrapEnvironment,
    onTexlabGoto,
  } = options;
  const live = () => options.live.current;
  const texlabPath = () => currentPath;
  const texlab = options.texlab && currentPath.endsWith(".tex");
  const gotoDefinition = (view: EditorView, position: number): boolean => {
    const data = live();
    const text = view.state.doc.toString();
    const target = onGotoDefinition && definitionTargetAt(text, position, data.references, data.projectPaths, data.graphicsRoots);
    if (target) {
      onGotoDefinition(target);
      return true;
    }
    if (!texlab || !onTexlabGoto) return false;
    const line = view.state.doc.lineAt(position);
    void resolveTexlabDefinition(currentPath, text, line.number, position - line.from + 1).then((location) => {
      if (location) onTexlabGoto(location.path, location.line, location.column);
    });
    return true;
  };
  const symbolCommand = (handler?: (target: SymbolTarget) => void): Command => (view) => {
    const target = handler && symbolAt(view.state.doc.toString(), view.state.selection.main.head);
    if (!target) return false;
    handler(target);
    return true;
  };
  return [
    ...textEditorExtensions(options.spellcheck, options.live, options.onPasteImage),
    citationTooltips(live),
    referenceTooltips(live, options.loadReferenceImage),
    texlabHoverTooltip(texlabPath, latexCommandHover, options.texlab),
    linter((view) => indexDiagnostics(view.state.doc.toString(), live(), currentPath, options.onCreateMissingFile), {
      delay: 400,
    }),
    autocompletion({
      override: [
        citationCompletions(live),
        referenceCompletions(live),
        includeCompletions(live),
        macroCompletions(live),
        ...(options.texlab ? [texlabCompletionSource(texlabPath)] : []),
        latexCommandCompletions,
      ],
      activateOnTyping: true,
      activateOnTypingDelay: 0,
      // Citation completion appears only after the opening brace, so the key
      // that opened it cannot also be a navigation key. CodeMirror's default
      // 75 ms guard just makes a quick Arrow/Enter fall through to the editor.
      interactionDelay: 0,
      icons: false,
      optionClass: (completion) => completion.type === "citation" ? "cm-citation-option" : "",
      tooltipClass: (state) => {
        const head = state.selection.main.head;
        return citationCompletionRange(textBefore(state, head), head) ? `cm-citation-menu ${floatingSurfaceClassName}` : "";
      },
      addToOptions: [{ position: 10, render: citationIcon }],
    }),
    EditorView.domEventHandlers({
      click(event, view) {
        if (!(event.metaKey || event.ctrlKey)) {
          // Clicking an unchanged cursor after Escape is an explicit reopen.
          if (event.target instanceof Node && view.contentDOM.contains(event.target)) openCitationAtCursor(view);
          return false;
        }
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position == null || !gotoDefinition(view, position)) return false;
        event.preventDefault();
        return true;
      },
    }),
    Prec.high(keymap.of([
      { key: "Enter", run: insertLatexNewline },
      { key: "Shift-Enter", run: insertNewlineKeepIndent },
    ])),
    // Typing a full `\cite{}` must compose with the pair inserted after
    // `\cite`: swallow the duplicate opening brace and step over its close.
    // Highest precedence also keeps optional Vim handling from seeing them.
    Prec.highest(keymap.of([
      { key: "{", run: (view) => bracedCommandContentBeforeCursor(view) === "" },
      { key: "}", run: skipExistingCommandCloseBrace },
    ])),
    keymap.of([
      ...searchKeymap,
      { key: "Mod-f", run: openSearchPanel },
      { key: "Mod-Alt-a", run: replaceAll },
      { key: "Mod-/", run: editCommand(toggleLineComments) },
      { key: "Mod-b", run: wrapCommand("\\textbf{", "}") },
      { key: "Mod-i", run: wrapCommand("\\emph{", "}") },
      { key: "Mod-Shift-m", run: wrapCommand("$", "$") },
      { key: "Mod-Alt-e", run: editCommand((text, from, to) => wrapEnvironment(text, from, to, "equation")) },
      { key: "Mod-Alt-i", run: editCommand((text, from, to) => wrapEnvironment(text, from, to, "itemize")) },
      { key: "Mod-Alt-s", run: editCommand(sortSelectedLines) },
      { key: "Mod-Alt-u", run: caseCommand("upper") },
      { key: "Mod-Alt-l", run: caseCommand("lower") },
      { key: "Mod-Alt-c", run: caseCommand("title") },
      { key: "Mod-Alt-/", run: editCommand((text, from, to) => wrapCommentRegion(text, from, to, "comment-env")) },
      { key: "Mod-Alt-;", run: editCommand((text, from, to) => wrapCommentRegion(text, from, to, "iffalse")) },
      {
        key: "Mod-Alt-w",
        run: () => {
          onWrapEnvironment?.();
          return Boolean(onWrapEnvironment);
        },
      },
      { key: "F12", run: (view) => gotoDefinition(view, view.state.selection.main.head) },
      { key: "Shift-F12", run: symbolCommand(onFindReferences) },
      { key: "F2", run: symbolCommand(onRenameSymbol) },
      {
        key: "Ctrl-m",
        mac: "Ctrl-m",
        run: (view) => {
          const text = view.state.doc.toString();
          const head = view.state.selection.main.head;
          return selectRange(view, matchingEnvironmentTarget(text, head) ?? matchingMathDelimiter(text, head));
        },
      },
      {
        key: "Mod-Alt-a",
        run: (view) => selectRange(view, enclosingEnvironmentRange(view.state.doc.toString(), view.state.selection.main.head)),
      },
      {
        key: "Mod-Alt-r",
        run: (view) => {
          const text = view.state.doc.toString();
          const head = view.state.selection.main.head;
          const name = onRenameEnvironment && (environmentAt(text, head) ?? enclosingEnvironment(text, head))?.name;
          if (!name) return false;
          onRenameEnvironment(name);
          return true;
        },
      },
    ]),
    // Lowest precedence so Vim's `$` (end of line) still wins when that keymap is active.
    Prec.lowest(keymap.of([{ key: "$", run: dollarPairCommand }])),
    EditorView.updateListener.of((update) => {
      // Cursor/focus entry is independent of typing. Ignore document edits
      // (autocomplete already handles them), including accepting a completion.
      // Escape and background updates must not reopen a dismissed menu.
      if (!update.docChanged && (update.selectionSet || update.focusChanged)) openCitationAtCursor(update.view);
      const completed = update.transactions.some((transaction) => transaction.isUserEvent("input.complete"));
      const typed = completed || update.transactions.some((transaction) => transaction.isUserEvent("input.type"));
      const { empty, head } = update.state.selection.main;
      if (!update.docChanged || !typed || !empty) return;
      const before = textBefore(update.state, head, 120);
      const indent = /^\s*/.exec(update.state.doc.lineAt(head).text)?.[0] ?? "";
      const close = before.endsWith("}") && beginEnvironmentClose(before, update.state.sliceDoc(head), indent);
      if (close) {
        update.view.dispatch({
          changes: { from: head, insert: close.insert },
          selection: { anchor: head + close.cursorOffset },
          annotations: Transaction.userEvent.of("input.type"),
        });
        return;
      }
      if (update.state.sliceDoc(head, head + 1) === "{" || !shouldInsertCommandBraces(before)) return;
      // `\cite` is a prefix of `\citep`, `\citet`, etc. Adding braces while
      // typing steals the remaining command letters into the citation query.
      // Accepted completions still insert braces; typed citations wait for `{`.
      if (CITATION_COMMAND_END.test(before) && !completed) return;
      const braceTransaction = insertBracket(update.state, "{");
      if (braceTransaction) update.view.dispatch(braceTransaction);
    }),
  ];
}
