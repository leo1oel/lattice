/**
 * "Review changes" dialog for manual Overleaf sync.
 *
 * Manual mode is meant to feel like reviewing a pull rather than pressing a
 * button and hoping: this asks the backend what a sync *would* do — without
 * writing anything — and shows it as a file list with real diffs, so nothing
 * lands on disk until you say so.
 */
import type { CodeViewItem } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowDownToLine, ArrowUpFromLine, GitMerge, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";
import { MotionButton } from "../components/ui/motion";
import { Button } from "../components/ui/button";
import { InfinityLoader, ReloadButton } from "../components/ui/activity-icons";
import { buttonClassName } from "../components/ui/button-styles";
import { ModalDialog } from "../components/ui/modal-dialog";
import type { OverleafChangeKind, OverleafPreview } from "../app-types";
import { toMessage } from "../app-utils";
import {
  pierreCodeViewOptions,
  pierreFileDiff,
  pierreLanguageForPath,
  topVisibleIndex,
  usePierreResources,
} from "../history/pierre-diff";
import "./overleaf-review.css";
import { InlineMessage } from "../components/ui/inline-message";
import { LoadingAnnouncement } from "../components/ui/loading-status";

/**
 * Each group's title carries what happens to its files. Only "Kept here" has
 * a blurb: it is the one group whose outcome (your copy wins over Overleaf's)
 * and whose override (delete here, sync again) the title cannot say.
 */
const GROUPS: { kind: OverleafChangeKind; Icon: typeof Trash2; title: MessageDescriptor; blurb?: MessageDescriptor }[] = [
  { kind: "conflict", Icon: TriangleAlert, title: msg`Edited on both sides` },
  { kind: "refusedIncoming", Icon: ShieldAlert, title: msg`Kept here`, blurb: msg`Overleaf sent these empty or much smaller, but its history does not confirm the change, so your copy stays. To take Overleaf's version anyway, delete the file here and sync again` },
  { kind: "incoming", Icon: ArrowDownToLine, title: msg`Coming from Overleaf` },
  { kind: "merge", Icon: GitMerge, title: msg`Combines automatically` },
  { kind: "outgoing", Icon: ArrowUpFromLine, title: msg`Going to Overleaf` },
  { kind: "deleteLocal", Icon: Trash2, title: msg`Deleted here too` },
  { kind: "skippedRemoteDelete", Icon: Trash2, title: msg`Still on Overleaf` },
];

const itemId = (path: string) => `overleaf:${path}`;

/** One small status for a load; what it means goes to assistive technology, not beside it. */
function Loading(props: { message: string }) {
  return <div className="overleaf-review-loading"><InfinityLoader size={16} /><LoadingAnnouncement message={props.message} /></div>;
}

export function OverleafReviewDialog(props: {
  open: boolean;
  projectRoot: string | null;
  onClose: () => void;
  /** Runs the real sync; resolves once it has finished. */
  onApply: () => Promise<void>;
}) {
  const { i18n, t } = useLingui();
  const [preview, setPreview] = useState<OverleafPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const codeViewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!props.projectRoot) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<OverleafPreview>("overleaf_preview", { projectRoot: props.projectRoot });
      if (loadGeneration.current !== generation) return;
      setPreview(result);
      setPreviewRevision((current) => current + 1);
      setSelected(result.changes.find((change) => !change.binary)?.path ?? null);
    } catch (reason) {
      if (loadGeneration.current === generation) setError(toMessage(reason));
    } finally {
      if (loadGeneration.current === generation) setLoading(false);
    }
  }, [props.projectRoot]);

  useEffect(() => {
    if (props.open) {
      void load();
      return;
    }
    // Closing makes any answer still in flight stale.
    loadGeneration.current += 1;
    setLoading(false);
    setPreview(null);
    setSelected(null);
    setError(null);
  }, [load, props.open]);

  const grouped = useMemo(() => GROUPS
    .map((group) => ({ ...group, items: (preview?.changes ?? []).filter((change) => change.kind === group.kind) }))
    .filter((group) => group.items.length > 0), [preview]);
  const textChanges = useMemo(
    () => grouped.flatMap((group) => group.items.filter((change) => !change.binary)),
    [grouped],
  );
  const textPaths = useMemo(() => textChanges.map((change) => change.path), [textChanges]);
  const resources = usePierreResources(textPaths);
  const items = useMemo<CodeViewItem<undefined>[]>(() => textChanges.map((change) => ({
    id: itemId(change.path),
    type: "diff",
    fileDiff: pierreFileDiff(change, pierreLanguageForPath(change.path), `${itemId(change.path)}:${previewRevision}`),
    version: previewRevision,
  })), [previewRevision, textChanges]);
  const groupByItem = useMemo(
    () => new Map(grouped.flatMap((group) => group.items.map((change) => [itemId(change.path), group] as const))),
    [grouped],
  );
  const syncSelectedFromViewport = useCallback((
    scrollTop: number,
    viewer: { getTopForItem: (id: string) => number | undefined },
  ) => {
    const visible = textChanges[topVisibleIndex(items.map((item) => item.id), scrollTop, viewer)];
    if (visible) setSelected(visible.path);
  }, [items, textChanges]);
  const { theme, themeName } = resources;
  const codeViewOptions = useMemo(() => pierreCodeViewOptions({ theme, themeName }, 12), [theme, themeName]);

  if (!props.open) return null;

  const total = preview?.changes.length ?? 0;
  const conflicts = preview?.changes.filter((change) => change.kind === "conflict").length ?? 0;
  const changeSummary = total === 1 ? t`${total} file would change` : t`${total} files would change`;
  const conflictSummary = conflicts === 1 ? t`${conflicts} needs your decision` : t`${conflicts} need your decision`;
  const summary = conflicts
    ? t`${changeSummary} · ${conflictSummary}`
    : changeSummary;

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

  const renderError = resources.error?.message;

  const reveal = (path: string) => {
    setSelected(path);
    codeViewRef.current?.scrollTo({ type: "item", id: itemId(path), align: "start", behavior: "smooth" });
  };

  return (
    <ModalDialog label={t`Review Overleaf changes`} onClose={props.onClose} closeDisabled={applying}>
      <div className="modal modal-large overleaf-review">
        <div className="overleaf-review-head">
          <div>
            <h2><Trans>Review changes</Trans></h2>
            {!loading && <p>{total === 0 ? t`Everything already matches Overleaf` : summary}</p>}
          </div>
          <ReloadButton size="compact" variant="ghost" busy={loading} disabled={loading || applying} onClick={() => void load()}>
            <Trans>Refresh</Trans>
          </ReloadButton>
        </div>

        {error && <InlineMessage level="error" className="overleaf-review-inline">{error}</InlineMessage>}

        {loading ? <Loading message={t`Fetching the Overleaf copy…`} /> : (
          <div className="overleaf-review-body">
            <div className="overleaf-review-list">
              {grouped.map((group) => (
                <section key={group.kind} className="overleaf-review-group">
                  <h3 data-kind={group.kind}><group.Icon size={13} /> {i18n._(group.title)}</h3>
                  {group.blurb && <p>{i18n._(group.blurb)}</p>}
                  <ul>
                    {group.items.map((change) => (
                      <li key={change.path}>
                        <button
                          type="button"
                          className={change.path === selected ? "active" : ""}
                          aria-current={change.path === selected ? "true" : undefined}
                          disabled={change.binary}
                          title={change.path}
                          onClick={() => reveal(change.path)}
                        >
                          <span className="overleaf-review-path">{change.path}</span>
                          {change.binary && <em><Trans>binary</Trans></em>}
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
                  <Trans>Could not render these changes: {renderError}</Trans>
                </InlineMessage>
              ) : !resources.ready ? <Loading message={t`Rendering changes…`} /> : items.length > 0 ? (
                <CodeView
                  ref={codeViewRef}
                  items={items}
                  options={codeViewOptions}
                  className="overleaf-review-code-view"
                  disableWorkerPool
                  onScroll={syncSelectedFromViewport}
                  renderHeaderPrefix={(item) => {
                    const group = groupByItem.get(item.id);
                    return group ? (
                      <span className="overleaf-review-diff-kind" data-kind={group.kind}>
                        <group.Icon size={13} /> {i18n._(group.title)}
                      </span>
                    ) : null;
                  }}
                />
              ) : (
                <p className="overleaf-review-empty">
                  {total === 0 ? t`Nothing to show` : t`Only binary files would change`}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="overleaf-review-actions">
          <Button disabled={applying} onClick={props.onClose}><Trans>Cancel</Trans></Button>
          <MotionButton
            className={buttonClassName({ variant: "primary" })}
            disabled={applying || loading || total === 0 || (items.length > 0 && (!resources.ready || resources.error != null))}
            onClick={() => void apply()}
          >
            {applying ? <InfinityLoader size={15} /> : null}
            {applying ? t`Applying…` : t`Apply and sync`}
          </MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}
