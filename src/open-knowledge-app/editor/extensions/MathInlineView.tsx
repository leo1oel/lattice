/**
 * MathInlineView — React NodeView for the `mathInline` PM atom.
 *
 * Renders the formula attr inline-flow via KaTeX (lazy-imported on first
 * mount). Atom node, so PM treats the rendered output as a single
 * indivisible cursor unit — selection lands on the math, Backspace
 * deletes the whole node.
 *
 * ## Editing UX (feature parity with block descriptors)
 *
 * Clicking the rendered atom selects it and opens an inline editor
 * popover anchored to the math span. The popover reuses the same
 * `<PropPanel>` component the block components use (Callout, Math,
 * Mermaid, etc.) — driven by a synthetic `JsxComponentDescriptor` that
 * exposes the `formula` prop. Input stays in local draft state until Enter,
 * Done, or outside-dismiss commits it to the atom via `tr.setNodeMarkup`.
 * Deferring that transaction prevents the canonical Markdown echo from
 * rebuilding the NodeView after every character.
 *
 * Slash-menu insertion auto-opens the popover via the shared
 * `setPendingAutoOpen` / `consumeAutoOpen` queue used by the
 * descriptor-driven slash entries — same auto-focus sequence as
 * `<Math>` slash-insert.
 *
 * Block math (`<MathView>` in `editor/components/Math.tsx`) and inline
 * math share the same KaTeX dependency in the lazy Visual Editor bundle.
 * Rendering itself is synchronous so virtual chunks never paint the source
 * placeholder for one frame before replacing it with KaTeX.
 *
 * `displayMode: false` is the inline-flow rendering mode (KaTeX wraps
 * output in `<span class="katex">`). `throwOnError: false` keeps
 * malformed LaTeX from crashing the editor — KaTeX renders the error
 * inline with its own red-underline styling.
 */

import { incrementJsxRenderFailure } from '@ok-core';
import { Trans } from '@ok-app/shims/lingui-react-macro';
import type { NodeViewProps } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { NodeViewWrapper } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Button } from '../../components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx';
import { PropPanel } from '../components/PropPanel.tsx';
import type { JsxComponentDescriptor } from '../registry/types.ts';
import { consumeAutoOpen } from '../slash-command/component-items.tsx';
import katex from 'katex';
import { getHostKatexMacros } from '@ok-app/shims/katex-macros';

/**
 * Synthetic descriptor used to drive the inline-math PropPanel. `mathInline`
 * is a PM atom (not a registered jsxComponent), but PropPanel is
 * descriptor-shaped — feeding it a 1-prop synthetic gets full UX parity
 * (auto-focus on `formula`, advanced section collapsed, persisted state
 * keyed by descriptor `name`) without lifting the registry's "all-block"
 * invariant or the jsxInline-render-less guarantee.
 *
 * Cast as `JsxComponentDescriptor` because PropPanel only reads
 * `descriptor.props` and `descriptor.name` — the React `Component` and
 * `reactNodePropNames` decoration fields are never accessed in this
 * editing context.
 */
const inlineMathDescriptor = {
  name: 'InlineMath',
  surface: 'canonical',
  hasChildren: false,
  isSelfClosing: true,
  category: 'content',
  description: 'Inline math',
  props: [
    {
      name: 'formula',
      type: 'string',
      required: true,
      autoFocus: true,
      description: 'LaTeX inline math source',
    },
  ],
} as unknown as JsxComponentDescriptor;

function KatexInlineRender(props: { formula: string }) {
  const html = katex.renderToString(props.formula, {
    displayMode: false,
    throwOnError: false,
    strict: 'ignore',
    macros: getHostKatexMacros(),
    trust: false,
  });
  return (
    <span
      className="math math-inline"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Visible empty-state placeholder for atoms with no formula yet (post-
 * slash-insert, pre-edit). Shows a pill with `f(x)` so the user can see
 * the atom landed and click it to open the editor — earlier iterations
 * used a zero-width space which was literally invisible. Italic + muted
 * styling distinguishes it from rendered math without competing for
 * attention.
 */
function EmptyInlineMathPlaceholder() {
  return (
    <span
      className="math math-inline math-placeholder math-placeholder-empty inline-flex items-center gap-1 rounded-sm border border-dashed border-muted-foreground/40 bg-muted/30 px-1.5 py-0.5 text-xs italic text-muted-foreground hover:bg-muted/60 cursor-pointer"
      data-component-type="math-inline"
    >
      f(x)
    </span>
  );
}

export function MathInlineView({ node, getPos, editor, selected }: NodeViewProps) {
  const formula = typeof node.attrs.formula === 'string' ? node.attrs.formula : '';
  const id = typeof node.attrs.id === 'string' ? node.attrs.id : undefined;
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [formulaDraft, setFormulaDraft] = useState(formula);
  const [, setSelectionVersion] = useState(0);
  const displayedFormula = popoverOpen ? formulaDraft : formula;
  const wasSelected = useRef(false);
  const selection = editor.state.selection;
  let isSoleSelection = false;
  if (selected && selection instanceof NodeSelection) {
    try {
      const pos = typeof getPos === 'function' ? getPos() : undefined;
      isSoleSelection = typeof pos === 'number'
        && selection.from === pos
        && selection.to === pos + node.nodeSize;
    } catch {
      isSoleSelection = false;
    }
  }

  // TipTap already updates the `selected` NodeView prop when this atom enters
  // or leaves a selection. Only keep a direct selection listener while the
  // atom is selected, covering the enclosing-range → exact-NodeSelection
  // transition without making every inline formula recompute getPos() on
  // every cursor move in a large document.
  useEffect(() => {
    if (!selected) return;
    const refreshSelection = () => setSelectionVersion((version) => version + 1);
    editor.on('selectionUpdate', refreshSelection);
    return () => {
      editor.off('selectionUpdate', refreshSelection);
    };
  }, [editor, selected]);

  const commitFormulaDraft = useCallback(() => {
    if (formulaDraft === formula) return;
    const p = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof p !== 'number') return;
    const curNode = editor.state.doc.nodeAt(p);
    if (!curNode || curNode.type.name !== 'mathInline') return;
    const tr = editor.state.tr.setNodeMarkup(p, null, {
      ...curNode.attrs,
      formula: formulaDraft,
      sourceRaw: null,
    });
    tr.setSelection(NodeSelection.create(tr.doc, p));
    editor.view.dispatch(tr);
  }, [editor, formula, formulaDraft, getPos]);

  const closePopover = useCallback(() => {
    commitFormulaDraft();
    setPopoverOpen(false);
  }, [commitFormulaDraft]);

  // Sync popover open state to selection. Two paths in:
  //   1. Slash-insert auto-open — `consumeAutoOpen(pos)` drains the
  //      pending flag set by the slash-menu command on the first
  //      sole-selection→true transition.
  //   2. Click-to-edit — PM produces a NodeSelection on click; the
  //      atom's sole-selection state flips true; we open the popover.
  //
  // And one path out:
  //   3. Close on sole-selection→false — covers genuine navigation
  //      away (arrow keys moving cursor off the atom, programmatic
  //      `setTextSelection`, collaborative edits). Formula typing changes
  //      only local draft state, so it cannot create a transient deselection.
  //      Outside-click and Escape are still handled by Radix's defaults;
  //      this branch covers selection-only changes that bypass those and
  //      commits the current draft before closing.
  //
  // TipTap's raw `selected` prop is true whenever a selection fully covers
  // this atom. That includes a NodeSelection on its containing paragraph, a
  // TextSelection across it, and AllSelection. Subscribe to editor state and
  // require exact from/to bounds instead: only a NodeSelection whose target is
  // this atom may open its properties. The subscription is load-bearing when
  // selection moves directly from an enclosing block to the atom — TipTap's
  // broad `selected` prop stays true across that transition and does not cause
  // a NodeView prop update by itself.
  useEffect(() => {
    if (isSoleSelection && !wasSelected.current) {
      const pos = typeof getPos === 'function' ? (getPos() ?? 0) : 0;
      consumeAutoOpen(pos);
      setFormulaDraft(formula);
      setPopoverOpen(true);
    } else if (!isSoleSelection && wasSelected.current) {
      closePopover();
    }
    wasSelected.current = isSoleSelection;
  }, [isSoleSelection, getPos, formula, closePopover]);

  return (
    <NodeViewWrapper as="span" className={isSoleSelection ? 'math-inline-selected' : undefined}>
      <Popover
        open={popoverOpen}
        onOpenChange={(open) => {
          if (open) {
            setFormulaDraft(formula);
            setPopoverOpen(true);
            return;
          }
          closePopover();
        }}
      >
        {/* PopoverTrigger asChild needs a single ref-able element. Wrap the
            conditional render in a stable <span> so Radix can attach its
            trigger ref (Suspense doesn't forward refs reliably across the
            fallback/rendered boundary). The wrapper also gives us a single
            place to hang `id` for deep-link anchors and the
            data-component-type attribute consistently across all states. */}
        <PopoverTrigger asChild>
          <span
            className="math-inline-trigger"
            data-component-type="math-inline"
            onClick={(event) => {
              // ProseMirror turns this pointer gesture into a NodeSelection.
              // That selection opens the controlled popover before Radix sees
              // the original click on large documents; prevent Radix from
              // interpreting the same click as a request to toggle it closed.
              event.preventDefault();
              const pos = typeof getPos === 'function' ? getPos() : undefined;
              if (typeof pos === 'number') {
                const current = editor.state.doc.nodeAt(pos);
                if (current?.type.name === 'mathInline') {
                  const currentSelection = editor.state.selection;
                  if (!(currentSelection instanceof NodeSelection)
                    || currentSelection.from !== pos
                    || currentSelection.to !== pos + current.nodeSize) {
                    editor.view.dispatch(
                      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)),
                    );
                  }
                }
              }
              setFormulaDraft(formula);
              setPopoverOpen(true);
            }}
            // Surface the formula as a DOM attribute so the clipboard
            // walker's post-clone pass can replace this span with a
            // source-fallback `<span class="mdx-inline">$$formula$$</span>`
            // in the cross-app paste payload. The KaTeX-rendered span
            // tree underneath isn't portable across destinations (paste
            // as garbage in plain-text apps; broken styling in some rich
            // apps); the source-fallback shape is universally readable.
            // Sister site: `clipboard-walker.ts:applyNonPortableInlineAtomReplacement`.
            data-formula={displayedFormula}
            {...(id ? { id } : {})}
          >
            {displayedFormula ? (
              // Block math goes through `JsxComponentView`'s
              // `ComponentErrorBoundary`; inline math is its own NodeView
              // and bypasses that path. Without this boundary, an unexpected
              // KaTeX rendering error would propagate up to `DocumentErrorBoundary` and
              // crash the entire document — block math would degrade
              // gracefully, inline math would not. `resetKeys={[formula]}`
              // lets a follow-up edit retry rendering without an editor
              // restart. Fallback shows the formula source so the
              // author still sees what they typed.
              <ErrorBoundary
                resetKeys={[displayedFormula]}
                onError={(error, info) => {
                  // Mirror JsxComponentView's `ComponentErrorBoundary`
                  // telemetry shape so block + inline math failures share
                  // one log search + one counter, instead of inline math
                  // failing silently while block math is fully observable.
                  const err = error instanceof Error ? error : new Error(String(error));
                  console.warn(
                    JSON.stringify({
                      event: 'jsx-render-failure',
                      component: 'mathInline',
                      // Match `JsxComponentView.ComponentErrorBoundary`'s
                      // log shape exactly so a single log query (or alert
                      // rule) covers both block + inline math failures.
                      // mathInline isn't a JSX component, so component +
                      // rawComponentName collapse to the same value.
                      rawComponentName: 'mathInline',
                      error: String(err),
                      stack: info.componentStack,
                    }),
                  );
                  incrementJsxRenderFailure('mathInline');
                }}
                fallbackRender={() => (
                  <span className="math math-inline math-error">{displayedFormula}</span>
                )}
              >
                <KatexInlineRender formula={displayedFormula} />
              </ErrorBoundary>
            ) : (
              <EmptyInlineMathPlaceholder />
            )}
          </span>
        </PopoverTrigger>
        <PopoverContent
          className="z-[60] w-72 p-3"
          side="bottom"
          align="start"
          // Keep the content inside the editor's React tree so PM
          // selection events from inside the input don't bubble back into
          // the editor as a deselect.
          onOpenAutoFocus={(e) => {
            // Let PropPanel's `autoFocus` propagate to the formula input
            // — don't steal focus to the popover container.
            e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            // Mirror JsxComponentView's leaf-descriptor pattern: hand
            // focus back to the editor view on dismiss so subsequent
            // keystrokes don't disappear into the popover's restore
            // target. `e.preventDefault()` blocks Radix's default focus
            // restore (which would target the trigger span and leave PM
            // unfocused on Escape / outside-click).
            //
            // Then drop the caret right AFTER the atom so the author can
            // just keep typing — leaving the NodeSelection intact
            // would swallow the next keystroke into a select-and-replace
            // gesture instead. Guard against a shifted position: the atom
            // may have been deleted or replaced by a remote peer between
            // popover open and close.
            e.preventDefault();
            if (editor.isDestroyed) return;
            const p = typeof getPos === 'function' ? getPos() : undefined;
            if (typeof p === 'number') {
              const state = editor.state;
              const atomNode = state.doc.nodeAt(p);
              if (atomNode?.type.name === 'mathInline') {
                const after = p + atomNode.nodeSize;
                if (after <= state.doc.content.size) {
                  editor.view.dispatch(
                    state.tr.setSelection(TextSelection.create(state.doc, after)),
                  );
                }
              }
            }
            editor.view.focus();
          }}
        >
          <div className="text-xs font-medium text-muted-foreground mb-2">
            <Trans>Inline Math Properties</Trans>
          </div>
          <PropPanel
            descriptor={inlineMathDescriptor}
            values={{ formula: formulaDraft }}
            onChange={(propName, value) => {
              if (propName === 'formula') setFormulaDraft(typeof value === 'string' ? value : '');
            }}
            // Keep formula edits local until acknowledgement. Updating the
            // PM atom on every character rebuilds its NodeView after the
            // canonical Markdown echo and closes the popover in WebKit.
            onDismiss={closePopover}
          />
          {/* Explicit confirmation affordance. Formula input remains a local
              draft until Enter, Done, or outside-dismiss closes the popover;
              `onCloseAutoFocus` then hands focus back to the editor view. */}
          <div className="mt-3 flex justify-end border-t border-border pt-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={closePopover}
              className="h-7 px-3 text-xs"
            >
              <Trans>Done</Trans>
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}
