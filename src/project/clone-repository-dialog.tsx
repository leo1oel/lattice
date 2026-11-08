import { useEffect, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { Channel, invoke } from "@tauri-apps/api/core";
import { documentDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { ModalDialog } from "../components/ui/modal-dialog";
import { MotionButton } from "../components/ui/motion";
import { cloneError, joinPath, parentFolder, repositoryName, type CloneError, type CloneProgress } from "./clone-repository";
import "./clone-repository-dialog.css";

type CloneForm = {
  url: string;
  /** The folder the clone goes in, unless a destination was typed. */
  parent: string;
  /** The destination as typed or chosen; null follows the URL's name inside `parent`. */
  typedDestination: string | null;
  /** Set while the clone runs. */
  progress: CloneProgress | null;
  error: CloneError | null;
};

const EMPTY_FORM: CloneForm = { url: "", parent: "", typedDestination: null, progress: null, error: null };

type CloneFormAction =
  | { type: "url"; url: string }
  | { type: "destination"; destination: string }
  | { type: "default-parent"; parent: string }
  | { type: "chose-parent"; parent: string; destination: string | null }
  | { type: "started" }
  | { type: "progress"; progress: CloneProgress }
  | { type: "stopped"; error: CloneError };

function cloneFormReducer(form: CloneForm, action: CloneFormAction): CloneForm {
  switch (action.type) {
    case "url": return { ...form, url: action.url, error: null };
    case "destination": return { ...form, typedDestination: action.destination, error: null };
    // Only while nothing better is there.
    case "default-parent": return form.parent ? form : { ...form, parent: action.parent };
    case "chose-parent": return { ...form, parent: action.parent, typedDestination: action.destination, error: null };
    case "started": return { ...form, progress: { stage: "connecting", progress: 0 }, error: null };
    // A report that lands after the clone stopped is dropped.
    case "progress": return form.progress ? { ...form, progress: action.progress } : form;
    // A cancel goes back to the form as it was.
    case "stopped": return { ...form, progress: null, error: action.error.kind === "cancelled" ? null : action.error };
  }
}

/**
 * Clone a Git repository from a URL into a new folder, then hand the folder
 * back to be opened as a project. git signs in the way it does in a terminal
 * (the user's SSH agent and credential helper); it never stops to ask.
 */
export function CloneRepositoryDialog({ recentProjectPath, onClose, onCloned }: {
  /** The most recently opened project, whose folder's parent is the first place offered. */
  recentProjectPath: string | null;
  onClose: () => void;
  /** The clone finished: the folder it made. */
  onCloned: (root: string) => void;
}) {
  const { t } = useLingui();
  const [{ url, parent, typedDestination, progress, error }, dispatch] = useReducer(
    cloneFormReducer, recentProjectPath, (recent) => ({ ...EMPTY_FORM, parent: recent ? parentFolder(recent) : "" }),
  );
  const cloning = progress !== null;
  const name = repositoryName(url);
  const destination = typedDestination ?? (name && parent ? joinPath(parent, name) : "");
  const destinationName = destination.replace(/\/+$/, "").split("/").pop() ?? "";

  // With no project yet, Documents, as a new Mac document would be.
  useEffect(() => {
    if (parent) return;
    let current = true;
    void documentDir().then((folder) => {
      if (current) dispatch({ type: "default-parent", parent: folder });
    }, () => {});
    return () => {
      current = false;
    };
  }, [parent]);

  // A clone still running when the dialog goes (the window closing) stops.
  const cloningRef = useRef(false);
  useEffect(() => () => {
    if (cloningRef.current) void invoke("cancel_clone").catch(() => {});
  }, []);

  const chooseParent = async () => {
    const chosen = await open({ directory: true, multiple: false, title: t`Choose where to clone the repository` });
    if (!chosen) return;
    dispatch({ type: "chose-parent", parent: String(chosen), destination: name ? joinPath(String(chosen), name) : null });
  };

  const clone = async () => {
    if (cloning || !url.trim() || !destination) return;
    dispatch({ type: "started" });
    cloningRef.current = true;
    const onProgress = new Channel<CloneProgress>();
    onProgress.onmessage = (next) => dispatch({ type: "progress", progress: next });
    try {
      const root = await invoke<string>("clone_repository", { url: url.trim(), destination, onProgress });
      cloningRef.current = false;
      onCloned(root);
    } catch (reason) {
      cloningRef.current = false;
      dispatch({ type: "stopped", error: cloneError(reason) });
    }
  };

  const stageCopy: Record<CloneProgress["stage"], string> = {
    connecting: t`Connecting…`,
    receiving: t`Downloading…`,
    resolving: t`Resolving changes…`,
    checkout: t`Checking out files…`,
  };
  // What went wrong, in the writer's words; git's own follows it.
  const errorCopy: Record<CloneError["kind"], string> = {
    invalidUrl: t`That isn’t a Git repository URL`,
    folderExists: t`“${destinationName}” already exists there. Choose another location`,
    noParent: t`The folder to clone into doesn’t exist`,
    gitMissing: t`Git isn’t installed. Install the Xcode Command Line Tools, then try again`,
    auth: t`Git couldn’t sign in to this repository`,
    notFound: t`Couldn’t find this repository, or your account can’t access it`,
    network: t`Couldn’t reach the server`,
    cancelled: "",
    failed: t`The clone didn’t finish`,
  };
  const percent = progress ? Math.round(progress.progress * 100) : 0;
  return (
    <ModalDialog label={t`Clone a Git repository`} onClose={onClose} closeDisabled={cloning}>
      <form
        className="modal clone-repository-modal"
        onSubmit={(event) => {
          event.preventDefault();
          void clone();
        }}
      >
        <h2>{t`Clone a Git repository`}</h2>
        <label>
          {t`Repository URL`}
          <Input
            autoFocus
            value={url}
            disabled={cloning}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="https://github.com/owner/paper.git"
            aria-invalid={error?.kind === "invalidUrl" || undefined}
            onChange={(event) => dispatch({ type: "url", url: event.target.value })}
          />
        </label>
        <label>
          {t`Location`}
          <span className="clone-repository-location">
            <Input
              aria-label={t`Location`}
              value={destination}
              disabled={cloning}
              spellCheck={false}
              aria-invalid={error?.kind === "folderExists" || error?.kind === "noParent" || undefined}
              onChange={(event) => dispatch({ type: "destination", destination: event.target.value })}
            />
            <Button type="button" variant="secondary" disabled={cloning} onClick={() => void chooseParent()}>
              {t`Choose…`}
            </Button>
          </span>
        </label>
        {progress && (
          <div className="clone-repository-progress" aria-live="polite">
            <div
              className="clone-repository-progress-track"
              role="progressbar"
              aria-label={t`Clone progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="clone-repository-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <span>{progress.stage === "connecting" ? stageCopy.connecting : `${stageCopy[progress.stage]} ${percent}%`}</span>
          </div>
        )}
        {error && (
          <div className="clone-repository-error">
            <InlineMessage level="error">{errorCopy[error.kind]}</InlineMessage>
            {"detail" in error && error.detail && <p className="clone-repository-detail">{error.detail}</p>}
          </div>
        )}
        <div className="modal-actions">
          <Button
            type="button"
            variant="ghost"
            onClick={() => (cloning ? void invoke("cancel_clone").catch(() => {}) : onClose())}
          >
            {t`Cancel`}
          </Button>
          <MotionButton
            type="submit"
            className={buttonClassName({ variant: "primary" })}
            disabled={cloning || !url.trim() || !destination}
          >
            {cloning ? t`Cloning…` : t`Clone`}
          </MotionButton>
        </div>
      </form>
    </ModalDialog>
  );
}
