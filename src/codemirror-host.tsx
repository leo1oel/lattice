/**
 * Hand-mounted CodeMirror 6 host, replacing `@uiw/react-codemirror`.
 *
 * Why not the wrapper: it materialized the whole document twice per
 * keystroke — once for `onChange` and once more in its controlled-value
 * effect's string comparison — an O(document) tax the editor itself never
 * needed (CM's own doc is a rope). It also answered any changed
 * extensions/handler identity with a full `StateEffect.reconfigure`, which
 * the call sites already had to defend against with refs and pinned arrays.
 *
 * This host keeps the wrapper's external contract (controlled `value`,
 * `onChange` with the full string, `onUpdate`, `onCreateEditor`, remount via
 * React `key`, `cm-theme-light` wrapper div) but reconciles the controlled
 * value by REFERENCE first: the string handed to `onChange` is the same
 * object App stores in state and passes back down, so the per-keystroke echo
 * is a pointer comparison. Content comparison and full-document replacement
 * only run for genuinely external values (file load, agent edits, visual-
 * editor publications), annotated `hostExternalChange` so they never echo
 * back through `onChange` — mirroring the wrapper's ExternalChange
 * semantics, including its "don't clobber mid-typing" deferral.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { Annotation, EditorState, StateEffect, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";

const hostExternalChange = Annotation.define<boolean>();

/** How long after a local keystroke an external value write is deferred. */
const TYPING_QUIET_MS = 200;

// The slice of @uiw's basicSetup both editors used (autocompletion off — the
// LaTeX extensions bring their own). Copied per the upstream advice that a
// configured editor should own this list.
const baseSetup: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...lintKeymap,
    indentWithTab,
  ]),
];

// Both mounts fill their pane; the light background matches the wrapper's
// default theme so nothing shifts visually.
const hostTheme: Extension = [
  EditorView.theme({ "&": { height: "100%" }, "& .cm-scroller": { height: "100% !important" } }),
  EditorView.theme({ "&": { backgroundColor: "#fff" } }, { dark: false }),
];

export function CodeMirrorHost(props: {
  className?: string;
  value: string;
  editable?: boolean;
  extensions: Extension[];
  onChange: (value: string) => void;
  onUpdate: (update: ViewUpdate) => void;
  onCreateEditor: (view: EditorView) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The exact string object last emitted through onChange (or reconciled from props). */
  const lastEmittedRef = useRef(props.value);
  const lastTypedAtRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const valueRef = useRef(props.value);
  const extensionsRef = useRef(props.extensions);
  const editableRef = useRef(props.editable ?? true);
  const onChangeRef = useRef(props.onChange);
  const onUpdateRef = useRef(props.onUpdate);
  const onCreateEditorRef = useRef(props.onCreateEditor);
  // Refreshed in a layout effect declared ahead of every other effect here, so
  // the mount and reconfigure passes below still read this render's props —
  // writing them during render instead is what the refs lint rule forbids.
  useLayoutEffect(() => {
    valueRef.current = props.value;
    extensionsRef.current = props.extensions;
    editableRef.current = props.editable ?? true;
    onChangeRef.current = props.onChange;
    onUpdateRef.current = props.onUpdate;
    onCreateEditorRef.current = props.onCreateEditor;
  });
  /** What the live view is currently configured with (mount seeds it). */
  const configuredRef = useRef<{ extensions: Extension[]; editable: boolean } | null>(null);

  const buildExtensions = (extensions: Extension[], editable: boolean): Extension[] => [
    EditorView.updateListener.of((update) => {
      if (
        update.docChanged
        && !update.transactions.some((tr) => tr.annotation(hostExternalChange))
      ) {
        lastTypedAtRef.current = Date.now();
        const text = update.state.doc.toString();
        lastEmittedRef.current = text;
        onChangeRef.current(text);
      }
      onUpdateRef.current(update);
    }),
    hostTheme,
    baseSetup,
    ...(editable ? [] : [EditorView.editable.of(false)]),
    ...extensions,
  ];

  // One view per mount; the call sites remount by React key when the
  // document identity changes (collabEditorKey), matching the wrapper.
  useLayoutEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const mountConfig = { extensions: extensionsRef.current, editable: editableRef.current };
    configuredRef.current = mountConfig;
    const view = new EditorView({
      state: EditorState.create({
        doc: valueRef.current,
        extensions: buildExtensions(mountConfig.extensions, mountConfig.editable),
      }),
      parent,
    });
    viewRef.current = view;
    lastEmittedRef.current = valueRef.current;
    onCreateEditorRef.current(view);
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
      const next = valueRef.current;
      if (next === lastEmittedRef.current) return;
      // Don't fight active typing or IME composition; retry shortly, like
      // the wrapper's typing latch.
      if (view.composing || Date.now() - lastTypedAtRef.current < TYPING_QUIET_MS) {
        if (retryTimerRef.current === null) {
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            applyExternalValue();
          }, TYPING_QUIET_MS);
        }
        return;
      }
      const current = view.state.doc.toString();
      if (next !== current) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
          annotations: [hostExternalChange.of(true)],
        });
      }
      lastEmittedRef.current = next;
    };
    applyExternalValue();
  }, [props.value]);

  return (
    <div
      ref={containerRef}
      className={`cm-theme-light${props.className ? ` ${props.className}` : ""}`}
    />
  );
}
