/**
 * Formulas in the visual engine (spec R-INL-2, R-BLK-4, R-FMT-12): KaTeX
 * renders them with the project's macros, and a formula field edits the TeX.
 * The field previews live in the document but changes nothing until the
 * author commits. An edit never changes the formula's kind: an edited inline
 * formula is written with dollar delimiters, and a display formula stays
 * display math, in its own `\[…\]` delimiters while the new TeX still reads
 * back there and as `$$…$$` otherwise.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the input rule belongs with the views it feeds */
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { InputRule } from "@tiptap/core";
import type { NodeType } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { Settings2, Trash2 } from "lucide-react";
import { IconButton } from "../../../../components/ui/icon-button";
import { Input } from "../../../../components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "../../../../components/ui/popover";
import { Textarea } from "../../../../components/ui/textarea";
import { deleteNode, setNodeAttrs, useCommitKeys } from "./view-chrome";

/** KaTeX macros for every formula in the editor (the project's `\newcommand`s). */
export const MathMacrosContext = createContext<Record<string, string>>({});

/**
 * LaTeX 2.09 font switches that converted papers still use, as KaTeX's
 * declarative equivalents: `{\sc x}` renders upright and `{\sl x}` slanted
 * (R-BLK-4).
 */
const COMPATIBILITY_MACROS: Record<string, string> = { "\\sc": "\\rm", "\\sl": "\\it" };

function Formula({ tex, display }: { tex: string; display: boolean }) {
  const macros = useContext(MathMacrosContext);
  const target = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!target.current) return;
    katex.render(tex, target.current, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      // KaTeX mutates the macro table it is given; keep the shared one pristine.
      macros: { ...COMPATIBILITY_MACROS, ...macros },
    });
  }, [display, macros, tex]);
  return <span ref={target} className="lx-md-formula" />;
}

/**
 * The formula being edited: the draft shown in place while the field is open,
 * committed to the node on request.
 */
function useFormulaDraft(props: NodeViewProps) {
  const tex = String(props.node.attrs.tex ?? "");
  const [draft, setDraft] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Leaving the atom resets the field (state adjusted while rendering, not in an effect).
  const [wasSelected, setWasSelected] = useState(props.selected);
  if (wasSelected !== props.selected) {
    setWasSelected(props.selected);
    if (!props.selected) {
      setDismissed(false);
      setDraft(null);
    }
  }
  const open = props.selected && props.editor.isEditable && !dismissed;
  const commit = () => {
    if (draft != null && draft !== tex) setNodeAttrs(props.editor, props.getPos, props.node, { tex: draft });
    setDraft(null);
  };
  /** Leave the atom: the caret goes right after it, so the field closes. */
  const leave = () => {
    const position = props.getPos();
    if (typeof position !== "number") return;
    const { state } = props.editor;
    const after = Math.min(position + props.node.nodeSize, state.doc.content.size);
    const selection = props.node.isInline ? TextSelection.create(state.doc, after) : TextSelection.near(state.doc.resolve(after));
    props.editor.view.dispatch(state.tr.setSelection(selection));
    props.editor.view.focus();
  };
  return {
    tex,
    shown: draft ?? tex,
    draft: draft ?? tex,
    setDraft,
    open,
    commitAndLeave: () => {
      commit();
      leave();
    },
    cancel: () => {
      setDraft(null);
      setDismissed(true);
      props.editor.view.focus();
    },
    closeOutside: () => {
      commit();
      setDismissed(true);
    },
  };
}

export function InlineMathView(props: NodeViewProps) {
  const { t } = useLingui();
  const formula = useFormulaDraft(props);
  const keys = useCommitKeys(formula.commitAndLeave, formula.cancel);
  const source = String(props.node.attrs.source ?? "");
  // `\[…\]` written as a whole paragraph is shown as the display formula it reads as.
  const display = source.startsWith("\\[");
  return (
    <NodeViewWrapper as="span" className={`lx-md-math${props.selected ? " is-selected" : ""}${display ? " is-display" : ""}`} data-formula={formula.shown}>
      <FormulaPopover
        open={formula.open}
        onOutside={formula.closeOutside}
        anchor={<Formula tex={formula.shown} display={display} />}
        title={t`Inline Math Properties`}
      >
        <Input
          autoFocus
          controlSize="compact"
          aria-label={t`Formula`}
          className="lx-md-formula-input"
          value={formula.draft}
          spellCheck={false}
          onChange={(event) => formula.setDraft(event.target.value)}
          {...keys}
        />
      </FormulaPopover>
    </NodeViewWrapper>
  );
}

export function MathBlockView(props: NodeViewProps) {
  const { t } = useLingui();
  const formula = useFormulaDraft(props);
  const [editing, setEditing] = useState(false);
  if (editing && !props.selected) setEditing(false);
  // An empty equation has nothing to show, so selecting it (as the slash menu does) edits it.
  const open = formula.open && (editing || !String(props.node.attrs.tex ?? "").trim());
  const selectSelf = () => {
    const position = props.getPos();
    if (typeof position !== "number" || !props.editor.isEditable) return;
    props.editor.view.dispatch(props.editor.state.tr.setSelection(NodeSelection.create(props.editor.state.doc, position)));
  };
  return (
    <NodeViewWrapper className={`lx-md-math-block${props.selected ? " is-selected" : ""}`} data-formula={formula.shown}>
      <FormulaPopover
        open={open}
        onOutside={() => {
          formula.closeOutside();
          setEditing(false);
        }}
        title={t`Equation`}
        anchor={(
          <div
            className="lx-md-math-display"
            onDoubleClick={() => {
              selectSelf();
              setEditing(true);
            }}
          >
            {formula.shown.trim() ? <Formula tex={formula.shown} display /> : <span className="lx-md-math-empty">{t`Empty equation`}</span>}
          </div>
        )}
      >
        <DisplayFormulaField
          value={formula.draft}
          onChange={formula.setDraft}
          onCommit={() => {
            formula.commitAndLeave();
            setEditing(false);
          }}
          onCancel={() => {
            formula.cancel();
            setEditing(false);
          }}
        />
      </FormulaPopover>
      {props.editor.isEditable && props.selected && !open && (
        <span className="lx-md-block-actions is-floating" contentEditable={false}>
          <IconButton size="compact" tooltip={false} label={t`Equation properties`} onClick={() => setEditing(true)}>
            <Settings2 aria-hidden="true" />
          </IconButton>
          <IconButton size="compact" tooltip={false} label={t`Delete equation`} onClick={() => deleteNode(props.editor, props.getPos, props.node)}>
            <Trash2 aria-hidden="true" />
          </IconButton>
        </span>
      )}
    </NodeViewWrapper>
  );
}

/** A multi-line TeX field: Enter adds a line, Mod-Enter commits, Escape cancels. */
function DisplayFormulaField({ value, onChange, onCommit, onCancel }: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  return (
    <Textarea
      autoFocus
      aria-label={t`Formula`}
      className="lx-md-formula-textarea"
      value={value}
      rows={Math.min(8, Math.max(2, value.split("\n").length))}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}

/**
 * The formula field, anchored to the formula itself. The formula is not a
 * trigger: the click that selected it must not toggle the field shut.
 */
function FormulaPopover({ open, onOutside, anchor, title, children }: {
  open: boolean;
  onOutside: () => void;
  anchor: ReactNode;
  title: string;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <span ref={anchorRef} className="lx-md-formula-anchor" data-state={open ? "open" : "closed"}>{anchor}</span>
      </PopoverAnchor>
      <PopoverContent
        align="center"
        className="lx-md-popover lx-md-formula-popover w-80"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
          else onOutside();
        }}
      >
        <div className="lx-md-properties">
          <span className="lx-md-properties-title">{title}</span>
          {children}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Typing the closing `$` of `$x+y$` turns the formula into a math atom (R-INL-2). */
export const inlineMathInputRule = (type: NodeType) => new InputRule({
  // Not after a backslash, a dollar or a digit, so escaped dollars and prices stay prose.
  find: /(?:^|[^\\$\d])(\$([^\s$](?:[^$\n]*[^\s$\\])?)\$)$/,
  handler: ({ state, range, match }) => {
    const whole = match[1]!;
    const start = range.from + (match[0].length - whole.length);
    state.tr.replaceWith(start, range.to, type.create({ tex: match[2]! }));
  },
});
