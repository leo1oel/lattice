import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { AlertTriangle, Check, ChevronRight, ClipboardCheck, ExternalLink, Minus, Plus, RotateCcw } from "lucide-react";
import type { PaperSummary } from "../app-types";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { Checkbox } from "../components/ui/checkbox";
import { PanelHeader } from "../components/ui/panel-header";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import { loadAuditReport, saveAuditReport, type AuditReport, type SavedAudit } from "./bibliography-audit-storage";
import { auditIssueText, auditResultMessage, auditSourceName, type CodedAuditIssue } from "./audit-messages";
import "./bibliography-audit.css";

export type AuditEntry = { path: string; key: string; title: string; bibtex: string; issues: string[] };
type AuditScan = { entries: AuditEntry[]; issues: ({ path: string; key?: string } & CodedAuditIssue)[] };
/** Stored in the saved report as a key; the panel translates it where it renders. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- persisted message key, translated in publicationMessage
const REFERENCE_CHANGED_MESSAGE = "Reference changed since the last check. Check this reference again.";
type S2BatchStatus = "not_configured" | "queue_busy" | "daily_quota" | "upstream_rate_limit" | "rate_limited" | "unauthorized" | "timeout" | "network" | "malformed" | "unavailable";
type BatchAudit = { results: (AuditResult | null)[]; s2Failure?: S2BatchStatus };
export type AuditResult = {
  status: "checked" | "update" | "unavailable" | "skipped" | "conflict";
  message: string;
  checkedAt?: string;
  publicationReason?: string;
  sources?: { source: string; outcome: string }[];
  before: string;
  after?: string;
  changes: { field: string; before: string; after: string }[];
  candidate?: {
    bibtex: string;
    changes: { field: string; before: string; after: string }[];
    reasons: string[];
  };
  health?: PaperSummary["citationHealth"];
};

/** Results follow an entry across rescans by its file and citation key. */
const auditKey = (entry: AuditEntry) => `${entry.path}\0${entry.key}`;

function auditReport(scan: AuditScan, results: Record<number, AuditResult>, applied: Set<number>): AuditReport {
  return scan.entries.flatMap((entry, index) => results[index]
    ? [[auditKey(entry), { snapshot: entry.bibtex, result: results[index], applied: applied.has(index) }]]
    : []);
}

/**
 * Carries prior results over to a fresh scan while an entry's BibTeX is
 * unchanged; `changed` decides what an edited entry shows instead.
 */
function carryOver(entries: AuditEntry[], prior: Map<string, SavedAudit>, changed?: (entry: AuditEntry, saved: SavedAudit) => AuditResult) {
  const results: Record<number, AuditResult> = {};
  const applied = new Set<number>();
  entries.forEach((entry, index) => {
    const saved = prior.get(auditKey(entry));
    if (saved?.snapshot === entry.bibtex) {
      results[index] = saved.result;
      if (saved.applied) applied.add(index);
    } else if (saved && changed) {
      results[index] = changed(entry, saved);
    }
  });
  return { results, applied };
}

/** A collapsed section with the drawer's rotating chevron. */
function Disclosure(props: { className: string; summary: ReactNode; open?: boolean; children: ReactNode }) {
  return <details className={props.className} open={props.open}>
    <summary><ChevronRight size={12} className="bibliography-audit-chevron" />{props.summary}</summary>
    {props.children}
  </details>;
}

// This component stays mounted when hidden so a large audit doesn't block
// editing. Changing projects unmounts it and stops scheduling further work.
export function BibliographyAudit(props: {
  open: boolean;
  projectRoot: string;
  onClose: () => void;
  onPrepare: () => Promise<boolean>;
  onApply: (entry: AuditEntry, result: AuditResult) => Promise<void>;
  onApplied?: () => void;
}) {
  const { t, i18n } = useLingui();
  const [scan, setScan] = useState<AuditScan | null>(null);
  const [results, setResults] = useState<Record<number, AuditResult>>({});
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [waitingForS2, setWaitingForS2] = useState(false);
  const cancelWait = useRef<() => void>(() => {});
  const [error, setError] = useState("");
  const [applying, setApplying] = useState<number | null>(null);
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const run = useRef({ generation: 0, busy: false, stop: false });
  const [checkStartedAt, setCheckStartedAt] = useState("");
  const [checkCount, setCheckCount] = useState(0);
  useEffect(() => () => { run.current.stop = true; cancelWait.current(); run.current.generation += 1; run.current.busy = false; }, []);

  useEffect(() => {
    if (!scan || loading) return;
    let disposed = false;
    void saveAuditReport(props.projectRoot, auditReport(scan, results, applied)).then(
      () => { if (!disposed) setStorageFailed(false); },
      () => { if (!disposed) setStorageFailed(true); },
    );
    return () => { disposed = true; };
  }, [scan, results, applied, loading, props.projectRoot]);

  const start = async (only?: number[]) => {
    if (!scan || loading || run.current.busy || applying !== null) return;
    const requested = only && new Set(only.map(index => auditKey(scan.entries[index])));
    const generation = ++run.current.generation;
    const current = () => run.current.generation === generation;
    run.current.busy = true;
    run.current.stop = false;
    setCheckStartedAt(new Date().toISOString());
    setCheckCount(only?.length ?? scan.entries.length);
    const cancelled = new Promise<void>(resolve => { cancelWait.current = resolve; });
    setBusy(true); setStopping(false); setError("");
    try {
      if (!await props.onPrepare()) throw new Error(t`Save pending edits before checking references.`);
      if (!current() || run.current.stop) return;
      const next = await invoke<AuditScan>("bibliography_audit_scan", { projectRoot: props.projectRoot });
      if (!current()) return;
      setScan(next);
      const indexesToCheck = next.entries.flatMap((entry, index) => !requested || requested.has(auditKey(entry)) ? [index] : []);
      setCheckCount(indexesToCheck.length);
      const retained = carryOver(next.entries, new Map(auditReport(scan, results, applied)));
      setResults(retained.results); setApplied(retained.applied); setSelected(new Set());
      let s2Failure: S2BatchStatus | undefined;
      // Twenty keeps cancellation responsive and fits the health-cache refresh
      // budget. The API supports larger batches; this isn't twenty HTTP calls.
      for (let start = 0; current() && !run.current.stop && start < indexesToCheck.length; start += 20) {
        const indexes = indexesToCheck.slice(start, start + 20);
        const entries = indexes.map(index => next.entries[index]);
        let batch: (AuditResult | null)[] = entries.map(() => null);
        let s2BatchStatus: "checked" | S2BatchStatus | undefined = s2Failure;
        let batchTask: Promise<void> | undefined;
        if (!s2Failure && indexesToCheck.length > 1) {
          s2BatchStatus = "checked"; // Suppress per-entry S2 while its batch is pending.
          batchTask = (async () => {
            try {
              const response = await invoke<BatchAudit>("bibliography_audit_batch", { projectRoot: props.projectRoot, entries });
              if (response.results.length !== entries.length) throw new Error();
              batch = response.results;
              s2Failure = response.s2Failure;
              s2BatchStatus = s2Failure ?? "checked";
            } catch {
              s2Failure = "unavailable";
              s2BatchStatus = s2Failure;
            }
          })();
          // Let a cache hit avoid redundant work. A queued/slow S2 request must
          // not hold Crossref, OpenAlex and DBLP behind its quota wait.
          let timer: ReturnType<typeof setTimeout> | undefined;
          let settled = false;
          void batchTask.then(() => { settled = true; });
          await Promise.race([batchTask, cancelled, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
          clearTimeout(timer);
          if (current() && !run.current.stop) setWaitingForS2(!settled);
        }
        if (!current()) return;
        setResults(previous => {
          const updated = { ...previous };
          batch.forEach((value, offset) => { if (value) updated[indexes[offset]] = { ...value, checkedAt: new Date().toISOString() }; });
          return updated;
        });
        setApplied(previous => new Set([...previous].filter(index => !batch[indexes.indexOf(index)])));
        let cursor = 0;
        const worker = async () => {
          while (current() && !run.current.stop && cursor < entries.length) {
            const offset = cursor++;
            if (batch[offset]) continue;
            const entry = entries[offset];
            let result: AuditResult;
            try {
              // The fallback still checks other sources, but must not repeat
              // this group's S2 lookup (including a failed lookup).
              result = await invoke<AuditResult>("bibliography_audit_entry", { projectRoot: props.projectRoot, entry, s2BatchStatus });
            } catch (reason) {
              result = { status: "unavailable", message: String(reason), before: entry.bibtex, changes: [] };
            }
            if (current()) {
              setResults(previous => ({ ...previous, [indexes[offset]]: { ...result, checkedAt: new Date().toISOString() } }));
              setApplied(previous => { const next = new Set(previous); next.delete(indexes[offset]); return next; });
            }
          }
        };
        // Cancellation drains the active group; no further group is scheduled.
        await Promise.all([worker(), worker()]);
        if (batchTask && !run.current.stop) await Promise.race([batchTask, cancelled]);
        if (current()) {
          setWaitingForS2(false);
          if (!run.current.stop) setApplied(previous => new Set([...previous].filter(index => !batch[indexes.indexOf(index)])));
          // Apply batch proposals only to this run. Never let a late response
          // from a cancelled audit overwrite a new scan or reviewed result.
          if (!run.current.stop) setResults(previous => {
            const updated = { ...previous };
            entries.forEach((_, offset) => {
              const result = batch[offset] ?? updated[indexes[offset]];
              if (!result) return;
              const checkedAt = batch[offset] ? new Date().toISOString() : updated[indexes[offset]]?.checkedAt;
              updated[indexes[offset]] = { ...result, checkedAt, ...(s2Failure ? {
                sources: [...(result.sources ?? []).filter(source => source.source !== "semanticscholar"), { source: "semanticscholar", outcome: s2Failure === "not_configured" ? "not_configured" : `batch_${s2Failure}` }],
              } : {}) };
            });
            return updated;
          });
        }
      }
    } catch (reason) {
      if (current()) setError(String(reason));
    } finally {
      if (current()) { run.current.busy = false; setBusy(false); setStopping(false); setWaitingForS2(false); }
    }
  };

  useEffect(() => {
    if (props.open && !run.current.busy && applying === null) {
      const generation = run.current.generation;
      let disposed = false;
      setLoading(true);
      setError("");
      void Promise.all([
        invoke<AuditScan>("bibliography_audit_scan", { projectRoot: props.projectRoot }),
        loadAuditReport(props.projectRoot),
      ])
        .then(([value, saved]) => {
          if (disposed || run.current.generation !== generation) return;
          const restored = carryOver(value.entries, saved, (entry, prior) => ({
            status: "conflict", before: entry.bibtex, changes: [], checkedAt: prior.result.checkedAt,
            message: REFERENCE_CHANGED_MESSAGE,
          }));
          setScan(value); setResults(restored.results); setApplied(restored.applied); setSelected(new Set());
        })
        .catch(reason => {
          if (!disposed && run.current.generation === generation) {
            // Do not replace an unreadable native report with stale/empty UI state.
            setScan(null); setError(String(reason));
          }
        })
        .finally(() => { if (!disposed && run.current.generation === generation) setLoading(false); });
      return () => { disposed = true; };
    }
    // Opening only reconciles local snapshots; remote checks remain explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  // `applying` is the row being written, or -1 while accepting all updates.
  const apply = async (indexes: number[], applyingIndex: number) => {
    if (!scan || loading || busy || applying !== null) return;
    setApplying(applyingIndex); setError("");
    try {
      const generation = run.current.generation;
      for (const index of indexes) {
        if (run.current.generation !== generation) break;
        await props.onApply(scan.entries[index], results[index]);
        setApplied(previous => new Set(previous).add(index));
        setScan(previous => previous && ({ ...previous, entries: previous.entries.map((entry, i) => i === index ? { ...entry, bibtex: results[index].after! } : entry) }));
      }
    } catch (reason) { setError(String(reason)); }
    finally { setApplying(null); props.onApplied?.(); }
  };

  const hasCandidate = (result?: AuditResult) => result?.candidate != null;
  const updates = Object.keys(results).map(Number).filter(index => !!results[index].after && !hasCandidate(results[index]) && results[index].status !== "conflict" && !applied.has(index));

  if (!props.open) return null;
  const completed = Object.values(results).filter(result => !busy || (result.checkedAt && result.checkedAt >= checkStartedAt)).length;
  const total = scan?.entries.length ?? 0;
  const progressTotal = busy ? checkCount : total;
  const statusLabel = (result?: AuditResult) => !result ? t`Not checked`
    : result.status === "update" ? t`Update available`
      : result.publicationReason === "missing_identity" ? t`Reference lacks identifying metadata`
        : result.publicationReason === "no_match" ? t`No matching publication found`
      : result.status === "unavailable" ? result.publicationReason === "identity_conflict" ? t`Candidate does not match reference`
        : result.publicationReason === "metadata_unavailable" ? t`Independent metadata unavailable`
          : result.publicationReason === "sources_unavailable" ? t`Some sources unavailable`
            : t`Check incomplete`
        : result.status === "skipped" ? t`Not verified`
          : result.status === "conflict" ? t`Entry changed`
            : t`No update found`;
  const fieldLabels: Record<string, string> = {
    title: t`Title`, author: t`Authors`, year: t`Year`, journal: t`Journal`,
    booktitle: t`Booktitle`, publisher: t`Publisher`, volume: t`Volume`,
    number: t`Number`, pages: t`Pages`, doi: "DOI", url: t`URL`, ENTRYTYPE: t`Entry type`,
  };
  const publicationMessage = (result: AuditResult) => !result.publicationReason
    ? result.message === "A published version is available." ? t`A published version is available.`
      : result.message === REFERENCE_CHANGED_MESSAGE ? t`Reference changed since the last check. Check this reference again.`
      : result.message === "No update found." ? t`No update found` : auditResultMessage(result.message)
    : result.publicationReason === "identity_conflict" ? t`A source returned a possible record, but its identifying metadata conflicts with this reference.`
      : result.publicationReason === "metadata_unavailable" ? t`No independent metadata was available to verify a possible record. The reference may still be valid.`
        : result.publicationReason === "missing_identity" ? t`Add a title, full authors, and year, or add a DOI or arXiv identifier, before checking this reference.`
          : result.publicationReason === "no_match" || result.publicationReason === "no_published_version" ? t`No matching publication was found in the sources checked.`
      : result.publicationReason === "sources_unavailable" ? t`Some sources could not complete the lookup. This does not mean the reference is incorrect.`
        : result.publicationReason === "ambiguous" ? t`The results did not identify a unique matching publication.`
          : t`The publication lookup could not be completed. Try again later.`;
  const sourceNames: Record<string, string> = {
    dblp: t`DBLP`, semanticscholar: t`Semantic Scholar`, googlescholar: t`Google Scholar`,
    crossref: t`Crossref`, unpaywall: t`Unpaywall`, openalex: t`OpenAlex`,
  };
  const sourceOutcomes: Record<string, string> = {
    matched: t`Verified publication match`,
    selected: t`Metadata source`,
    selected_cached: t`Metadata source · cached`,
    candidate: t`Candidate record considered, not verified`,
    candidate_cached: t`Candidate record considered, not verified · cached record`,
    not_configured: t`Not enabled · add your own API key in Settings`,
    no_match: t`No published version found`, rate_limited: t`Rate limited`,
    batch_reused: t`Batch result reused`, queue_busy: t`Request queue busy`,
    daily_quota: t`Public daily quota exhausted`,
    batch_rate_limited: t`Rate limited; subsequent Semantic Scholar queries skipped`,
    batch_queue_busy: t`Request queue busy; subsequent Semantic Scholar queries skipped`,
    batch_daily_quota: t`Public daily quota exhausted; subsequent Semantic Scholar queries skipped`,
    batch_upstream_rate_limit: t`Semantic Scholar rate limited the service; subsequent queries skipped`,
    batch_unauthorized: t`Semantic Scholar authorization failed; subsequent queries skipped`,
    batch_network: t`Semantic Scholar connection failed; subsequent queries skipped`,
    batch_malformed: t`Semantic Scholar returned an invalid response; subsequent queries skipped`,
    batch_timeout: t`Semantic Scholar request timed out; subsequent queries skipped`,
    batch_unavailable: t`Semantic Scholar unavailable; subsequent queries skipped`,
    blocked: t`Requests blocked`, timeout: t`Request timed out`,
    connection_failed: t`Connection failed`, network: t`Network connection failed`,
    unauthorized: t`Authorization failed`, malformed: t`Invalid response from source`,
    forbidden: t`Access forbidden by provider`,
    upstream_rate_limit: t`Source rate limit reached`, server_error: t`Source service error`,
    unavailable: t`Source temporarily unavailable`,
  };
  const sourceOutcome = (result: AuditResult, outcome: string) => {
    // Reports saved before candidate outcomes existed may say that a source was
    // selected even though the final result was unavailable. Do not present
    // those records as verified or accepted.
    if (result.status === "unavailable" && outcome === "selected") return t`Source record considered, not verified`;
    if (result.status === "unavailable" && outcome === "selected_cached") return t`Source record considered, not verified · cached record`;
    return sourceOutcomes[outcome] ?? t`Unknown source response`;
  };
  const reasonLabels: Record<string, string> = {
    ...fieldLabels, insufficient_identity: t`Insufficient identifying metadata`,
    record: t`Record identity`, venue: t`Venue`, arxiv: t`arXiv identifier`,
  };
  // A running check or a selection waiting to be applied must survive a stray click outside.
  const dirty = busy || applying !== null || selected.size > 0;
  return <SheetDialog className="bibliography-audit" label={t`Check references`} dirty={dirty} onClose={props.onClose}>
    <PanelHeader className="drawer-header" icon={<ClipboardCheck size={16} />} title={t`Check references`} titleAfter={scan && <Badge>{total}</Badge>} onClose={props.onClose} />
    <div className="bibliography-audit-overview">
      <p className="bibliography-audit-copy">{t`Checks all project bibliographies without changing them. Review differences before applying an update.`}</p>
      <div className="bibliography-audit-toolbar">
        <p role="status" className="bibliography-audit-status">
          {busy ? <InfinityLoader size={14} /> : <ClipboardCheck size={14} aria-hidden="true" />}
          {waitingForS2 ? t`Partial results for ${completed} of ${progressTotal} references` : scan ? t`${completed} of ${progressTotal} references checked` : busy ? t`Scanning bibliography files…` : t`Check not started`}
        </p>
        <div className="bibliography-audit-actions">
          {busy
            ? <Button size="compact" variant="ghost" disabled={stopping} onClick={() => { run.current.stop = true; cancelWait.current(); setStopping(true); }}>{stopping ? t`Stopping…` : t`Cancel check`}</Button>
            : <Button size="compact" variant="ghost" onClick={() => void start()} disabled={!scan || loading || applying !== null}><RotateCcw size={12} aria-hidden="true" />{t`Check all`}</Button>}
        </div>
      </div>
      {scan && <div className="bibliography-audit-toolbar">
        <label className="bibliography-audit-status"><Checkbox aria-label={t`Select all references`} disabled={busy || applying !== null} checked={total > 0 && selected.size === total} indeterminate={selected.size > 0 && selected.size < total} onChange={event => setSelected(event.target.checked ? new Set(scan.entries.map((_, index) => index)) : new Set())} />{t`Select all`}</label>
        <Button size="compact" variant="ghost" disabled={busy || applying !== null || selected.size === 0} onClick={() => void start([...selected])}>{t`Check selected`}</Button>
        {updates.length > 0 && <Button size="compact" variant="primary" disabled={busy || applying !== null} onClick={() => void apply(updates, -1)}><Check size={12} />{t`Accept all updates`}</Button>}
      </div>}
      {waitingForS2 && <p className="bibliography-audit-copy" role="status">{t`Semantic Scholar is queued or querying. Other sources continue; you can cancel without waiting for it.`}</p>}
      {scan && <progress aria-label={t`Reference check progress`} max={Math.max(progressTotal, 1)} value={waitingForS2 ? undefined : completed} />}
    </div>
    <ScrollArea className="bibliography-audit-scroll" viewportClassName="bibliography-audit-viewport">
    <div className="bibliography-audit-results">
    {error && <p role="alert" className="bibliography-audit-notice" data-tone="danger">{error}</p>}
    {storageFailed && <p role="alert" className="bibliography-audit-notice">{t`Could not save the report on this device. Keep this window open to retain the results.`}</p>}
    {scan && scan.issues.length > 0 && <Disclosure className="bibliography-audit-local" open
      summary={<><AlertTriangle size={14} /><span>{t`Local issues`}</span><Badge tone="warning">{scan.issues.length}</Badge></>}>
      <ul>{scan.issues.map((issue, index) => <li key={index}><span>{issue.path}{issue.key ? ` · ${issue.key}` : ""}</span><p>{auditIssueText(issue)}</p></li>)}</ul>
    </Disclosure>}
    {scan && total === 0 && <div className="bibliography-audit-empty"><ClipboardCheck size={24} aria-hidden="true" /><p>{t`No references to check`}</p></div>}
    {scan?.entries.map((entry, index) => {
      const result = results[index];
      const health = result?.health;
      const notice = health && !["unknown", "unavailable"].includes(health.kind);
      const isApplied = applied.has(index);
      const incomplete = result?.status === "unavailable" || result?.status === "conflict";
      const candidatePresent = hasCandidate(result);
      const candidate = candidatePresent && result?.candidate && typeof result.candidate === "object"
        && Array.isArray(result.candidate.changes) && Array.isArray(result.candidate.reasons)
        ? result.candidate : undefined;
      // The scan is the source of truth until an accepted proposal is written.
      // Candidate records are comparison-only and must never displace it.
      const currentBibtex = isApplied && result?.after && !candidatePresent ? result.after : entry.bibtex;
      return <article className="bibliography-audit-entry" key={`${entry.path}:${entry.key}:${index}`}>
        <div className="bibliography-audit-entry-heading">
          <Checkbox aria-label={t`Select ${entry.key}`} checked={selected.has(index)} disabled={busy || applying !== null} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(index); else next.delete(index); return next; })} />
          <div><h3>{entry.title || entry.key}</h3><p className="bibliography-audit-meta">{entry.key} <span>· {entry.path}</span></p></div>
          <IconButton size="compact" label={t`Check ${entry.key}`} disabled={busy || applying !== null} onClick={() => void start([index])}><ClipboardCheck size={14} /></IconButton>
        </div>
        <div className="bibliography-audit-entry-status">
          <Badge tone={isApplied || result?.status === "update" ? "success" : incomplete ? "warning" : "neutral"}>
            {isApplied && <Check size={11} aria-hidden="true" />}{isApplied ? t`Update applied` : statusLabel(result)}
          </Badge>
          {result?.checkedAt && <span className="bibliography-audit-meta">{t`Last checked`}: <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString(i18n.locale)}</time></span>}
        </div>
        <Disclosure className="bibliography-audit-source" summary={t`Current BibTeX`}>
          <pre>{currentBibtex}</pre>
        </Disclosure>
        {health && (notice || (health.link && /^https?:\/\//i.test(health.link))) && <div className="bibliography-audit-notice" data-tone={!notice ? "neutral" : health.kind === "retracted" ? "danger" : "warning"}>
          {notice && <p><AlertTriangle size={13} aria-hidden="true" />{t`Publisher notice`}: {health.updateType || health.kind}</p>}
          {health.link && /^https?:\/\//i.test(health.link) && <a href={health.link} onClick={(event) => {
            event.preventDefault();
            void openUrl(health.link!).catch(reason => setError(String(reason)));
          }}>{t`Open notice`}<ExternalLink size={12} aria-hidden="true" /></a>}
        </div>}
        {result && <Disclosure className="bibliography-audit-details" summary={t`Details`}>
          <p>{publicationMessage(result)}</p>
          {!!result.sources?.length && <dl className="bibliography-audit-sources">
            {result.sources.map(source => <div key={source.source}>
              <dt>{sourceNames[source.source] ?? auditSourceName(source.source)}</dt>
              <dd>{sourceOutcome(result, source.outcome)}</dd>
            </div>)}
          </dl>}
          {health && <p className="bibliography-audit-meta">{t`Health checked at`}: <time dateTime={health.checkedAt}>{new Date(health.checkedAt).toLocaleString(i18n.locale)}</time>{health.stale ? ` · ${t`Stale result`}` : ""}</p>}
        </Disclosure>}
        {candidate && <Disclosure className="bibliography-audit-changes"
          summary={<><span>{t`Review candidate`}</span><Badge size="compact">{candidate.changes.length}</Badge></>}>
          <p className="bibliography-audit-copy">{t`This source record is shown for comparison only. It was not verified and cannot be applied.`}</p>
          {candidate.reasons.length > 0 && <p className="bibliography-audit-copy">{t`Conflicting or insufficient fields`}: {candidate.reasons.map(reason => reasonLabels[reason] ?? reason).join(", ")}</p>}
          <dl className="bibliography-audit-diff">{candidate.changes.map((change, changeIndex) => <div key={`${change.field}:${changeIndex}`}>
            <dt>{fieldLabels[change.field] ?? change.field}</dt>
            <dd className="bibliography-audit-candidate-values">
              <div><span>{t`Current reference`}</span><span>{change.before || "—"}</span></div>
              <div><span>{t`Source candidate (not applied)`}</span><span>{change.after || "—"}</span></div>
            </dd>
          </div>)}</dl>
          {candidate.bibtex && <Disclosure className="bibliography-audit-source" summary={t`Unverified candidate BibTeX`}><pre>{candidate.bibtex}</pre></Disclosure>}
        </Disclosure>}
        {result?.after && !candidatePresent && <Disclosure className="bibliography-audit-changes"
          summary={<><span>{t`Review proposed changes`}</span><Badge size="compact">{result.changes.length}</Badge></>}>
          <dl className="bibliography-audit-diff">{result.changes.map(change => <div key={change.field}>
            <dt>{fieldLabels[change.field] ?? change.field}</dt>
            <dd><div className="bibliography-audit-before"><Minus size={12} aria-hidden="true" /><del>{change.before || "—"}</del></div><div className="bibliography-audit-after"><Plus size={12} aria-hidden="true" /><ins>{change.after || "—"}</ins></div></dd>
          </div>)}</dl>
          <Disclosure className="bibliography-audit-source" summary={t`Proposed BibTeX`}><pre>{result.after}</pre></Disclosure>
          <div className="bibliography-audit-apply"><Button size="compact" variant="primary" disabled={busy || applying !== null || isApplied} onClick={() => void apply([index], index)}>
            {applying === index ? <InfinityLoader size={13} /> : <Check size={13} aria-hidden="true" />}{t`Apply this update`}
          </Button></div>
        </Disclosure>}
      </article>;
    })}
    </div>
    </ScrollArea>
  </SheetDialog>;
}
