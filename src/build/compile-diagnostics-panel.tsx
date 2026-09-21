import { useState } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleHelp,
  LoaderCircle,
  Square,
  WandSparkles,
  ScrollText,
} from "lucide-react";
import { CopyButton } from "../components/copy-button";
import { Button } from "../components/ui/button";
import { CloseButton, IconButton } from "../components/ui/icon-button";
import { EmptyState } from "../components/ui/empty-state";
import {
  diagnosticLocationLabel,
  diagnosticSeverity,
  missingTexDependencyFile,
  sortDiagnostics,
  summarizeDiagnostics,
  type CompileDiagnostic,
} from "./compile-diagnostics";
import { SlidingTabs } from "../components/ui/motion";
import type { CompileRepairState } from "./use-compile-repair";

function SeverityIcon({ level }: { level: string }) {
  const severity = diagnosticSeverity(level);
  // Errors and warnings share the glyph; the status colour carries severity.
  if (severity === "error" || severity === "warning") return <CircleAlert size={15} />;
  return <CircleHelp size={15} />;
}

export function CompileDiagnosticsPanel(props: {
  diagnostics: CompileDiagnostic[];
  log: string;
  success: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSelect: (diagnostic: CompileDiagnostic) => void;
  onInstallDependency: (missingFile: string) => void;
  onFixAll?: () => void;
  fixDisabled?: boolean;
  repair?: CompileRepairState | null;
  onCancelRepair?: () => void;
  onOpenRepair?: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  const diagnostics = sortDiagnostics(props.diagnostics);
  const summary = summarizeDiagnostics(diagnostics);
  const tone = summary.error > 0 || !props.success ? "error" : summary.warning > 0 ? "warning" : "info";
  const parts = [
    summary.error ? `${summary.error} error${summary.error === 1 ? "" : "s"}` : "",
    summary.warning ? `${summary.warning} warning${summary.warning === 1 ? "" : "s"}` : "",
    summary.info ? `${summary.info} note${summary.info === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const hasLog = Boolean(props.log.trim());
  const [tab, setTab] = useState<"diagnostics" | "log">(diagnostics.length ? "diagnostics" : "log");
  if (props.success && !diagnostics.length && !props.repair) return null;
  const title = parts.join(" · ") || (props.success ? "Build notes" : "Build failed");
  const busy = props.repair && !["completed", "failed"].includes(props.repair.status);
  const progress = props.repair?.status === "compiling" ? t`Recompiling…`
    : props.repair?.status === "awaiting-approval" ? t`Needs approval` : t`Repairing…`;

  return (
    <section className={`compile-diagnostics ${tone}`} aria-label="Compile diagnostics">
      <div className="compile-diagnostics-bar">
        <button
          className="compile-diagnostics-toggle"
          aria-expanded={props.expanded}
          onClick={() => props.onExpandedChange(!props.expanded)}
        >
          <SeverityIcon level={tone} />
          <span>{title}</span>
          {props.expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {busy ? (
          <div className="compile-repair-progress" role="status" aria-live="polite">
            <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
            <span>{progress}</span>
            {props.repair?.status !== "compiling" && props.onCancelRepair && (
              <IconButton label={t`Cancel repair`} size="compact" onClick={props.onCancelRepair}><Square size={11} /></IconButton>
            )}
          </div>
        ) : (summary.error + summary.warning > 0 && props.onFixAll) && (
          <Button variant="ghost" size="compact" className="compile-repair-action" disabled={props.fixDisabled}
            title={t`Fix all errors and warnings, then recompile`} onClick={props.onFixAll}>
            <WandSparkles size={13} />{t`Fix all`}
          </Button>
        )}
        <CloseButton
          label="Dismiss diagnostics"
          size="compact"
          onClick={props.onDismiss}
        />
      </div>
      {(props.repair?.message || props.repair?.status === "awaiting-approval") && (
        <p className="compile-repair-detail" role="status">{props.repair.message ?? t`Open the repair task to continue.`}</p>
      )}
      {props.expanded && (
        <div className="compile-diagnostics-body">
          {(diagnostics.length > 0 && hasLog) && (
            <SlidingTabs
              value={tab}
              onChange={(next) => setTab(next as "diagnostics" | "log")}
              ariaLabel="Build output"
              className="compile-diagnostics-tabs"
              items={[
                { value: "diagnostics", label: "Messages" },
                { value: "log", label: <><ScrollText size={12} /> Log</> },
              ]}
            />
          )}
          {(tab === "diagnostics" || !hasLog) && diagnostics.length > 0 && (
            <ul className="compile-diagnostics-list">
              {diagnostics.map((diagnostic, index) => {
                const severity = diagnosticSeverity(diagnostic.level);
                const navigable = Boolean(diagnostic.file || diagnostic.line);
                const key = `${severity}-${diagnostic.file ?? ""}-${diagnostic.line ?? ""}-${index}`;
                const copyText = `${diagnosticLocationLabel(diagnostic)} ${diagnostic.message}`;
                const missingFile = missingTexDependencyFile(diagnostic.message);
                return (
                  <li key={key}>
                    <button
                      className={`compile-diagnostic-item ${severity}`}
                      disabled={!navigable}
                      onClick={() => props.onSelect(diagnostic)}
                      title={navigable ? "Jump to this location" : diagnostic.message}
                    >
                      <SeverityIcon level={diagnostic.level} />
                      <span className="compile-diagnostic-location">{diagnosticLocationLabel(diagnostic)}</span>
                      <span className="compile-diagnostic-message">{diagnostic.message}</span>
                    </button>
                    {missingFile && (
                      <Button
                        variant="ghost"
                        size="compact"
                        title={`Find and install the TeX Live package for ${missingFile}`}
                        onClick={() => props.onInstallDependency(missingFile)}
                      >
                        Install
                      </Button>
                    )}
                    <CopyButton
                      className="compile-diagnostic-copy"
                      aria-label="Copy error message"
                      title="Copy error message"
                      iconSize={12}
                      text={copyText}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {(tab === "log" || !diagnostics.length) && hasLog && (
            <pre className="compile-log" aria-label="Raw build log">{props.log}</pre>
          )}
          {!props.success && !diagnostics.length && !hasLog && (
            <EmptyState
              align="start"
              density="compact"
              description="Build failed without a captured log"
            />
          )}
        </div>
      )}
      {props.repair?.threadId && props.onOpenRepair && (
        <div className="compile-repair-footer">
          {props.repair.status === "completed" && <span role="status">{t`Repair finished`}</span>}
          <Button variant="ghost" size="compact" onClick={props.onOpenRepair}>{t`View repair`}</Button>
        </div>
      )}
    </section>
  );
}
