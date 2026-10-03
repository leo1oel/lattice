/**
 * The visual Markdown editor on Lattice's own engine: Tiptap for editing, the
 * round-trip core (markdown-document.ts) for reading and writing Markdown.
 * The canvas mounts it through the host contract in visual-editor-props.ts.
 *
 * Publication follows the contract the canvas already uses: a debounced
 * compare-and-swap `onChangeMarkdown(next, expected)`, a synchronous flush the
 * host calls before it hands the document elsewhere, history owned by the
 * host, and canonical text from the host applied without an undo step.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { useLingui } from "@lingui/react/macro";
import { Extension, type AnyExtension, type EditorOptions, type JSONContent } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { InlineMessage } from "../../../components/ui/inline-message";
import { notifyError } from "../../../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../../../telemetry/app-log-store";
import { rebaseMarkdownDraft } from "../markdown-collab";
import { openMarkdownLink } from "../markdown-link-routing";
import { markdownPreviewSyncPolicy } from "../markdown-preview-sync-policy";
import { isPaperLibraryPath } from "../../../papers/paper-link";
import { ProjectImageHostProvider } from "../project-image-host";
import { DocumentHeadingRail, type DocumentHeadingItem } from "../document-heading-rail";
import type { VisualMarkdownEditorProps, VisualRevealTarget } from "../visual-editor-props";
import { resolveCommentAnchor } from "../../comments/editor-comment-data";
import { blockAnchors } from "./block-anchors";
import { blockWindow, mayDrawInWindow, revealPosition, scrollToTarget } from "./block-window";
import { FrozenHeaders } from "./frozen-headers";
import { HeadingAnchors, REFRESH_ANCHORS, plannedHeadings, type DocumentHeading } from "./heading-anchors";
import { PassiveView, passiveModel, type PassiveModel } from "./passive-view";
import type { ImeGuard } from "./engine-keymap";
import { MathMacrosContext, engineNodeViews } from "./engine-node-views";
import { engineSchema, engineSchemaExtensions, type RawBlockKind } from "./engine-schema";
import { adoptNodes, openMarkdown, serializeMarkdown, type MarkdownBaseline, type OpenOptions } from "./markdown-document";
import { SourceMap } from "./source-map";
import { SourceOverlays, buildOverlays, setOverlays } from "./source-overlays";
import { REVEAL_FLASH_MS, RevealFlash, setRevealFlash } from "./reveal-flash";
import { TableControls } from "./views/table-controls";
import { EngineChrome, EngineFindBar, chromeExtensions, createChrome, type Chrome } from "./chrome/engine-chrome";
import "./lattice-visual-editor.css";
import "./lattice-visual-blocks.css";
import "./lattice-visual-chrome.css";

/** Transactions carrying this meta replace the document from canonical text; they are never published. */
const CANONICAL = "latticeCanonicalMarkdown";

const EMPTY_MACROS: Record<string, string> = {};

/**
 * Everything the editor tracks outside React state, in one object the
 * extensions, effects and event handlers share. Mutated only outside render.
 */
type Host = {
  props: VisualMarkdownEditorProps;
  editor: Editor | null;
  composing: boolean;
  /** The file shown; empty before the first load. */
  path: string;
  /** Nothing has been loaded yet: the first document was deferred to a load (a long one). */
  fresh: boolean;
  /** The last Markdown the host accepted (or supplied) for `path`. */
  accepted: string;
  /** Block baseline of `accepted`; null when the engine declined the file. */
  baseline: MarkdownBaseline | null;
  /** The publisher bound to `path`, kept so a path switch still publishes to the old file. */
  publish: (next: string, expected: string) => boolean;
  /** An edit is waiting for its debounced publication. */
  dirty: boolean;
  /** A publication the host rejected, kept until canonical text arrives to rebase onto. */
  rejected: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  setReason: (reason: string | null) => void;
  setBusy: (busy: boolean) => void;
  /** Localized notification copy, refreshed every render. */
  messages: HostMessages | null;
  /** The Enter that commits an IME candidate is swallowed until this time. */
  ime: ImeGuard;
  /** Bumped by every scheduled load; a load that is no longer the latest does nothing. */
  loadGeneration: number;
  /** The kind of load waiting for its microtask, if any. */
  pending: "swap" | "canonical" | null;
  /** The source map of the last document and baseline it was asked for. */
  map: SourceMap | null;
  /** What the host was last told of the caret and the selection, so it hears only changes. */
  reported: { caret: string | null; selection: string | null };
  /** Clears the mark the last jump left. */
  revealTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * The source map for the document as shown against the accepted Markdown
 * (R-SRC-1). Rebuilt only for a new document or baseline; the blocks'
 * placement is shared per baseline, so a rebuild costs one pass over the
 * top-level nodes.
 */
function sourceMapOf(host: Host): SourceMap | null {
  const { editor, baseline } = host;
  if (!editor || editor.isDestroyed || !baseline) return null;
  const { doc } = editor.state;
  if (host.map?.doc !== doc || host.map.baseline !== baseline) host.map = new SourceMap(doc, baseline, host.accepted);
  return host.map;
}

/** Repaint what is placed from source coordinates: carets, comments, changes, labels (R-SRC-2–11). */
function refreshOverlays(host: Host) {
  const { editor, props } = host;
  if (!editor || editor.isDestroyed) return;
  const inputs = {
    cursors: props.presenceCursors ?? [],
    comments: props.editorComments ?? [],
    activeComment: props.activeEditorCommentId ?? null,
    changes: props.overleafChanges ?? [],
    labels: Boolean(props.synchronizeSourceScroll),
  };
  const empty = !inputs.cursors.length && !inputs.comments.length && !inputs.changes.length && !inputs.labels;
  if (empty && !editor.view.dom.querySelector("[data-source-line], [data-lx-comment], [data-lx-change], .lx-md-peer-caret")) return;
  editor.view.dispatch(setOverlays(editor.state.tr, buildOverlays(editor.state.doc, empty ? null : sourceMapOf(host), inputs)));
}

/**
 * Tell the host where the caret is in Markdown (row, column), and what the
 * selection is as Markdown (R-SRC-1, R-SRC-12). The caret is reported only
 * while the document matches the accepted Markdown, so a pending edit never
 * reports coordinates in text the host has not seen yet; it follows once the
 * edit is published.
 */
function reportSelection(host: Host) {
  const { editor, props } = host;
  if (!editor || editor.isDestroyed) return;
  const { selection } = editor.state;
  if (props.onCaretChange && !host.dirty) {
    const caret = sourceMapOf(host)?.positionToRowColumn(selection.head);
    const key = caret ? caret.join(":") : "";
    if (caret && key !== host.reported.caret) {
      host.reported.caret = key;
      props.onCaretChange(caret[0], caret[1]);
    }
  }
  if (props.onSelectionMarkdown) {
    const value = selectionMarkdown(host);
    if (value !== host.reported.selection) {
      host.reported.selection = value;
      props.onSelectionMarkdown(value);
    }
  }
}

/** The selection as the Markdown it was written as, or its text where that has no exact place. */
function selectionMarkdown(host: Host): string {
  const editor = host.editor!;
  const { selection, doc } = editor.state;
  if (selection.empty) return "";
  const map = sourceMapOf(host);
  if (map && selection instanceof NodeSelection && selection.$from.depth === 0) {
    const range = map.blockRange(selection.$from.index(0));
    if (range) return map.text.slice(range.from, range.to);
  }
  const from = map?.positionToOffset(selection.from);
  const to = map?.positionToOffset(selection.to, "before");
  if (map && from != null && to != null && to > from) return map.text.slice(from, to);
  return doc.textBetween(selection.from, selection.to, "\n\n", " ");
}

/** How the file at `path` is read: paper reading mode infers merged table cells (R-BLK-11). */
const openOptions = (props: VisualMarkdownEditorProps): OpenOptions => ({
  paperSpans: Boolean(props.optimizeForReading && isPaperLibraryPath(props.activePath)),
});

type HostMessages = { unavailable: string; source: string; title: string; detail: string; copy: string; restore: string };

function clearTimers(host: Host) {
  if (host.idleTimer) clearTimeout(host.idleTimer);
  if (host.maxTimer) clearTimeout(host.maxTimer);
  if (host.revealTimer) clearTimeout(host.revealTimer);
  host.idleTimer = null;
  host.maxTimer = null;
  host.revealTimer = null;
}

/** How long a jump waits for the document it names to be the one shown before giving up. */
const REVEAL_WAIT_MS = 3000;

/** The text offset where 1-based `line` of `text` starts, clamped to the text. */
function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let row = 1; row < line; row += 1) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return offset;
    offset = next + 1;
  }
  return offset;
}

/**
 * The document range a jump lands on: the comment's anchor, or the start of
 * the line — or, for a line nothing shown sits on (a blank line, hidden
 * markup), the start of the next block that is shown.
 */
function targetRange(host: Host, map: SourceMap, target: VisualRevealTarget): { from: number; to: number } | null {
  if ("commentId" in target) {
    const comment = host.props.editorComments?.find((item) => item.id === target.commentId);
    const anchor = comment && resolveCommentAnchor(map.text, comment);
    if (!anchor) return null;
    const from = map.offsetToPosition(anchor.from, "forward");
    const to = map.offsetToPosition(anchor.to, "backward");
    return from == null ? null : { from, to: to != null && to > from ? to : from };
  }
  const offset = lineOffset(map.text, target.line);
  const exact = map.offsetToPosition(offset, "forward");
  if (exact != null) return { from: exact, to: exact };
  const labels = map.labels();
  const label = labels.find((entry) => entry.to >= offset) ?? labels.at(-1);
  if (!label) return null;
  const from = map.offsetToPosition(label.from, "forward") ?? label.pos + 1;
  return { from, to: from };
}

/** Land on `target`: select it, center it, mark its block for a moment. False when it is not in the shown document. */
function revealTarget(host: Host, target: VisualRevealTarget): boolean {
  const map = sourceMapOf(host);
  const range = map && targetRange(host, map, target);
  return Boolean(range) && landOn(host, range!);
}

/** Select `range`, center its start and mark its top-level block for a moment. */
function landOn(host: Host, range: { from: number; to: number }): boolean {
  const { editor } = host;
  if (!editor || editor.isDestroyed) return false;
  const { view } = editor;
  const { doc } = view.state;
  const from = Math.min(range.from, doc.content.size);
  const $from = doc.resolve(from);
  const blockFrom = $from.depth ? $from.before(1) : from;
  const blockNode = doc.nodeAt(blockFrom);
  const selection = range.to > from ? TextSelection.create(doc, from, Math.min(range.to, doc.content.size)) : Selection.near($from);
  // Selecting first pins (and so draws) the target's block in a windowed document.
  const transaction = view.state.tr.setSelection(selection);
  view.dispatch(blockNode ? setRevealFlash(transaction, { from: blockFrom, to: blockFrom + blockNode.nodeSize }) : transaction);
  view.focus();
  revealPosition(view, selection.from);
  if (host.revealTimer) clearTimeout(host.revealTimer);
  host.revealTimer = setTimeout(() => {
    host.revealTimer = null;
    if (!editor.isDestroyed) editor.view.dispatch(setRevealFlash(editor.view.state.tr, null));
  }, REVEAL_FLASH_MS);
  return true;
}

/**
 * Replace the editor's document without an undo step, an update event, or a
 * publication. Only the blocks that differ are replaced, so formulas and
 * images elsewhere stay mounted when canonical text comes back.
 */
function replaceDocument(editor: Editor, doc: PmNode, caretAtStart = false) {
  const current = editor.state.doc;
  let start = 0;
  let from = 0;
  while (start < current.childCount && start < doc.childCount && current.child(start).eq(doc.child(start))) {
    from += current.child(start).nodeSize;
    start += 1;
  }
  let end = 0;
  let to = current.content.size;
  let newTo = doc.content.size;
  while (
    end < current.childCount - start && end < doc.childCount - start
    && current.child(current.childCount - 1 - end).eq(doc.child(doc.childCount - 1 - end))
  ) {
    to -= current.child(current.childCount - 1 - end).nodeSize;
    newTo -= doc.child(doc.childCount - 1 - end).nodeSize;
    end += 1;
  }
  if (start === current.childCount && start === doc.childCount) return;
  const transaction = editor.state.tr.replaceWith(from, to, doc.slice(from, newTo).content);
  // A first document opens with the caret at its start, as one read at creation does.
  if (caretAtStart) transaction.setSelection(Selection.atStart(transaction.doc));
  transaction.setMeta(CANONICAL, true).setMeta("addToHistory", false).setMeta("preventUpdate", true);
  editor.view.dispatch(transaction);
}

/**
 * Serialize and publish a pending edit. Returns whether the document is safe to
 * hand to another owner: false while an IME composition is open, and once when
 * the host rejects the publication (the draft is kept for rebasing).
 */
function publishPending(host: Host, allowDuringComposition = false): boolean {
  clearTimers(host);
  const { editor } = host;
  if (!host.dirty || !editor || editor.isDestroyed || !host.baseline) return true;
  if (host.composing && !allowDuringComposition) return false;
  host.dirty = false;
  let result: ReturnType<typeof serializeMarkdown>;
  try {
    result = serializeMarkdown(editor.state.doc, host.baseline);
  } catch (error) {
    // A document the serializer refuses (malformed table spans, R-FMT-11) is never written.
    console.warn("[lattice-visual-editor] not publishing an unwritable document", error);
    return true;
  }
  if (result.text === host.accepted) return true;
  if (host.publish(result.text, host.accepted)) {
    host.accepted = result.text;
    host.baseline = adoptNodes(result.baseline, editor.state.doc);
    host.rejected = null;
    // Carets and overlays follow the Markdown the host now has.
    refreshOverlays(host);
    reportSelection(host);
    return true;
  }
  host.rejected = result.text;
  return false;
}

function schedulePublication(host: Host) {
  host.dirty = true;
  const policy = markdownPreviewSyncPolicy(host.accepted.length);
  if (host.idleTimer) clearTimeout(host.idleTimer);
  host.idleTimer = setTimeout(() => publishPending(host), policy.publicationIdleMs);
  host.maxTimer ??= setTimeout(() => publishPending(host), policy.publicationMaxMs);
}

/** Show `text` and make it the accepted Markdown. `draft`, when given, is shown instead as an unpublished edit. */
function loadDocument(host: Host, text: string, draft?: string) {
  const { editor } = host;
  if (!editor || editor.isDestroyed) return;
  clearTimers(host);
  const fresh = host.fresh;
  host.fresh = false;
  host.accepted = text;
  host.dirty = false;
  host.rejected = null;
  host.reported = { caret: null, selection: null };
  const options = openOptions(host.props);
  const opened = openMarkdown(text, editor.schema, options);
  if ("unavailable" in opened) {
    host.baseline = null;
    // Still show what can be shown, read-only: a file with mixed line endings
    // reads fine once normalized, but it must never be written back that way.
    const shown = openMarkdown(text.replace(/\r\n?/g, "\n"), editor.schema, options);
    if ("unavailable" in shown) editor.commands.clearContent(false);
    else replaceDocument(editor, shown.doc, fresh);
    host.setReason(host.messages?.unavailable ?? "");
    return;
  }
  host.baseline = opened.baseline;
  const restored = draft == null ? null : openMarkdown(draft, editor.schema, options);
  if (restored && !("unavailable" in restored)) {
    replaceDocument(editor, restored.doc, fresh);
    schedulePublication(host);
  } else {
    replaceDocument(editor, opened.doc, fresh);
  }
  host.baseline = adoptNodes(opened.baseline, editor.state.doc);
  host.setReason(null);
  refreshOverlays(host);
  reportSelection(host);
}

/**
 * Canonical text arrived for the shown file. A pending or rejected local edit
 * is rebased onto it when the two touch different text; otherwise the
 * canonical text wins and the draft is offered back to the user.
 */
function reconcileCanonical(host: Host, text: string) {
  const { editor } = host;
  if (!editor || text === host.accepted) return;
  let draft = host.rejected;
  if (host.dirty && host.baseline) {
    try {
      draft = serializeMarkdown(editor.state.doc, host.baseline).text;
    } catch {
      draft = null;
    }
  }
  if (draft == null || draft === host.accepted || draft === text) {
    loadDocument(host, text);
    return;
  }
  const rebased = rebaseMarkdownDraft(host.accepted, draft, text);
  if (rebased != null && host.publish(rebased, text)) {
    loadDocument(host, rebased);
    return;
  }
  loadDocument(host, text);
  notifyConflict(host, draft);
}

/**
 * Apply the host's current file and text on a microtask: outside React's
 * commit, so node views mount without lifecycle warnings (R-PUB-10). A swap
 * keeps the view busy and read-only until the new file is shown (R-PUB-8);
 * a later schedule supersedes an earlier one, so switching back before a swap
 * lands keeps the retained document (R-PUB-9).
 */
function scheduleLoad(host: Host, kind: "swap" | "canonical") {
  const generation = ++host.loadGeneration;
  host.pending = kind;
  if (kind === "swap") {
    host.setBusy(true);
    host.editor?.setEditable(false, false);
  }
  queueMicrotask(() => {
    if (generation !== host.loadGeneration) return;
    host.pending = null;
    const { editor } = host;
    if (!editor || editor.isDestroyed) return;
    const text = host.props.text;
    if (kind === "swap") {
      loadDocument(host, text);
      host.setBusy(false);
      const canEdit = (host.props.editable ?? true) && host.baseline != null;
      if (editor.isEditable !== canEdit) editor.setEditable(canEdit, false);
    } else if (!host.composing) {
      reconcileCanonical(host, text);
    }
  });
}

function notifyConflict(host: Host, draft: string) {
  const messages = host.messages;
  if (!messages) return;
  const key = `lattice-visual-conflict:${host.path}`;
  const path = host.path;
  const dismiss = () => dismissAppToastByDedupeKey(key);
  notifyError(messages.source, messages.title, {
    detail: messages.detail,
    timeoutMs: 0,
    dedupeKey: key,
    // Copying keeps the toast: Restore is still to be decided.
    primaryAction: { label: messages.copy, onClick: () => writeText(draft), keepOpen: true },
    secondaryAction: {
      label: messages.restore,
      onClick: () => {
        if (host.path === path) loadDocument(host, host.accepted, draft);
        dismiss();
      },
    },
    onDismiss: dismiss,
  });
}

/** The host this editor instance serves, installed once the editor exists (see the load effect). */
type HostStorage = { host: Host | null };
const hostOf = (editor: Editor | null | undefined) => (
  (editor?.storage as unknown as { latticeHost?: HostStorage } | undefined)?.latticeHost?.host ?? null
);

function attachHost(editor: Editor, host: Host) {
  (editor.storage as unknown as { latticeHost: HostStorage }).latticeHost.host = host;
}

/** History belongs to the host: undo and redo publish the pending edit, then ask the host. */
const HostHistory = Extension.create<object, HostStorage>({
  name: "latticeHost",
  addStorage: () => ({ host: null }),
  addKeyboardShortcuts() {
    const delegate = (command: "onUndo" | "onRedo") => () => {
      const host = this.storage.host;
      if (!host) return false;
      publishPending(host);
      return host.props[command]();
    };
    return { "Mod-z": delegate("onUndo"), "Mod-Shift-z": delegate("onRedo"), "Mod-y": delegate("onRedo") };
  },
});

/** ProseMirror props for the writing surface: its accessible role, and link opening. */
function surfaceProps(label: string): EditorOptions["editorProps"] {
  return {
    attributes: { class: "lx-md-surface", role: "textbox", "aria-multiline": "true", "aria-label": label },
    handleDOMEvents: {
      // A click on a link follows it (R-INL-3); Shift- or Alt-click, or a
      // drag that selected text, stays with the selection. A wiki link keeps
      // its text editable, so only Mod-click (or any click while read-only)
      // opens its page (R-INL-6). Handled on the DOM click, not ProseMirror's
      // position-mapped click, so it never depends on layout.
      click: (view, event) => {
        const host = hostOf((view.dom as HTMLElement & { editor?: Editor }).editor);
        if (!host || event.shiftKey || event.altKey || window.getSelection()?.isCollapsed === false) return false;
        const target = event.target as HTMLElement | null;
        const wiki = target?.closest?.("[data-lattice-wiki]");
        if (wiki) {
          if (!(event.metaKey || event.ctrlKey || !view.editable)) return false;
          // A wiki link opens its page by document name; the heading slug stays for the page to use.
          const name = (wiki.getAttribute("data-target") ?? "").split("#")[0]!;
          const doc = host.props.workspaceIndex?.getDoc(name);
          if (doc) host.props.onOpenProjectPath?.(doc.path);
          event.preventDefault();
          return true;
        }
        const anchor = target?.closest?.("a[href]");
        if (!anchor) return false;
        event.preventDefault();
        openMarkdownLink(host.props.activePath, anchor.getAttribute("href") ?? "", host.props.onOpenProjectPath, view.dom);
        return true;
      },
      // IME: never publish or hand the document away mid-composition, and apply
      // canonical text that arrived during it once the composition ends.
      compositionstart: (view) => {
        const host = hostOf((view.dom as HTMLElement & { editor?: Editor }).editor);
        if (host) host.composing = true;
        return false;
      },
      compositionend: (view) => {
        const host = hostOf((view.dom as HTMLElement & { editor?: Editor }).editor);
        // The committing Enter can follow in the same turn (WebKit); the keymap swallows it.
        if (host) host.ime.composingUntil = performance.now() + 50;
        // WebKit can deliver the committing transaction right after compositionend.
        queueMicrotask(() => {
          if (!host) return;
          host.composing = false;
          if (host.props.activePath === host.path) reconcileCanonical(host, host.props.text);
          if (host.dirty) schedulePublication(host);
        });
        return false;
      },
    },
  };
}

const NO_HEADINGS: DocumentHeadingItem[] = [];

const railCache = new WeakMap<readonly DocumentHeading[], DocumentHeadingItem[]>();

/** The rail's items for the planned headings: the same array while the headings are the same. */
function railHeadings(headings: readonly DocumentHeading[], size: number): DocumentHeadingItem[] {
  let items = railCache.get(headings);
  if (!items) {
    items = headings
      .filter((heading) => heading.id && !heading.generatedContents)
      .map((heading) => ({ id: heading.id, label: heading.text, level: heading.level, position: heading.pos / Math.max(1, size) }));
    railCache.set(headings, items);
  }
  return items;
}

const sameHeadings = (a: DocumentHeadingItem[] | null, b: DocumentHeadingItem[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((item, index) => item.id === b[index]!.id && item.label === b[index]!.label && item.level === b[index]!.level));

/** What any view of a document needs: the engine's schema and its block views. */
function readingExtensions(labels: Partial<Record<RawBlockKind, string>>, ime: ImeGuard): AnyExtension[] {
  const views = engineNodeViews({ ime });
  const viewNames = new Set(views.map((view) => view.name));
  return [...engineSchemaExtensions({ rawBlockLabels: labels }).filter((extension) => !viewNames.has(extension.name)), ...views];
}

/** The passive layout for a large read-only document (R-PERF-1), or null to draw it whole. */
function passiveFor(text: string, activePath: string, reading: boolean): PassiveModel | null {
  const opened = openMarkdown(text, engineSchema(), { paperSpans: reading && isPaperLibraryPath(activePath) });
  return "unavailable" in opened ? null : passiveModel(opened.doc, opened.baseline, text.length, reading);
}

/** The complete editor: a long document is drawn only near the viewport (R-PERF-3). */
function editorExtensions(labels: Partial<Record<RawBlockKind, string>>, ime: ImeGuard, chrome: Chrome): AnyExtension[] {
  return blockWindow([
    ...readingExtensions(labels, ime),
    ...chromeExtensions(chrome),
    SourceOverlays,
    RevealFlash,
    HeadingAnchors.configure({ paper: () => Boolean(chrome.host.props().optimizeForReading) }),
    FrozenHeaders.configure({ enabled: () => !openOptions(chrome.host.props()).paperSpans }),
    HostHistory,
  ], { anchors: blockAnchors });
}

/**
 * The editor once its ProseMirror view is mounted, else null. Tiptap creates
 * the editor before `EditorContent` mounts the view, and every view access
 * before that throws; effects here wait for this instead.
 */
function useMountedEditor(editor: Editor | null): Editor | null {
  const [mounted, setMounted] = useState<Editor | null>(null);
  useEffect(() => {
    if (!editor) return;
    const update = () => setMounted(isMounted(editor) ? editor : null);
    update();
    editor.on("mount", update);
    editor.on("unmount", update);
    return () => {
      editor.off("mount", update);
      editor.off("unmount", update);
    };
  }, [editor]);
  return mounted;
}

const isMounted = (editor: Editor) => !editor.isDestroyed && Boolean((editor as unknown as { editorView?: unknown }).editorView);

/** Chip labels for kept-verbatim blocks; anchors are invisible and need none. */
function useRawBlockLabels(): Partial<Record<RawBlockKind, string>> {
  const { t } = useLingui();
  return {
    html: t`HTML`,
    component: t`Component`,
    definition: t`Definition`,
    frontmatter: t`Frontmatter`,
    unsupported: t`Markdown source`,
  };
}

/**
 * The first document, read while the editor is created: node views built
 * during editor creation mount on Tiptap's deferred path, outside React's
 * lifecycle (R-PUB-10). Later loads are scheduled the same way. A long
 * document is not read here: the editor is created before its plugins, and
 * only they draw it in a window, so it loads as a file switch does
 * (`deferred`).
 */
function initialDocument(props: VisualMarkdownEditorProps) {
  if (mayDrawInWindow(props.text)) return { content: null, baseline: null, unavailable: false, deferred: true };
  const schema = engineSchema();
  const options = openOptions(props);
  const opened = openMarkdown(props.text, schema, options);
  if (!("unavailable" in opened)) return { content: opened.doc.toJSON() as JSONContent, baseline: opened.baseline, unavailable: false };
  const shown = openMarkdown(props.text.replace(/\r\n?/g, "\n"), schema, options);
  return { content: "unavailable" in shown ? null : shown.doc.toJSON() as JSONContent, baseline: null, unavailable: true };
}

/**
 * The first baseline was read with the view-less schema; ProseMirror compares
 * nodes by schema, so move it onto the editor's own nodes, which were built
 * from the same blocks.
 */
function rebindBaseline(baseline: MarkdownBaseline, editor: Editor): MarkdownBaseline {
  const first = baseline.entries[0]?.node;
  if (!first || first.type.schema === editor.schema) return baseline;
  const { doc } = editor.state;
  const entries = baseline.entries.map((entry, index) => ({
    ...entry,
    node: doc.childCount === baseline.entries.length ? doc.child(index) : editor.schema.nodeFromJSON(entry.node.toJSON()),
  }));
  return { ...baseline, entries };
}

/**
 * The passive view's jump: center the last block starting at or before `line`.
 * Its chunk may not be drawn yet; then the chunk is brought into view, which
 * draws it, and the jump is not landed until the block itself is centered.
 */
function revealPassiveLine(layer: HTMLElement | null, model: PassiveModel, line: number): boolean {
  const chunk = model.chunks.filter((candidate) => candidate.labels[0]!.line <= line).at(-1) ?? model.chunks[0]!;
  const label = chunk.labels.filter((candidate) => candidate.line <= line).at(-1) ?? chunk.labels[0]!;
  const block = layer?.querySelector<HTMLElement>(`[data-source-line="${label.line}"]`);
  if (block) {
    block.scrollIntoView({ block: "center" });
    return true;
  }
  layer?.querySelector<HTMLElement>(`[data-visual-chunk-id="${chunk.id}"]`)?.scrollIntoView({ block: "center" });
  return false;
}

export function LatticeVisualMarkdownEditor(props: VisualMarkdownEditorProps): JSX.Element {
  const { text, activePath, editable = true, optimizeForReading, onEligibilityChange, onFlushPendingChange } = props;
  const { t } = useLingui();
  const labels = useRawBlockLabels();
  const unavailableMessage = t`Visual editing is unavailable because this Markdown contains unsupported or lossy syntax. Use source mode to preserve it.`;
  const [initial] = useState(() => initialDocument(props));
  const [reason, setReason] = useState<string | null>(initial.unavailable ? unavailableMessage : null);
  const [busy, setBusy] = useState(false);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [ime] = useState<ImeGuard>(() => ({ composingUntil: 0 }));
  const host = useRef<Host>({
    props,
    editor: null,
    composing: false,
    // A deferred first document loads through the swap the first effect schedules.
    path: initial.deferred ? "" : activePath,
    fresh: Boolean(initial.deferred),
    accepted: text,
    baseline: initial.baseline,
    publish: props.onChangeMarkdown,
    dirty: false,
    rejected: null,
    idleTimer: null,
    maxTimer: null,
    setReason,
    setBusy,
    messages: null,
    ime,
    loadGeneration: 0,
    pending: null,
    map: null,
    reported: { caret: "", selection: "" },
    revealTimer: null,
  });
  const [chrome] = useState(() => createChrome(props));
  // Extensions are read once, when the editor is created; labels are fixed then.
  const [extensions] = useState(() => editorExtensions(labels, ime, chrome));
  const [reading] = useState(() => () => readingExtensions(labels, ime));

  // A large read-only document opens passive until the reader asks for the complete editor (R-PERF-1–3).
  const [activated, setActivated] = useState<{ path: string; href: string | null } | null>(null);
  const passiveWanted = !editable && activated?.path !== activePath;
  // Only the text, the file and reading mode shape the passive layout.
  const passive = useMemo(
    () => (passiveWanted ? passiveFor(text, activePath, Boolean(optimizeForReading)) : null),
    [passiveWanted, text, activePath, optimizeForReading],
  );

  useLayoutEffect(() => {
    const current = host.current;
    current.props = props;
    chrome.host.setProps(props);
    current.messages = {
      unavailable: unavailableMessage,
      source: t`Preview`,
      title: t`This document changed in the same place`,
      detail: t`The shared version is shown. Your visual draft was kept — copy it, or restore it and try again.`,
      copy: t`Copy draft`,
      restore: t`Restore draft and retry`,
    };
    // A path switch keeps the old publisher until the old file's edit is out.
    if (props.activePath === current.path) current.publish = props.onChangeMarkdown;
  });

  const [editorProps] = useState(() => surfaceProps(t`Markdown document editor`));
  const instance = useEditor({
    extensions,
    content: initial.content,
    // Kept in step with the effect below: Tiptap re-applies these options on re-render.
    editable: editable && reason == null,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps,
    onTransaction: ({ transaction }) => {
      if (transaction.docChanged && !transaction.getMeta(CANONICAL) && host.current.baseline) schedulePublication(host.current);
      if (transaction.selectionSet || transaction.docChanged) reportSelection(host.current);
    },
  }, []);
  const editor = useMountedEditor(instance);

  // The section rail (R-BLK-13): the document's headings, less a generated paper Contents (R-BLK-14).
  const railItems = useEditorState({
    editor: instance,
    selector: ({ editor: current }) => (current ? railHeadings(plannedHeadings(current.state), current.state.doc.content.size) : NO_HEADINGS),
    equalityFn: sameHeadings,
  }) ?? NO_HEADINGS;
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(REFRESH_ANCHORS, true).setMeta("addToHistory", false));
  }, [editor, optimizeForReading]);

  // Load the active file, and reconcile canonical text from the host: our
  // own echo is ignored, anything else replaces the document.
  useEffect(() => {
    const current = host.current;
    current.editor = editor;
    if (!editor || editor.isDestroyed) return;
    attachHost(editor, current);
    if (current.baseline) current.baseline = rebindBaseline(current.baseline, editor);
    if (current.path !== activePath) {
      // Publish the previous file's pending edit through the previous file's publisher.
      if (current.path) publishPending(current, true);
      current.path = activePath;
      current.publish = current.props.onChangeMarkdown;
      scheduleLoad(current, "swap");
      return;
    }
    // A pending swap reads the latest text when it lands.
    if (current.pending !== "swap" && (text !== current.accepted || current.pending)) scheduleLoad(current, "canonical");
  }, [activePath, editor, text]);

  useEffect(() => {
    onEligibilityChange?.(reason);
  }, [onEligibilityChange, reason]);

  // A link into the paper followed from the passive view lands once the complete editor shows (R-PERF-2).
  useEffect(() => {
    const href = activated?.href;
    if (!href || passive || !editor || editor.isDestroyed) return;
    const frame = requestAnimationFrame(() => {
      openMarkdownLink(host.current.props.activePath, href, host.current.props.onOpenProjectPath, editor.view.dom);
    });
    return () => cancelAnimationFrame(frame);
  }, [activated, editor, passive]);

  // A jump lands once the document it names is the one shown: after a file
  // swap's load, and on text the host has accepted (so its lines are the
  // host's). It is answered either way, landed or given up on.
  const { revealRequest } = props;
  useEffect(() => {
    if (!revealRequest) return;
    const deadline = performance.now() + REVEAL_WAIT_MS;
    let frame = 0;
    const attempt = () => {
      const current = host.current;
      const shown = current.path === activePath && current.pending == null && current.accepted === current.props.text;
      const landed = passive && "line" in revealRequest.target
        ? revealPassiveLine(layer, passive, revealRequest.target.line)
        : shown && revealTarget(current, revealRequest.target);
      if (!landed && performance.now() < deadline) {
        frame = requestAnimationFrame(attempt);
        return;
      }
      current.props.onRevealHandled?.(revealRequest.id);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [activePath, editor, layer, passive, revealRequest]);

  // The chrome reads the source map through the host; a settled read publishes a pending edit first.
  useEffect(() => {
    chrome.host.setSourceMap((settle) => {
      if (settle) publishPending(host.current);
      return sourceMapOf(host.current);
    });
  }, [chrome]);

  // New carets, comments or changes from the host repaint, outside React's commit.
  const { presenceCursors, editorComments, activeEditorCommentId, overleafChanges, synchronizeSourceScroll } = props;
  useEffect(() => {
    if (!editor) return;
    let live = true;
    queueMicrotask(() => {
      if (live) refreshOverlays(host.current);
    });
    return () => {
      live = false;
    };
  }, [activeEditorCommentId, editor, editorComments, overleafChanges, presenceCursors, synchronizeSourceScroll]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const canEdit = editable && reason == null;
    if (editor.isEditable !== canEdit) editor.setEditable(canEdit, false);
  }, [editable, editor, reason]);

  useLayoutEffect(() => {
    if (!onFlushPendingChange) return;
    onFlushPendingChange(() => publishPending(host.current));
    return () => onFlushPendingChange(null);
  }, [onFlushPendingChange]);

  // Unmounting (a mode or tab switch) publishes the final edit while the editor is alive.
  useLayoutEffect(() => () => {
    publishPending(host.current, true);
    clearTimers(host.current);
  }, []);

  return (
    <MathMacrosContext.Provider value={props.macros ?? EMPTY_MACROS}>
      <ProjectImageHostProvider activePath={activePath} loadAsset={props.onLoadAsset} revision={props.assetRevision}>
        <div ref={setLayer} className={`lx-md-editor${optimizeForReading ? " is-reading" : ""}`} aria-busy={busy || undefined}>
          {reason && !onEligibilityChange && (
            <InlineMessage level="warning" className="lx-md-eligibility">{reason}</InlineMessage>
          )}
          {passive ? (
            <PassiveView model={passive} props={props} reading={reading} onActivate={(href) => setActivated({ path: activePath, href })} />
          ) : (
            <>
              <DocumentHeadingRail
                items={railItems}
                onSelect={(item) => {
                  const find = () => layer?.querySelector<HTMLElement>(`[id="${CSS.escape(item.id)}"]`);
                  const heading = find();
                  if (!heading || !editor || editor.isDestroyed) return;
                  // A heading still standing in as a placeholder is drawn first,
                  // then landed on like any jump, in the heading now drawn.
                  scrollToTarget(heading, { block: "center" });
                  const drawn = find() ?? heading;
                  if (!drawn.isConnected) return;
                  const pos = editor.view.posAtDOM(drawn, 0);
                  landOn(host.current, { from: pos, to: pos });
                }}
              />
              {/* Before the article, so the sticky find bar stays in view over its whole length. */}
              {editor && <EngineFindBar editor={editor} chrome={chrome} />}
              <EditorContent editor={instance} />
              {editor && <TableControls editor={editor} layer={layer} paperMode={openOptions(props).paperSpans ?? false} />}
              {editor && <EngineChrome editor={editor} chrome={chrome} layer={layer} />}
            </>
          )}
        </div>
      </ProjectImageHostProvider>
    </MathMacrosContext.Provider>
  );
}
