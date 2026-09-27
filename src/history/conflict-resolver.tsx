/**
 * Per-spot conflict resolution.
 *
 * When a merge cannot decide, the file keeps standard `<<<<<<<` markers. This
 * turns each of those spots into an explicit choice — keep this computer's
 * text, keep Overleaf's, or keep both — so resolving never means editing around
 * markers by hand. Anything left undecided keeps its markers, so saving halfway
 * is safe.
 *
 * The choices are applied by `resolveConflicts`, not by the diff renderer.
 * Pierre's inline "Accept current/incoming change" links drew a whole-file
 * diff3 conflict with the local text under the `=======` line — where incoming
 * text normally sits — so the button that looked like "keep my text" emptied
 * the file. Each side is now shown under its own name, next to the choice that
 * keeps it.
 */
import { File, EditProvider } from "@pierre/diffs/react";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft, Check, PencilLine, TriangleAlert } from "lucide-react";
import { MotionButton } from "../components/ui/motion";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { buttonClassName } from "../components/ui/button-styles";
import { ModalDialog } from "../components/ui/modal-dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import { conflictHunks, resolveConflicts, type ConflictChoice, type ConflictHunk } from "./conflict-markers";
import { toMessage } from "../app-utils";
import { InlineMessage } from "../components/ui/inline-message";
import { logAction } from "../telemetry/app-notify";
import { PIERRE_UNSAFE_CSS, usePierreResources } from "./file-diff-view";
import "./conflict-resolver.css";

/** Notification source label for conflict resolution. */
const CONFLICT_SOURCE = "Conflicts";

const createEditor = (options: EditorOptions<undefined>) => new Editor(options);

function ConflictSide(props: {
  label: string;
  caption: string;
  lines: string[];
  kept: boolean | null;
  emptyLabel: string;
}) {
  const { t } = useLingui();
  const count = props.lines.length;
  return (
    <section
      className="conflict-side"
      aria-label={props.label}
      data-kept={props.kept === null ? undefined : String(props.kept)}
    >
      <header className="conflict-side-head">
        <strong>{props.label}</strong>
        <span>{props.caption}</span>
        <span className="conflict-side-count">
          {count === 0 ? t`Empty` : count === 1 ? t`1 line` : t`${count} lines`}
        </span>
      </header>
      {count === 0 ? (
        <p className="conflict-side-empty">{props.emptyLabel}</p>
      ) : (
        <pre className="conflict-side-code" tabIndex={0}>{props.lines.join("\n")}</pre>
      )}
    </section>
  );
}

function ConflictSpot(props: {
  hunk: ConflictHunk;
  position: number;
  total: number;
  choice: ConflictChoice | undefined;
  disabled: boolean;
  onChoose: (choice: ConflictChoice) => void;
}) {
  const { t } = useLingui();
  const { hunk, choice } = props;
  const options: { value: ConflictChoice; label: string }[] = [
    { value: "ours", label: t`Keep this computer's version` },
    { value: "theirs", label: t`Keep Overleaf's version` },
    { value: "both", label: t`Keep both` },
  ];
  const kept = (side: "ours" | "theirs") => choice === undefined
    ? null
    : choice === "both" || choice === side;
  return (
    <article className="conflict-spot" data-decided={choice ? "true" : "false"}>
      <div className="conflict-spot-head">
        <div className="conflict-spot-title">
          <h3>{t`Spot ${props.position} of ${props.total}`}</h3>
          <span>{t`Starts at line ${hunk.line}`}</span>
        </div>
        <Badge tone={choice ? "success" : "warning"} size="compact">
          {choice ? <Check size={11} aria-hidden="true" /> : null}
          {choice ? t`Decided` : t`Needs a decision`}
        </Badge>
      </div>
      <div
        className="conflict-choices"
        role="radiogroup"
        aria-label={t`Version to keep for spot ${props.position}`}
      >
        {options.map((option) => (
          <Button
            key={option.value}
            role="radio"
            aria-checked={choice === option.value}
            size="compact"
            variant={choice === option.value ? "primary" : "secondary"}
            disabled={props.disabled}
            onClick={() => props.onChoose(option.value)}
          >
            {choice === option.value ? <Check size={12} aria-hidden="true" /> : null}
            {option.label}
          </Button>
        ))}
      </div>
      <div className="conflict-sides">
        <ConflictSide
          label={t`This computer`}
          caption={t`Your Lattice copy`}
          lines={hunk.oursLines}
          kept={kept("ours")}
          emptyLabel={t`This computer removed this part.`}
        />
        <ConflictSide
          label={t`Overleaf`}
          caption={t`The copy on Overleaf`}
          lines={hunk.theirsLines}
          kept={kept("theirs")}
          emptyLabel={t`Overleaf removed this part.`}
        />
      </div>
    </article>
  );
}

export function ConflictResolverDialog(props: {
  open: boolean;
  path: string | null;
  projectRoot: string;
  onClose: () => void;
  /** Called after the resolved file is written, so the editor can reload and sync can upload it. */
  onResolved: (path: string) => void;
}) {
  const { t } = useLingui();
  const [content, setContent] = useState("");
  const [choices, setChoices] = useState<ReadonlyMap<number, ConflictChoice>>(new Map());
  const [draftContent, setDraftContent] = useState("");
  const [stage, setStage] = useState<"resolve" | "edit">("resolve");
  const [loadVersion, setLoadVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef("");
  const loadGenerationRef = useRef(0);
  const onCloseRef = useRef(props.onClose);
  const resources = usePierreResources(props.path ?? "conflict.txt");

  useLayoutEffect(() => { onCloseRef.current = props.onClose; }, [props.onClose]);

  const load = useCallback(async (path: string) => {
    // Live sync can retarget the dialog to a different conflict while a slow
    // read is still in flight; if the stale read resolved last, the dialog
    // showed (and Save would write) the previous file's contents.
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    setStage("resolve");
    try {
      const nextContent = await invoke<string>("read_project_file", { path, projectRoot: props.projectRoot });
      if (generation !== loadGenerationRef.current) return;
      setContent(nextContent);
      setChoices(new Map());
      setDraftContent(nextContent);
      draftRef.current = nextContent;
      setLoadVersion((current) => current + 1);
      // A sync result describes an earlier snapshot. Editing or a later sync
      // may already have removed its markers; there is then nothing to save.
      if (conflictHunks(nextContent).length === 0) onCloseRef.current();
    } catch (reason) {
      if (generation !== loadGenerationRef.current) return;
      setError(toMessage(reason));
    }
    if (generation === loadGenerationRef.current) setLoading(false);
  }, [props.projectRoot]);

  useEffect(() => {
    if (props.open && props.path) void load(props.path);
    return () => { loadGenerationRef.current += 1; };
  }, [load, props.open, props.path]);

  const hunks = useMemo(() => conflictHunks(content), [content]);
  const resolvedContent = useMemo(() => resolveConflicts(content, choices), [choices, content]);
  const total = hunks.length;
  const decided = hunks.filter((hunk) => choices.has(hunk.index)).length;
  const editorOptions = useMemo<EditorOptions<undefined>>(() => ({
    onChange(file) {
      draftRef.current = file.contents;
      setDraftContent(file.contents);
    },
  }), []);

  if (!props.open || !props.path || (!loading && !error && total === 0)) return null;
  const path = props.path;

  const choose = (index: number, choice: ConflictChoice) => {
    setChoices((current) => new Map(current).set(index, choice));
  };

  const save = async () => {
    setSaving(true);
    const savedContent = stage === "edit" ? draftRef.current : resolvedContent;
    const trace = logAction(CONFLICT_SOURCE, "Save resolved file", path);
    try {
      await invoke("write_project_file", {
        path,
        content: savedContent,
        projectRoot: props.projectRoot,
      });
      if (stage === "edit" && draftRef.current !== savedContent) {
        trace.fail("The file changed while it was saving. Review the latest text and save again.");
        setSaving(false);
        return;
      }
      trace.note(`Resolved ${path}`);
      props.onResolved(path);
      props.onClose();
    } catch (reason) {
      setError(toMessage(reason));
      trace.fail(reason);
    }
    setSaving(false);
  };

  const remaining = total - decided;
  const progress = total === 0
    ? ""
    : stage === "edit"
      ? t`Review the final file before saving`
      : remaining === 0
        ? t`Every spot decided`
        : t`${decided} of ${total} decided`;

  return (
    <ModalDialog label={t`Resolve conflicts in ${path}`} onClose={props.onClose} closeDisabled={saving}>
      <div className="modal conflict-resolver" data-stage={stage}>
        <div className="conflict-resolver-head">
          <div className="modal-icon"><TriangleAlert size={18} /></div>
          <div>
            <h2>{t`Resolve changes to ${path}`}</h2>
            <p>
              {stage === "edit"
                ? t`Edit the combined file if anything still needs fixing, then save it.`
                : t`This computer and Overleaf both changed the same part of this file since the last sync. Choose which version to keep for each spot. Saving writes your choice to this file, and Overleaf sync then uploads it.`}
            </p>
          </div>
        </div>

        {error && <InlineMessage level="error">{error}</InlineMessage>}

        {resources.error ? (
          <InlineMessage level="error">{t`Could not render this file: ${resources.error.message}`}</InlineMessage>
        ) : loading || (stage === "edit" && !resources.ready) ? (
          <div className="conflict-loading"><InfinityLoader size={16} /> {t`Reading the file…`}</div>
        ) : stage === "edit" ? (
          <div className="conflict-editor" inert={saving || undefined}>
            <EditProvider createEditor={createEditor}>
              <File
                file={{
                  name: path,
                  contents: draftContent,
                  lang: resources.language,
                  cacheKey: `conflict:${path}:${loadVersion}`,
                }}
                edit
                editorOptions={editorOptions}
                options={{
                  disableFileHeader: true,
                  overflow: "wrap",
                  theme: resources.themeName,
                  themeType: resources.theme,
                  unsafeCSS: PIERRE_UNSAFE_CSS,
                }}
                disableWorkerPool
              />
            </EditProvider>
          </div>
        ) : (
          <ScrollArea
            className="conflict-spots"
            viewportClassName="conflict-spots-viewport"
            viewportProps={{ tabIndex: 0, "aria-label": t`Conflicting spots` }}
          >
            <div className="conflict-spot-list" inert={saving || undefined}>
              {hunks.map((hunk, position) => (
                <ConflictSpot
                  key={`${loadVersion}:${hunk.index}`}
                  hunk={hunk}
                  position={position + 1}
                  total={total}
                  choice={choices.get(hunk.index)}
                  disabled={saving}
                  onChoose={(choice) => choose(hunk.index, choice)}
                />
              ))}
            </div>
          </ScrollArea>
        )}

        <div className="conflict-actions">
          <span className="conflict-progress" role="status">{loading ? "" : progress}</span>
          <Button disabled={saving} onClick={props.onClose}>
            {t`Cancel`}
          </Button>
          {stage === "edit" ? (
            <Button
              disabled={saving}
              onClick={() => setStage("resolve")}
            >
              <ArrowLeft size={14} aria-hidden="true" /> {t`Back to choices`}
            </Button>
          ) : (
            <Button
              disabled={saving || loading || total === 0}
              onClick={() => {
                draftRef.current = resolvedContent;
                setDraftContent(resolvedContent);
                setLoadVersion((current) => current + 1);
                setStage("edit");
              }}
            >
              <PencilLine size={14} aria-hidden="true" /> {t`Edit before saving`}
            </Button>
          )}
          <MotionButton
            className={buttonClassName({ variant: "primary" })}
            disabled={saving || loading || (stage === "resolve" && decided === 0)}
            onClick={() => void save()}
          >
            {saving ? <InfinityLoader size={15} /> : null}
            {saving
              ? t`Saving…`
              : stage === "edit" || remaining === 0
                ? t`Save resolved file`
                : t`Save decided spots`}
          </MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}
