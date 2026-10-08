import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { browserRuntimeDetached } from "../platform/browser-runtime";
import {
  forgetRecentProject, hasSeenTutorial, loadRecentProjects, markTutorialSeen, rememberRecentProject, type RecentProject,
} from "../settings/app-settings";
import type { CreateProjectForm } from "./app-project-dialogs";
import type { UnopenedProject } from "../project/project-dialogs";
import { showError, showNotice } from "./notify";
import type { useBuildPipeline } from "./use-build-pipeline";
import type { OpenDocuments } from "./use-open-documents";
import { requestBibliographyIndex, type useProjectLibrary } from "./use-project-library";
import { loadDocumentCanvas } from "./use-preview-prewarm";
import type { ProjectState } from "./use-project-state";
import { useLatestRef } from "../hooks/use-latest-ref";

/** How long a project switch waits for an in-flight Overleaf sync before giving up on it. */
const PROJECT_SWITCH_SYNC_WAIT_MS = 15_000;

// Must match the prefix `open_project_window` puts on a window-creation
// failure. Everything else it can fail with is the project itself.
// eslint-disable-next-line lingui/no-unlocalized-strings -- matched against the backend's error text
const NEW_WINDOW_FAILURE_PREFIX = "Could not open a new window";

const settleWithin = (work: Promise<unknown>) => Promise.race([
  work,
  new Promise<void>((resolve) => window.setTimeout(resolve, PROJECT_SWITCH_SYNC_WAIT_MS)),
]);

/** Why {@link saveEveryEdit} stopped, or "saved" once every open edit is on disk. */
export type SaveEveryEditOutcome = "saved" | "composing" | "failed" | "changed";

/**
 * Publish and durably save every open edit before this surface lets go of its
 * project: a project switch, or another surface taking the workspace. Only
 * "saved" means letting go loses nothing. An unfinished IME composition
 * cannot be published yet, a failed save is reported where it happened, and
 * an edit typed while the save ran is still only in this page's memory.
 */
export async function saveEveryEdit({ flush, save, flushWholeFiles, hasUnsavedEdits }: {
  flush: () => boolean;
  save: () => Promise<boolean>;
  flushWholeFiles: () => Promise<void>;
  hasUnsavedEdits: () => boolean;
}): Promise<SaveEveryEditOutcome> {
  if (!flush()) return "composing";
  if (!(await save())) return "failed";
  await settleWithin(flushWholeFiles());
  return hasUnsavedEdits() ? "changed" : "saved";
}

export type ProjectLifecycleDeps = {
  projectState: ProjectState;
  documents: Pick<OpenDocuments, "claim" | "flush" | "save" | "hasUnsavedEdits" | "enter" | "chooseMode">;
  library: Pick<
    ReturnType<typeof useProjectLibrary>,
    "claimBibliographyRefresh" | "resetBibliographyIndex" | "applyBibliographyIndex" | "applyReferences" | "setPapers"
  >;
  build: Pick<ReturnType<typeof useBuildPipeline>, "runBuild" | "resetForProject">;
  /** Forget the outgoing project's agent compile associations (and, on a switch, its queued build). */
  resetCompileTracking: (cancelQueuedBuild: boolean) => void;
  cancelPrewarm: () => void;
  /**
   * The Overleaf sync gate: a sync must finish its disk refresh before a
   * switch, and the whole-file documents it deferred must reach Overleaf.
   */
  overleafSync: {
    syncingRef: RefObject<boolean>;
    settledRef: RefObject<Promise<void> | null>;
    flushWholeFilesRef: RefObject<() => Promise<void>>;
  };
  /** Put per-project panels back to their defaults, synchronously, as the new project is published. */
  resetProjectUi: () => void;
  /** The project's own scans, which run after its tabs are restored and before its Paper or asset surface opens. */
  scanProject: () => Promise<void>;
  /** Begin the guided tour, once the tutorial's sample project is open. */
  startTour: () => void;
  shellRef: RefObject<HTMLDivElement | null>;
  browserHosted: boolean;
};

/**
 * Which project this window shows, and every way of changing it: the startup
 * routing (the backend's project, else the most recent one, else the
 * tutorial on a first launch), opening, creating, importing and cloning
 * projects, the recent-projects list, and handing the workspace to a
 * browser tab and back.
 *
 * A switch is a transition with an order that matters: wait out an Overleaf
 * sync, publish and save every edit, flush deferred whole-file syncs, refuse
 * if anything changed meanwhile, then claim the backend root (which
 * invalidates work scoped to the old project) and enter the new one.
 */
export function useProjectLifecycle(deps: ProjectLifecycleDeps) {
  const { t } = useLingui();
  // The per-project resets and scans are App's closures; read the latest at entry time.
  const depsRef = useLatestRef(deps);
  const { projectState, documents, library, build, resetCompileTracking, cancelPrewarm, shellRef, browserHosted } = deps;
  const { syncingRef, settledRef, flushWholeFilesRef } = deps.overleafSync;
  const {
    project, setProject, projectRef, projectBeforeTransitionRef, beginTransition, cancelProjectTransition,
    captureProjectScope,
  } = projectState;
  const { claim, flush, save, hasUnsavedEdits, enter: enterDocuments, chooseMode } = documents;
  const { claimBibliographyRefresh, resetBibliographyIndex, applyBibliographyIndex, applyReferences, setPapers } = library;
  const { runBuild, resetForProject } = build;
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  /** The workspace is being handed to another surface: its editors stay read-only meanwhile. */
  const [movingWorkspace, setMovingWorkspace] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  // The projects to go back to, and the last one when launch could not
  // reopen it (with why), which the welcome screen names. One state rather
  // than two: every startup render of App pays for each hook here.
  const [recents, setRecents] = useState<{ projects: RecentProject[]; unopened: UnopenedProject | null }>(
    () => ({ projects: loadRecentProjects(), unopened: null }),
  );
  const autoTutorialAttemptedRef = useRef(false);

  // `name: null` is the untouched default, resolved per render so it follows the interface language.
  const [createFormState, setCreateForm] = useState<Omit<CreateProjectForm, "name"> & { name: string | null }>({
    open: false, error: null, name: null, venue: "neurips",
  });
  const defaultProjectName = t`Untitled research`;
  const createForm = useMemo<CreateProjectForm>(
    () => ({ ...createFormState, name: createFormState.name ?? defaultProjectName }),
    [createFormState, defaultProjectName],
  );
  const updateCreateForm = useCallback((update: Partial<CreateProjectForm>) => {
    setCreateForm((form) => ({ ...form, error: null, ...update }));
  }, []);

  const beginProjectTransition = useCallback((force = false) => {
    // Let sync finish its disk refresh before attempting a switch. Cancelling
    // only its UI phase after a failed switch could leave newly pulled bytes
    // hidden behind an old editor buffer that later overwrites them.
    if (syncingRef.current && !force) return false;
    beginTransition();
    claim();
    resetCompileTracking(true);
    cancelPrewarm();
    return true;
  }, [beginTransition, cancelPrewarm, claim, resetCompileTracking, syncingRef]);

  /**
   * Claim the right to switch projects, waiting out an Overleaf sync rather
   * than refusing.
   *
   * A sync must finish its disk refresh before a switch — cancelling only its
   * UI phase could leave newly pulled bytes hidden behind an old editor buffer
   * that later overwrites them. But a linked project auto-syncs on open and
   * live mode re-syncs every few seconds, so simply rejecting the click meant
   * "open that project" often did nothing at all and had to be clicked again
   * with no way to tell when. Queueing behind the sync honors the same
   * constraint while making one click enough. The timeout is the escape hatch
   * for a sync that never settles: fall back to the old refusal rather than
   * leaving the window wedged.
   */
  const startProjectTransition = useCallback(async () => {
    if (syncingRef.current) {
      const settled = settledRef.current;
      if (settled) {
        showNotice(t`Finishing Overleaf sync, then switching…`, "Overleaf");
        await settleWithin(settled);
      }
    }
    // The editor stayed live while Overleaf settled, so publish and durably
    // save any edit (including a just-finished IME composition) made during
    // that wait before invalidating the outgoing project's ownership.
    const saved = await saveEveryEdit({ flush, save, flushWholeFiles: flushWholeFilesRef.current, hasUnsavedEdits });
    if (saved === "composing") showNotice(t`Finish the current text composition, then switch projects again.`);
    if (saved === "changed") showNotice(t`The document changed while saving. Save it, then switch projects again.`);
    if (saved !== "saved") return false;
    if (beginProjectTransition()) return true;
    showNotice(t`Overleaf sync is finishing. Try switching projects again in a moment.`, "Overleaf");
    return false;
  }, [beginProjectTransition, flush, flushWholeFilesRef, hasUnsavedEdits, save, settledRef, syncingRef, t]);

  const rememberProject = useCallback((snapshot: ProjectSnapshot) => {
    setRecents((current) => ({ ...current, projects: rememberRecentProject({ name: snapshot.manifest.name, path: snapshot.root }) }));
  }, []);

  const enterProject = useCallback(async (
    snapshot: ProjectSnapshot,
    options?: { deferInitialBuild?: boolean },
  ) => {
    void loadDocumentCanvas();
    beginProjectTransition(true);
    // The backend already owns the incoming root. The outgoing documents go
    // before that root is exposed to effects (see the documents' enter).
    const entry = enterDocuments(snapshot);
    projectRef.current = snapshot;
    projectBeforeTransitionRef.current = null;
    setProject(snapshot);
    const ownsProject = captureProjectScope();
    rememberProject(snapshot);
    setProjectMenuOpen(false);
    depsRef.current.resetProjectUi();
    resetForProject(snapshot.root);
    // The startup reopen defers this build and starts its own once the
    // project is fully entered (see the recent-project auto-reopen below).
    if (!options?.deferInitialBuild) {
      void runBuild(false, { immediatePreview: true });
    }
    const isLatestBibliography = claimBibliographyRefresh();
    resetBibliographyIndex();
    const bibliographyIndex = requestBibliographyIndex();
    const nextPapers = await bibliographyIndex[0];
    if (!ownsProject()) return;
    // Opening a file cancels workspace restoration, not the project's paper
    // scan. Apply metadata before the restore's own guards, but do not
    // overwrite a newer bibliography refresh triggered by a save.
    // Only the papers decide what the restore opens. Citations and labels
    // feed completions and diagnostics, and the label scan of a long .tex
    // takes seconds (a 3.2 MB file: 10 s), so they land when ready instead
    // of holding the document back.
    if (isLatestBibliography()) setPapers(nextPapers);
    void Promise.all(bibliographyIndex).then((index) => {
      if (!ownsProject()) return;
      if (isLatestBibliography()) applyBibliographyIndex(index);
      else applyReferences(index[2]);
    }, () => undefined);
    if (!(await entry.restore(nextPapers))) return;
    await depsRef.current.scanProject();
    entry.finish();
    // Never animate shell opacity from 0 — a cancelled/interrupted tween leaves the
    // whole window blank white with the UI still "mounted".
    if (shellRef.current) shellRef.current.style.opacity = "1";
  }, [
    applyBibliographyIndex, applyReferences, beginProjectTransition, captureProjectScope, claimBibliographyRefresh,
    depsRef, enterDocuments, projectBeforeTransitionRef, projectRef, rememberProject, resetBibliographyIndex,
    resetForProject, runBuild, setPapers, setProject, shellRef,
  ]);
  const enterProjectRef = useLatestRef(enterProject);

  /// Hand a project to a window of its own, or raise the window already
  /// showing it. Returns the failure message so a caller that keeps a list of
  /// projects can decide whether the project is worth forgetting.
  const openProjectWindow = useCallback(async (path: string): Promise<string | null> => {
    setBusyLabel(t`Opening window…`);
    return invoke("open_project_window", { path })
      .then(() => null, (reason: unknown) => {
        const message = toMessage(reason);
        showError(message);
        return message;
      })
      .finally(() => setBusyLabel(null));
  }, [t]);

  /// Show a project that was just created, imported or cloned. A window in use
  /// keeps what it has and the project gets one of its own; an empty window
  /// takes it in place, claiming the switch first. The backend deliberately
  /// does not bind these on creation, so this is the only thing that decides
  /// where they land. `create` resolves the new project's root.
  const revealNewProject = useCallback(async (
    label: string,
    create: () => Promise<string>,
    onError?: (reason: unknown) => void,
  ) => {
    setBusyLabel(label);
    const openHere = !project?.root;
    await (async () => {
      if (openHere && !await startProjectTransition()) return;
      const root = await create();
      if (openHere) await enterProject(await invoke<ProjectSnapshot>("open_project", { path: root }));
      else await openProjectWindow(root);
    })().catch((reason: unknown) => {
      if (openHere) cancelProjectTransition();
      if (onError) onError(reason);
      else showError(toMessage(reason));
    }).finally(() => setBusyLabel(null));
  }, [cancelProjectTransition, enterProject, openProjectWindow, project?.root, startProjectTransition]);

  /// Replace this window's project with the one at `path`: save, claim the
  /// switch, enter; roll the claim back on failure.
  const switchProject = useCallback(async (label: string, path: string, onError?: () => void) => {
    setBusyLabel(label);
    await (async () => {
      if (!(await save()) || !await startProjectTransition()) return;
      await enterProject(await invoke<ProjectSnapshot>("open_project", { path }));
    })().catch((reason: unknown) => {
      cancelProjectTransition();
      onError?.();
      showError(toMessage(reason));
    }).finally(() => setBusyLabel(null));
  }, [cancelProjectTransition, enterProject, save, startProjectTransition]);

  const chooseExisting = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: t`Open a LaTeX project` });
    if (!selected) return;
    // Same rule as the recent-projects list: a window in use keeps the project
    // it has, and the chosen one gets a window of its own.
    if (project?.root) await openProjectWindow(String(selected));
    else await switchProject(t`Opening project…`, String(selected));
  }, [openProjectWindow, project?.root, switchProject, t]);

  const createProject = useCallback(async () => {
    if (!createForm.name.trim()) {
      updateCreateForm({ error: t`Enter a project name.` });
      return;
    }
    const parent = await open({ directory: true, multiple: false, title: t`Choose where to create the project` });
    if (!parent) return;
    await revealNewProject(t`Creating project…`, async () => {
      const snapshot = await invoke<ProjectSnapshot>("create_project", {
        parent, name: createForm.name, venue: createForm.venue,
      });
      updateCreateForm({ open: false });
      return snapshot.root;
    }, (reason) => updateCreateForm({ error: toMessage(reason) }));
  }, [createForm.name, createForm.venue, revealNewProject, updateCreateForm, t]);

  const openTutorialProject = useCallback(async () => {
    autoTutorialAttemptedRef.current = true;
    setBusyLabel(t`Preparing tutorial…`);
    const failed = () => {
      autoTutorialAttemptedRef.current = false;
      return false;
    };
    return (async () => {
      if (!(await save()) || !await startProjectTransition()) return failed();
      const snapshot = await invoke<ProjectSnapshot>("open_tutorial_project");
      await enterProject(snapshot);
      chooseMode("source");
      markTutorialSeen();
      depsRef.current.startTour();
      return true;
    })().catch((reason: unknown) => {
      cancelProjectTransition();
      showError(toMessage(reason));
      return failed();
    }).finally(() => setBusyLabel(null));
  }, [cancelProjectTransition, chooseMode, depsRef, enterProject, save, startProjectTransition, t]);

  // On launch, honor a project explicitly assigned to this window, otherwise
  // reopen the project the writer used last. A genuinely empty first launch
  // enters the tutorial directly; the welcome screen remains the fallback for
  // returning writers whose last folder was moved or deleted.
  //
  // Resolved by the boot effect below with whether the backend designated an
  // initial project. The auto-reopen must wait for that answer: both flows
  // funnel through enterProject, and whichever claims a project generation
  // last wins — since startProjectTransition became async, the recent-project
  // reopen could land after the backend's choice and silently clobber it.
  const [initialProjectProbe] = useState(() => {
    let resolve!: (result: "project" | "empty" | "failed") => void;
    const promise = new Promise<"project" | "empty" | "failed">((r) => { resolve = r; });
    return { promise, resolve };
  });
  const didRouteStartupRef = useRef(false);
  useEffect(() => {
    if (didRouteStartupRef.current) return;
    didRouteStartupRef.current = true;
    void (async () => {
      const initialProject = await initialProjectProbe.promise;
      if (initialProject !== "empty") return;
      const lastProject = loadRecentProjects()[0];
      const mostRecent = lastProject?.path;
      if (!mostRecent) {
        if (!hasSeenTutorial() && !autoTutorialAttemptedRef.current) {
          void openTutorialProject();
        }
        return;
      }
      try {
        if (!await startProjectTransition()) return;
        const snapshot = await invoke<ProjectSnapshot>("open_project", { path: mostRecent });
        // Defer enterProject's own initial build (it races cold-start init and
        // the PDF never appears), then kick one explicitly once the project is
        // fully entered.
        await enterProject(snapshot, { deferInitialBuild: true });
        void runBuild(false, { immediatePreview: true });
      } catch (reason) {
        cancelProjectTransition();
        // Folder gone, or on a drive that is not mounted: stay on the welcome
        // screen, which names it. It stays in the recent list, so the next
        // launch tries again.
        const unopened = { ...lastProject, reason: toMessage(reason) };
        setRecents((current) => ({ ...current, unopened }));
      }
    })();
  }, [
    cancelProjectTransition, enterProject, initialProjectProbe, openTutorialProject, runBuild,
    startProjectTransition,
  ]);

  useEffect(() => {
    let active = true;
    // Boot once. Depending on `enterProject` re-ran this whenever that callback
    // identity churned (after every build/load), which cleared the PDF and
    // restarted compile → endless “Rendering PDF…”.
    void invoke<ProjectSnapshot | null>("initial_project")
      .then(async (snapshot) => {
        initialProjectProbe.resolve(snapshot ? "project" : "empty");
        if (!active || !snapshot) return;
        await enterProjectRef.current(snapshot);
      })
      .catch((reason) => {
        initialProjectProbe.resolve("failed");
        if (active) showError(toMessage(reason));
      });
    return () => {
      active = false;
    };
    // Both are stable (a useState value and a ref) — listed to satisfy the
    // lint without changing the boot-once behavior.
  }, [enterProjectRef, initialProjectProbe]);

  const importOverleafZip = useCallback(async () => {
    const zipPath = await open({
      multiple: false,
      title: t`Import Overleaf ZIP`,
      filters: [{ name: t`ZIP archive`, extensions: ["zip"] }],
    });
    if (!zipPath) return;
    const parent = await open({
      directory: true,
      multiple: false,
      title: t`Choose where to extract the project`,
    });
    if (!parent) return;
    await revealNewProject(t`Importing ZIP…`, async () => (
      (await invoke<ProjectSnapshot>("import_project_zip", { zipPath, parent })).root
    ));
  }, [revealNewProject, t]);

  const exportProjectZip = useCallback(async () => {
    if (!project) return;
    const zipPath = await saveDialog({
      title: t`Export project ZIP`,
      defaultPath: `${project.manifest.name.replace(/[\\/:*?"<>|]+/g, "-") || t`project`}.zip`,
      filters: [{ name: t`ZIP archive`, extensions: ["zip"] }],
    });
    if (!zipPath) return;
    setBusyLabel(t`Exporting ZIP…`);
    await (async () => {
      if (!(await save())) return;
      await invoke("export_project_zip", { zipPath });
    })().catch((reason: unknown) => showError(toMessage(reason))).finally(() => setBusyLabel(null));
  }, [project, save, t]);

  const chooseRecentProject = useCallback(async (path: string) => {
    if (path === project?.root) {
      setProjectMenuOpen(false);
      return;
    }
    // Another project gets its own window once this one is in use. Replacing
    // the project in place would close editors, cancel a build and reset the
    // agent for work the writer never asked to put away. With nothing open yet
    // the window is empty, so it takes the project itself rather than leaving
    // a blank window behind.
    if (project?.root) {
      setProjectMenuOpen(false);
      const failure = await openProjectWindow(path);
      // Only the project itself failing means the entry is worth dropping; a
      // window that could not be created says nothing about the project.
      if (failure && !failure.startsWith(NEW_WINDOW_FAILURE_PREFIX)) {
        setRecents((current) => ({ ...current, projects: forgetRecentProject(path) }));
      }
      return;
    }
    await switchProject(t`Switching project…`, path, () => setRecents((current) => ({ ...current, projects: forgetRecentProject(path) })));
  }, [openProjectWindow, project?.root, switchProject, t]);

  // ---- Handing the workspace to a browser tab and back ------------------------------------------------------------
  useEffect(() => {
    if (!browserHosted) return;
    const saveBrowserPage = (event?: BeforeUnloadEvent) => {
      flush();
      if (!hasUnsavedEdits()) return;
      // Sending the invoke begins synchronously before the tab is discarded.
      // The confirmation keeps a just-typed buffer alive long enough for the
      // loopback write to finish instead of losing the last autosave interval.
      void save();
      if (event) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const pageHide = () => saveBrowserPage();
    window.addEventListener("beforeunload", saveBrowserPage);
    window.addEventListener("pagehide", pageHide);
    return () => {
      window.removeEventListener("beforeunload", saveBrowserPage);
      window.removeEventListener("pagehide", pageHide);
    };
  }, [browserHosted, flush, hasUnsavedEdits, save]);

  /** "Open in browser" from a Lattice window, "Open in Lattice app" from a browser tab. */
  const moveWorkspace = useCallback(async () => {
    if (browserHosted) {
      if (!await startProjectTransition()) return;
      setMovingWorkspace(true);
      const failure = await invoke("return_to_desktop").then(() => null, (reason: unknown) => reason);
      // Once the window has taken over, this page is detached and the
      // reply never arrives: that is the success case. A reply means the
      // workspace stayed in this tab.
      if (browserRuntimeDetached()) return;
      cancelProjectTransition();
      setMovingWorkspace(false);
      if (failure !== null) showError(toMessage(failure));
      return;
    }
    // A native window closes, and the tab starts relaying only once it
    // has, so the two never edit together. Claim the switch meanwhile.
    if (!await startProjectTransition()) return;
    setMovingWorkspace(true);
    try {
      await invoke("open_in_browser");
    } catch (reason) {
      cancelProjectTransition();
      setMovingWorkspace(false);
      showError(toMessage(reason));
      return;
    }
    await getCurrentWindow().close();
  }, [browserHosted, cancelProjectTransition, startProjectTransition]);

  return {
    busyLabel, recentProjects: recents.projects, unopenedProject: recents.unopened, projectMenuOpen, setProjectMenuOpen, createForm, updateCreateForm,
    startProjectTransition, cancelProjectTransition, revealNewProject, chooseExisting, createProject,
    chooseRecentProject, openTutorialProject, importOverleafZip, exportProjectZip, moveWorkspace,
    movingWorkspace,
  };
}
