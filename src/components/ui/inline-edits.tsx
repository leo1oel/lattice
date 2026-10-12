import { Fragment, type KeyboardEvent, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { Lock } from "lucide-react";
import { Tip } from "@/components/icon-tip";
import { cn } from "@/lib/utils";
import { inlineEditSpans } from "./inline-edit-spans";
import "./inline-edits.css";

/**
 * One suggested change to a passage: replace `[from, to)` of its text with
 * `insert`. Edits of one passage are ordered and never overlap.
 */
export type InlineEdit = {
  id: number;
  from: number;
  to: number;
  insert: string;
  /**
   * `applied`: drawn made, the old words struck and the new ones marked;
   * `kept`: the original stays, and toggling makes the edit again;
   * `held`: the original stays and the edit cannot be chosen.
   */
  status: "applied" | "kept" | "held";
  /** A word or two naming why, drawn as a tag after the edit. */
  tag?: string;
  /** The longer reason, read in the edit's tooltip and accessible name. */
  detail?: string;
};

/** Keeps a tag on the line of the word it explains. */
const WORD_JOINER = "\u2060";

/** Spaces and line breaks made visible when they are all an edit changes. */
const visible = (text: string) => text && !text.trim()
  ? text.replace(/\n/g, "↵").replace(/[^\S\n]/g, "␣")
  : text.replace(/\s+/g, " ");

/** `text`'s edge spaces drawn outside a mark, so the strike and the wash cover words only. */
function marked(text: string, mark: (core: string) => ReactNode): ReactNode {
  if (!text.trim()) return mark(visible(text));
  const core = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return <>{core[1] ? " " : null}{mark(visible(core[2]!))}{core[3] ? " " : null}</>;
}

/**
 * Unchanged source read as prose: a line break is a space, as TeX reads it,
 * and a blank line starts a new paragraph.
 */
function prose(text: string, key: string): ReactNode {
  const paragraphs = text.split(/\n[^\S\n]*\n\s*/);
  return paragraphs.map((paragraph, index) => (
    <Fragment key={`${key}:${index}`}>
      {index > 0 && <span className="inline-edits-break" aria-hidden />}
      {paragraph.replace(/\s+/g, " ")}
    </Fragment>
  ));
}

/**
 * A passage read in place with its suggested edits: one paragraph in the
 * reading font, each edit's old words struck and its new ones marked, with a
 * tag saying why. With `onToggle`, an edit is a toggle: clicking it (or Enter
 * or Space on it) keeps the original, and again makes the edit. Held edits
 * show where they would have been, locked.
 *
 * The edits are the caller's: this draws them and reports the toggles. The
 * inline Proofread and Polish card is its first host.
 */
export function InlineEdits(props: {
  text: string;
  edits: readonly InlineEdit[];
  onToggle?: (id: number) => void;
  className?: string;
}) {
  const { t } = useLingui();
  const { text, onToggle } = props;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const { edit, from, to, deleted: original, inserted: revised } of inlineEditSpans(text, props.edits)) {
    parts.push(prose(text.slice(cursor, from), `text:${edit.id}`));
    cursor = to;
    const deleted = visible(original).trim();
    const inserted = visible(revised).trim();
    const change = !inserted ? t`Delete “${deleted}”` : !deleted ? t`Insert “${inserted}”` : t`Replace “${deleted}” with “${inserted}”`;
    const tag = edit.status === "held"
      ? <>{WORD_JOINER}<span className="inline-edit-tag" aria-hidden><Lock size={12} strokeWidth={1.5} />{edit.tag}</span></>
      : edit.tag && <>{WORD_JOINER}<span className="inline-edit-tag" aria-hidden>{edit.tag}</span></>;
    if (edit.status === "held") {
      parts.push(
        <Tip key={edit.id} label={edit.detail} side="top">
          <span className="inline-edit" data-status="held">
            {marked(original, (core) => <span className="inline-edit-original">{core}</span>)}
            {tag}
            <span className="sr-only">{[t`Held back: ${change}`, edit.tag, edit.detail].filter(Boolean).join(". ")}</span>
          </span>
        </Tip>,
      );
      continue;
    }
    const applied = edit.status === "applied";
    const body = applied
      // A space, not a margin, between the two, so a narrow line can break there.
      ? <>{original && marked(original, (core) => <del>{core}</del>)}{original && revised ? " " : null}{revised && marked(revised, (core) => <ins>{core}</ins>)}</>
      // A kept insertion has no words of its own: a caret marks where it would go.
      : original ? marked(original, (core) => <span className="inline-edit-original">{core}</span>) : <span className="inline-edit-caret" aria-hidden>⁁</span>;
    const toggle = onToggle && (() => onToggle(edit.id));
    parts.push(
      <Tip key={edit.id} label={edit.detail} side="top">
        <span
          className="inline-edit"
          data-status={edit.status}
          role={toggle ? "button" : undefined}
          tabIndex={toggle ? 0 : undefined}
          aria-pressed={toggle ? applied : undefined}
          aria-label={toggle ? [change, edit.tag, edit.detail].filter(Boolean).join(". ") : undefined}
          onClick={toggle && (() => {
            // A drag that selects words inside the edit reads them; it does not choose.
            if (window.getSelection()?.isCollapsed !== false) toggle();
          })}
          onKeyDown={toggle && ((event: KeyboardEvent) => {
            if ((event.key !== "Enter" && event.key !== " ") || event.metaKey || event.ctrlKey || event.altKey) return;
            event.preventDefault();
            toggle();
          })}
        >
          {body}
          {tag}
        </span>
      </Tip>,
    );
  }
  parts.push(prose(text.slice(cursor), "text:end"));
  return <div className={cn("inline-edits", props.className)}>{parts}</div>;
}
