/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original file: packages/app/src/editor/components/TagView.tsx.
 * Modified 2026-08-04 for Research Writer: dropped the Lingui macros
 * (host is English-only) and pointed INLINE_TAG_VALUE_RE at the vendored
 * core path. Licensed under GPL-3.0-or-later.
 *
 * TagView — React NodeView for the `tag` PM atom.
 *
 * Two states:
 *
 * 1. **Filled** (value non-empty) — renders the same `<a class="tag"
 *    data-tag>` chip core's `renderHTML` emits, so cross-app paste, the
 *    `.tag` CSS, and any `a[data-tag]` click handling keep working.
 *    No popover, no edit surface — to change a tag, Backspace it (one
 *    keystroke, see the tag extension's keymap in visual-tag.ts) and
 *    re-insert.
 *
 * 2. **Empty placeholder** (value === '') — pill containing an inline
 *    auto-focused `<input>`. The input filters keystrokes against
 *    `INLINE_TAG_VALUE_RE` so only valid tag chars stick. On
 *    Enter/Space/blur with a non-empty value: `setNodeMarkup` writes
 *    the value to the atom, inserts a trailing space, and returns the
 *    cursor to PM so the user keeps typing. On Escape or blur with
 *    empty value: the atom deletes itself.
 *
 * Slash-menu insertion (`getInlineComponentItems`) lands the empty
 * atom; the NodeView's auto-focus effect pulls focus into the input on
 * mount so the user types straight in. The `#` typeahead in
 * visual-tag-suggestion.tsx is the other insertion path — it lands a
 * pre-filled atom and never enters the placeholder state. Both paths
 * end at the same filled-chip shape.
 */

import { INLINE_TAG_VALUE_RE } from "./open-knowledge-core/markdown/tag-promotion.ts";
import type { NodeViewProps } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { NodeViewWrapper } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";

/**
 * Commit a non-empty draft to the atom's `value` attr, then move the
 * cursor past the atom and insert a trailing space. Mirrors the
 * `#` typeahead's command — every successful insert lands followed by
 * a space so the user keeps typing without manually dismissing focus
 * from the chip.
 */
function commitDraft(
  editor: NodeViewProps["editor"],
  pos: number | undefined,
  next: string,
): boolean {
  if (typeof pos !== "number") return false;
  if (!next || !INLINE_TAG_VALUE_RE.test(next)) return false;
  const { state, view } = editor;
  const curNode = state.doc.nodeAt(pos);
  if (!curNode || curNode.type.name !== "tag") return false;
  const tr = state.tr.setNodeMarkup(pos, null, { ...curNode.attrs, value: next });
  const after = pos + curNode.nodeSize;
  tr.insertText(" ", after);
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  view.dispatch(tr);
  view.focus();
  return true;
}

/**
 * Discard the placeholder atom and return cursor focus to PM. Triggered
 * by Escape, Backspace-on-empty-input, or blur-with-empty-draft.
 */
function cancelDraft(editor: NodeViewProps["editor"], pos: number | undefined): void {
  if (typeof pos !== "number") return;
  const { state, view } = editor;
  const curNode = state.doc.nodeAt(pos);
  if (!curNode || curNode.type.name !== "tag") return;
  const tr = state.tr.delete(pos, pos + curNode.nodeSize);
  view.dispatch(tr);
  view.focus();
}

/**
 * Filled chip — same shape as core's `renderHTML` so cross-app paste,
 * `.tag` CSS, and `a[data-tag]` click selectors all keep working.
 */
function RenderedTagChip({ value }: { value: string }) {
  return (
    <a className="tag" data-tag={value} href={`#tag/${value}`}>
      #{value}
    </a>
  );
}

type PlaceholderInputProps = {
  initialDraft: string;
  onCommit: (next: string) => boolean;
  onCancel: () => void;
};

/**
 * Empty-state placeholder — a pill containing an inline `<input>`.
 * Auto-focuses on mount so slash-insertion lands the user typing
 * immediately. Filters keystrokes against `INLINE_TAG_VALUE_RE`
 * so only valid tag chars accumulate (matching the parser regex —
 * invalid keystrokes can never enter the value).
 *
 * Width sizing uses the `size` attribute so the input grows as the
 * user types without manual measurement. The minimum width
 * (`size={Math.max(…)}`) keeps the empty placeholder visible enough
 * to click on if the user navigates away and clicks back.
 */
function PlaceholderInput({ initialDraft, onCommit, onCancel }: PlaceholderInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(initialDraft);
  // Re-entry guard for the commit path. `commitDraft` calls
  // `view.focus()` after dispatching the PM transaction, which
  // synchronously moves DOM focus from this input to the editor
  // contenteditable. That fires the input's `onBlur` BEFORE the parent
  // re-renders, and the blur handler (designed to commit on click-
  // outside) would call `onCommit(draft)` a second time — inserting a
  // duplicate trailing space. The flag is set on a successful keyDown
  // commit and short-circuits onBlur on the same tick. Once the parent
  // re-renders into the filled-chip branch, this NodeView component
  // unmounts entirely and the flag is moot.
  const committedRef = useRef(false);

  useEffect(() => {
    // Defer to next animation frame so the focus lands AFTER any
    // editor-side focus restoration on the same tick — the slash
    // command's `chain().focus()` and the suggestion plugin's
    // teardown both call `view.focus()` synchronously, which would
    // otherwise win the race and leave the cursor past the atom
    // instead of inside the input. rAF pushes the input.focus() into
    // the next frame, after PM's DOM reconciliation settles.
    const handle = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(handle);
  }, []);

  return (
    <span
      className="tag tag-placeholder inline-flex items-center rounded-sm border border-dashed border-muted-foreground/40 bg-muted/30 px-1.5 py-0.5 text-xs text-muted-foreground"
      data-component-type="tag-placeholder"
    >
      <span aria-hidden="true" className="font-mono">
        #
      </span>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        size={Math.max(draft.length, 8)}
        placeholder="tag-name"
        aria-label="Tag value"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        // Inline-editor-style: no border, transparent bg, inherit font.
        // Width is driven by the `size` attribute above so the chrome
        // tracks content as the user types.
        className="bg-transparent border-0 p-0 outline-none focus:outline-none focus:ring-0 text-inherit font-inherit"
        onChange={(event) => {
          const next = event.target.value;
          // Filter: only accept the empty string or values matching
          // the tag-value regex. Uses the same shape as
          // `INLINE_TAG_VALUE_RE` (`^[a-zA-Z][\w/-]*$`) — both
          // the keystroke filter and the commit-time check gate
          // against identical patterns so the input never accepts a
          // character the commit path would later reject. Partial
          // states like `ab/` (trailing slash with no continuation)
          // pass `[\w/-]*` and stick in the input; commit-time blur
          // re-tests with the same regex and cancels rather than
          // persisting a value that wouldn't round-trip.
          if (next === "" || INLINE_TAG_VALUE_RE.test(next)) {
            setDraft(next);
          }
          // else: silently reject — the input visually rejects too,
          // since React's controlled input won't accept the change.
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            // Set the guard BEFORE invoking commit. `commitDraft`
            // calls `view.focus()` synchronously, which fires this
            // input's blur on the same tick — so the blur handler
            // would re-enter `onCommit` BEFORE this line runs if we
            // set it after. Reset on commit failure (commitDraft
            // early-returns without calling view.focus, so no blur
            // race in that branch — `onCancel` deletes the atom
            // and unmounts this component).
            committedRef.current = true;
            const ok = onCommit(draft);
            if (!ok) {
              committedRef.current = false;
              onCancel();
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Backspace" && draft === "") {
            // Empty + Backspace → delete the placeholder and return to PM
            // (matches @-mention / slash-command UX in Slack / Notion).
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          // Skip if onKeyDown already committed on this tick — preventing
          // the duplicate-trailing-space bug. See `committedRef`.
          if (committedRef.current) return;
          if (draft === "") {
            onCancel();
            return;
          }
          if (INLINE_TAG_VALUE_RE.test(draft)) {
            onCommit(draft);
          } else {
            // Partial value (e.g. `ab/`) — drop the placeholder rather
            // than commit something the parser would later reject.
            onCancel();
          }
        }}
      />
    </span>
  );
}

export function VisualTagView({ node, getPos, editor }: NodeViewProps) {
  const value = typeof node.attrs.value === "string" ? node.attrs.value : "";

  if (value === "") {
    return (
      <NodeViewWrapper as="span">
        <PlaceholderInput
          initialDraft=""
          onCommit={(next) =>
            commitDraft(editor, typeof getPos === "function" ? getPos() : undefined, next)
          }
          onCancel={() => cancelDraft(editor, typeof getPos === "function" ? getPos() : undefined)}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span">
      <RenderedTagChip value={value} />
    </NodeViewWrapper>
  );
}
