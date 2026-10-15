import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import type { EditorView } from "@codemirror/view";
import { comboText, parseKeyName } from "../app/key-combos";
import { Button } from "../components/ui/button";
import { useExitPicture } from "../components/ui/exit-picture";
import { popupMotionClassName } from "../components/ui/popup-motion";
import { Textarea } from "../components/ui/textarea";
import {
  ANNOTATION_INTENTS,
  resolveCommentAnchor,
  type AnnotationIntent,
} from "../editor/comments/editor-comment-data";
import "../editor/comments/annotations.css";
import { useIntentLabels } from "../editor/comments/use-intent-labels";
import { clamp } from "../settings/app-settings";
import { onLayoutChange } from "../app/effect-helpers";
import { useDismissOnOutsidePointer } from "../hooks/use-dismiss-on-outside-pointer";
import { useLatestRef } from "../hooks/use-latest-ref";

/* eslint-disable lingui/no-unlocalized-strings -- key names, drawn as glyphs */
const SAVE_KEYS = comboText(parseKeyName("Mod-Enter"));
const REVISE_KEYS = comboText(parseKeyName("Mod-Shift-Enter"));
/* eslint-enable lingui/no-unlocalized-strings */

/** A note being written on a source selection, before it is saved. */
export type AnnotationDraft = {
  path: string;
  from: number;
  to: number;
  quote: string;
  prefix: string;
  suffix: string;
  /** The 1-based line the selection starts on, for its location. */
  line: number;
  body: string;
  intent?: AnnotationIntent;
  error: string | null;
};

/**
 * The note itself: the quoted passage in the highlighter's amber with where
 * it is, a line for what should change, the optional intent chips, and Save
 * or Save and revise now. Shared by the source and the PDF composers, which
 * close on Esc or a click anywhere outside them, as a popover does, so the
 * note draws no button for it.
 */
export function AnnotationForm(props: {
  quote: string;
  location: ReactNode;
  body: string;
  intent?: AnnotationIntent;
  error: string | null;
  /** Where the location came from, said beside the actions (the PDF's SyncTeX mapping). */
  footnote?: string;
  /** False while there is nowhere to save to yet (the PDF selection is still being mapped). */
  ready?: boolean;
  /** The agent can be asked now; otherwise only Save is offered. */
  canRevise: boolean;
  onBodyChange: (body: string) => void;
  onIntentChange: (intent: AnnotationIntent | undefined) => void;
  onCancel: () => void;
  onSave: (revise: boolean) => void;
}) {
  const { t } = useLingui();
  const labels = useIntentLabels();
  const ready = props.ready !== false;
  const saveable = ready && Boolean(props.body.trim() || props.intent);
  return (
    <div
      className="annotation-form"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (saveable) props.onSave(event.shiftKey && props.canRevise);
        }
      }}
    >
      <blockquote className="annotation-quote">
        <span className="annotation-quote-text">{props.quote.trim() || t`(empty span)`}</span>
        <span className="annotation-quote-location">{props.location}</span>
      </blockquote>
      <Textarea
        autoFocus
        rows={2}
        className="annotation-note-field"
        aria-label={t`Annotation`}
        placeholder={t`What should change here?`}
        value={props.body}
        onChange={(event) => props.onBodyChange(event.target.value)}
      />
      <div className="annotation-intents" role="group" aria-label={t`What the agent should do`}>
        {ANNOTATION_INTENTS.map((intent) => (
          <button
            type="button"
            key={intent}
            className="annotation-intent"
            aria-pressed={props.intent === intent}
            onClick={() => props.onIntentChange(props.intent === intent ? undefined : intent)}
          >
            {labels[intent]}
          </button>
        ))}
      </div>
      {props.error && <p role="alert" className="annotation-form-error">{props.error}</p>}
      <div className="annotation-form-actions">
        <Button size="compact" variant="tinted" disabled={!saveable} onClick={() => props.onSave(false)}>
          {t`Save`} <kbd>{SAVE_KEYS}</kbd>
        </Button>
        {props.canRevise && (
          <Button size="compact" variant="ghost" disabled={!saveable} onClick={() => props.onSave(true)}>
            {t`Save and revise now`} <kbd>{REVISE_KEYS}</kbd>
          </Button>
        )}
        {props.footnote && <span className="annotation-form-hint">{props.footnote}</span>}
      </div>
    </div>
  );
}

/**
 * The popover for a new annotation on the source, pinned beside the text it
 * quotes while the editor scrolls. `anchorKey` names the document and editor
 * instance.
 */
export function AnnotationComposer({ draft, view, anchorKey, canRevise, onChange, onCancel, onSave }: {
  draft: AnnotationDraft;
  view: EditorView | null;
  anchorKey: string;
  canRevise: boolean;
  onChange: (change: Partial<Pick<AnnotationDraft, "body" | "intent">>) => void;
  /** Esc closed the note, or a click outside it, which goes on to do what it does there. */
  onCancel: (outside: boolean) => void;
  onSave: (revise: boolean) => void;
}) {
  const { t } = useLingui();
  const popupRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useLatestRef(draft);
  // It grows from the text it quotes as every popup does, and leaves on the popup exit.
  useExitPicture([popupRef]);
  useDismissOnOutsidePointer(popupRef, () => onCancel(true));
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const host = view?.dom.closest(".source-editor");
    if (!view || !popup || !host) return;
    let above: boolean | undefined;
    const reposition = () => {
      const range = resolveCommentAnchor(view.state.doc.toString(), draftRef.current);
      const anchor = range && view.coordsAtPos(range.from);
      const end = range && view.coordsAtPos(range.to);
      const bounds = host.getBoundingClientRect();
      const viewport = view.scrollDOM.getBoundingClientRect();
      const top = Math.max(bounds.top, viewport.top);
      const bottom = Math.min(bounds.bottom, viewport.bottom);
      if (!anchor || anchor.bottom <= top || anchor.top >= bottom) {
        // Keep the mounted field and draft, but never pin it to a viewport edge.
        popup.style.visibility = "hidden";
        return;
      }
      const width = Math.min(360, Math.max(0, bounds.width - 16));
      const below = Math.max(anchor.bottom, end?.bottom ?? anchor.bottom);
      Object.assign(popup.style, { visibility: "visible", width: `${width}px` });
      // Choose a side once so scrolling cannot make the draft jump across its text.
      if (above === undefined) above = bottom - below - 8 < popup.offsetHeight && anchor.top - top > bottom - below;
      popup.dataset.side = above ? "top" : "bottom";
      Object.assign(popup.style, {
        left: `${clamp(anchor.left - bounds.left, 8, Math.max(8, bounds.width - width - 8))}px`,
        top: `${(above ? anchor.top - 8 : below + 8) - bounds.top}px`,
        translate: above ? "0 -100%" : "none",
        maxHeight: `${Math.max(0, Math.min(400, above ? anchor.top - top - 8 : bottom - below - 8))}px`,
      });
    };
    reposition();
    return onLayoutChange([host, view.contentDOM], reposition);
  }, [anchorKey, draftRef, view]);
  const name = draft.path.split("/").at(-1) ?? draft.path;
  return (
    <div
      ref={popupRef}
      className={`editor-comment-popover annotation-composer ${popupMotionClassName}`}
      style={{ bottom: "auto", right: "auto" }}
      role="dialog"
      aria-label={t`Annotate`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <AnnotationForm
        quote={draft.quote}
        location={`${name}:${draft.line}`}
        body={draft.body}
        intent={draft.intent}
        error={draft.error}
        canRevise={canRevise}
        onBodyChange={(body) => onChange({ body })}
        onIntentChange={(intent) => onChange({ intent })}
        onCancel={() => onCancel(false)}
        onSave={onSave}
      />
    </div>
  );
}
