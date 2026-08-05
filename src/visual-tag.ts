/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original files: packages/app/src/editor/extensions/tag-view.ts,
 * packages/app/src/editor/extensions/tag-click-plugin.ts.
 * Modified 2026-08-04 for Research Writer's workspace index and event
 * wiring. Licensed under GPL-3.0-or-later.
 *
 * App-side Tag extension — extends core's `Tag` atom with:
 *   - The React `VisualTagView` NodeView (filled chip vs empty-placeholder
 *     inline-input states; no popover panel).
 *   - The `#`-typeahead suggestion plugin (visual-tag-suggestion.tsx).
 *   - Adjacent-atom Backspace/Delete handlers (single-keystroke chip
 *     removal — matches @-mention UX in Slack / Discord / Notion).
 *
 * Two insertion paths land at the same filled-chip shape:
 *   - `#` typeahead — user types `#`, picks/creates → suggestion's
 *     command inserts a pre-filled atom.
 *   - Slash-menu "Tag" — inserts an empty `tag` atom; the NodeView's
 *     placeholder state takes over with an auto-focused inline input,
 *     committing on Enter/Space/blur and deleting on Escape/empty-blur.
 *
 * Backspace / Delete next to a tag atom — when an atom sits adjacent to
 * the empty cursor and the suggestion plugin is NOT active, swallow the
 * keystroke and delete the whole atom in a single step. Without this,
 * the default behavior deletes the atom in two steps (first selects it,
 * then deletes on the second press), which surprises authors used to
 * text editors.
 */
import type { AnyExtension } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { MarkdownWorkspaceIndex } from "./markdown-workspace-index";
import { Tag as BaseTag } from "./open-knowledge-core/extensions/tag.ts";
import { VisualTagView } from "./visual-tag-view";
import { configureVisualTagSuggestion, tagSuggestionKey } from "./visual-tag-suggestion";

/**
 * Upstream dispatches `ok:tag-click` from a PM plugin
 * (`tag-click-plugin.ts`). Here the host editor's
 * `editorProps.handleDOMEvents.click` runs BEFORE any plugin's DOM
 * handlers and already claims every anchor click, so the `a[data-tag]`
 * branch lives there instead (visual-markdown-editor.tsx) and calls
 * `dispatchTagClick` — the event contract stays identical.
 */
export const TAG_CLICK_EVENT = "ok:tag-click";

/** Dispatch a tag-click event with the given bare value (no `#` prefix). */
export function dispatchTagClick(value: string): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new CustomEvent(TAG_CLICK_EVENT, { detail: { value } }));
}

export function visualTag(getIndex: () => MarkdownWorkspaceIndex | null): AnyExtension {
  return BaseTag.extend({
    // Higher priority ensures the suggestion plugin's handleKeyDown
    // fires before TipTap's base keymap (Enter → split block, Backspace
    // → joinBackward), so Enter completes a `#` suggestion and
    // Backspace/Delete can target adjacent tag atoms via the handlers
    // below.
    priority: 200,

    addNodeView() {
      return ReactNodeViewRenderer(VisualTagView);
    },

    addKeyboardShortcuts() {
      return {
        Backspace: () => {
          // WARN: Reads @tiptap/suggestion internal state — verify
          // shape on upgrades. Same pattern wiki-link uses upstream to
          // avoid swallowing Backspace while the typeahead is open.
          const pluginState = tagSuggestionKey.getState(this.editor.state) as
            | { active: boolean }
            | undefined;
          if (pluginState?.active) return false;

          const { selection } = this.editor.state;
          if (!selection.empty) return false;

          const nodeBefore = selection.$from.nodeBefore;
          if (nodeBefore?.type.name === "tag") {
            const { state, view } = this.editor;
            view.dispatch(state.tr.delete(selection.from - nodeBefore.nodeSize, selection.from));
            return true;
          }
          return false;
        },
        Delete: () => {
          const pluginState = tagSuggestionKey.getState(this.editor.state) as
            | { active: boolean }
            | undefined;
          if (pluginState?.active) return false;

          const { selection } = this.editor.state;
          if (!selection.empty) return false;

          const nodeAfter = selection.$from.nodeAfter;
          if (nodeAfter?.type.name === "tag") {
            const { state, view } = this.editor;
            view.dispatch(state.tr.delete(selection.from, selection.from + nodeAfter.nodeSize));
            return true;
          }
          return false;
        },
      };
    },

    addProseMirrorPlugins() {
      return [configureVisualTagSuggestion(this.editor, getIndex)];
    },
  });
}
