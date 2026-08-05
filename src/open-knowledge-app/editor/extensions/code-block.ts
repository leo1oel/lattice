/**
 * App-side CodeBlock — extends core CodeBlockFidelity with:
 *   - lowlight-powered syntax-highlight decorations (ProseMirror plugin)
 *   - React NodeView for the language dropdown in visual mode
 *
 * The core extension keeps the fidelity attrs (fenceDelimiter, fenceLength,
 * meta, sourceStyle, language) and the markdown round-trip handlers; this
 * layer is browser-render-only and never reaches the server schema.
 */

import { CodeBlockFidelity as BaseCodeBlockFidelity } from '@ok-core';
import { textblockTypeInputRule } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { common, createLowlight } from 'lowlight';
import { CodeBlockView } from './CodeBlockView';
import { type LowlightLike, LowlightPlugin } from './code-block-lowlight-plugin';

// lowlight's typings expose the full hast `Root`; the plugin only consumes the
// structural subset declared in `LowlightLike`.
const lowlight = createLowlight(common) as unknown as LowlightLike;
const codeBodyGuardKey = new PluginKey('codeBodyGuard');

export const CodeBlockFidelity = BaseCodeBlockFidelity.extend({
  // No `addAttributes` override here. Setting a non-null schema default
  // for `language` would break the y-tiptap bridge round-trip: y-tiptap's
  // `createTypeFromElementNode` / `updateYFragment` drop PM `null` attrs
  // from the XmlFragment, so parsed-from-disk bare fences (which carry
  // `language: null` explicitly at the PM JSON layer → no attr on the Y
  // node) would be filled back in by the app schema's default on the
  // next read, then serialized as `\`\`\`<default>`. Bare fences on
  // disk would silently migrate after any WYSIWYG interaction.
  //
  // The JS default for NEW blocks lives on the three creation surfaces
  // instead: this file's bare-backticks input rule (`getAttributes`),
  // `slash-command/items.tsx` (slash menu), and `bubble-menu/
  // BlockTypeSelector.tsx` (block-type selector). Parsed nodes keep
  // their explicit `null`; the bridge round-trip stays lossless.

  // Turn on upstream Tiptap's `Tab` / `Shift-Tab` handler inside code
  // blocks (gated on `enableTabIndentation`, default `false`). With this
  // on, Tab inserts `tabSize` spaces at the caret (or indents each line
  // of a multi-line selection); Shift-Tab removes up to `tabSize` leading
  // spaces from the current line. Without it, the editor-level
  // `TabFocusTrap` would consume the keystroke and leave authors unable
  // to indent code — the gap users hit when typing a code snippet.
  //
  // `tabSize: 2` matches Prettier / Biome defaults across the languages
  // most likely to appear in OK docs (JS/TS/JSON/YAML/Bun shell). Two-
  // space indent round-trips through the markdown pipeline as literal
  // spaces (CommonMark §4.5 fenced code preserves whitespace byte-for-
  // byte), so no fidelity risk.
  // Spread parent options + flip the Tab knobs. Cast the spread result so
  // TypeScript carries the full `CodeBlockOptions` shape: `parent` here is
  // typed `(() => CodeBlockOptions) | undefined` (optional-chain spread is
  // required even though `parent` always exists at runtime for an inherited
  // `addOptions`), and spreading the optional result yields a Partial that
  // doesn't satisfy the override return type's required fields.
  addOptions() {
    return {
      ...this.parent?.(),
      enableTabIndentation: true,
      tabSize: 2,
      // Code blocks are multiline editing surfaces. Tiptap defaults to
      // leaving the block after three consecutive Enter presses, which makes
      // a third blank line look like Enter stopped working. Keep Enter
      // inserting literal newlines; Mod-Enter remains the explicit exit path.
      exitOnTripleEnter: false,
    } as ReturnType<NonNullable<typeof this.parent>>;
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView, {
      update: ({
        oldNode,
        oldDecorations,
        newNode,
        newDecorations,
        oldInnerDecorations,
        innerDecorations,
        updateProps,
      }) => {
        const decorationsChanged = oldDecorations.length !== newDecorations.length
          || oldDecorations.some((decoration, index) => {
            const next = newDecorations[index];
            return decoration.from !== next.from
              || decoration.to !== next.to
              || decoration.spec !== next.spec;
          })
          || oldInnerDecorations !== innerDecorations;
        if (oldNode !== newNode || decorationsChanged) updateProps();
        return true;
      },
    });
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: codeBodyGuardKey,
        appendTransaction(transactions, oldState, newState) {
          if (
            !transactions.some((transaction) => transaction.docChanged)
            || transactions.some((transaction) => transaction.getMeta('canonicalMarkdownReplace') === true)
          ) return null;
          const repairs: Array<{ position: number; text: string }> = [];
          const oldCodeBlocks: Array<{ node: ProseMirrorNode; position: number }> = [];
          const newCodeBlocks: Array<{ node: ProseMirrorNode; position: number }> = [];
          oldState.doc.descendants((node, position) => {
            if (node.type.name === 'codeBlock') oldCodeBlocks.push({ node, position });
          });
          newState.doc.descendants((node, position) => {
            if (node.type.name === 'codeBlock') newCodeBlocks.push({ node, position });
          });
          let oldCodeIndex = 0;
          oldState.doc.descendants((oldNode, oldPosition) => {
            if (oldNode.type.name !== 'codeBlock') return;
            const fallback = oldCodeBlocks.length === newCodeBlocks.length
              ? newCodeBlocks[oldCodeIndex]
              : undefined;
            oldCodeIndex += 1;
            if (!oldNode.textContent) return;
            let mappedPosition = oldPosition;
            for (const transaction of transactions) {
              const result = transaction.mapping.mapResult(mappedPosition, 1);
              mappedPosition = result.pos;
            }
            const mappedNode = newState.doc.nodeAt(mappedPosition);
            const target = mappedNode?.type.name === 'codeBlock'
              ? { node: mappedNode, position: mappedPosition }
              : fallback;
            if (!target || target.node.textContent) return;
            const selectedAfter = newState.selection.from <= target.position + target.node.nodeSize
              && newState.selection.to >= target.position;
            if (!selectedAfter) repairs.push({ position: target.position + 1, text: oldNode.textContent });
          });
          if (!repairs.length) return null;
          const repair = newState.tr.setMeta('addToHistory', false);
          for (const item of repairs.reverse()) repair.insertText(item.text, item.position);
          return repair;
        },
      }),
      LowlightPlugin({
        name: this.name,
        lowlight,
        defaultLanguage: null,
      }),
    ];
  },

  // Add a bare-fence input rule alongside the inherited ones. TipTap's
  // default rule (`/^```([a-z]+)?[\s\n]$/`) requires a trailing space or
  // newline, so plain `\`\`\`` sits as literal text until the user hits
  // space — which is fine when typing a language token (`\`\`\`js<space>`)
  // but unnecessary friction when the author just wants to start a code
  // block without committing to a language token up-front. This second
  // rule fires on EXACTLY three backticks (anchored both ends), so the
  // language-bearing variant stays intact and won't fire mid-typing on
  // `\`\`\`j`.
  //
  // `getAttributes` defaults the new block to JavaScript so syntax
  // highlighting fires on the first character. Setting it here (an
  // explicit attr at creation) rather than via the schema default keeps
  // parsed-from-disk bare fences pristine.
  addInputRules() {
    return [
      ...(this.parent?.() ?? []),
      textblockTypeInputRule({
        find: /^```$/,
        type: this.type,
        getAttributes: () => ({ language: 'js' }),
      }),
    ];
  },
});
