/**
 * Hand-mounted CodeMirror 6 host, replacing `@uiw/react-codemirror`, which
 * materialized the whole document twice per keystroke and answered any changed
 * extensions/handler identity with a full `StateEffect.reconfigure`.
 *
 * It keeps the wrapper's external contract (controlled `value`, `onChange`
 * with the full string, `onUpdate`, `onCreateEditor`, remount via React `key`,
 * `cm-theme-light` wrapper div) but reconciles the controlled value by
 * REFERENCE first: App passes back the very string object `onChange` emitted,
 * so the per-keystroke echo is a pointer comparison. Genuinely external values
 * (file load, agent edits, visual-editor publications) replace the document
 * annotated `hostExternalChange`, so they never echo back through `onChange`,
 * and wait out active typing as the wrapper did.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Annotation, EditorState, Prec, StateEffect, type Extension } from "@codemirror/state";
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection, type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { withoutAppShortcuts } from "./editor-app-shortcuts";
import { i18n } from "../i18n";

const hostExternalChange = Annotation.define<boolean>();

/** How long after a local keystroke an external value write is deferred. */
const TYPING_QUIET_MS = 200;

// The slice of @uiw's basicSetup both editors used (autocompletion off — the
// LaTeX extensions bring their own). Copied per the upstream advice that a
// configured editor should own this list.
const baseSetup: Extension = [
  lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
  dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(), closeBrackets(),
  rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
  keymap.of(withoutAppShortcuts([
    ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap,
    indentWithTab,
  ])),
];

/**
 * Interface text the loaded CodeMirror packages read through `state.phrase`
 * (fold gutter, lint panel, completion list, screen-reader announcements).
 * The search panel's phrases live with `compactSearchPanel`.
 */
const HOST_PHRASES: Record<string, MessageDescriptor> = {
  "Fold line": msg`Fold line`,
  "Unfold line": msg`Unfold line`,
  "folded code": msg`folded code`,
  unfold: msg`unfold`,
  // Announced as "Folded lines 3 to 7." with the numbers between the phrases.
  "Folded lines": msg`Folded lines`,
  "Unfolded lines": msg`Unfolded lines`,
  to: msg`to`,
  Diagnostics: msg`Diagnostics`,
  "No diagnostics": msg`No diagnostics`,
  close: msg`Close`,
  Completions: msg`Completions`,
  "Selection deleted": msg`Selection deleted`,
  "Control character": msg`Control character`,
};

/**
 * Phrases resolve against the active catalog, so they are built per editor
 * rather than at module load. Lowest precedence lets an editor's own phrases
 * (the search panel's "close") win.
 */
function hostPhrases(): Extension {
  const phrases = Object.fromEntries(Object.entries(HOST_PHRASES).map(([phrase, message]) => [phrase, i18n._(message)]));
  return Prec.lowest(EditorState.phrases.of(phrases));
}

// Both mounts fill their pane; the light background matches the wrapper's
// default theme so nothing shifts visually.
const hostTheme: Extension = [
  EditorView.theme({ "&": { height: "100%" }, "& .cm-scroller": { height: "100% !important" } }),
  EditorView.theme({ "&": { backgroundColor: "#fff" } }, { dark: false }),
];

type CodeMirrorHostProps = {
  className?: string;
  value: string;
  editable?: boolean;
  extensions: Extension[];
  onChange: (value: string) => void;
  onUpdate: (update: ViewUpdate) => void;
  onCreateEditor: (view: EditorView) => void;
};

export function CodeMirrorHost(props: CodeMirrorHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The exact string object last emitted through onChange (or reconciled from props). */
  const lastEmittedRef = useRef(props.value);
  const lastTypedAtRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const propsRef = useRef(props);
  // Refreshed in a layout effect declared ahead of every other effect here, so
  // the mount and reconfigure passes below still read this render's props —
  // writing them during render instead is what the refs lint rule forbids.
  useLayoutEffect(() => {
    propsRef.current = props;
  });
  /** What the live view is currently configured with (mount seeds it). */
  const configuredRef = useRef<{ extensions: Extension[]; editable: boolean } | null>(null);

  const buildExtensions = (extensions: Extension[], editable: boolean): Extension[] => [
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !update.transactions.some((tr) => tr.annotation(hostExternalChange))) {
        lastTypedAtRef.current = Date.now();
        const text = update.state.doc.toString();
        lastEmittedRef.current = text;
        propsRef.current.onChange(text);
      }
      propsRef.current.onUpdate(update);
    }),
    hostTheme,
    baseSetup,
    hostPhrases(),
    ...(editable ? [] : [EditorView.editable.of(false)]),
    ...extensions,
  ];

  // One view per mount; the call sites remount by React key when the
  // document identity changes (collabEditorKey), matching the wrapper.
  useLayoutEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const { value, extensions, editable = true, onCreateEditor } = propsRef.current;
    configuredRef.current = { extensions, editable };
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions: buildExtensions(extensions, editable) }),
      parent,
    });
    viewRef.current = view;
    lastEmittedRef.current = value;
    onCreateEditor(view);
    return () => {
      viewRef.current = null;
      configuredRef.current = null;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      view.destroy();
    };
    // Mount-once: everything volatile is read through refs.
  }, []);

  // Reconfigure only when the inputs actually change identity — the call
  // sites deliberately pin these (see the comments on editorExtensions).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const editable = props.editable ?? true;
    const configured = configuredRef.current;
    if (configured && configured.extensions === props.extensions && configured.editable === editable) return;
    configuredRef.current = { extensions: props.extensions, editable };
    view.dispatch({ effects: StateEffect.reconfigure.of(buildExtensions(props.extensions, editable)) });
    // buildExtensions reads only refs; its identity churn is irrelevant here.
  }, [props.extensions, props.editable]);

  // Controlled-value reconciliation. Hot path: the value App passes back is
  // the very string onChange emitted — reference equality, no O(n) work.
  useEffect(() => {
    const applyExternalValue = () => {
      const view = viewRef.current;
      if (!view) return;
      const next = propsRef.current.value;
      if (next === lastEmittedRef.current) return;
      // Don't fight active typing or IME composition; retry shortly, like
      // the wrapper's typing latch.
      if (view.composing || Date.now() - lastTypedAtRef.current < TYPING_QUIET_MS) {
        retryTimerRef.current ??= window.setTimeout(() => {
          retryTimerRef.current = null;
          applyExternalValue();
        }, TYPING_QUIET_MS);
        return;
      }
      if (next !== view.state.doc.toString()) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
          annotations: [hostExternalChange.of(true)],
        });
      }
      lastEmittedRef.current = next;
    };
    applyExternalValue();
  }, [props.value]);

  return <div ref={containerRef} className={`cm-theme-light${props.className ? ` ${props.className}` : ""}`} />;
}
