/**
 * Per-spot conflict resolution.
 *
 * When a merge cannot decide, the file keeps standard `<<<<<<<` markers. This
 * turns each of those spots into a choice — keep mine, keep theirs, or keep
 * both — so resolving never means editing around markers by hand. Anything
 * left undecided keeps its markers, so closing halfway is safe.
 */
import { UnresolvedFile as PierreUnresolvedFile, type FileContents } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import {
  EditProvider,
  File,
} from "@pierre/diffs/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PencilLine, TriangleAlert } from "lucide-react";
import { MotionButton } from "./motion";
import { Button } from "./components/ui/button";
import { InfinityLoader } from "./components/ui/activity-icons";
import { buttonClassName } from "./components/ui/button-styles";
import { ModalDialog } from "./components/ui/modal-dialog";
import { conflictHunks } from "./conflict-markers";
import { toMessage } from "./app-utils";
import { PIERRE_UNSAFE_CSS, usePierreResources } from "./file-diff-view";
import "./conflict-resolver.css";

const createEditor = (options: EditorOptions<undefined>) => new Editor(options);

function PierreConflictSurface(props: {
  content: string;
  language: FileContents["lang"];
  onResolve: (content: string) => void;
  path: string;
  session: number;
  theme: "light" | "dark";
  themeName: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef(props.content);
  const onResolveRef = useRef(props.onResolve);

  useLayoutEffect(() => {
    contentRef.current = props.content;
    onResolveRef.current = props.onResolve;
  }, [props.content, props.onResolve]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const surface = new PierreUnresolvedFile({
      disableFileHeader: true,
      mergeConflictActionsType: "default",
      onMergeConflictResolve(file) {
        contentRef.current = file.contents;
        onResolveRef.current(file.contents);
      },
      overflow: "scroll",
      theme: props.themeName,
      themeType: props.theme,
      unsafeCSS: PIERRE_UNSAFE_CSS,
    });
    surface.render({
      file: { name: props.path, contents: contentRef.current, lang: props.language },
      fileContainer: container,
    });
    return () => surface.cleanUp();
  }, [props.language, props.path, props.session, props.theme, props.themeName]);

  return <div ref={containerRef} />;
}

export function ConflictResolverDialog(props: {
  open: boolean;
  path: string | null;
  onClose: () => void;
  /** Called after the resolved file is written, so the editor can reload. */
  onResolved: (path: string) => void;
}) {
  const [content, setContent] = useState("");
  const [resolvedContent, setResolvedContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [stage, setStage] = useState<"resolve" | "edit">("resolve");
  const [loadVersion, setLoadVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef("");
  const resources = usePierreResources(props.path ?? "conflict.txt");

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setStage("resolve");
    try {
      const nextContent = await invoke<string>("read_project_file", { path });
      setContent(nextContent);
      setResolvedContent(nextContent);
      setDraftContent(nextContent);
      draftRef.current = nextContent;
      setLoadVersion((current) => current + 1);
    } catch (reason) {
      setError(toMessage(reason));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (props.open && props.path) void load(props.path);
  }, [load, props.open, props.path]);

  const total = useMemo(() => conflictHunks(content).length, [content]);
  const remaining = useMemo(() => conflictHunks(resolvedContent).length, [resolvedContent]);
  const decided = total - remaining;
  const editorOptions = useMemo<EditorOptions<undefined>>(() => ({
    onChange(file) {
      draftRef.current = file.contents;
      setDraftContent(file.contents);
    },
  }), []);

  if (!props.open || !props.path) return null;

  const save = async () => {
    if (!props.path) return;
    setSaving(true);
    setError(null);
    const savedContent = draftRef.current;
    try {
      await invoke("write_project_file", { path: props.path, content: savedContent });
      if (draftRef.current !== savedContent) {
        setError("The file changed while it was saving. Review the latest text and save again.");
        setSaving(false);
        return;
      }
      props.onResolved(props.path);
      props.onClose();
    } catch (reason) {
      setError(toMessage(reason));
    }
    setSaving(false);
  };

  return (
    <ModalDialog label={`Resolve conflicts in ${props.path}`} onClose={props.onClose} closeDisabled={saving}>
      <div
        className="modal conflict-resolver"
      >
        <div className="modal-icon"><TriangleAlert size={18} /></div>
        <h2>Resolve “{props.path}”</h2>
        <p>
          These spots were edited on both sides at once. Pick what the file should say at each
          one; anything you skip keeps its markers so you can come back.
        </p>

        {error && <p className="conflict-error" role="alert">{error}</p>}

        {resources.error ? (
          <p className="conflict-error" role="alert">Could not render this file: {resources.error.message}</p>
        ) : loading || !resources.ready ? (
          <div className="conflict-loading"><InfinityLoader size={16} /> Reading the file…</div>
        ) : total === 0 ? (
          <p className="conflict-empty">
            Nothing left to decide — this file has no conflict markers.
          </p>
        ) : stage === "edit" ? (
          <div className="conflict-pierre-surface" data-stage="edit" inert={saving || undefined}>
            <EditProvider createEditor={createEditor}>
              <File
                file={{
                  name: props.path,
                  contents: draftContent,
                  lang: resources.language,
                  cacheKey: `conflict:${props.path}:${loadVersion}`,
                }}
                edit
                editorOptions={editorOptions}
                options={{
                  disableFileHeader: true,
                  overflow: "scroll",
                  theme: resources.themeName,
                  themeType: resources.theme,
                  unsafeCSS: PIERRE_UNSAFE_CSS,
                }}
                disableWorkerPool
              />
            </EditProvider>
          </div>
        ) : (
          <div className="conflict-pierre-surface" data-stage="resolve" inert={saving || undefined}>
            <PierreConflictSurface
              content={resolvedContent}
              language={resources.language}
              onResolve={(nextContent) => {
                setResolvedContent(nextContent);
                setDraftContent(nextContent);
                draftRef.current = nextContent;
              }}
              path={props.path}
              session={loadVersion}
              theme={resources.theme}
              themeName={resources.themeName}
            />
          </div>
        )}

        <div className="conflict-actions">
          <span className="conflict-progress">
            {total > 0 ? (stage === "edit" ? "Review the final file before saving" : `${decided} of ${total} decided`) : ""}
          </span>
          <Button disabled={saving} onClick={props.onClose}>
            Cancel
          </Button>
          {stage === "resolve" && remaining === 0 && total > 0 ? (
            <MotionButton
              className={buttonClassName({ variant: "primary" })}
              disabled={saving || loading}
              onClick={() => {
                draftRef.current = resolvedContent;
                setDraftContent(resolvedContent);
                setStage("edit");
              }}
            >
              <PencilLine size={14} /> Review and edit
            </MotionButton>
          ) : (
            <MotionButton
              className={buttonClassName({ variant: "primary" })}
              disabled={saving || loading || decided === 0}
              onClick={() => void save()}
            >
              {saving ? <InfinityLoader size={15} /> : null}
              {saving ? "Saving…" : stage === "edit" ? "Save file" : "Save progress"}
            </MotionButton>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
