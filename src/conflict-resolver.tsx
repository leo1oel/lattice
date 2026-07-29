/**
 * Per-spot conflict resolution.
 *
 * When a merge cannot decide, the file keeps standard `<<<<<<<` markers. This
 * turns each of those spots into a choice — keep mine, keep theirs, or keep
 * both — so resolving never means editing around markers by hand. Anything
 * left undecided keeps its markers, so closing halfway is safe.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { MotionButton } from "./motion";
import { Button } from "./components/ui/button";
import { buttonClassName } from "./components/ui/button-styles";
import { ModalDialog } from "./components/ui/modal-dialog";
import {
  type ConflictChoice,
  conflictHunks,
  resolveConflicts,
} from "./conflict-markers";
import { toMessage } from "./app-utils";
import "./conflict-resolver.css";

export function ConflictResolverDialog(props: {
  open: boolean;
  path: string | null;
  onClose: () => void;
  /** Called after the resolved file is written, so the editor can reload. */
  onResolved: (path: string) => void;
}) {
  const [content, setContent] = useState("");
  const [choices, setChoices] = useState<Map<number, ConflictChoice>>(new Map());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setChoices(new Map());
    try {
      setContent(await invoke<string>("read_project_file", { path }));
    } catch (reason) {
      setError(toMessage(reason));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (props.open && props.path) void load(props.path);
  }, [load, props.open, props.path]);

  const hunks = useMemo(() => conflictHunks(content), [content]);
  const decided = hunks.filter((hunk) => choices.has(hunk.index)).length;

  if (!props.open || !props.path) return null;

  const save = async () => {
    if (!props.path) return;
    setSaving(true);
    setError(null);
    try {
      const resolved = resolveConflicts(content, choices);
      await invoke("write_project_file", { path: props.path, content: resolved });
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

        {loading ? (
          <div className="conflict-loading"><LoaderCircle className="spin" size={16} /> Reading the file…</div>
        ) : hunks.length === 0 ? (
          <p className="conflict-empty">
            Nothing left to decide — this file has no conflict markers.
          </p>
        ) : (
          <div className="conflict-list">
            {hunks.map((hunk, position) => {
              const choice = choices.get(hunk.index);
              const pick = (value: ConflictChoice) => {
                setChoices((current) => {
                  const next = new Map(current);
                  if (next.get(hunk.index) === value) next.delete(hunk.index);
                  else next.set(hunk.index, value);
                  return next;
                });
              };
              return (
                <section key={hunk.index} className="conflict-hunk">
                  <header>
                    <strong>Spot {position + 1}</strong>
                    <span>line {hunk.line}</span>
                    {choice && <em><Check size={11} /> {choice === "both" ? "keeping both" : `keeping ${choice}`}</em>}
                  </header>
                  <div className="conflict-sides">
                    <button
                      type="button"
                      className={`conflict-side${choice === "ours" ? " chosen" : ""}`}
                      onClick={() => pick("ours")}
                    >
                      <span className="conflict-side-label">Mine</span>
                      <pre>{hunk.ours || "(nothing)"}</pre>
                    </button>
                    <button
                      type="button"
                      className={`conflict-side${choice === "theirs" ? " chosen" : ""}`}
                      onClick={() => pick("theirs")}
                    >
                      <span className="conflict-side-label">From Overleaf</span>
                      <pre>{hunk.theirs || "(nothing)"}</pre>
                    </button>
                  </div>
                  <button
                    type="button"
                    className={`conflict-both${choice === "both" ? " chosen" : ""}`}
                    onClick={() => pick("both")}
                  >
                    Keep both, mine first
                  </button>
                </section>
              );
            })}
          </div>
        )}

        <div className="conflict-actions">
          <span className="conflict-progress">
            {hunks.length > 0 ? `${decided} of ${hunks.length} decided` : ""}
          </span>
          <Button disabled={saving} onClick={props.onClose}>
            Cancel
          </Button>
          <MotionButton
            className={buttonClassName({ variant: "primary" })}
            disabled={saving || loading || decided === 0}
            onClick={() => void save()}
          >
            {saving ? <LoaderCircle className="spin" size={15} /> : null}
            {saving ? "Saving…" : "Save file"}
          </MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}
