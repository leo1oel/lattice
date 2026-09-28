import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { BuildResult, ProjectSnapshot } from "../app-types";
import { confirmAction, toMessage } from "../app-utils";
import { diagnosticsFingerprint, missingTexDependencyFile, type CompileDiagnostic } from "../build/compile-diagnostics";
import { isMissingTexBuildError } from "../build/tex-setup";
import { pdfBytesFingerprint, pdfBytesToObjectUrl } from "../pdf/pdf-bytes";
import { logAction } from "../telemetry/app-notify";
import { diagnosticInvoke } from "../telemetry/diagnostic-request";
import { playInterfaceSound } from "../telemetry/interface-sounds";
import { clearTimer, restartTimer, useRefState } from "./effect-helpers";
import { setError } from "./notify";
import type { AgentCompileAssociation } from "./use-agent-checkpoints";

type BuildOptions = {
  immediatePreview?: boolean;
  requested?: boolean;
  sound?: boolean;
  consumeAgentAssociations?: boolean;
};

/** A build asked for while another runs; `force: null` means nothing is queued. */
type QueuedBuild = { force: boolean | null; sound: boolean; consumeAgentAssociations: boolean };
const IDLE_QUEUE: QueuedBuild = { force: null, sound: false, consumeAgentAssociations: false };

type Ref<T> = { readonly current: T };

/**
 * Adopt the root document the backend built. It may have promoted the open
 * file to the manifest default (Overleaf's rule); mirroring that locally keeps
 * the outline and the next build's guard in agreement without a re-read.
 */
function adoptRootDocument(project: ProjectSnapshot, rootDocument: string): ProjectSnapshot {
  const documents = project.manifest.rootDocuments;
  if (documents.some((document) => document.isDefault && document.path === rootDocument)) return project;
  const rootDocuments = documents.map((document) => ({ ...document, isDefault: document.path === rootDocument }));
  if (!documents.some((document) => document.path === rootDocument)) {
    const stem = rootDocument.split("/").pop()?.replace(/\.tex$/i, "");
    rootDocuments.push({ path: rootDocument, name: stem || rootDocument, isDefault: true });
  }
  return { ...project, manifest: { ...project.manifest, rootDocuments } };
}

/** Ask, then delete LaTeX auxiliary files while `cleaning` is held; false when declined or failed. */
async function cleanAuxiliaryFiles(question: string, setCleaning: (cleaning: boolean) => void): Promise<boolean> {
  if (!await confirmAction(question)) return false;
  setCleaning(true);
  try {
    await invoke("clean_project");
    return true;
  } catch (reason) {
    setError(toMessage(reason));
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
  activeFileRef, sourceRef, savedSourceRef, secondarySourceRef,
  agent, openDiagnosticRef, onMissingTex,
}: {
  project: ProjectSnapshot | null;
  projectRef: Ref<ProjectSnapshot | null>;
  setProject: Dispatch<SetStateAction<ProjectSnapshot | null>>;
  projectGenerationRef: Ref<number>;
  activeFileRef: Ref<string>;
  sourceRef: Ref<string>;
  savedSourceRef: Ref<string>;
  secondarySourceRef: Ref<string>;
  agent: {
    takePendingCompiles: () => AgentCompileAssociation[];
    reportCompiles: (associations: AgentCompileAssociation[], result: BuildResult | null) => void;
  };
  openDiagnosticRef: Ref<(diagnostic: CompileDiagnostic) => Promise<void>>;
  onMissingTex: () => void;
}) {
  const { t } = useLingui();
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [building, , buildingRef, setBuilding] = useRefState(false);
  const queueRef = useRef<QueuedBuild>({ ...IDLE_QUEUE });
  const [cleaning, setCleaning] = useState(false);
  /** The buffers each build compiled, so diagnostics only show against the text they describe. */
  const [compiledSources, setCompiledSources] = useState({ primary: "", secondary: "" });
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
  /** Bumped when leaving a project so a late build cannot revive a stale PDF. */
  const previewGenerationRef = useRef(0);

  const replacePdfUrl = useCallback((nextUrl: string | null) => setPdfUrl((previous) => {
    if (previous) URL.revokeObjectURL(previous);
    return nextUrl;
  }), []);

  const showPreview = useCallback((bytes: ArrayBuffer, previewGeneration: number, immediate: boolean) => {
    // LaTeX rewrites PDF metadata on every compile, so bytes almost always
    // change. Debounce preview updates for autosave compiles so pdf.js is
    // not destroyed mid-load on every keystroke pause.
    pendingPreviewRef.current = bytes;
    clearTimer(previewTimerRef);
    const applyPreview = () => {
      const pending = pendingPreviewRef.current;
      if (previewGeneration !== previewGenerationRef.current || !pending) return;
      const fingerprint = pdfBytesFingerprint(pending);
      pendingPreviewRef.current = null;
      if (fingerprint === pdfFingerprintRef.current) return;
      pdfFingerprintRef.current = fingerprint;
      displayedPdfBytesRef.current = pending;
      replacePdfUrl(pdfBytesToObjectUrl(pending));
    };
    if (immediate) applyPreview();
    else restartTimer(previewTimerRef, 1_200, applyPreview);
  }, [replacePdfUrl]);

  /**
   * Drop the outgoing project's build and preview, invalidating any in-flight
   * one *before* the incoming project's first build starts (starting first
   * used to race the preview and wipe a just-loaded PDF → endless “Rendering
   * PDF…”). A project usually already has a compiled PDF on disk; with
   * `showCachedPdf` it is shown while latexmk checks for changes.
   */
  const resetForProject = useCallback((projectRoot: string) => {
    setBuild(null);
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
  }, [projectRef, replacePdfUrl]);

  /** Forget queued work; `cancelQueuedBuild` also drops a queued pass itself. */
  const resetQueue = useCallback((cancelQueuedBuild: boolean) => {
    if (cancelQueuedBuild) Object.assign(queueRef.current, IDLE_QUEUE);
    else queueRef.current.consumeAgentAssociations = false;
  }, []);

  const { takePendingCompiles, reportCompiles } = agent;
  const runBuild = useCallback(async function runBuild(force = false, options?: BuildOptions) {
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
        setError(
          "This project has no LaTeX document to build yet. Add a .tex file, or set one as the root document in project settings.",
          "Build",
        );
      }
      return;
    }
    if (buildingRef.current) {
      queue.force = (queue.force ?? false) || force;
      queue.sound ||= options?.sound === true;
      queue.consumeAgentAssociations ||= options?.consumeAgentAssociations === true;
      return;
    }
    setBuilding(true);
    // One action name for both variants, so a clean rebuild that succeeds still
    // retracts the ordinary build's failure toast; "clean" lives in the detail.
    let trace = logAction("Build", "Build", force ? "clean rebuild" : undefined);
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
    let completionSound: "build-succeeded" | "build-failed" | null = null;
    // Nothing is queued while no build runs (`force` is only set behind the lock), so this clears flags alone.
    Object.assign(queue, IDLE_QUEUE);
    try {
      let currentForce = force;
      const takeQueuedBuild = () => {
        if (queue.force === null) return false;
        trace.finish("cancelled", t`Build superseded`);
        trace = logAction("Build", "Build", queue.force ? "clean rebuild" : "queued");
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
        const compiledSource = sourceRef.current;
        const compiledSecondarySource = secondarySourceRef.current;
        // The open file rides along so the backend can re-target the build on
        // it when it is a compilable root — recomputed each pass because a
        // queued rebuild may run after the editor moved to another document.
        const documentPath = activeFileRef.current.toLowerCase().endsWith(".tex") ? activeFileRef.current : null;
        // A failure after the project moved on belongs to nobody: the pass is simply skipped.
        const result = await diagnosticInvoke<BuildResult>(
          "build_project", { force: currentForce, projectRoot, documentPath }, { operationId: trace.id },
        ).catch((reason) => {
          if (!scopeIsCurrent()) return null;
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
        const pdfBytes = result.hasPdf ? await invoke<ArrayBuffer>("read_compiled_pdf", { projectRoot }).catch((reason) => {
          if (scopeIsCurrent()) throw reason;
          return null;
        }) : null;
        if (!scopeIsCurrent()) continue;
        setBuild(result);
        const { rootDocument } = result;
        if (rootDocument) {
          setProject((current) => current?.root === projectRoot ? adoptRootDocument(current, rootDocument) : current);
        }
        setCompiledSources({ primary: compiledSource, secondary: compiledSecondarySource });
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
        setDiagnosticsExpanded(!result.success || result.diagnostics.some((item) => item.level === "error"));
        // The debounce exists so a slow pdf.js load is not torn down by the
        // next rebuild while someone is still typing. Once they have stopped —
        // the buffer matches what is on disk — waiting is just the PDF lagging.
        if (pdfBytes) showPreview(pdfBytes, previewGeneration, immediatePreview || sourceRef.current === savedSourceRef.current);
        if (!result.success) {
          const firstError = result.diagnostics.find((item) => missingTexDependencyFile(item.message))
            ?? result.diagnostics.find((item) => item.level === "error")
            ?? result.diagnostics[0]
            ?? null;
          const navigationError = result.diagnostics.find((item) => (
            item.level === "error" && Boolean(item.file || item.line)
          )) ?? firstError;
          if (shouldNavigateToError && navigationError) void openDiagnosticRef.current(navigationError);
          trace.fail("LaTeX compilation failed.", {
            detail: firstError?.message ?? "",
            copyText: [result.log, ...result.diagnostics.map((item) => item.message)].join("\n"),
            // The diagnostics panel already owns this failure on screen and
            // includes the message, full log, navigation, copy, and package
            // install action. Keep the action trace without showing it twice.
            toast: false,
          });
          completionSound = "build-failed";
          // A raw latexmk log contains its own name and uses "not found" for
          // every missing project file. Only parsed tool diagnostics may open
          // system setup; the full log is evidence for diagnostics and logs,
          // not a machine-readable failure category.
          if (result.diagnostics.some((item) => isMissingTexBuildError(item.message))) onMissingTex();
        } else {
          // A rebuild that succeeds retracts the previous failure instead of
          // leaving it on screen to time out on its own.
          trace.clear();
          trace.finish("success", `Build succeeded in ${(result.durationMs / 1000).toFixed(1)}s`);
          completionSound = "build-succeeded";
        }
      } while (takeQueuedBuild());
    } catch (reason) {
      if (scopeIsCurrent()) {
        trace.fail(reason, { timeoutMs: shouldPlayCompletionSound ? 0 : undefined });
        completionSound = "build-failed";
        if (isMissingTexBuildError(toMessage(reason))) onMissingTex();
      }
    } finally {
      trace.finish("cancelled", t`Build superseded`);
      const queued = queue.force === null ? null : { ...queue, force: queue.force };
      Object.assign(queue, IDLE_QUEUE);
      setBuilding(false);
      if (shouldPlayCompletionSound && completionSound && scopeIsCurrent()) playInterfaceSound(completionSound);
      // A backend rejection skips the loop's takeQueuedBuild() condition. Start
      // the captured pass only after releasing the in-flight lock, and only if
      // its immutable project scope still owns the active root.
      if (queued && scopeIsCurrent()) {
        void runBuild(queued.force, { ...queued, immediatePreview: options?.immediatePreview ?? queued.force });
      }
    }
  }, [
    activeFileRef, buildingRef, onMissingTex, openDiagnosticRef, projectGenerationRef, projectRef, reportCompiles,
    savedSourceRef, secondarySourceRef, setBuilding, setProject, showPreview, sourceRef, t, takePendingCompiles,
  ]);

  const abortBuild = useCallback(async () => {
    if (!buildingRef.current) return;
    await invoke<boolean>("abort_build").catch((reason) => setError(toMessage(reason)));
  }, [buildingRef]);

  const cleanProject = useCallback(async () => {
    if (!project || cleaning || building) return;
    await cleanAuxiliaryFiles("Delete LaTeX auxiliary files (`.aux`, `.log`, `.bbl`, …) from this project?", setCleaning);
  }, [building, cleaning, project]);

  const cleanAndRebuild = useCallback(async () => {
    if (!project || cleaning) return;
    // The active build owns the backend until it settles. Preserve the clean
    // rebuild intent in its queue rather than cleaning files out from under it.
    if (buildingRef.current || await cleanAuxiliaryFiles("Delete auxiliary files and rebuild the PDF?", setCleaning)) {
      await runBuild(true, { requested: true, sound: true });
    }
  }, [buildingRef, cleaning, project, runBuild]);

  const dismissDiagnostics = useCallback((diagnostics: CompileDiagnostic[]) => {
    dismissedDiagnosticsRef.current = diagnosticsFingerprint(diagnostics);
    setDiagnosticsDismissed(true);
  }, []);

  /** Step to the next or previous diagnostic of the current build, wrapping; a new build restarts the walk. */
  const cycleDiagnostic = useCallback((direction: 1 | -1) => {
    const diagnostics = build?.diagnostics ?? [];
    if (!diagnostics.length) return;
    const cursor = diagnosticCursorRef.current.build === build ? diagnosticCursorRef.current.index : 0;
    const next = (cursor + direction + diagnostics.length * 10) % diagnostics.length;
    diagnosticCursorRef.current = { build, index: next };
    void openDiagnosticRef.current(diagnostics[next]);
  }, [build, openDiagnosticRef]);

  // One object for as long as its members hold still: App hands it to the
  // compiled titlebar, which re-rendered its build controls on every keystroke
  // while this was a fresh literal per render.
  return useMemo(() => ({
    build,
    setBuild,
    building,
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
    abortBuild,
    cleanProject,
    cleanAndRebuild,
  }), [
    abortBuild, build, building, cleanAndRebuild, cleanProject, cleaning, compiledSources, cycleDiagnostic,
    diagnosticsDismissed, diagnosticsExpanded, dismissDiagnostics, pdfUrl, resetForProject, resetQueue, runBuild,
  ]);
}
export type BuildPipeline = ReturnType<typeof useBuildPipeline>;
