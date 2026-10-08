import { useLayoutEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDown, ChevronUp, CircleAlert, CircleHelp, LoaderCircle, PanelBottom, PictureInPicture2, Square, WandSparkles, ScrollText } from "lucide-react";
import { CopyButton } from "../components/copy-button";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { CloseButton, IconButton } from "../components/ui/icon-button";
import { EmptyState } from "../components/ui/empty-state";
import {
  diagnosticLocationLabel,
  diagnosticSeverity,
  groupDiagnosticsByFile,
  missingTexDependencyFile,
  failedLogAnchor,
  sortDiagnostics,
  summarizeDiagnostics,
  type CompileDiagnostic,
} from "./compile-diagnostics";
import { SegmentedControl } from "../components/ui/segmented-control";
import type { CompileRepairState } from "./use-compile-repair";
import { compileDiagnosticText } from "./build-log-messages";
import { buildHeadline } from "./build-result-text";
import { compileRepairMessage } from "./compile-repair-messages";

const DOCKED_KEY = "lattice.build-output-docked.v1";

/**
 * Floating keeps the page at full height and covers its top; docked gives
 * the output its own strip under the PDF. One preference for every project;
 * it is read whenever the panel appears, so the next build keeps the choice.
 */
function useDockedPreference() {
  const [docked, setDocked] = useState(() => {
    try {
      return localStorage.getItem(DOCKED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const change = (next: boolean) => {
    setDocked(next);
    try {
      if (next) localStorage.setItem(DOCKED_KEY, "1");
      else localStorage.removeItem(DOCKED_KEY);
    } catch {
      // Unavailable storage only forgets the choice for the next build.
    }
  };
  return [docked, change] as const;
}

function SeverityIcon({ level }: { level: string }) {
  // Errors and warnings share the glyph; the status colour carries severity.
  return diagnosticSeverity(level) === "info" ? <CircleHelp size={15} /> : <CircleAlert size={15} />;
}

/**
 * The raw log, opened where a failed build went wrong rather than at TeX's
 * banner. A wrapped line has no fixed height, so the distance to the error is
 * measured on an invisible copy of the field holding the text before it.
 */
function CompileLog({ log, failed, label }: { log: string; failed: boolean; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field || !failed) return;
    const anchor = failedLogAnchor(log);
    if (anchor === 0) return;
    if (anchor >= log.length) {
      field.scrollTop = field.scrollHeight;
      return;
    }
    const probe = field.cloneNode() as HTMLTextAreaElement;
    // Up to the newline before the error, so the copy ends on the line above it.
    probe.value = log.slice(0, anchor - 1);
    probe.setAttribute("aria-hidden", "true");
    probe.tabIndex = -1;
    Object.assign(probe.style, {
      position: "absolute", visibility: "hidden", pointerEvents: "none",
      width: `${field.offsetWidth}px`, height: "0", minHeight: "0", maxHeight: "none", fieldSizing: "fixed",
    });
    field.parentElement?.append(probe);
    const style = getComputedStyle(field);
    // One line of what came before stays in view above the error.
    const context = parseFloat(style.lineHeight) || 0;
    field.scrollTop = Math.max(0, probe.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - context);
    probe.remove();
  }, [failed, log]);
  return (
    // A read-only field, not a <pre>: this panel sits directly above the PDF
    // toolbar and text layer, and a selection that starts in a <pre> keeps
    // going. Dragging past the bottom, or Edit → Select All, copied the log
    // followed by "1 / 29", "%" and the stale PDF's text. A field keeps every
    // selection inside the log.
    <textarea
      ref={ref}
      className="compile-log"
      aria-label={label}
      readOnly
      spellCheck={false}
      value={log}
      onKeyDown={(event) => {
        // The PDF text layer's capture listener cancels Command-A for
        // read-only fields; select the log itself instead.
        if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
          && event.key.toLowerCase() === "a") {
          event.preventDefault();
          event.currentTarget.select();
        }
      }}
    />
  );
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
  const hasLog = Boolean(props.log.trim());
  const [tab, setTab] = useState<"diagnostics" | "log">(diagnostics.length ? "diagnostics" : "log");
  const [docked, setDocked] = useDockedPreference();
  if (props.success && !diagnostics.length && !props.repair) return null;
  // The same sentence the Build button's tip gives for this build.
  const title = diagnostics.length || !props.success ? buildHeadline(props.success, summary) : t`Build notes`;
  const busy = props.repair && !["completed", "failed"].includes(props.repair.status);
  const progress = props.repair?.status === "compiling" ? t`Recompiling…`
    : props.repair?.status === "awaiting-approval" ? t`Needs approval` : t`Repairing…`;

  return (
    <section className={`compile-diagnostics ${tone}${docked ? " docked" : ""}${props.expanded ? " expanded" : ""}`} aria-label={t`Compile diagnostics`}>
      <div className="compile-diagnostics-bar">
        <button className="compile-diagnostics-toggle" aria-expanded={props.expanded} onClick={() => props.onExpandedChange(!props.expanded)}>
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
        <IconButton
          className="compile-diagnostics-dock"
          label={docked ? t`Float over the page` : t`Dock below the page`}
          size="compact"
          onClick={() => setDocked(!docked)}
        >
          {docked ? <PictureInPicture2 size={13} /> : <PanelBottom size={13} />}
        </IconButton>
        <CloseButton label={t`Dismiss diagnostics`} size="compact" onClick={props.onDismiss} />
      </div>
      {(props.repair?.message || props.repair?.status === "awaiting-approval") && (
        <p className="compile-repair-detail" role="status">{props.repair.message ? compileRepairMessage(props.repair.message) : t`Open the repair task to continue.`}</p>
      )}
      {props.expanded && (
        <div className="compile-diagnostics-body">
          {hasLog && (diagnostics.length > 0 || tab === "log") && (
            <div className="compile-diagnostics-switch">
              {diagnostics.length > 0 && (
                <SegmentedControl
                  value={tab}
                  onChange={setTab}
                  ariaLabel={t`Build output`}
                  className="compile-diagnostics-tabs"
                  items={[
                    { value: "diagnostics", label: t`Messages` },
                    { value: "log", label: <><ScrollText size={12} /> <Trans>Log</Trans></> },
                  ]}
                />
              )}
              {(tab === "log" || !diagnostics.length) && (
                <CopyButton className={buttonClassName({ variant: "ghost", size: "compact", className: "compile-log-copy" })} text={props.log} iconSize={12} title={t`Copy the whole build log`}>
                  <Trans>Copy log</Trans>
                </CopyButton>
              )}
            </div>
          )}
          {(tab === "diagnostics" || !hasLog) && diagnostics.length > 0 && (
            <ul className="compile-diagnostics-list">
              {groupDiagnosticsByFile(diagnostics).map((group) => (
                <li key={group.file ?? ""} className="compile-diagnostics-group">
                  <div className="compile-diagnostics-file" title={group.file}>
                    <span>{group.file ?? t`Build log`}</span>
                    {group.diagnostics.length > 1 && <span className="compile-diagnostics-count">{group.diagnostics.length}</span>}
                  </div>
                  <ul>
                    {group.diagnostics.map((diagnostic, index) => {
                      const severity = diagnosticSeverity(diagnostic.level);
                      const navigable = Boolean(diagnostic.file || diagnostic.line);
                      const location = diagnosticLocationLabel(diagnostic);
                      const text = compileDiagnosticText(diagnostic);
                      const line = diagnostic.line;
                      const missingFile = missingTexDependencyFile(diagnostic.message);
                      return (
                        <li key={`${severity}-${diagnostic.line ?? ""}-${index}`}>
                          <button
                            className={`compile-diagnostic-item ${severity}`}
                            disabled={!navigable}
                            onClick={() => props.onSelect(diagnostic)}
                            // The file is the group's heading; the name still says where.
                            aria-label={`${location} ${text}`}
                            title={navigable ? t`Jump to this location` : text}
                          >
                            <SeverityIcon level={diagnostic.level} />
                            <span className="compile-diagnostic-message">{text}</span>
                            {line ? <span className="compile-diagnostic-line">{t`line ${line}`}</span> : null}
                          </button>
                          {missingFile && (
                            <Button variant="ghost" size="compact" title={t`Find and install the TeX Live package for ${missingFile}`}
                              onClick={() => props.onInstallDependency(missingFile)}>
                              <Trans>Install</Trans>
                            </Button>
                          )}
                          <CopyButton
                            className="compile-diagnostic-copy"
                            aria-label={t`Copy error message`}
                            title={t`Copy error message`}
                            iconSize={12}
                            text={`${location} ${diagnostic.message}`}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {(tab === "log" || !diagnostics.length) && hasLog && (
            <CompileLog log={props.log} failed={!props.success} label={t`Raw build log`} />
          )}
          {!props.success && !diagnostics.length && !hasLog && (
            <EmptyState align="start" density="compact" description={t`Build failed without a captured log`} />
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
