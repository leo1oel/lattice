/**
 * The visual Markdown editor on Lattice's own engine: Tiptap for editing, the
 * round-trip core (markdown-document.ts) for reading and writing Markdown.
 * Mounted instead of the vendored editor when the `visualEditorEngine`
 * setting is `lattice`; it takes the same props (visual-editor-props.ts).
 *
 * Publication follows the contract the canvas already uses: a debounced
 * compare-and-swap `onChangeMarkdown(next, expected)`, a synchronous flush the
 * host calls before it hands the document elsewhere, history owned by the
 * host, and canonical text from the host applied without an undo step.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { useLingui } from "@lingui/react/macro";
import { Extension, type AnyExtension, type EditorOptions } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { InlineMessage } from "../../../components/ui/inline-message";
import { notifyError } from "../../../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../../../telemetry/app-log-store";
import { rebaseMarkdownDraft } from "../markdown-collab";
import { openMarkdownLink } from "../markdown-link-routing";
import { markdownPreviewSyncPolicy } from "../markdown-preview-sync-policy";
import { ProjectImageHostProvider } from "../project-image-host";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { MathMacrosContext, engineNodeViews } from "./engine-node-views";
import { engineSchemaExtensions, type RawBlockKind } from "./engine-schema";
import { openMarkdown, serializeMarkdown, type MarkdownBaseline } from "./markdown-document";
import "./lattice-visual-editor.css";

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
  /** Localized notification copy, refreshed every render. */
  messages: HostMessages | null;
};

type HostMessages = { unavailable: string; source: string; title: string; detail: string; copy: string; restore: string };

function clearTimers(host: Host) {
  if (host.idleTimer) clearTimeout(host.idleTimer);
  if (host.maxTimer) clearTimeout(host.maxTimer);
  host.idleTimer = null;
  host.maxTimer = null;
}

/**
 * Replace the editor's document without an undo step, an update event, or a
 * publication. Only the blocks that differ are replaced, so formulas and
 * images elsewhere stay mounted when canonical text comes back.
 */
function replaceDocument(editor: Editor, doc: PmNode) {
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
  const result = serializeMarkdown(editor.state.doc, host.baseline);
  if (result.text === host.accepted) return true;
  if (host.publish(result.text, host.accepted)) {
    host.accepted = result.text;
    host.baseline = result.baseline;
    host.rejected = null;
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
  host.accepted = text;
  host.dirty = false;
  host.rejected = null;
  const opened = openMarkdown(text, editor.schema);
  if ("unavailable" in opened) {
    host.baseline = null;
    // Still show what can be shown, read-only: a file with mixed line endings
    // reads fine once normalized, but it must never be written back that way.
    const shown = openMarkdown(text.replace(/\r\n?/g, "\n"), editor.schema);
    if ("unavailable" in shown) editor.commands.clearContent(false);
    else replaceDocument(editor, shown.doc);
    host.setReason(host.messages?.unavailable ?? "");
    return;
  }
  host.baseline = opened.baseline;
  const restored = draft == null ? null : openMarkdown(draft, editor.schema);
  if (restored && !("unavailable" in restored)) {
    replaceDocument(editor, restored.doc);
    schedulePublication(host);
  } else {
    replaceDocument(editor, opened.doc);
  }
  host.setReason(null);
}

/**
 * Canonical text arrived for the shown file. A pending or rejected local edit
 * is rebased onto it when the two touch different text; otherwise the
 * canonical text wins and the draft is offered back to the user.
 */
function reconcileCanonical(host: Host, text: string) {
  const { editor } = host;
  if (!editor || text === host.accepted) return;
  const draft = host.dirty && host.baseline ? serializeMarkdown(editor.state.doc, host.baseline).text : host.rejected;
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
    primaryAction: { label: messages.copy, onClick: () => writeText(draft) },
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
    // IME: never publish or hand the document away mid-composition, and apply
    // canonical text that arrived during it once the composition ends.
    handleDOMEvents: {
      compositionstart: (view) => {
        const host = hostOf((view.dom as HTMLElement & { editor?: Editor }).editor);
        if (host) host.composing = true;
        return false;
      },
      compositionend: (view) => {
        const host = hostOf((view.dom as HTMLElement & { editor?: Editor }).editor);
        // WebKit can deliver the committing transaction right after compositionend.
        queueMicrotask(() => {
          if (!host) return;
          host.composing = false;
          if (host.props.activePath === host.path) reconcileCanonical(host, host.props.text);
        });
        return false;
      },
    },
    handleClickOn: (view, _position, _node, _nodePosition, event) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]");
      const host = hostOf((view.dom as HTMLElement & { editor?: Editor }).editor);
      // Editing owns plain clicks; Mod-click (or any click while read-only) follows the link.
      if (!anchor || !host || !(event.metaKey || event.ctrlKey || !view.editable)) return false;
      event.preventDefault();
      openMarkdownLink(host.props.activePath, anchor.getAttribute("href") ?? "", host.props.onOpenProjectPath, view.dom);
      return true;
    },
  };
}

function editorExtensions(labels: Partial<Record<RawBlockKind, string>>): AnyExtension[] {
  const views = engineNodeViews();
  const viewNames = new Set(views.map((view) => view.name));
  return [
    ...engineSchemaExtensions({ rawBlockLabels: labels }).filter((extension) => !viewNames.has(extension.name)),
    ...views,
    HostHistory,
  ];
}

/** Chip labels for kept-verbatim blocks; anchors are invisible and need none. */
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

function useRawBlockLabels(): Partial<Record<RawBlockKind, string>> {
  const { t } = useLingui();
  return {
    html: t`HTML`,
    component: t`Component`,
    definition: t`Definition`,
    footnote: t`Footnote`,
    frontmatter: t`Frontmatter`,
    "layout-table": t`Merged table`,
    unsupported: t`Markdown source`,
  };
}

export function LatticeVisualMarkdownEditor(props: VisualMarkdownEditorProps): JSX.Element {
  const { text, activePath, editable = true, optimizeForReading, onEligibilityChange, onFlushPendingChange } = props;
  const { t } = useLingui();
  const labels = useRawBlockLabels();
  const [reason, setReason] = useState<string | null>(null);
  const host = useRef<Host>({
    props,
    editor: null,
    composing: false,
    path: "",
    accepted: "",
    baseline: null,
    publish: props.onChangeMarkdown,
    dirty: false,
    rejected: null,
    idleTimer: null,
    maxTimer: null,
    setReason,
    messages: null,
  });
  // Extensions are read once, when the editor is created; labels are fixed then.
  const [extensions] = useState(() => editorExtensions(labels));

  useLayoutEffect(() => {
    const current = host.current;
    current.props = props;
    current.messages = {
      // The vendored editor's notice, so hosts and users see one message whichever engine runs.
      unavailable: t`Visual editing is unavailable because this Markdown contains unsupported or lossy syntax. Use source mode to preserve it.`,
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
    // Kept in step with the effect below: Tiptap re-applies these options on re-render.
    editable: editable && reason == null,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps,
    onTransaction: ({ transaction }) => {
      if (transaction.docChanged && !transaction.getMeta(CANONICAL) && host.current.baseline) schedulePublication(host.current);
    },
  }, []);
  const editor = useMountedEditor(instance);

  // Load the active file, and reconcile canonical text from the host: our
  // own echo is ignored, anything else replaces the document.
  useEffect(() => {
    const current = host.current;
    current.editor = editor;
    if (!editor || editor.isDestroyed) return;
    attachHost(editor, current);
    if (current.path !== activePath) {
      // Publish the previous file's pending edit through the previous file's publisher.
      if (current.path) publishPending(current, true);
      current.path = activePath;
      current.publish = current.props.onChangeMarkdown;
      loadDocument(current, text);
      return;
    }
    if (!current.composing) reconcileCanonical(current, text);
  }, [activePath, editor, text]);

  useEffect(() => {
    onEligibilityChange?.(reason);
  }, [onEligibilityChange, reason]);

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
        <div className={`lx-md-editor${optimizeForReading ? " is-reading" : ""}`}>
          {reason && !onEligibilityChange && (
            <InlineMessage level="warning" className="lx-md-eligibility">{reason}</InlineMessage>
          )}
          <EditorContent editor={instance} />
        </div>
      </ProjectImageHostProvider>
    </MathMacrosContext.Provider>
  );
}
