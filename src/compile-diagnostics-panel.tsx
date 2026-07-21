import { useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleHelp,
  ScrollText,
  X,
} from "lucide-react";
import {
  diagnosticLocationLabel,
  diagnosticSeverity,
  sortDiagnostics,
  summarizeDiagnostics,
  type CompileDiagnostic,
} from "./compile-diagnostics";

function SeverityIcon({ level }: { level: string }) {
  const severity = diagnosticSeverity(level);
  if (severity === "error") return <CircleAlert size={15} />;
  if (severity === "warning") return <AlertTriangle size={15} />;
  return <CircleHelp size={15} />;
}

export function CompileDiagnosticsPanel(props: {
  diagnostics: CompileDiagnostic[];
  log: string;
  success: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSelect: (diagnostic: CompileDiagnostic) => void;
  onDismiss: () => void;
}) {
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
  if (props.success && !diagnostics.length) return null;
  if (!diagnostics.length && !hasLog && props.success) return null;
  const title = parts.join(" · ") || (props.success ? "Build notes" : "Build failed");

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
        <button title="Dismiss diagnostics" onClick={props.onDismiss}>
          <X size={13} />
        </button>
      </div>
      {props.expanded && (
        <div className="compile-diagnostics-body">
          {(diagnostics.length > 0 && hasLog) && (
            <div className="compile-diagnostics-tabs" role="tablist" aria-label="Build output">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "diagnostics"}
                className={tab === "diagnostics" ? "active" : ""}
                onClick={() => setTab("diagnostics")}
              >
                Messages
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "log"}
                className={tab === "log" ? "active" : ""}
                onClick={() => setTab("log")}
              >
                <ScrollText size={12} />
                Log
              </button>
            </div>
          )}
          {(tab === "diagnostics" || !hasLog) && diagnostics.length > 0 && (
            <ul className="compile-diagnostics-list">
              {diagnostics.map((diagnostic, index) => {
                const severity = diagnosticSeverity(diagnostic.level);
                const navigable = Boolean(diagnostic.file || diagnostic.line);
                return (
                  <li key={`${severity}-${diagnostic.file ?? ""}-${diagnostic.line ?? ""}-${index}`}>
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
                  </li>
                );
              })}
            </ul>
          )}
          {(tab === "log" || !diagnostics.length) && hasLog && (
            <pre className="compile-log" aria-label="Raw build log">{props.log}</pre>
          )}
          {!diagnostics.length && !hasLog && (
            <p className="compile-diagnostics-empty">Build failed without a captured log.</p>
          )}
        </div>
      )}
    </section>
  );
}
