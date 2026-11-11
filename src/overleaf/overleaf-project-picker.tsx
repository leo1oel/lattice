/**
 * The "Open from Overleaf" picker: connect if needed, browse every project
 * the account can open in Overleaf's own order, see invitations still
 * waiting on Overleaf, or paste a project or share link, then download one
 * as a local Lattice project — or, for a project already linked to a folder
 * on this Mac, open that folder rather than download a second copy.
 */
import { useCallback, useEffect, useReducer, useRef, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Cloud, CloudAlert, CloudOff, ExternalLink, FileText, HardDrive, MailOpen, SearchX, UploadCloud } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Badge } from "../components/ui/badge";
import { InfinityLoader, ReloadButton } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { CheckboxField } from "../components/ui/checkbox-field";
import { Input } from "../components/ui/input";
import { PanelHeader } from "../components/ui/panel-header";
import { ScrollArea } from "../components/ui/scroll-area";
import { SearchField } from "../components/ui/search-field";
import { useCompositionGuard } from "../hooks/use-composition-guard";
import { rowClassName } from "../components/ui/row";
import { MotionButton } from "../components/ui/motion";
import { ModalDialog } from "../components/ui/modal-dialog";
import { mentionsAny } from "../platform/ipc-error-phrases";
import { OVERLEAF_SESSION_EXPIRED } from "./overleaf-realtime-model";
import type { CloneTarget, LocalCopy, OverleafInvite, OverleafProject, OverleafProjectList, OverleafStatus } from "../app-types";
import { confirmAction, relativeTime, toMessage } from "../app-utils";
import { subscribeTauriEvent } from "../app/effect-helpers";
import { listenInThisWindow } from "../app/window-events";
import { InlineMessage } from "../components/ui/inline-message";
import { notifyError, notifySuccess } from "../telemetry/app-notify";
import { useOverleafLogin } from "./use-overleaf-login";
import { OverleafDownloadBar } from "./overleaf-download-bar";
import { ProjectControlsSkeleton, ProjectSkeleton } from "./overleaf-project-skeleton";
import "./overleaf-connect.css";
import { joinPhrases } from "../i18n";
import { Glyph, LoginControls, OVERLEAF_SOURCE, Progress, RetryRow, StageMessage } from "./overleaf-connect-parts";
import { PastedLinkMessage } from "./overleaf-pasted-link";
import { looksLikeOverleafLink, usePastedLink } from "./use-pasted-overleaf-link";
import { initialPickerState, reducePicker } from "./overleaf-picker-state";
import type { DownloadProgress } from "./overleaf-download-progress";



type PickerProps = {
  open: boolean;
  onClose: () => void;
  onCloned: (root: string) => void;
  /**
   * Open a folder already linked to the chosen project, raising its window
   * when one shows it. Without it, every project downloads.
   */
  onOpenLocalCopy?: (root: string) => void;
  /**
   * Folders the app knows of (its recent projects), checked for a link first.
   * Kept as the caller's list, not mapped, so the lookup reruns only when it changes.
   */
  knownFolders?: readonly { path: string }[];
  /** The open, unlinked local project that can become a new Overleaf project. */
  currentProject?: { name: string } | null;
  /** Saves, uploads and links the current project. False means saving was cancelled. */
  onPublish?: (name: string) => Promise<boolean>;
  /** Re-read account-dependent project state after sign-out or sign-in. */
  onConnectionChanged?: () => void;
};

/**
 * "Open from Overleaf" modal: connect (if needed), browse and search your
 * Overleaf projects, and download one as a local Lattice project.
 */
export function OverleafPickerDialog(props: PickerProps) {
  // Mounted afresh on every open, and for another current project, so no
  // search, selection or failed load from an earlier visit carries over.
  return props.open ? <OverleafPicker key={props.currentProject?.name} {...props} /> : null;
}

function OverleafPicker(props: PickerProps) {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(reducePicker, props.currentProject?.name ?? "", initialPickerState);
  const { status, statusLoading, statusError, list, projectsLoading, projectsError, invitationOpened, localCopies } = state;
  const { search, showArchived, selected, opening, cloning, downloaded, publishing, transferError, publishName } = state;
  const { compositionProps, isComposing } = useCompositionGuard();
  const login = useOverleafLogin((session) => {
    dispatch({ type: "status", status: session });
    props.onConnectionChanged?.();
  });
  const { onClose, onConnectionChanged, knownFolders } = props;
  const canOpenLocal = Boolean(props.onOpenLocalCopy);
  const lookup = useRef<Promise<Record<string, LocalCopy>>>(Promise.resolve({}));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadStatus = useCallback(async () => {
    dispatch({ type: "statusLoading" });
    try {
      dispatch({ type: "status", status: await invoke<OverleafStatus>("overleaf_status") });
    } catch (reason) {
      dispatch({ type: "statusFailed", error: toMessage(reason) });
    }
  }, []);

  /** A failed Overleaf request: an expired session becomes the reconnect state, anything else is reported. */
  const handleFailure = useCallback(async (reason: unknown, report: (message: string) => void) => {
    if (!mentionsAny(toMessage(reason), [OVERLEAF_SESSION_EXPIRED])) return report(toMessage(reason));
    // The backend has already recorded the expiry (Settings and background
    // sync read the same record), so re-reading the status shows reconnect.
    dispatch({ type: "projectsCleared" });
    await loadStatus();
    onConnectionChanged?.();
  }, [loadStatus, onConnectionChanged]);

  const loadProjects = useCallback(async () => {
    dispatch({ type: "projectsLoading" });
    try {
      dispatch({ type: "projects", list: await invoke<OverleafProjectList>("overleaf_list_projects") });
    } catch (reason) {
      await handleFailure(reason, (error) => dispatch({ type: "projectsFailed", error }));
    }
  }, [handleFailure]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // Once connected (on open, or right after the in-dialog login), list projects.
  useEffect(() => {
    if (status?.connected) void loadProjects();
  }, [status?.connected, loadProjects]);

  const publish = async () => {
    const name = publishName.trim();
    if (!name || !props.currentProject || !props.onPublish || publishing || cloning || opening) return;
    if (!await confirmAction(
      t`Upload “${name}” to Overleaf and connect this folder?

Lattice will create a new Overleaf project from the files that normally sync. Lattice app data, saved account credentials, build output and Git history stay on this Mac.`,
    )) return;
    dispatch({ type: "publishing", publishing: true });
    try {
      if (await props.onPublish(name)) {
        notifySuccess(OVERLEAF_SOURCE, t`Project uploaded and connected to Overleaf.`);
        onClose();
      }
    } catch (reason) {
      await handleFailure(reason, (detail) => {
        dispatch({ type: "transferFailed", error: detail });
        notifyError(OVERLEAF_SOURCE, t`Could not upload the project to Overleaf`, { detail });
      });
    }
    dispatch({ type: "publishing", publishing: false });
  };

  /**
   * Download `project` into its folder. Downloading binds nothing: where the
   * new root opens (this window when empty, a new one otherwise) is decided
   * afterwards by `onCloned`, so the project open here is never touched.
   */
  const download = async (project: OverleafProject) => {
    // A folder of this name already holding files, with no link to any
    // Overleaf project, is what Stop syncing leaves behind. Downloading a
    // second copy beside it strands whatever was written in the meantime in
    // a folder nothing points at, so this asks rather than choosing.
    const target = await invoke<CloneTarget>("overleaf_clone_target", { projectId: project.id, name: project.name })
      .catch(() => null);
    // Named buttons say what each choice does, so the question stays short.
    // Declining downloads a separate copy, as it always has.
    const adopt = target?.kind === "occupied" && await confirmAction({
      message: t`“${target.folder}” already has files and isn’t linked to Overleaf

Files that differ are kept side by side. Nothing is overwritten`,
      confirmLabel: t`Link this folder`,
      cancelLabel: t`Download a new copy`,
    });
    return invoke<string>("overleaf_clone_project", {
      projectId: project.id,
      name: project.name,
      accessLevel: project.accessLevel,
      adopt,
    });
  };

  const clone = async (project: OverleafProject) => {
    dispatch({ type: "cloning", project });
    try {
      const root = await download(project);
      dispatch({ type: "cloning", project: null });
      props.onCloned(root);
      onClose();
    } catch (reason) {
      dispatch({ type: "cloning", project: null });
      await handleFailure(reason, (detail) => {
        dispatch({ type: "transferFailed", error: detail });
        notifyError(OVERLEAF_SOURCE, t`Could not open the Overleaf project`, { detail });
      });
    }
  };

  /**
   * Open `project`: the folder on this Mac already linked to it when there is
   * one — a second copy would sync too, drift apart from the first and leave
   * the writer guessing which holds their work — or else a download. The
   * copy first takes the role the dashboard reports now, as a reopened
   * download does. The lookup is awaited, so an Open pressed before it answers
   * still finds the copy.
   */
  const openProject = async (project: OverleafProject) => {
    if (opening || cloning || publishing) return;
    dispatch({ type: "opening", project });
    const copy = props.onOpenLocalCopy ? (await lookup.current)[project.id] : undefined;
    if (!mounted.current) return;
    if (!copy || !props.onOpenLocalCopy) {
      dispatch({ type: "opening", project: null });
      return clone(project);
    }
    try {
      await invoke("overleaf_reopen_local_copy", { path: copy.path, projectId: project.id, accessLevel: project.accessLevel });
    } catch (reason) {
      const detail = toMessage(reason);
      dispatch({ type: "opening", project: null });
      dispatch({ type: "transferFailed", error: detail });
      notifyError(OVERLEAF_SOURCE, t`Could not open the Overleaf project`, { detail });
      return;
    }
    if (!mounted.current) return;
    dispatch({ type: "opening", project: null });
    props.onOpenLocalCopy(copy.path);
    onClose();
  };

  /** The account's connection, once it has been read without error. */
  const known = !statusLoading && !statusError ? status : null;
  const projects = list?.projects ?? null;
  // A pasted link is looked up instead of filtering the list by its text.
  const link = known?.connected && looksLikeOverleafLink(search) ? search.trim() : null;
  const pasted = usePastedLink(link, handleFailure);
  const linked = pasted.answer?.kind === "project" ? pasted.answer.project : null;

  // Which listed projects already have a folder on this Mac. Each answer is
  // read from that folder's own link, so a folder deleted or unlinked since
  // simply does not answer and its project downloads as before.
  useEffect(() => {
    const listed = [...(list?.projects ?? []), ...(linked ? [linked] : [])];
    if (!canOpenLocal || !listed.length) return;
    let disposed = false;
    lookup.current = invoke<Record<string, LocalCopy>>("overleaf_local_copies", {
      names: listed.map((project) => project.name),
      folders: (knownFolders ?? []).map((folder) => folder.path),
    })
      // Without an answer every project downloads, which is what it did before.
      .catch(() => ({}));
    void lookup.current.then((copies) => { if (!disposed) dispatch({ type: "localCopies", copies }); });
    return () => { disposed = true; };
  }, [list, linked, knownFolders, canOpenLocal]);
  const query = link ? "" : search.trim().toLowerCase();
  const matches = (...values: (string | null)[]) => !query || values.some((value) => value?.toLowerCase().includes(query));
  const visible = (projects ?? [])
    .filter((project) => showArchived || (!project.archived && !project.trashed))
    .filter((project) => matches(project.name, project.ownerName, project.ownerEmail));
  const invites = (list?.invites ?? []).filter((invite) => matches(invite.projectName, invite.inviterName));
  const transferring = Boolean(cloning) || publishing;
  const working = Boolean(opening) || transferring;
  const openingText = (name: string) => t`Opening ${name}…`;
  // A project with large figures takes minutes to arrive over a slow link:
  // show how much has and how fast, so a long download reads as moving, not stuck.
  const cloningId = cloning?.id ?? null;
  useEffect(() => {
    if (!cloningId) return;
    return subscribeTauriEvent<DownloadProgress>(
      (handler) => listenInThisWindow("overleaf-download-progress", handler),
      (progress) => dispatch({ type: "downloaded", progress, at: performance.now() }),
    );
  }, [cloningId]);
  const updated = (project: OverleafProject) => Date.parse(project.lastUpdated ?? "") || 0;
  // One list, newest first whoever owns it: the order of Overleaf's own
  // dashboard (its default sort is lastUpdated, descending).
  const recent = [...visible].sort((a, b) => updated(b) - updated(a) || a.name.localeCompare(b.name));
  const ordered = link ? (linked ? [linked] : []) : recent;
  const navigateProjects = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".overleaf-project-main");
    const inSearch = target instanceof HTMLInputElement && Boolean(target.closest(".overleaf-search"));
    if (working || !ordered.length || isComposing(event) || !(row || inSearch)) return;
    // A focused row acts from itself; the search field acts from the selected
    // row, or from the one project a pasted link opens.
    const current = row ? row.dataset.projectId : linked?.id ?? selected;
    const index = ordered.findIndex((project) => project.id === current);
    if (event.key === "Enter") {
      if (index >= 0) { event.preventDefault(); void openProject(ordered[index]); }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    // Home/End in the search field still move the text caret.
    if (target instanceof HTMLInputElement && (event.key === "Home" || event.key === "End")) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? ordered.length - 1
      : Math.max(0, Math.min(ordered.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
    const project = ordered[next];
    dispatch({ type: "select", id: project.id });
    const button = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-project-id]"))
      .find((element) => element.dataset.projectId === project.id);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView?.({ block: "nearest" });
  };

  const renderProject = (project: OverleafProject, chosen: boolean) => {
    const copy = props.onOpenLocalCopy ? localCopies[project.id] : undefined;
    return (
    <li key={project.id} className={rowClassName("store", `overleaf-project-row${chosen ? " selected" : ""}`)}>
      <button type="button" className="overleaf-project-main" data-project-id={project.id} data-local={copy ? "" : undefined} aria-pressed={chosen} disabled={working} onClick={() => dispatch({ type: "select", id: project.id })}>
        <span className="overleaf-project-icon" aria-hidden="true"><FileText size={15} /></span>
        <span className="overleaf-project-name">
          {project.name}
          {project.trashed
            ? <Badge size="compact">{t`Trashed`}</Badge>
            : project.archived ? <Badge size="compact">{t`Archived`}</Badge> : null}
        </span>
        <span className="overleaf-project-meta">
          {joinPhrases([project.ownerName || project.ownerEmail || t`Unknown owner`,
            project.lastUpdated ? t`updated ${relativeTime(project.lastUpdated)}` : t`last update unknown`])}
        </span>
        {copy && (
          <span className="overleaf-project-local" title={copy.path}>
            <HardDrive size={11} aria-hidden="true" />
            <span>{t`Opens your local copy at ${copy.display}`}</span>
          </span>
        )}
      </button>
      {/* A download in progress is said once, by the progress line under the list. */}
      {chosen && cloning?.id !== project.id && (
        <MotionButton
          className={buttonClassName({ variant: "tinted", size: "compact", className: "overleaf-open-button" })}
          disabled={working}
          onClick={() => void openProject(project)}
        >
          {t`Open`}
        </MotionButton>
      )}
    </li>
    );
  };

  const openInvitation = (invite: OverleafInvite) => {
    dispatch({ type: "invitationOpened" });
    void openUrl(invite.url);
  };
  const renderInvite = (invite: OverleafInvite) => (
    <li key={invite.projectId} className={rowClassName("store", "overleaf-project-row overleaf-invite-row")}>
      <span className="overleaf-project-main">
        <span className="overleaf-project-icon" aria-hidden="true"><MailOpen size={15} /></span>
        <span className="overleaf-project-name">
          {invite.projectName}
          <Badge size="compact">{t`Invitation`}</Badge>
        </span>
        <span className="overleaf-project-meta">
          {invite.inviterName
            ? t`${invite.inviterName} invited you. Accept on Overleaf to open it here`
            : t`Accept the invitation on Overleaf to open it here`}
        </span>
      </span>
      <Button size="compact" variant="ghost" disabled={working} onClick={() => openInvitation(invite)}>
        <ExternalLink size={13} /> {t`Open invitation`}
      </Button>
    </li>
  );
  const invitations = invites.length > 0 && (
    <section className="overleaf-project-group" aria-label={t`Invitations`}>
      <h3>
        {t`Invitations`}
        {invitationOpened && (
          <ReloadButton size="compact" variant="ghost" busy={projectsLoading} disabled={projectsLoading} onClick={() => void loadProjects()}>
            {t`Reload list`}
          </ReloadButton>
        )}
      </h3>
      <ul className="overleaf-project-list">{invites.map(renderInvite)}</ul>
    </section>
  );
  const account = known?.email ?? known?.name ?? t`This Overleaf account`;
  const pastedStage = link && (
    pasted.error ? (
      <StageMessage glyph={<CloudOff size={20} />} tone="danger">
        <RetryRow error={pasted.error} busy={pasted.checking} label={t`Retry`} onRetry={pasted.retry} />
      </StageMessage>
    ) : pasted.checking || !pasted.answer ? (
      <ProjectSkeleton message={t`Looking up this link on Overleaf…`} />
    ) : pasted.answer.kind === "project" ? (
      <ScrollArea className="overleaf-project-list-scroll" orientation="vertical" viewportProps={{ "aria-label": t`Overleaf projects` }}>
        <ul className="overleaf-project-list">{renderProject(pasted.answer.project, true)}</ul>
      </ScrollArea>
    ) : (
      <PastedLinkMessage answer={pasted.answer} account={account} host={known?.host ?? ""} />
    )
  );
  const hasRows = visible.length > 0 || invites.length > 0;

  return (
    <ModalDialog
      label={t`Open from Overleaf`}
      closeDisabled={transferring}
      onClose={onClose}
    >
      <div className="modal modal-large overleaf-picker-modal" onKeyDown={navigateProjects}>
      <PanelHeader
        className="overleaf-picker-header"
        icon={<Cloud size={22} />}
        title={t`Open from Overleaf`}
        closeDisabled={transferring}
        closeTooltip={transferring ? t`You can close this once the transfer finishes` : undefined}
        onClose={onClose}
      />
      {known?.connected && (
        <div className="overleaf-picker-lede">
          <p className="overleaf-picker-account">{known.email ?? known.name ?? known.host}</p>
        </div>
      )}
      <div className="overleaf-picker-body">
        {transferError && <InlineMessage level="error" className="overleaf-transfer-error">{transferError}</InlineMessage>}
        {statusLoading && !statusError && (
          <>
            <ProjectControlsSkeleton />
            <div className="overleaf-stage"><ProjectSkeleton message={t`Checking your Overleaf connection…`} /></div>
          </>
        )}
        {statusError && (
          <div className="overleaf-stage">
            <StageMessage glyph={<CloudOff size={20} />} tone="danger">
              <RetryRow error={statusError} busy={statusLoading} label={t`Retry`} onRetry={() => void loadStatus()} />
            </StageMessage>
          </div>
        )}
        {known && !known.connected && (
          <div className="overleaf-stage" data-plain="">
            <StageMessage glyph={known.expired && <CloudAlert size={20} />} tone="warning">
              {known.expired && <p className="overleaf-stage-text">{t`Your Overleaf session expired`}</p>}
              <LoginControls
                login={login}
                label={known.expired ? t`Reconnect to Overleaf` : t`Connect to Overleaf`}
                hint={t`You sign in on Overleaf. Lattice never sees your password.`}
              />
            </StageMessage>
          </div>
        )}
        {known?.connected && (
          <>
            <div className="overleaf-picker-controls">
              <SearchField
                aria-label={t`Search Overleaf projects`}
                containerClassName="overleaf-search"
                clearLabel={t`Clear search`}
                placeholder={t`Search by project or owner, or paste a link…`}
                autoFocus
                {...compositionProps}
                value={search}
                disabled={working}
                onChange={(event) => dispatch({ type: "search", search: event.target.value })}
                onPaste={pasted.retry}
                onClear={() => dispatch({ type: "search", search: "" })}
              />
              <CheckboxField
                className="overleaf-checkbox"
                checked={showArchived}
                disabled={working}
                label={t`Show archived`}
                onChange={(event) => dispatch({ type: "showArchived", showArchived: event.target.checked })}
              />
            </div>
            <div className="overleaf-stage" data-list={link ? (linked ? "" : undefined) : !projectsError && hasRows ? "" : undefined}>
              {pastedStage}
              {!link && projectsError && (
                <StageMessage glyph={<CloudOff size={20} />} tone="danger">
                  <RetryRow error={projectsError} busy={projectsLoading} label={t`Retry`} onRetry={() => void loadProjects()} />
                </StageMessage>
              )}
              {!link && !projectsError && projects === null && (
                <ProjectSkeleton message={t`Loading your Overleaf projects…`} />
              )}
              {!link && !projectsError && projects !== null && !hasRows && (
                <StageMessage glyph={projects.length === 0 ? <FileText size={20} /> : <SearchX size={20} />} tone="neutral">
                  <p className="overleaf-empty">
                    {projects.length === 0
                      ? t`No projects in this account yet`
                      : query
                        ? t`No projects match your search`
                        : t`All your projects are archived or trashed`}
                  </p>
                </StageMessage>
              )}
              {!link && !projectsError && hasRows && (
                <ScrollArea
                  className="overleaf-project-list-scroll"
                  orientation="vertical"
                  viewportProps={{ "aria-label": t`Overleaf projects` }}
                >
                  {invitations}
                  {visible.length > 0 && (
                    <section className="overleaf-project-group">
                      {invitations && <h3>{t`Projects`}</h3>}
                      <ul className="overleaf-project-list">{recent.map((project) => renderProject(project, selected === project.id))}</ul>
                    </section>
                  )}
                </ScrollArea>
              )}
            </div>
            {props.currentProject && props.onPublish && (
              <section className="overleaf-publish-card">
                <div className="overleaf-publish-head">
                  <Glyph tone="neutral"><UploadCloud size={15} /></Glyph>
                  <div className="overleaf-publish-copy">
                    <strong>{t`Upload this project to Overleaf`}</strong>
                  </div>
                </div>
                <div className="overleaf-publish-actions">
                  <Input
                    aria-label={t`New Overleaf project name`}
                    value={publishName}
                    disabled={working}
                    onChange={(event) => dispatch({ type: "publishName", name: event.target.value })}
                    onKeyDown={(event) => { if (event.key === "Enter") void publish(); }}
                  />
                  <MotionButton
                    className={buttonClassName({ variant: "primary" })}
                    disabled={working || !publishName.trim()}
                    onClick={() => void publish()}
                  >
                    {publishing ? <InfinityLoader size={13} /> : <Cloud size={14} />}
                    {publishing ? t`Uploading…` : t`Upload and connect`}
                  </MotionButton>
                </div>
              </section>
            )}
            {cloning && downloaded ? (
              <OverleafDownloadBar name={cloning.name} track={downloaded} />
            ) : working && (
              <Progress
                className="overleaf-progress"
                text={opening ? openingText(opening.name) : t`Uploading ${publishName.trim()}…`}
              />
            )}
          </>
        )}
      </div>
      </div>
    </ModalDialog>
  );
}
