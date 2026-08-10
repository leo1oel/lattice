/**
 * chunk-wrapper-decoration plugin.
 *
 * Applies `class="ok-chunk-wrapper"` to top-level document blocks via PM
 * `Decoration.node`. Large lists also get independent boundaries on their
 * direct items, preventing WebKit from materializing hundreds of rich items
 * and math NodeViews when one top-level list intersects the viewport.
 *
 * Why per-block (chunk size N=1) instead of grouped chunks
 * --------------------------------------------------------
 * PM's Decoration API has three forms — `inline`, `node`, `widget`. None
 * supports "wrap N consecutive sibling nodes in a shared parent without
 * touching schema." Slate-based editors like Plate use a structural-node
 * chunking model; PM forbids that without a schema change (precedent #9
 * add-only).
 * So we apply CV:auto to each top-level block as its own chunk — chunk
 * size N=1 — and rely on Chromium's implementation handling thousands of
 * CV:auto-classed elements without superlinear overhead.
 *
 * Nested blocks normally rely on their top-level parent's skip. The exception
 * is a list above `LIST_ITEM_CHUNK_THRESHOLD`: each direct listItem gets a
 * containment boundary. Small lists stay untouched, and a large nested list
 * can qualify independently.
 *
 * `jsxComponent` exclusion
 * ------------------------
 * `content-visibility: auto` implies `contain: paint`, which clips at the
 * decorated element's border box. `.jsx-component-wrapper` (the DOM node
 * TipTap renders for `jsxComponent`) paints visual chrome OUTSIDE its own
 * border box in three places — the `::before` hover hit-zone at `top:-12px`,
 * the `::after` selection halo at `inset:-4px`, and the `.jsx-component-chrome`
 * toolbar child at `top:-11px` (all in `globals.css` §7/§7a). Decorating these
 * with `.ok-chunk-wrapper` would clip the halo (left/right) and the chrome
 * bar (top), so most components remain excluded. Image and math leaves are
 * the exception: imported papers can contain hundreds of them, and their
 * expensive decoded media / KaTeX trees stay inside the component box. They
 * opt into containment and temporarily turn it off on hover, focus, or
 * selection so their editing chrome can still paint outside the box.
 *
 * Marks
 * -----
 * `ok/render/cv-auto-skip` — fires once per session (module-global flag) on
 * the first decoration emit. The mark is a "track active" signal for
 * DevTools-Performance-tab visibility — one entry per session is sufficient;
 * per-emit would flood the trace.
 *
 * System / config doc safety
 * --------------------------
 * The CLAUDE.md STOP rule "isSystemDoc()/isConfigDoc() gates at every
 * documentName-keyed entry point" doesn't apply directly because this plugin
 * keys off `state.doc` (PM structure), not `documentName`. Safety is enforced
 * upstream:
 *   - `__system__` is rejected at ProviderPool admission and filtered out of
 *     the editor mount list. It never reaches a TiptapEditor instance, so
 *     this plugin's `props.decorations` is never called for it.
 *   - `__config__/workspace` and `__user__/config.yml` use Y.Text-only
 *     Settings-pane transport (CLAUDE.md §STOP rules). No `Y.XmlFragment`
 *     exists for TipTap to bind to, so no editor mount, no plugin call.
 * No in-plugin gate is required.
 *
 * Plugin design
 * -------------
 * Decorations live in plugin state. Selection-only transactions reuse the
 * exact DecorationSet; document changes rebuild it because block/list splits
 * can change structural boundaries. This keeps arrow-key navigation and IME
 * selection updates from walking large documents.
 *
 * Cross-browser graceful degradation
 * ----------------------------------
 * Browsers that don't support `content-visibility: auto` (Firefox <123,
 * Safari <18) treat the property as unknown and drop it; the CSS rule
 * becomes a no-op. The plugin would then walk the doc and emit decorations
 * on every transaction for no observable benefit (just a stale wrapper
 * class on every top-level block + a per-transaction DOM mutation). The
 * feature-detection short-circuit at module init returns a no-op plugin
 * on those browsers — zero per-transaction CPU, zero unnecessary class
 * attributes in the rendered DOM.
 *
 * SSR / non-browser environments (unit tests with EditorState only) have
 * no `CSS` global; the helper returns `true` there so the plugin still
 * emits decorations for test assertions.
 */

import { NodeSelection, Plugin, PluginKey, type Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { mark } from '@ok-app/lib/perf';

export const chunkWrapperDecorationKey = new PluginKey('chunkWrapperDecoration');
export const activeChunkDecorationKey = new PluginKey<ActiveChunkState>('activeChunkDecoration');

/** CSS class consumed by `.ProseMirror .ok-chunk-wrapper` in globals.css. */
export const OK_CHUNK_WRAPPER_CLASS = 'ok-chunk-wrapper';

/** Small lists are cheaper to render normally than to add nested containment. */
export const LIST_ITEM_CHUNK_THRESHOLD = 20;
const LIST_ITEM_INTRINSIC_HEIGHT = 56;

const CONTAINABLE_JSX_COMPONENTS = new Map<string, number>([
  ['img', 560],
  ['CommonMarkImage', 560],
  ['WikiEmbedImage', 560],
  ['Math', 120],
  ['DollarMath', 120],
  ['MathFence', 120],
]);

let firstEmitFired = false;

/**
 * Test-only — resets the once-per-session emit flag so unit tests can assert
 * the mark fires on first emit without cross-test contamination. Not used
 * outside test files.
 */
export function __resetFirstEmitForTesting(): void {
  firstEmitFired = false;
}

/**
 * Returns true when the current environment supports `content-visibility:
 * auto`, OR when `CSS.supports` is unavailable (SSR / unit tests with no DOM).
 * The unavailable branch defaults to `true` so the plugin keeps emitting
 * decorations in test environments where the feature-detection itself can't
 * run; tests assert decoration shape, not browser support.
 */
function supportsContentVisibilityAuto(): boolean {
  if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.supports !== 'function') {
    return true;
  }
  return globalThis.CSS.supports('content-visibility', 'auto');
}

const cvAutoSupported = supportsContentVisibilityAuto();

function qualifyingListItemCount(node: ProseMirrorNode): number {
  let count = node.type.name === 'list' && node.childCount >= LIST_ITEM_CHUNK_THRESHOLD
    ? node.childCount
    : 0;
  node.descendants((descendant) => {
    if (descendant.type.name === 'list' && descendant.childCount >= LIST_ITEM_CHUNK_THRESHOLD) {
      count += descendant.childCount;
    }
  });
  return count;
}

function buildChunkDecorations(doc: ProseMirrorNode): DecorationSet | null {
  const decos: Decoration[] = [];
  doc.forEach((node, pos) => {
    // Skip text-only at root (rare); only emit for block children.
    if (node.isInline) return;
    // Interactive containers paint chrome outside their border box and
    // remain excluded. Heavy image/math leaves are safe to contain while
    // idle; CSS releases containment whenever their chrome is active.
    const componentName = node.type.name === 'jsxComponent'
      ? String(node.attrs.componentName ?? '')
      : null;
    const componentHeight = componentName
      ? CONTAINABLE_JSX_COMPONENTS.get(componentName)
      : undefined;
    if (componentName && componentHeight === undefined) return;

    // Child intrinsic sizes don't contribute while their parent list itself
    // is skipped. Reserve an aggregate first-pass height so a cold large list
    // doesn't expand from the generic 80px fallback to thousands of pixels.
    const containedListItems = qualifyingListItemCount(node);
    const largeListHeight = containedListItems > 0
      ? containedListItems * LIST_ITEM_INTRINSIC_HEIGHT
      : undefined;
    const intrinsicHeight = componentHeight ?? largeListHeight;
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: componentHeight === undefined
          ? OK_CHUNK_WRAPPER_CLASS
          : `${OK_CHUNK_WRAPPER_CLASS} ok-chunk-heavy-leaf`,
        ...(intrinsicHeight === undefined
          ? {}
          : { style: `--ok-cv-h: ${intrinsicHeight}px` }),
      }),
    );
  });

  // WebKit otherwise materializes every descendant when one huge list enters
  // view. Decorate only direct children of qualifying lists; ordinary lists
  // and unrelated nested blocks keep the simpler top-level containment path.
  doc.descendants((node, pos) => {
    if (node.type.name !== 'list' || node.childCount < LIST_ITEM_CHUNK_THRESHOLD) return;
    node.forEach((child, offset) => {
      if (child.type.name !== 'listItem') return;
      const childPos = pos + 1 + offset;
      decos.push(
        Decoration.node(childPos, childPos + child.nodeSize, {
          class: 'ok-chunk-list-item',
          style: `--ok-cv-h: ${LIST_ITEM_INTRINSIC_HEIGHT}px`,
        }),
      );
    });
  });

  if (decos.length === 0) return null;
  if (!firstEmitFired) {
    firstEmitFired = true;
    mark(
      'ok/render/cv-auto-skip',
      { chunkCount: decos.length },
      { startTime: performance.now(), duration: 0 },
    );
  }
  return DecorationSet.create(doc, decos);
}

export function chunkWrapperDecorationPlugin(): Plugin<DecorationSet | null> {
  // Browsers without CV:auto support get a no-op plugin: the CSS rule is
  // already inert there, so emitting decorations would just churn DOM
  // attributes per-transaction for no rendering benefit.
  if (!cvAutoSupported) {
    return new Plugin<DecorationSet | null>({ key: chunkWrapperDecorationKey });
  }
  return new Plugin<DecorationSet | null>({
    key: chunkWrapperDecorationKey,
    state: {
      init: (_config, state) => buildChunkDecorations(state.doc),
      apply: (tr, value) => (tr.docChanged ? buildChunkDecorations(tr.doc) : value),
    },
    props: {
      decorations(state) {
        return chunkWrapperDecorationKey.getState(state);
      },
    },
  });
}

type ActiveChunkState = {
  signature: string;
  decorations: DecorationSet | null;
};

function buildActiveChunkDecorations(
  doc: ProseMirrorNode,
  selection: Selection,
): ActiveChunkState {
  const ranges = new Map<number, ProseMirrorNode>();
  const addResolvedPath = ($pos: Selection['$from']) => {
    for (let depth = 1; depth <= $pos.depth; depth += 1) {
      const node = $pos.node(depth);
      if (depth === 1 || node.type.name === 'listItem') {
        ranges.set($pos.before(depth), node);
      }
    }
  };
  addResolvedPath(selection.$from);
  addResolvedPath(selection.$to);

  // A top-level NodeSelection resolves in the doc rather than inside the
  // selected node, so include the node explicitly when no ancestor path can.
  if (selection instanceof NodeSelection) {
    ranges.set(selection.from, selection.node);
  }

  const sorted = [...ranges.entries()].sort(([a], [b]) => a - b);
  const signature = sorted.map(([pos, node]) => `${pos}:${node.nodeSize}`).join('|');
  if (sorted.length === 0) return { signature, decorations: null };
  return {
    signature,
    decorations: DecorationSet.create(
      doc,
      sorted.map(([pos, node]) =>
        Decoration.node(pos, pos + node.nodeSize, { class: 'ok-chunk-active' }),
      ),
    ),
  };
}

/** Keeps containment off only around the active caret/selection and IME path. */
export function activeChunkDecorationPlugin(): Plugin<ActiveChunkState> {
  return new Plugin<ActiveChunkState>({
    key: activeChunkDecorationKey,
    state: {
      init: (_config, state) => buildActiveChunkDecorations(state.doc, state.selection),
      apply: (tr, value, _oldState, newState) => {
        if (!tr.docChanged && !tr.selectionSet) return value;
        const next = buildActiveChunkDecorations(newState.doc, newState.selection);
        return !tr.docChanged && next.signature === value.signature ? value : next;
      },
    },
    props: {
      decorations(state) {
        return activeChunkDecorationKey.getState(state)?.decorations ?? null;
      },
    },
  });
}
