import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { AlertTriangle, Check, ChevronRight, ClipboardCheck, ExternalLink, FileText, Info, Minus, Plus, RotateCcw } from "lucide-react";
import type { PaperSummary } from "../app-types";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PanelHeader } from "../components/ui/panel-header";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { ScrollArea } from "../components/ui/scroll-area";
import "./bibliography-audit.css";

export type AuditEntry = { path: string; key: string; title: string; bibtex: string; issues: string[] };
type AuditScan = { entries: AuditEntry[]; issues: { path: string; key?: string; message: string }[] };
export type AuditResult = {
  status: "checked" | "update" | "unavailable" | "skipped" | "conflict";
  message: string;
  before: string;
  after?: string;
  changes: { field: string; before: string; after: string }[];
  health?: PaperSummary["citationHealth"];
};

// This component stays mounted when hidden so a large audit doesn't block
// editing. Changing projects unmounts it and stops scheduling further work.
export function BibliographyAudit(props: {
  open: boolean;
  projectRoot: string;
  canApply: boolean;
  onClose: () => void;
  onPrepare: () => Promise<boolean>;
  onApply: (entry: AuditEntry, result: AuditResult) => Promise<void>;
}) {
  const { t, i18n } = useLingui();
  const [scan, setScan] = useState<AuditScan | null>(null);
  const [results, setResults] = useState<Record<number, AuditResult>>({});
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState<number | null>(null);
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const run = useRef({ generation: 0, busy: false, stop: false });
  const started = useRef(false);
  useEffect(() => () => { run.current.stop = true; run.current.generation += 1; run.current.busy = false; started.current = false; }, []);

  const start = async () => {
    if (run.current.busy || applying !== null) return;
    const generation = ++run.current.generation;
    const current = () => run.current.generation === generation;
    run.current.busy = true;
    run.current.stop = false;
    setBusy(true); setStopping(false); setError(""); setScan(null); setResults({}); setApplied(new Set());
    try {
      if (!await props.onPrepare()) throw new Error(t`Save pending edits before checking references.`);
      if (!current() || run.current.stop) return;
      const next = await invoke<AuditScan>("bibliography_audit_scan", { projectRoot: props.projectRoot });
      if (!current()) return;
      setScan(next);
      let cursor = 0;
      const worker = async () => {
        while (current() && !run.current.stop && cursor < next.entries.length) {
          const index = cursor++;
          const entry = next.entries[index];
          let result: AuditResult;
          try {
            result = await invoke<AuditResult>("bibliography_audit_entry", { projectRoot: props.projectRoot, entry });
          } catch (reason) {
            result = { status: "unavailable", message: String(reason), before: entry.bibtex, changes: [] };
          }
          if (current()) setResults(previous => ({ ...previous, [index]: result }));
        }
      };
      // Two entries at once; each provider retains its own timeout and cache.
      // Cancel drains those requests but never schedules the rest of the queue.
      await Promise.all([worker(), worker()]);
    } catch (reason) {
      if (current()) setError(String(reason));
    } finally {
      if (current()) { run.current.busy = false; setBusy(false); setStopping(false); }
    }
  };

  useEffect(() => {
    if (props.open && !started.current) { started.current = true; void start(); }
    // A project-keyed instance starts once, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const apply = async (index: number) => {
    if (!scan || applying !== null || busy || !props.canApply) return;
    setApplying(index); setError("");
    try {
      await props.onApply(scan.entries[index], results[index]);
      setApplied(previous => new Set(previous).add(index));
    } catch (reason) { setError(String(reason)); }
    finally { setApplying(null); }
  };

  if (!props.open) return null;
  const completed = Object.keys(results).length;
  const total = scan?.entries.length ?? 0;
  const statusLabel = (result?: AuditResult) => !result ? t`Not checked`
    : result.status === "update" ? t`Update available`
      : result.status === "unavailable" ? t`Check incomplete`
        : result.status === "skipped" ? t`Not verified`
          : result.status === "conflict" ? t`Entry changed`
            : t`No update found`;
  const fieldLabels: Record<string, string> = {
    title: t`Title`, author: t`Authors`, year: t`Year`, journal: t`Journal`,
    booktitle: t`Booktitle`, publisher: t`Publisher`, volume: t`Volume`,
    number: t`Number`, pages: t`Pages`, doi: "DOI", url: t`URL`,
  };
  return <ResizableDrawer className="bibliography-audit" ariaLabel={t`Check references`} onClose={props.onClose}>
    <PanelHeader className="drawer-header" icon={<ClipboardCheck size={16} />} title={t`Check references`} titleAfter={scan && <Badge>{total}</Badge>} onClose={props.onClose} />
    <div className="bibliography-audit-overview">
      <p className="bibliography-audit-copy">{t`Checks all project bibliographies without changing them. Review differences before applying an update.`}</p>
      <div className="bibliography-audit-toolbar">
        <p role="status" className="bibliography-audit-status">
          {busy ? <InfinityLoader size={14} /> : <ClipboardCheck size={14} aria-hidden="true" />}
          {scan ? t`${completed} of ${total} references checked` : busy ? t`Scanning bibliography files…` : t`Check not started`}
        </p>
        <div className="bibliography-audit-actions">
          {busy
            ? <Button size="compact" variant="ghost" disabled={stopping} onClick={() => { run.current.stop = true; setStopping(true); }}>{stopping ? t`Stopping…` : t`Cancel check`}</Button>
            : <Button size="compact" variant="ghost" onClick={() => void start()} disabled={applying !== null}><RotateCcw size={12} aria-hidden="true" />{t`Check again`}</Button>}
        </div>
      </div>
      {scan && <progress aria-label={t`Reference check progress`} max={Math.max(total, 1)} value={completed} />}
    </div>
    <ScrollArea className="bibliography-audit-scroll" viewportClassName="bibliography-audit-viewport">
    <div className="bibliography-audit-results">
    {!props.canApply && <p className="bibliography-audit-notice">{t`Updates are disabled in read-only projects. You can still check references.`}</p>}
    {error && <p role="alert" className="bibliography-audit-notice" data-tone="danger">{error}</p>}
    {scan && scan.issues.length > 0 && <details className="bibliography-audit-local" open>
      <summary><ChevronRight size={12} className="bibliography-audit-chevron" /><AlertTriangle size={14} /><span>{t`Local issues`}</span><Badge tone="warning">{scan.issues.length}</Badge></summary>
      <ul>{scan.issues.map((issue, index) => <li key={index}><span>{issue.path}{issue.key ? ` · ${issue.key}` : ""}</span><p>{issue.message}</p></li>)}</ul>
    </details>}
    {scan && total === 0 && <div className="bibliography-audit-empty"><ClipboardCheck size={24} aria-hidden="true" /><p>{t`No references to check`}</p></div>}
    {scan?.entries.map((entry, index) => {
      const result = results[index];
      const health = result?.health;
      const notice = health && !["unknown", "unavailable"].includes(health.kind);
      const isApplied = applied.has(index);
      const incomplete = result?.status === "unavailable" || result?.status === "conflict";
      return <article className="bibliography-audit-entry" key={`${entry.path}:${entry.key}:${index}`}>
        <div className="bibliography-audit-entry-heading">
          <FileText size={15} aria-hidden="true" />
          <div><h3>{entry.title || entry.key}</h3><p className="bibliography-audit-meta">{entry.key} <span>· {entry.path}</span></p></div>
        </div>
        <div className="bibliography-audit-entry-status">
          <Badge tone={isApplied ? "success" : incomplete ? "warning" : "neutral"}>
            {isApplied && <Check size={11} aria-hidden="true" />}{isApplied ? t`Update applied` : statusLabel(result)}
          </Badge>
        </div>
        {health && (notice || (health.link && /^https?:\/\//i.test(health.link))) && <div className="bibliography-audit-notice" data-tone={!notice ? "neutral" : health.kind === "retracted" ? "danger" : "warning"}>
          {notice && <p><AlertTriangle size={13} aria-hidden="true" />{t`Publisher notice`}: {health.updateType || health.kind}</p>}
          {health.link && /^https?:\/\//i.test(health.link) && <a href={health.link} onClick={(event) => {
            event.preventDefault();
            void openUrl(health.link!).catch(reason => setError(String(reason)));
          }}>{t`Open notice`}<ExternalLink size={12} aria-hidden="true" /></a>}
        </div>}
        {result && <details className="bibliography-audit-details">
          <summary><ChevronRight size={12} className="bibliography-audit-chevron" />{t`Details`}</summary>
          <p>{result.message}</p>
          {health && <p className="bibliography-audit-meta">{t`Health checked at`}: <time dateTime={health.checkedAt}>{new Date(health.checkedAt).toLocaleString(i18n.locale)}</time>{health.stale ? ` · ${t`Stale result`}` : ""}</p>}
        </details>}
        {result?.after && <details className="bibliography-audit-changes">
          <summary><ChevronRight size={12} className="bibliography-audit-chevron" /><span>{t`Review proposed changes`}</span><Badge size="compact">{result.changes.length}</Badge></summary>
          <dl className="bibliography-audit-diff">{result.changes.map(change => <div key={change.field}>
            <dt>{fieldLabels[change.field] ?? change.field}</dt>
            <dd><div className="bibliography-audit-before"><Minus size={12} aria-hidden="true" /><del>{change.before || "—"}</del></div><div className="bibliography-audit-after"><Plus size={12} aria-hidden="true" /><ins>{change.after || "—"}</ins></div></dd>
          </div>)}</dl>
          <details className="bibliography-audit-source"><summary><ChevronRight size={12} className="bibliography-audit-chevron" />BibTeX</summary><pre>{result.after}</pre></details>
          <div className="bibliography-audit-apply"><Button size="compact" variant="primary" disabled={busy || !props.canApply || applying !== null || isApplied} onClick={() => void apply(index)}>
            {applying === index ? <InfinityLoader size={13} /> : <Check size={13} aria-hidden="true" />}{t`Apply this update`}
          </Button></div>
        </details>}
      </article>;
    })}
    </div>
    </ScrollArea>
    <p className="bibliography-audit-disclaimer"><Info size={13} aria-hidden="true" /><span>{t`Results reflect available sources and cached records, not a guarantee that a reference is correct or current.`}</span></p>
  </ResizableDrawer>;
}
