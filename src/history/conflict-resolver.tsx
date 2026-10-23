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
 * the file. Each side is now shown under its own name and is itself the choice
 * that keeps it, with the words the two sides disagree on marked in both.
 */
import { File, EditProvider } from "@pierre/diffs/react";
import { Editor, type EditorChangeEvent, type EditorFactory } from "@pierre/diffs/edit";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { phraseHunks } from "../agent/proofread-edits";
import { toMessage } from "../app-utils";
import { InlineMessage } from "../components/ui/inline-message";
import { logAction } from "../telemetry/app-notify";
import { PIERRE_UNSAFE_CSS, usePierreResources } from "./pierre-diff";
import "./conflict-resolver.css";

const createEditor: EditorFactory<undefined, undefined> = (editorType, options, editStateKey) =>
  new Editor(editorType, options, editStateKey);

/**
 * `text` with the words that differ from `other` washed, so a two-word change
 * is seen rather than hunted for. A side the other one removed has nothing to
 * compare against and is left plain.
 */
function MarkedText(props: { text: string; other: string }) {
  if (!props.other.trim()) return <>{props.text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const hunk of phraseHunks(props.text, props.other)) {
    if (hunk.to <= hunk.from) continue;
    parts.push(props.text.slice(cursor, hunk.from), <mark key={hunk.from}>{props.text.slice(hunk.from, hunk.to)}</mark>);
    cursor = hunk.to;
  }
  parts.push(props.text.slice(cursor));
  return <>{parts}</>;
}

/** One side of a spot, and the choice that keeps it: clicking the side is choosing it. */
function ConflictSide(props: {
  label: string;
  choiceLabel: string;
  shortcut: string;
  text: string;
  other: string;
  checked: boolean;
  dropped: boolean;
  disabled: boolean;
  emptyLabel: string;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      className="conflict-side"
      aria-checked={props.checked}
      aria-label={props.choiceLabel}
      aria-keyshortcuts={props.shortcut}
      data-dropped={props.dropped || undefined}
      disabled={props.disabled}
      onClick={props.onChoose}
    >
      <span className="conflict-side-head">
        <span className="conflict-side-radio" aria-hidden="true">{props.checked ? <Check size={10} strokeWidth={3} /> : null}</span>
        <strong>{props.label}</strong>
        <kbd aria-hidden="true">{props.shortcut}</kbd>
      </span>
      {props.text ? (
        <span className="conflict-side-text"><MarkedText text={props.text} other={props.other} /></span>
      ) : (
        <span className="conflict-side-empty">{props.emptyLabel}</span>
      )}
    </button>
  );
}

const CHOICE_KEYS: Record<string, ConflictChoice> = { 1: "ours", 2: "theirs", 3: "both" };

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
  const ours = hunk.oursLines.join("\n");
  const theirs = hunk.theirsLines.join("\n");
  const keeps = (side: "ours" | "theirs") => choice === side || choice === "both";
  const decision = { ours: t`Keeping this computer's`, theirs: t`Keeping Overleaf's`, both: t`Keeping both` };
  return (
    <article
      className="conflict-spot"
      data-decided={choice ? "true" : "false"}
      onKeyDown={(event) => {
        // 1, 2 and 3 choose while focus is anywhere in the spot.
        const picked = CHOICE_KEYS[event.key];
        if (!picked || props.disabled || event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        props.onChoose(picked);
      }}
    >
      <div className="conflict-spot-head">
        <div className="conflict-spot-title">
          <h3>{t`Spot ${props.position} of ${props.total}`}</h3>
          <span>{t`Line ${hunk.line}`}</span>
        </div>
        <Badge tone={choice ? "success" : "warning"} size="compact">
          {choice ? <Check size={11} aria-hidden="true" /> : null}
          {choice ? decision[choice] : t`Needs a decision`}
        </Badge>
      </div>
      <div className="conflict-choices" role="radiogroup" aria-label={t`Version to keep for spot ${props.position}`}>
        <div className="conflict-sides">
        <ConflictSide
          label={t`This computer`}
          choiceLabel={t`Keep this computer's version`}
          shortcut="1"
          text={ours}
          other={theirs}
          checked={keeps("ours")}
          dropped={choice === "theirs"}
          disabled={props.disabled}
          emptyLabel={t`This computer removed this part.`}
          onChoose={() => props.onChoose("ours")}
        />
        <ConflictSide
          label={t`Overleaf`}
          choiceLabel={t`Keep Overleaf's version`}
          shortcut="2"
          text={theirs}
          other={ours}
          checked={keeps("theirs")}
          dropped={choice === "ours"}
          disabled={props.disabled}
          emptyLabel={t`Overleaf removed this part.`}
          onChoose={() => props.onChoose("theirs")}
        />
        </div>
        <button
          type="button"
          role="radio"
          className="conflict-both"
          aria-checked={choice === "both"}
          aria-keyshortcuts="3"
          disabled={props.disabled}
          onClick={() => props.onChoose("both")}
        >
          {choice === "both" ? <Check size={12} aria-hidden="true" /> : null}
          {t`Keep both, yours first`}
          <kbd aria-hidden="true">3</kbd>
        </button>
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
  // The text the edit stage opens with. Pierre's editor owns the draft from
  // then on; typing only updates `draftRef`, because feeding the draft back
  // into the component would overwrite its session.
  const [editStartContent, setEditStartContent] = useState("");
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
      setEditStartContent(nextContent);
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
  const onEditChange = useCallback((event: EditorChangeEvent<"file", undefined, undefined>) => {
    draftRef.current = event.file.contents;
  }, []);

  if (!props.open || !props.path || (!loading && !error && total === 0)) return null;
  const path = props.path;

  const choose = (index: number, choice: ConflictChoice) => {
    setChoices((current) => new Map(current).set(index, choice));
  };

  const save = async () => {
    setSaving(true);
    const savedContent = stage === "edit" ? draftRef.current : resolvedContent;
    const trace = logAction(t`Conflicts`, t`Save resolved file`, path);
    try {
      await invoke("write_project_file", {
        path,
        content: savedContent,
        projectRoot: props.projectRoot,
      });
      if (stage === "edit" && draftRef.current !== savedContent) {
        trace.fail(t`The file changed while it was saving. Review the latest text and save again.`);
        setSaving(false);
        return;
      }
      trace.note(t`Resolved ${path}`);
      props.onResolved(path);
      props.onClose();
    } catch (reason) {
      setError(toMessage(reason));
      trace.fail(reason);
    }
    setSaving(false);
  };

  const remaining = total - decided;
  const progress = total === 0 || stage === "edit"
    ? ""
    : remaining === 0
      ? t`Every spot decided`
      : t`${decided} of ${total} decided`;

  return (
    <ModalDialog label={t`Resolve conflicts in ${path}`} onClose={props.onClose} closeDisabled={saving}>
      <div className="modal modal-large conflict-resolver" data-stage={stage}>
        <div className="conflict-resolver-head">
          <div className="modal-icon" data-tone="warning"><TriangleAlert size={18} /></div>
          <h2>{t`Resolve changes to ${path}`}</h2>
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
                  contents: editStartContent,
                  lang: resources.language,
                  cacheKey: `conflict:${path}:${loadVersion}`,
                }}
                edit
                onEditChange={onEditChange}
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
                setEditStartContent(resolvedContent);
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
                // A settled file is queued for upload (App's onResolved), so the button says so.
                ? t`Save and upload`
                : t`Save decided spots`}
          </MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}
