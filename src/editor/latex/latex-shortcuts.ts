import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * The LaTeX source editor's own keys. `latexCommandKeymap` (latex-editor)
 * binds each of them, Proofread's aside, and the shortcut sheet lists them,
 * so the sheet shows what the editor does. `scope` is CodeMirror's:
 * "search-panel" keys work in the find bar, not in the text.
 *
 * Two keys moved when they turned out to mean two things: ⌘⌥A replaced every
 * match of the last search (kept after the find bar closed) before it could
 * select the environment around the caret, so Replace all now answers it only
 * in the find bar; and Wrap in environment took ⌘⌥W, the workspace's Close
 * tab, from the editor, so it is ⌘⇧E beside ⌘⌥E's equation.
 */
export const LATEX_SHORTCUTS = {
  bold: { key: "Mod-b", label: msg`Bold (\\textbf)` },
  emphasis: { key: "Mod-i", label: msg`Emphasis (\\emph)` },
  math: { key: "Mod-Shift-m", label: msg`Inline math` },
  comment: { key: "Mod-/", label: msg`Comment or uncomment lines` },
  commentEnvironment: { key: "Mod-Alt-/", label: msg`Wrap in a comment environment` },
  iffalse: { key: "Mod-Alt-;", label: msg`Wrap in \\iffalse … \\fi` },
  equation: { key: "Mod-Alt-e", label: msg`Wrap in equation` },
  itemize: { key: "Mod-Alt-i", label: msg`Wrap in itemize` },
  wrapEnvironment: { key: "Mod-Shift-e", label: msg`Wrap in environment…` },
  renameEnvironment: { key: "Mod-Alt-r", label: msg`Rename the environment` },
  selectEnvironment: { key: "Mod-Alt-a", label: msg`Select the environment` },
  matchingEnvironment: { key: "Ctrl-m", label: msg`Go to the matching \\begin, \\end or math delimiter` },
  sortLines: { key: "Mod-Alt-s", label: msg`Sort lines` },
  upperCase: { key: "Mod-Alt-u", label: msg`UPPER CASE` },
  lowerCase: { key: "Mod-Alt-l", label: msg`lower case` },
  titleCase: { key: "Mod-Alt-c", label: msg`Title Case` },
  find: { key: "Mod-f", label: msg`Find in document` },
  replaceAll: { key: "Mod-Alt-a", scope: "search-panel", label: msg`Replace all (in the find bar)` },
  definition: { key: "F12", label: msg`Go to definition` },
  references: { key: "Shift-F12", label: msg`Find references` },
  renameSymbol: { key: "F2", label: msg`Rename label or citation` },
  // Bound by the Proofread card's own keymap (proofread-anchor), which also takes ⌘↵ and Escape while a card is open.
  proofread: { key: "Mod-Alt-p", label: msg`Proofread the selection` },
} satisfies Record<string, { key: string; label: MessageDescriptor; scope?: "search-panel" }>;

export type LatexShortcut = keyof typeof LATEX_SHORTCUTS;
