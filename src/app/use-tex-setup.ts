import { useCallback, useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { DoctorReport } from "../app-types";
import { toMessage } from "../app-utils";
import type { TexDependencyInstallStatus } from "../build/tex-dependency-installer";
import {
  isCompileSetupMissing,
  isOnlyPaperToolsMissing,
  isRequiredSetupMissing,
  texDependencyInstallFailure,
  type TexDependencyInstallProgress,
} from "../build/tex-setup";
import { deferPaperTools, hasDeferredPaperTools } from "../settings/app-settings";
import { logAction, notifyError, notifySuccess } from "../telemetry/app-notify";
import { useRefState, whenIdle } from "./effect-helpers";
import { useLatestRef } from "../hooks/use-latest-ref";

/**
 * The TeX toolchain check ("doctor"), the setup wizard it opens when a
 * required tool is missing, and on-demand installs of single LaTeX packages a
 * build reported missing. `rebuild` runs after a package install succeeds.
 *
 * Missing TeX or conference fonts hold the app in the wizard: nothing compiles
 * without them. Missing paper tools alone do not: launch asks once, "Install
 * later" is remembered, and the first paper feature that needs them reopens it.
 */
export function useTexSetup(rebuild: () => void) {
  const { t } = useLingui();
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [doctorNotice, setDoctorNotice] = useState("");
  const doctorGenerationRef = useRef(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  // The wizard is open because a paper feature just failed without the tools.
  const [paperToolsNeeded, setPaperToolsNeeded] = useState(false);
  const [install, , installRef, publishInstall] = useRefState<TexDependencyInstallStatus | null>(null);
  const installAttemptRef = useRef(0);
  const rebuildRef = useLatestRef(rebuild);

  // Idle-deferred: run_doctor shells out to probe the TeX toolchain, and
  // nothing needs its report during first paint. The timeout keeps the setup
  // wizard appearing within a few seconds on a missing toolchain.
  useEffect(() => {
    // A perf-lab run measures the editor, not the toolchain probe and the
    // setup wizard it may open over the window.
    if (import.meta.env.VITE_PERF_LAB === "1" && window.__latticeLab) return;
    const cancel = whenIdle(() => {
      const generation = ++doctorGenerationRef.current;
      void invoke<DoctorReport>("run_doctor")
        .then((report) => {
          if (generation !== doctorGenerationRef.current) return;
          setDoctorReport(report);
          if (isCompileSetupMissing(report) || (isOnlyPaperToolsMissing(report) && !hasDeferredPaperTools())) {
            setWizardOpen(true);
          }
        })
        .catch(() => {
          // Tests and incomplete environments may not expose doctor.
        });
    }, 4_000, 1_000);
    return () => {
      doctorGenerationRef.current += 1;
      cancel();
    };
  }, []);

  const runDoctor = useCallback(async (options?: { openWizardIfMissing?: boolean; reportFailure?: boolean }) => {
    const generation = ++doctorGenerationRef.current;
    setDoctorBusy(true);
    setDoctorNotice("");
    try {
      const report = await invoke<DoctorReport>("run_doctor");
      if (generation !== doctorGenerationRef.current) return null;
      setDoctorReport(report);
      if (options?.openWizardIfMissing && isRequiredSetupMissing(report)) setWizardOpen(true);
      return report;
    } catch (reason) {
      if (generation === doctorGenerationRef.current) {
        setDoctorNotice(toMessage(reason));
        if (options?.reportFailure) notifyError(t`LaTeX setup`, t`Couldn’t check the LaTeX tools`, { detail: toMessage(reason) });
      }
      return null;
    } finally {
      if (generation === doctorGenerationRef.current) setDoctorBusy(false);
    }
  }, [t]);

  // Asked for by name (the welcome screen, the palette, Settings), so it
  // always looks again — tools may have arrived since the launch check — and
  // always answers: the wizard when something is missing, a toast when
  // nothing is. A report that already knows something is missing opens the
  // wizard at once and rechecks under it.
  const openWizard = useCallback(async () => {
    if (isRequiredSetupMissing(doctorReport)) setWizardOpen(true);
    const report = await runDoctor({ openWizardIfMissing: true, reportFailure: true });
    if (report && !isRequiredSetupMissing(report)) {
      notifySuccess(t`LaTeX setup`, t`LaTeX is ready to build`, { detail: t`Every tool Lattice needs is installed` });
    }
  }, [doctorReport, runDoctor, t]);

  /**
   * A paper feature failed because the paper tools are missing: offer the
   * install over it, however launch went. The report may predate the failure,
   * so it is checked again; with nothing to install, the failure stands.
   */
  const openForMissingPaperTools = useCallback(async (failure: string) => {
    setPaperToolsNeeded(true);
    if (isOnlyPaperToolsMissing(doctorReport)) setWizardOpen(true);
    const report = await runDoctor({ openWizardIfMissing: true });
    if (!report || !isRequiredSetupMissing(report)) {
      setPaperToolsNeeded(false);
      notifyError(t`LaTeX setup`, t`Couldn’t start the paper tools`, { detail: failure });
    }
  }, [doctorReport, runDoctor, t]);

  // Closing over missing paper tools alone is "Install later": launch stops
  // asking. Closing after an install, or over anything else, is not.
  const closeWizard = useCallback(() => {
    if (isOnlyPaperToolsMissing(doctorReport)) deferPaperTools();
    setWizardOpen(false);
    setPaperToolsNeeded(false);
  }, [doctorReport]);

  /** A build found no TeX toolchain: drop the stale report and show setup. */
  const openForMissingTex = useCallback(() => {
    doctorGenerationRef.current += 1;
    setDoctorReport(null);
    setDoctorBusy(false);
    setWizardOpen(true);
  }, []);

  const installDependency = useCallback((missingFile: string) => {
    if (installRef.current?.installing) return;
    const attempt = ++installAttemptRef.current;
    publishInstall({
      missingFile,
      progress: { stage: "searching-packages", progress: 0 },
      installing: true,
      error: null,
    });
    const trace = logAction(t`LaTeX setup`, t`Install missing package`, missingFile);
    const update = (change: Partial<TexDependencyInstallStatus>) => {
      const current = installRef.current;
      if (current && installAttemptRef.current === attempt) publishInstall({ ...current, ...change });
    };
    const onProgress = new Channel<TexDependencyInstallProgress>();
    onProgress.onmessage = (progress) => update({ progress });
    void invoke("start_tex_dependency_install", { missingFile, onProgress })
      .then(() => {
        if (installAttemptRef.current !== attempt) return;
        installAttemptRef.current += 1;
        publishInstall(null);
        trace.ok(t`LaTeX package installed`, { detail: missingFile });
        rebuildRef.current();
      })
      .catch((reason) => {
        const error = toMessage(reason);
        const { summary, detail } = texDependencyInstallFailure(error);
        update({ installing: false, error });
        trace.fail(reason, { detail: [summary, detail].filter(Boolean).join("\n") });
      });
  }, [installRef, publishInstall, rebuildRef, t]);

  const closeInstall = useCallback(() => {
    if (installRef.current?.installing) return;
    installAttemptRef.current += 1;
    publishInstall(null);
  }, [installRef, publishInstall]);

  return {
    doctorReport,
    doctorBusy,
    doctorNotice,
    runDoctor,
    wizardOpen,
    paperToolsNeeded,
    closeWizard,
    openWizard,
    openForMissingTex,
    openForMissingPaperTools,
    install,
    installDependency,
    closeInstall,
  };
}

export type TexSetup = ReturnType<typeof useTexSetup>;
