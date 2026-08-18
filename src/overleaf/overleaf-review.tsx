/**
 * "Review changes" dialog for manual Overleaf sync.
 *
 * Manual mode is meant to feel like reviewing a pull rather than pressing a
 * button and hoping: this asks the backend what a sync *would* do — without
 * writing anything — and shows it as a file list with real diffs, so nothing
 * lands on disk until you say so.
 */
import { parseDiffFromFile, type CodeViewItem } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  GitMerge,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { MotionButton } from "../components/ui/motion";
import { Button } from "../components/ui/button";
import { InfinityLoader, ReloadButton } from "../components/ui/activity-icons";
import { buttonClassName } from "../components/ui/button-styles";
import { ModalDialog } from "../components/ui/modal-dialog";
import {
  type OverleafChangeKind,
  type OverleafPreview,
} from "../app-types";
import { toMessage } from "../app-utils";
import {
  PIERRE_UNSAFE_CSS,
  pierreLanguageForPath,
  usePierreResources,
} from "../history/file-diff-view";
import "./overleaf-review.css";
import { InlineMessage } from "../components/ui/inline-message";

const GROUPS: { kind: OverleafChangeKind; title: string; blurb: string }[] = [
  {
    kind: "conflict",
    title: "Needs your decision",
    blurb: "Edited on both sides in the same place. Applying marks the spots in the file so you can choose.",
  },
  {
    kind: "incoming",
    title: "Coming from Overleaf",
    blurb: "Changed there, untouched here.",
  },
  {
    kind: "merge",
    title: "Combines automatically",
    blurb: "Both sides edited different parts, so the two sets of edits join.",
  },
  {
    kind: "outgoing",
    title: "Going to Overleaf",
    blurb: "Changed here, untouched there.",
  },
  {
    kind: "deleteLocal",
    title: "Removed on Overleaf",
    blurb: "Deleted there and unchanged here, so it goes away locally too.",
  },
  {
    kind: "skippedRemoteDelete",
    title: "Left alone",
    blurb: "Deleted here but still on Overleaf. Lattice never deletes remote files; remove them on Overleaf if you meant to.",
  },
];

const itemId = (path: string) => `overleaf:${path}`;

function iconFor(kind: OverleafChangeKind) {
  if (kind === "conflict") return <TriangleAlert size={13} />;
  if (kind === "incoming") return <ArrowDownToLine size={13} />;
  if (kind === "merge") return <GitMerge size={13} />;
  if (kind === "outgoing") return <ArrowUpFromLine size={13} />;
  return <Trash2 size={13} />;
}

export function OverleafReviewDialog(props: {
  open: boolean;
  projectRoot: string | null;
  onClose: () => void;
  /** Runs the real sync; resolves once it has finished. */
  onApply: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<OverleafPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!props.projectRoot) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<OverleafPreview>("overleaf_preview", {
        projectRoot: props.projectRoot,
      });
      if (loadGeneration.current !== generation) return;
      setPreview(result);
      setPreviewRevision((current) => current + 1);
      setSelected(result.changes.find((change) => !change.binary)?.path ?? null);
    } catch (reason) {
      if (loadGeneration.current !== generation) return;
      setError(toMessage(reason));
    } finally {
      if (loadGeneration.current === generation) setLoading(false);
    }
  }, [props.projectRoot]);

  useEffect(() => {
    if (props.open) void load();
    else {
      loadGeneration.current += 1;
      setLoading(false);
      setPreview(null);
      setSelected(null);
      setError(null);
    }
  }, [load, props.open]);

  const grouped = useMemo(() => {
    const changes = preview?.changes ?? [];
    return GROUPS
      .map((group) => ({
        ...group,
        items: changes.filter((change) => change.kind === group.kind),
      }))
      .filter((group) => group.items.length > 0);
  }, [preview]);

  const textChanges = useMemo(
    () => grouped.flatMap((group) => group.items.filter((change) => !change.binary)),
    [grouped],
  );
  const textPaths = useMemo(() => textChanges.map((change) => change.path), [textChanges]);
  const resources = usePierreResources(textPaths);
  const items = useMemo<CodeViewItem[]>(() => textChanges.map((change) => {
    const language = pierreLanguageForPath(change.path);
    const revisionKey = `${itemId(change.path)}:${previewRevision}`;
    const parsed = parseDiffFromFile(
      {
        name: change.path,
        contents: change.before ?? "",
        lang: language,
        cacheKey: `${revisionKey}:before`,
      },
      {
        name: change.path,
        contents: change.after ?? "",
        lang: language,
        cacheKey: `${revisionKey}:after`,
      },
    );
    const fileDiff = change.before == null
      ? { ...parsed, type: "new" as const }
      : change.after == null
        ? { ...parsed, type: "deleted" as const }
        : parsed;
    return { id: itemId(change.path), type: "diff", fileDiff, version: previewRevision };
  }), [previewRevision, textChanges]);
  const syncSelectedFromViewport = useCallback((
    scrollTop: number,
    viewer: { getTopForItem: (id: string) => number | undefined },
  ) => {
    let visibleItem: CodeViewItem | null = items[0] ?? null;
    for (const item of items) {
      const top = viewer.getTopForItem(item.id);
      if (top == null) continue;
      if (top > scrollTop + 1) break;
      visibleItem = item;
    }
    if (visibleItem?.type === "diff") {
      setSelected((current) => current === visibleItem.fileDiff.name
        ? current
        : visibleItem.fileDiff.name);
    }
  }, [items]);
  const kindByItem = useMemo(
    () => new Map(textChanges.map((change) => [itemId(change.path), change.kind])),
    [textChanges],
  );
  const codeViewOptions = useMemo(() => ({
    diffStyle: "unified" as const,
    lineDiffType: "word" as const,
    overflow: "scroll" as const,
    stickyHeaders: true,
    theme: resources.themeName,
    themeType: resources.theme,
    unsafeCSS: PIERRE_UNSAFE_CSS,
    layout: { paddingTop: 0, paddingBottom: 12, gap: 12 },
  }), [resources.theme, resources.themeName]);

  if (!props.open) return null;

  const total = preview?.changes.length ?? 0;
  const conflicts = preview?.changes.filter((change) => change.kind === "conflict").length ?? 0;

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      await props.onApply();
      props.onClose();
    } catch (reason) {
      setError(toMessage(reason));
    }
    setApplying(false);
  };

  return (
    <ModalDialog label="Review Overleaf changes" onClose={props.onClose} closeDisabled={applying}>
      <div
        className="modal overleaf-review"
      >
        <div className="overleaf-review-head">
          <div>
            <h2>Review changes</h2>
            <p>
              {loading
                ? "Comparing this project with Overleaf…"
                : total === 0
                  ? "Everything already matches Overleaf."
                  : `${total} file${total === 1 ? "" : "s"} would change`
                    + (conflicts ? ` · ${conflicts} need${conflicts === 1 ? "s" : ""} your decision` : "")
                    + ". Nothing has been written yet."}
            </p>
          </div>
          <ReloadButton
            size="compact"
            variant="ghost"
            busy={loading}
            disabled={loading || applying}
            onClick={() => void load()}
          >
            Refresh
          </ReloadButton>
        </div>

        {error && <InlineMessage level="error" className="overleaf-review-inline">{error}</InlineMessage>}

        {loading ? (
          <div className="overleaf-review-loading">
            <InfinityLoader size={16} />
            <span>Fetching the Overleaf copy…</span>
          </div>
        ) : (
          <div className="overleaf-review-body">
            <div className="overleaf-review-list">
              {grouped.length === 0 && !error && (
                <p className="overleaf-review-empty">
                  No differences. You can close this window.
                </p>
              )}
              {grouped.map((group) => (
                <section key={group.kind} className="overleaf-review-group">
                  <h3 data-kind={group.kind}>{iconFor(group.kind)} {group.title}</h3>
                  <p>{group.blurb}</p>
                  <ul>
                    {group.items.map((change) => (
                      <li key={change.path}>
                        <button
                          type="button"
                          className={change.path === selected ? "active" : ""}
                          aria-current={change.path === selected ? "true" : undefined}
                          disabled={change.binary}
                          title={change.binary ? "Binary file — no line-by-line view" : change.path}
                          onClick={() => {
                            setSelected(change.path);
                            codeViewRef.current?.scrollTo({
                              type: "item",
                              id: itemId(change.path),
                              align: "start",
                              behavior: "smooth",
                            });
                          }}
                        >
                          <span className="overleaf-review-path">{change.path}</span>
                          {change.binary && <em>binary</em>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <div className="overleaf-review-diff" id="overleaf-review-diffs">
              {resources.error ? (
                <InlineMessage level="error" className="overleaf-review-inline">
                  Could not render these changes: {resources.error.message}
                </InlineMessage>
              ) : !resources.ready ? (
                <div className="overleaf-review-loading">
                  <InfinityLoader size={16} /> Rendering changes…
                </div>
              ) : items.length > 0 ? (
                <CodeView
                  ref={codeViewRef}
                  items={items}
                  options={codeViewOptions}
                  className="overleaf-review-code-view"
                  disableWorkerPool
                  onScroll={syncSelectedFromViewport}
                  renderHeaderPrefix={(item) => {
                    const kind = kindByItem.get(item.id);
                    const group = GROUPS.find((candidate) => candidate.kind === kind);
                    return kind && group ? (
                      <span className="overleaf-review-diff-kind" data-kind={kind}>
                        {iconFor(kind)} {group.title}
                      </span>
                    ) : null;
                  }}
                />
              ) : (
                <p className="overleaf-review-empty">
                  {total === 0
                    ? "Nothing to show."
                    : "Only binary files would change; line-by-line review is unavailable."}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="overleaf-review-actions">
          <Button disabled={applying} onClick={props.onClose}>
            Cancel
          </Button>
          <MotionButton
            className={buttonClassName({ variant: "primary" })}
            disabled={
              applying
              || loading
              || total === 0
              || (items.length > 0 && (!resources.ready || resources.error != null))
            }
            onClick={() => void apply()}
          >
            {applying ? <InfinityLoader size={15} /> : null}
            {applying ? "Applying…" : "Apply and sync"}
          </MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}
