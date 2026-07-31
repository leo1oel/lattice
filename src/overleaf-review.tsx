/**
 * "Review changes" dialog for manual Overleaf sync.
 *
 * Manual mode is meant to feel like reviewing a pull rather than pressing a
 * button and hoping: this asks the backend what a sync *would* do — without
 * writing anything — and shows it as a file list with real diffs, so nothing
 * lands on disk until you say so.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  GitMerge,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { MotionButton } from "./motion";
import { Button } from "./components/ui/button";
import { InfinityLoader, ReloadButton } from "./components/ui/activity-icons";
import { buttonClassName } from "./components/ui/button-styles";
import { ModalDialog } from "./components/ui/modal-dialog";
import { HistoryDiff } from "./versions-timeline";
import {
  type OverleafChangeKind,
  type OverleafPreview,
} from "./app-types";
import { toMessage } from "./app-utils";
import "./overleaf-review.css";

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

  const load = useCallback(async () => {
    if (!props.projectRoot) return;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<OverleafPreview>("overleaf_preview", {
        projectRoot: props.projectRoot,
      });
      setPreview(result);
      setSelected(result.changes.find((change) => !change.binary)?.path ?? null);
    } catch (reason) {
      setError(toMessage(reason));
    }
    setLoading(false);
  }, [props.projectRoot]);

  useEffect(() => {
    if (props.open) void load();
    else {
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

  const active = useMemo(
    () => preview?.changes.find((change) => change.path === selected) ?? null,
    [preview, selected],
  );

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

        {error && <p className="overleaf-review-error" role="alert">{error}</p>}

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
                          disabled={change.binary}
                          title={change.binary ? "Binary file — no line-by-line view" : change.path}
                          onClick={() => setSelected(change.path)}
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
            <div className="overleaf-review-diff">
              {active && !active.binary ? (
                <HistoryDiff
                  change={{ path: active.path, before: active.before, after: active.after }}
                />
              ) : (
                <p className="overleaf-review-empty">
                  {total === 0
                    ? "Nothing to show."
                    : "Pick a file on the left to see what changes."}
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
            disabled={applying || loading || total === 0}
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
