import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { BuildResult, ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { diagnosticsFingerprint, missingTexDependencyFile, sortDiagnostics, type CompileDiagnostic } from "../build/compile-diagnostics";
import { isMissingTexBuildError } from "../build/tex-setup";
import { pdfBytesFingerprint, pdfBytesToObjectUrl } from "../pdf/pdf-bytes";
import { scheduleFirstPage } from "../project/first-pages";
import { logAction } from "../telemetry/app-notify";
import { diagnosticInvoke } from "../telemetry/diagnostic-request";
import { playInterfaceSound } from "../telemetry/interface-sounds";
import { clearTimer, restartTimer, subscribeTauriEvent, useRefState } from "./effect-helpers";
import { listenInThisWindow } from "./window-events";
import { showError, showNotice } from "./notify";
import type { AgentCompileAssociation } from "./use-agent-checkpoints";
import type { LivePreviewBuildHooks } from "../live-preview/use-live-preview";
import { BUILD_OPERATION } from "../telemetry/app-log-export";
import { adoptRootDocument } from "./adopt-root-document";
import { buildOutcome, rejectedBuildOutcome, type BuildOutcome } from "./build-outcome";
import { BUILD_PROGRESS_EVENT, createProgressStore, type BuildProgressEvent } from "./build-progress";
import { NO_COMPILED_SOURCES, readCompiledSources, type CompiledSources } from "./compiled-sources";
import { createQuietBuilds } from "../live-preview/quiet-builds";
import type { BuildPreferences } from "../settings/app-settings";
import { createWatchedBuilds } from "./watched-builds";

export type { BuildOutcome } from "./build-outcome";
export type { BuildProgressStore } from "./build-progress";

type BuildOptions = {
  immediatePreview?: boolean;
  requested?: boolean;
  sound?: boolean;
  consumeAgentAssociations?: boolean;
  /** Autosave asked: it waits for a pause while the live preview is live (quiet-builds.ts). */
  automatic?: boolean;
  /** Runs without the Build button's spinner or the PDF's "Updating…" (quiet-builds.ts). */
  quiet?: boolean;
};

/** A build asked for while another runs; `force: null` means nothing is queued. */
type QueuedBuild = { force: boolean | null; sound: boolean; consumeAgentAssociations: boolean };
const IDLE_QUEUE: QueuedBuild = { force: null, sound: false, consumeAgentAssociations: false };

type Ref<T> = { readonly current: T };

/** The live preview's name for the files a build read, and whether it ran quietly. */
type LiveBase = { token: number | null; quiet: boolean };

/** The build that holds the pipeline: settles once it and every pass it took from the queue are done. */
type RunningBuild = { settled: Promise<void>; revision: number };

/**
 * Delete LaTeX auxiliary files while `cleaning` is held; false when it failed.
 * No confirmation: every file it removes is one the next build writes again.
 */
async function cleanAuxiliaryFiles(setCleaning: (cleaning: boolean) => void): Promise<boolean> {
  setCleaning(true);
  try {
    await invoke("clean_project");
    return true;
  } catch (reason) {
    showError(toMessage(reason));
    return false;
  } finally {
    setCleaning(false);
  }
}

/**
 * LaTeX builds and the PDF preview they feed: one build at a time with later
 * requests coalesced into a single queued pass, the debounced preview, the
 * diagnostics panel's dismissal state, and cleaning auxiliary files.
 */
export function useBuildPipeline({
  project, projectRef, setProject, projectGenerationRef,
  activeFileRef, sourceRef, savedSourceRef,
  agent, openDiagnosticRef, onMissingTex, livePreview, autoBuildModeRef,
}: {
  project: ProjectSnapshot | null;
  projectRef: Ref<ProjectSnapshot | null>;
  setProject: Dispatch<SetStateAction<ProjectSnapshot | null>>;
  projectGenerationRef: Ref<number>;
  activeFileRef: Ref<string>;
  sourceRef: Ref<string>;
  savedSourceRef: Ref<string>;
  agent: {
    takePendingCompiles: () => AgentCompileAssociation[];
    reportCompiles: (associations: AgentCompileAssociation[], result: BuildResult | null) => void;
  };
  openDiagnosticRef: Ref<(diagnostic: CompileDiagnostic) => Promise<void>>;
  onMissingTex: () => void;
  /**
   * The LuaLaTeX live preview while it runs: told what each build compiled,
   * so it stops painting edits once the PDF on screen holds them.
   */
  livePreview?: Ref<LivePreviewBuildHooks | null>;
  autoBuildModeRef: Ref<BuildPreferences["autoBuildMode"]>;
}) {
  const { t } = useLingui();
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [outcome, setOutcome] = useState<BuildOutcome | null>(null);
  const [building, , buildingRef, setBuilding] = useRefState(false);
  const [quiet, , quietRef, setQuiet] = useRefState(false);
  const [quietBuilds] = useState(createQuietBuilds);
  useEffect(() => quietBuilds.cancel, [quietBuilds]);
  const [watchedBuilds] = useState(createWatchedBuilds);
  const [progress] = useState(createProgressStore);
  /** Names each pass to the backend, which tags its progress with it; a late report from an earlier pass is not this one's. */
  const progressIdRef = useRef(0);
  const queueRef = useRef<QueuedBuild>({ ...IDLE_QUEUE });
  const [cleaning, setCleaning] = useState(false);
  /** The text each build compiled, so diagnostics only show against the text they describe. */
  const [compiledSources, setCompiledSources] = useState<CompiledSources>(NO_COMPILED_SOURCES);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [diagnosticsDismissed, setDiagnosticsDismissed] = useState(false);
  /** Fingerprint of the diagnostics the reader last dismissed, so an unchanged
   *  set stays dismissed through the recompiles that autosave keeps firing. */
  const dismissedDiagnosticsRef = useRef<string | null>(null);
  const diagnosticCursorRef = useRef<{ build: BuildResult | null; index: number }>({ build: null, index: 0 });

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const pdfFingerprintRef = useRef<string | null>(null);
  const displayedPdfBytesRef = useRef<ArrayBuffer | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  /** Stable preview payload — debounced so automatic rebuilds do not thrash pdf.js. */
  const pendingPreviewRef = useRef<ArrayBuffer | null>(null);
  /** The live preview's name for the files the pending payload was built from, and whether a quiet build made it. */
  const pendingLiveRef = useRef<LiveBase>({ token: null, quiet: false });
  /** Bumped when leaving a project so a late build cannot revive a stale PDF. */
  const previewGenerationRef = useRef(0);

  /**
   * Which project inputs the PDF and its SyncTeX map were compiled from.
   * Every change a build could compile — the app's own saves, and whatever
   * else the watcher sees change besides the build's output — bumps the input
   * revision; a pass that writes the PDF records the revision it started at
   * and the document it compiled. SyncTeX answers in the lines it compiled,
   * so a jump from the editor needs the two to agree: one saved but unbuilt
   * edit moves every line below it, and the jump lands on another passage.
   */
  const inputRevisionRef = useRef(0);
  const compiledRef = useRef<{ revision: number; rootDocument: string | null } | null>(null);
  /** The last compiled PDF read from disk, so a failed pass can tell whether it wrote a new one. */
  const readPdfFingerprintRef = useRef<string | null>(null);
  const runningBuildRef = useRef<RunningBuild | null>(null);

  /** A project input changed through the app; `paths` are the files it wrote. */
  const markInputsChanged = useCallback((paths: readonly string[] = []) => {
    inputRevisionRef.current += 1;
    livePreview?.current?.noteSaved();
    watchedBuilds.saved(paths);
  }, [livePreview, watchedBuilds]);

  /** Whether the compiled PDF is of the project's current inputs and root document. */
  const compiledIsCurrent = useCallback(() => {
    const compiled = compiledRef.current;
    if (!compiled || compiled.revision !== inputRevisionRef.current) return false;
    const rootDocument = projectRef.current?.manifest.rootDocuments.find((document) => document.isDefault)?.path;
    return !rootDocument || !compiled.rootDocument || rootDocument === compiled.rootDocument;
  }, [projectRef]);

  const replacePdfUrl = useCallback((nextUrl: string | null) => setPdfUrl((previous) => {
    if (previous) URL.revokeObjectURL(previous);
    return nextUrl;
  }), []);

  const showPreview = useCallback((bytes: ArrayBuffer, previewGeneration: number, immediate: boolean, live: LiveBase) => {
    // LaTeX rewrites PDF metadata on every compile, so bytes almost always
    // change. Debounce preview updates for autosave compiles so pdf.js is
    // not destroyed mid-load on every keystroke pause.
    pendingPreviewRef.current = bytes;
    pendingLiveRef.current = live;
    clearTimer(previewTimerRef);
    const applyPreview = () => {
      const pending = pendingPreviewRef.current;
      if (previewGeneration !== previewGenerationRef.current || !pending) return;
      const fingerprint = pdfBytesFingerprint(pending);
      pendingPreviewRef.current = null;
      const { token, quiet } = pendingLiveRef.current;
      // The same pages as on screen: they hold what this build compiled now.
      if (fingerprint === pdfFingerprintRef.current) {
        livePreview?.current?.baseShown(token);
        return;
      }
      pdfFingerprintRef.current = fingerprint;
      displayedPdfBytesRef.current = pending;
      livePreview?.current?.baseLoading(token, quiet);
      replacePdfUrl(pdfBytesToObjectUrl(pending));
    };
    if (immediate) applyPreview();
    else restartTimer(previewTimerRef, 1_200, applyPreview);
  }, [livePreview, replacePdfUrl]);

  /**
   * Drop the outgoing project's build and preview, invalidating any in-flight
   * one *before* the incoming project's first build starts (starting first
   * used to race the preview and wipe a just-loaded PDF → endless “Rendering
   * PDF…”). A project usually already has a compiled PDF on disk; with
   * `showCachedPdf` it is shown while latexmk checks for changes.
   */
  const resetForProject = useCallback((projectRoot: string) => {
    setBuild(null);
    setOutcome(null);
    // A PDF already on disk was compiled from inputs this session never saw.
    compiledRef.current = null;
    inputRevisionRef.current += 1;
    watchedBuilds.reset();
    quietBuilds.cancel();
    readPdfFingerprintRef.current = null;
    const generation = ++previewGenerationRef.current;
    pdfFingerprintRef.current = null;
    displayedPdfBytesRef.current = null;
    pendingPreviewRef.current = null;
    clearTimer(previewTimerRef);
    replacePdfUrl(null);
    const current = (fingerprint: string | null) => generation === previewGenerationRef.current
      && projectRef.current?.root === projectRoot
      && pdfFingerprintRef.current === fingerprint;
    void invoke<ArrayBuffer>("read_compiled_pdf", { projectRoot })
      .then((pdfBytes) => {
        if (!current(null)) return;
        const fingerprint = pdfBytesFingerprint(pdfBytes);
        const nextUrl = pdfBytesToObjectUrl(pdfBytes);
        pdfFingerprintRef.current = fingerprint;
        if (readPdfFingerprintRef.current === null) readPdfFingerprintRef.current = fingerprint;
        displayedPdfBytesRef.current = pdfBytes;
        setPdfUrl((previous) => {
          if (!current(fingerprint)) {
            URL.revokeObjectURL(nextUrl);
            return previous;
          }
          if (previous) URL.revokeObjectURL(previous);
          return nextUrl;
        });
      })
      .catch(() => {
        // A new or cleaned project has no cached PDF; the initial build
        // remains the source of its first preview.
      });
  }, [projectRef, quietBuilds, replacePdfUrl, watchedBuilds]);

  /** Forget queued work; `cancelQueuedBuild` also drops a queued pass itself. */
  const resetQueue = useCallback((cancelQueuedBuild: boolean) => {
    if (cancelQueuedBuild) Object.assign(queueRef.current, IDLE_QUEUE);
    else queueRef.current.consumeAgentAssociations = false;
  }, []);

  useEffect(() => subscribeTauriEvent<BuildProgressEvent>(
    (deliver) => listenInThisWindow(BUILD_PROGRESS_EVENT, deliver),
    ({ projectRoot: root, progressId, elapsedMs, steps }) => {
      if (progressId !== progressIdRef.current || root !== projectRef.current?.root || !buildingRef.current) return;
      progress.set({ steps, startedAt: performance.now() - elapsedMs });
    },
  ), [buildingRef, progress, projectRef]);

  const { takePendingCompiles, reportCompiles } = agent;
  const runBuild = useCallback(async function runBuild(force = false, options?: BuildOptions) {
    if (options?.automatic && quietBuilds.defer()) return;
    const queue = queueRef.current;
    // A project with no LaTeX document has nothing to compile. Autosave, a
    // synctex jump and opening the project all reach here, and each of them
    // turned a folder of Markdown notes into a red "Build failed" the reader
    // never asked for. Someone pressing Build still gets told what to add.
    // A compilable .tex open in the editor overrides the empty manifest: the
    // backend adopts it as the root document (Overleaf's rule), so a folder
    // of notes that just gained its first real document builds on the spot.
    const activeLooksCompilable = activeFileRef.current.toLowerCase().endsWith(".tex")
      && sourceRef.current.includes("\\documentclass");
    if (!projectRef.current?.manifest.rootDocuments.length && !activeLooksCompilable) {
      if (options?.consumeAgentAssociations) reportCompiles(takePendingCompiles(), null);
      if (options?.requested) {
        showError(
          t`This project has no LaTeX document to build yet. Add a .tex file, or set one as the root document in project settings.`,
          t`Build`,
        );
      }
      return;
    }
    if (!options?.quiet) quietBuilds.cancel();
    // A build asked for any other way shows, and so does the quiet one it waits on.
    if (!options?.quiet || !buildingRef.current) setQuiet(options?.quiet === true);
    if (buildingRef.current) {
      queue.force = (queue.force ?? false) || force;
      queue.sound ||= options?.sound === true;
      queue.consumeAgentAssociations ||= options?.consumeAgentAssociations === true;
      return;
    }
    setBuilding(true);
    let settle = () => {};
    const running: RunningBuild = {
      settled: new Promise<void>((resolve) => { settle = resolve; }),
      revision: inputRevisionRef.current,
    };
    runningBuildRef.current = running;
    // The spinner stands in while this runs; whatever the previous build
    // reported must not come back if no pass of this one gets to report.
    if (!quietRef.current) setOutcome(null);
    // One action name for both variants, so a clean rebuild that succeeds still
    // retracts the ordinary build's failure toast; "clean" lives in the detail.
    let trace = logAction(t`Build`, t`Build`, force ? t`clean rebuild` : undefined, BUILD_OPERATION);
    let buildScope: { operationGeneration: number; previewGeneration: number; projectRoot: string } | null = null;
    const scopeIsCurrent = () => Boolean(buildScope
      && projectGenerationRef.current === buildScope.operationGeneration
      && previewGenerationRef.current === buildScope.previewGeneration
      && projectRef.current?.root === buildScope.projectRoot);
    let shouldPlayCompletionSound = options?.sound === true;
    // Only explicit UI builds opt into sound (even when audio is muted).
    // Background failures must not steal the caret while an edit is unfinished.
    let shouldNavigateToError = options?.sound === true;
    let shouldConsumeAgentAssociations = options?.consumeAgentAssociations === true;
    let completionSound: "success" | "error" | null = null;
    // Nothing is queued while no build runs (`force` is only set behind the lock), so this clears flags alone.
    Object.assign(queue, IDLE_QUEUE);
    try {
      let currentForce = force;
      const takeQueuedBuild = () => {
        if (queue.force === null) return false;
        trace.finish("cancelled", t`Build superseded`);
        trace = logAction(t`Build`, t`Build`, queue.force ? t`clean rebuild` : t`queued`, BUILD_OPERATION);
        currentForce = queue.force;
        shouldPlayCompletionSound ||= queue.sound;
        shouldNavigateToError = queue.sound;
        shouldConsumeAgentAssociations = queue.consumeAgentAssociations;
        Object.assign(queue, IDLE_QUEUE);
        return true;
      };
      do {
        // Associate only work present at the start of this pass. A checkpoint
        // arriving during an in-flight build remains pending for the queued
        // pass, rather than being credited to stale output.
        const agentCompileAssociations = shouldConsumeAgentAssociations ? takePendingCompiles() : [];
        const immediatePreview = options?.immediatePreview ?? currentForce;
        const previewGeneration = previewGenerationRef.current;
        const projectRoot = projectRef.current?.root;
        if (!projectRoot) continue;
        buildScope = { operationGeneration: projectGenerationRef.current, previewGeneration, projectRoot };
        // latexmk reads the inputs after this; a change landing meanwhile
        // leaves the pass's PDF behind it, as it should.
        const revisionAtBuild = inputRevisionRef.current;
        running.revision = revisionAtBuild;
        watchedBuilds.passStarted();
        const liveAtBuild = { token: livePreview?.current?.buildStarted(quietRef.current) ?? null, quiet: quietRef.current };
        const sourceAtBuild = sourceRef.current;
        const fileAtBuild = activeFileRef.current;
        // The open file rides along so the backend can re-target the build on
        // it when it is a compilable root — recomputed each pass because a
        // queued rebuild may run after the editor moved to another document.
        const documentPath = activeFileRef.current.toLowerCase().endsWith(".tex") ? activeFileRef.current : null;
        // Each pass starts its sequence afresh; the backend fills it in as latexmk runs.
        const progressId = ++progressIdRef.current;
        progress.set({ steps: [], startedAt: performance.now() });
        // A failure after the project moved on belongs to nobody: the pass is simply skipped.
        const result = await diagnosticInvoke<BuildResult>(
          "build_project", { force: currentForce, projectRoot, documentPath, progressId }, { operationId: trace.id },
        ).catch((reason) => {
          if (!scopeIsCurrent()) return null;
          compiledRef.current = null;
          reportCompiles(agentCompileAssociations, null);
          throw reason;
        });
        if (!result || !scopeIsCurrent()) continue;
        reportCompiles(agentCompileAssociations, result);
        trace.enrich({
          force: currentForce,
          compiler_duration_ms: result.durationMs,
          diagnostics: result.diagnostics.length,
          has_pdf: result.hasPdf,
        });
        const project = projectRef.current;
        const [pdfBytes, sources] = await Promise.all([
          result.hasPdf ? invoke<ArrayBuffer>("read_compiled_pdf", { projectRoot }).catch((reason) => {
            if (scopeIsCurrent()) throw reason;
            return null;
          }) : null,
          project ? readCompiledSources(project, result.diagnostics, fileAtBuild, sourceAtBuild) : NO_COMPILED_SOURCES,
        ]);
        if (!scopeIsCurrent()) continue;
        setBuild(result);
        watchedBuilds.passWrote(result.outputs);
        // A stopped build comes back as a failed result carrying the
        // build-cancelled advice. The writer asked for that; it is not an error.
        const cancelled = result.diagnostics.some((item) => item.code === "build-cancelled");
        // LaTeX carries on past most errors, so a failed pass that wrote a
        // new PDF still compiled these inputs. One that left the previous PDF
        // in place (or was stopped partway) did not, and its SyncTeX map
        // cannot be trusted either.
        const fingerprint = pdfBytes ? pdfBytesFingerprint(pdfBytes) : null;
        const wrotePdf = fingerprint !== null && !cancelled
          && (result.success || fingerprint !== readPdfFingerprintRef.current);
        if (fingerprint !== null) readPdfFingerprintRef.current = fingerprint;
        compiledRef.current = wrotePdf ? { revision: revisionAtBuild, rootDocument: result.rootDocument || null } : null;
        setOutcome(buildOutcome(result, cancelled, quietRef.current, wrotePdf));
        const { rootDocument } = result;
        if (rootDocument) {
          setProject((current) => current?.root === projectRoot ? adoptRootDocument(current, rootDocument) : current);
        }
        // The backend switched the project to pdfLaTeX on its own and says so
        // in this note (latex/engine_mismatch.rs); Settings shows the engine too.
        const switchedEngine = result.diagnostics.some((item) => item.code === "engine-switched");
        if (switchedEngine) {
          setProject((current) => current?.root === projectRoot
            ? { ...current, manifest: { ...current.manifest, engine: "pdf" } }
            : current);
        }
        setCompiledSources(sources);
        // Reopening the panel is for news. Autosave rebuilds after every pause
        // in typing, and reopening unconditionally meant a warning the writer
        // had chosen to live with returned seconds after they dismissed it, for
        // as long as they kept writing. A failed build they explicitly
        // requested is different: reopening its result is the acknowledgement
        // that Build did run.
        setDiagnosticsDismissed(
          (result.success || !shouldPlayCompletionSound)
            && diagnosticsFingerprint(result.diagnostics) === dismissedDiagnosticsRef.current,
        );
        // A switch the writer did not ask for is shown open, with its undo, and
        // so is CJK text the PDF dropped: the build succeeded, the page did not.
        setDiagnosticsExpanded(!result.success || switchedEngine || result.diagnostics.some((item) => item.level === "error" || item.code === "cjk-glyphs-missing"));
        // The welcome screen's desk shows each recent project by its first page.
        if (pdfBytes && wrotePdf) scheduleFirstPage(projectRoot, pdfBytes, result.venue ?? null);
        // The debounce exists so a slow pdf.js load is not torn down by the
        // next rebuild while someone is still typing. Once they have stopped —
        // the buffer matches what is on disk — waiting is just the PDF lagging.
        if (pdfBytes) showPreview(pdfBytes, previewGeneration, immediatePreview || sourceRef.current === savedSourceRef.current, liveAtBuild);
        if (!result.success) {
          const firstError = result.diagnostics.find((item) => missingTexDependencyFile(item.message))
            ?? result.diagnostics.find((item) => item.level === "error")
            ?? result.diagnostics[0]
            ?? null;
          const navigationError = result.diagnostics.find((item) => (
            item.level === "error" && Boolean(item.file || item.line)
          )) ?? firstError;
          if (shouldNavigateToError && navigationError) void openDiagnosticRef.current(navigationError);
          trace.fail(t`LaTeX compilation failed.`, {
            detail: firstError?.message ?? "",
            copyText: [result.log, ...result.diagnostics.map((item) => item.message)].join("\n"),
            // The diagnostics panel already owns this failure on screen and
            // includes the message, full log, navigation, copy, and package
            // install action. Keep the action trace without showing it twice.
            toast: false,
          });
          completionSound = "error";
          // A raw latexmk log contains its own name and uses "not found" for
          // every missing project file. Only parsed tool diagnostics may open
          // system setup; the full log is evidence for diagnostics and logs,
          // not a machine-readable failure category.
          if (result.diagnostics.some((item) => isMissingTexBuildError(item.message))) onMissingTex();
        } else {
          // A rebuild that succeeds retracts the previous failure instead of
          // leaving it on screen to time out on its own.
          trace.clear();
          const seconds = (result.durationMs / 1000).toFixed(1);
          trace.finish("success", t`Build succeeded in ${seconds} s`);
          completionSound = "success";
        }
      } while (takeQueuedBuild());
    } catch (reason) {
      if (scopeIsCurrent()) {
        compiledRef.current = null;
        trace.fail(reason, { timeoutMs: shouldPlayCompletionSound ? 0 : undefined });
        setOutcome(rejectedBuildOutcome());
        completionSound = "error";
        if (isMissingTexBuildError(toMessage(reason))) onMissingTex();
      }
    } finally {
      trace.finish("cancelled", t`Build superseded`);
      const queued = queue.force === null ? null : { ...queue, force: queue.force };
      Object.assign(queue, IDLE_QUEUE);
      setBuilding(false);
      setQuiet(false);
      livePreview?.current?.buildFinished();
      progress.set(null);
      runningBuildRef.current = null;
      settle();
      watchedBuilds.idle();
      if (shouldPlayCompletionSound && completionSound && scopeIsCurrent()) playInterfaceSound(completionSound);
      // A backend rejection skips the loop's takeQueuedBuild() condition. Start
      // the captured pass only after releasing the in-flight lock, and only if
      // its immutable project scope still owns the active root.
      if (queued && scopeIsCurrent()) {
        void runBuild(queued.force, { ...queued, immediatePreview: options?.immediatePreview ?? queued.force });
      }
    }
  }, [
    activeFileRef, buildingRef, livePreview, onMissingTex, openDiagnosticRef, progress, projectGenerationRef, projectRef,
    quietBuilds, quietRef, reportCompiles, savedSourceRef, setBuilding, setProject, setQuiet, showPreview, sourceRef, t,
    takePendingCompiles, watchedBuilds,
  ]);
  // Everything else that changes an input — the agent, a terminal, an
  // Overleaf pull, a rename in the tree, another editor — reaches the project
  // through the watcher, and builds on its own like an autosave (watched-builds.ts).
  const projectRoot = project?.root;
  useEffect(() => projectRoot ? watchedBuilds.watch(projectRoot, {
    rootDocuments: () => projectRef.current?.manifest.rootDocuments.map((document) => document.path) ?? [],
    inputsChanged: () => { inputRevisionRef.current += 1; },
    automatic: () => autoBuildModeRef.current === "automatic",
    building: () => buildingRef.current,
    build: () => void runBuild(false, { automatic: true }),
  }) : undefined, [autoBuildModeRef, buildingRef, projectRef, projectRoot, runBuild, watchedBuilds]);
  useEffect(() => quietBuilds.connect({
    livePreview, activeFileRef, sourceRef, savedSourceRef, run: (quiet) => void runBuild(false, { quiet }),
  }), [activeFileRef, livePreview, quietBuilds, runBuild, savedSourceRef, sourceRef]);

  /**
   * Make the compiled PDF, and the SyncTeX map beside it, those of the
   * project as it is now: build when an input changed since, or wait for the
   * build already running (queueing one more pass when it started before the
   * change). False when no build got there — one failed without writing a
   * PDF, or was stopped — so a jump never lands through an older map.
   */
  const ensureCompiled = useCallback(async (): Promise<boolean> => {
    // Inputs that keep changing under the build get a few passes, not a loop.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (compiledIsCurrent()) return true;
      const running = runningBuildRef.current;
      if (running && running.revision === inputRevisionRef.current) {
        await running.settled;
      } else {
        // With a build running, this only queues the pass it takes next.
        const requested = runBuild(false, { immediatePreview: true });
        await (running?.settled ?? requested);
      }
      if (!compiledRef.current) return false;
    }
    return compiledIsCurrent();
  }, [compiledIsCurrent, runBuild]);

  const abortBuild = useCallback(async () => {
    if (!buildingRef.current) return;
    await invoke<boolean>("abort_build").catch((reason) => showError(toMessage(reason)));
  }, [buildingRef]);

  const cleanProject = useCallback(async () => {
    if (!project || cleaning || building) return;
    if (await cleanAuxiliaryFiles(setCleaning)) showNotice(t`Build files cleaned`, t`Build`);
  }, [building, cleaning, project, t]);

  const cleanAndRebuild = useCallback(async () => {
    if (!project || cleaning) return;
    // The active build owns the backend until it settles. Preserve the clean
    // rebuild intent in its queue rather than cleaning files out from under it.
    if (buildingRef.current || await cleanAuxiliaryFiles(setCleaning)) {
      await runBuild(true, { requested: true, sound: true });
    }
  }, [buildingRef, cleaning, project, runBuild]);

  const dismissDiagnostics = useCallback((diagnostics: CompileDiagnostic[]) => {
    dismissedDiagnosticsRef.current = diagnosticsFingerprint(diagnostics);
    setDiagnosticsDismissed(true);
  }, []);

  /**
   * Step to the next or previous diagnostic of the current build in the order
   * the panel lists them, wrapping. A new build restarts the walk at its first
   * diagnostic (or its last, stepping back).
   */
  const cycleDiagnostic = useCallback((direction: 1 | -1) => {
    const diagnostics = sortDiagnostics(build?.diagnostics ?? []);
    if (!diagnostics.length) return;
    const walking = diagnosticCursorRef.current.build === build;
    const next = walking
      ? (diagnosticCursorRef.current.index + direction + diagnostics.length) % diagnostics.length
      : direction === 1 ? 0 : diagnostics.length - 1;
    diagnosticCursorRef.current = { build, index: next };
    void openDiagnosticRef.current(diagnostics[next]);
  }, [build, openDiagnosticRef]);

  // One object for as long as its members hold still: App hands it to the
  // compiled titlebar, which re-rendered its build controls on every keystroke
  // while this was a fresh literal per render.
  return useMemo(() => ({
    build,
    setBuild,
    /** A build the writer sees running: a quiet one is not (quiet-builds.ts). */
    building: building && !quiet,
    progress,
    outcome,
    cleaning,
    compiledSources,
    diagnosticsExpanded,
    setDiagnosticsExpanded,
    diagnosticsDismissed,
    dismissDiagnostics,
    cycleDiagnostic,
    pdfUrl,
    displayedPdfBytesRef,
    resetForProject,
    resetQueue,
    runBuild,
    markInputsChanged,
    ensureCompiled,
    abortBuild,
    cleanProject,
    cleanAndRebuild,
  }), [
    abortBuild, build, building, progress, outcome, cleanAndRebuild, cleanProject, cleaning, compiledSources, cycleDiagnostic,
    diagnosticsDismissed, diagnosticsExpanded, dismissDiagnostics, ensureCompiled, markInputsChanged, pdfUrl, quiet,
    resetForProject, resetQueue, runBuild,
  ]);
}
