import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { AlertTriangle, ArrowDown, ArrowRight, Check, ChevronRight, ClipboardCheck, ExternalLink, RotateCcw, X } from "lucide-react";
import type { PaperSummary } from "../app-types";
import { isMissingPaperToolsError } from "../build/tex-setup";
import { CopyButton } from "../components/copy-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { Checkbox } from "../components/ui/checkbox";
import { CheckboxField } from "../components/ui/checkbox-field";
import { InlineEdits } from "../components/ui/inline-edits";
import { SlidingTabs } from "../components/ui/motion";
import { PanelHeader } from "../components/ui/panel-header";
import { renderKeycaps } from "../components/ui/render-keycaps";
import { ResearchArt } from "../components/ui/research-art";
import { REFERENCE_CHECK } from "../components/ui/research-art-reference-check";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import { comboKeys, parseKeyName } from "../app/key-combos";
import { useLatestRef } from "../hooks/use-latest-ref";
import { useProgressiveRows } from "../hooks/use-progressive-rows";
import { loadAuditReport, saveAuditReport, type AuditReport, type SavedAudit } from "./bibliography-audit-storage";
import { auditIssueText, auditResultMessage, auditSourceName, type CodedAuditIssue } from "./audit-messages";
import { REFERENCE_CHECK_SHORTCUTS, referenceCheckAction } from "./reference-check-keys";
import { correctedBibitem, typesetBibFix, typesetInlineFix, wordDifference, type TypesetFix } from "./reference-typeset";
import "./bibliography-audit.css";

/**
 * `inline` is the `\bibitem` as written in a root document's own reference
 * list: checked, never rewritten. `line` is where the entry or item starts.
 */
export type AuditEntry = { path: string; key: string; title: string; bibtex: string; issues: string[]; inline?: string; line?: number };
/** A file the scan read references from: a `.bib` file or a root document's inline list. */
type AuditCoverage = { path: string; kind: "bibliography" | "inline"; entries: number };
type AuditScan = { entries: AuditEntry[]; issues: ({ path: string; key?: string } & CodedAuditIssue)[]; coverage?: AuditCoverage[] };
/** Stored in the saved report as a key; the panel translates it where it renders. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- persisted message key, translated in publicationMessage
const REFERENCE_CHANGED_MESSAGE = "Reference changed since the last check. Check this reference again.";
/** A LaTeX command the copy names; never translated. */
const BIBITEM = "\\bibitem";
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
  /** Fields on which the conference's own export and Crossref disagree; the export is kept. */
  disagreements?: string[];
};

/**
 * What a finding asks of the writer, which orders the report: a fix to apply
 * (or, for an inline reference, to make by hand), an unverified candidate to
 * read, a check that could not finish, a reference not checked yet, a
 * candidate the writer read and kept their own entry over, and a verified one.
 */
type Bucket = "fix" | "review" | "incomplete" | "unchecked" | "kept" | "verified";
const BUCKET_ORDER: readonly Bucket[] = ["fix", "review", "incomplete", "unchecked", "kept", "verified"];
/** The findings J, K and S walk through, and Apply or Keep mine finishes. */
const ACTIONABLE = new Set<Bucket>(["fix", "review"]);
/** A reference row's usual height, for the list not drawn yet. */
const AUDIT_ROW_HEIGHT = 54;
/** A row's status mark: its bucket, or the check running on it right now. */
type Mark = Bucket | "checking";

/** Results follow an entry across rescans by its file and citation key. */
const auditKey = (entry: AuditEntry) => `${entry.path}\0${entry.key}`;

function auditReport(scan: AuditScan, results: Record<number, AuditResult>, applied: Set<number>, kept: Set<number>): AuditReport {
  return scan.entries.flatMap((entry, index) => results[index]
    ? [[auditKey(entry), { snapshot: entry.bibtex, result: results[index], applied: applied.has(index), ...(kept.has(index) ? { kept: true } : {}) }]]
    : []);
}

/**
 * Carries prior results over to a fresh scan while an entry's BibTeX is
 * unchanged; `changed` decides what an edited entry shows instead.
 */
function carryOver(entries: AuditEntry[], prior: Map<string, SavedAudit>, changed?: (entry: AuditEntry, saved: SavedAudit) => AuditResult) {
  const results: Record<number, AuditResult> = {};
  const applied = new Set<number>();
  const kept = new Set<number>();
  entries.forEach((entry, index) => {
    const saved = prior.get(auditKey(entry));
    if (saved?.snapshot === entry.bibtex) {
      results[index] = saved.result;
      if (saved.applied) applied.add(index);
      if (saved.kept) kept.add(index);
    } else if (saved && changed) {
      results[index] = changed(entry, saved);
    }
  });
  return { results, applied, kept };
}

/** Without each index in `indexes`: a fresh result replaces what the writer did with the old one. */
const without = (indexes: Iterable<number>) => (previous: Set<number>) => {
  const next = new Set(previous);
  for (const index of indexes) next.delete(index);
  return next;
};

/** A collapsed section with the drawer's rotating chevron. */
function Disclosure(props: { className: string; summary: ReactNode; open?: boolean; children: ReactNode }) {
  return <details className={props.className} open={props.open}>
    <summary><ChevronRight size={12} className="bibliography-audit-chevron" />{props.summary}</summary>
    {props.children}
  </details>;
}

/**
 * Wide enough for the review queue's two panes: the list beside the finding
 * it has open. The sheet is the large dialog's width, so this follows the
 * window; narrower, an opened finding unfolds under its row.
 */
const QUEUE_QUERY = "(min-width: 800px)";
function subscribeQueueWidth(onChange: () => void) {
  const media = window.matchMedia(QUEUE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const isQueueWidth = () => window.matchMedia(QUEUE_QUERY).matches;

/** Source outcomes that mean the source never answered, rather than answered "no". */
const SILENT_OUTCOMES = new Set([
  "rate_limited", "queue_busy", "daily_quota", "blocked", "timeout", "connection_failed", "network",
  "unauthorized", "malformed", "forbidden", "upstream_rate_limit", "server_error", "unavailable",
]);
const isSilent = (outcome: string) => SILENT_OUTCOMES.has(outcome) || (outcome.startsWith("batch_") && outcome !== "batch_reused");

// This component stays mounted when hidden so a large audit doesn't block
// editing. Changing projects unmounts it and stops scheduling further work.
export function BibliographyAudit(props: {
  open: boolean;
  projectRoot: string;
  onClose: () => void;
  onPrepare: () => Promise<boolean>;
  onApply: (entry: AuditEntry, result: AuditResult) => Promise<void>;
  onApplied?: () => void;
  /** Opens a file at a line: an inline reference's `\bibitem`, a `.bib` entry. */
  onOpenSource?: (path: string, line: number) => void;
  /** The checks need the paper tools, and they are missing. */
  onMissingPaperTools?: (failure: string) => void;
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
  const [kept, setKept] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const run = useRef({ generation: 0, busy: false, stop: false });
  const [checkStartedAt, setCheckStartedAt] = useState("");
  const [checkCount, setCheckCount] = useState(0);
  /** The references the running check asked for, by `auditKey`; null while it checks them all. */
  const [checkKeys, setCheckKeys] = useState<Set<string> | null>(null);
  /** The finding open in the queue's pane, or unfolded under its row. */
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [view, setView] = useState<Bucket | "all">("all");
  const queue = useSyncExternalStore(subscribeQueueWidth, isQueueWidth, () => false);
  const rowButtons = useRef(new Map<number, HTMLButtonElement>());
  useEffect(() => () => { run.current.stop = true; cancelWait.current(); run.current.generation += 1; run.current.busy = false; }, []);

  useEffect(() => {
    if (!scan || loading) return;
    let disposed = false;
    void saveAuditReport(props.projectRoot, auditReport(scan, results, applied, kept)).then(
      () => { if (!disposed) setStorageFailed(false); },
      () => { if (!disposed) setStorageFailed(true); },
    );
    return () => { disposed = true; };
  }, [scan, results, applied, kept, loading, props.projectRoot]);

  const start = async (only?: number[]) => {
    if (!scan || loading || run.current.busy || applying !== null) return;
    const requested = only && new Set(only.map(index => auditKey(scan.entries[index])));
    const generation = ++run.current.generation;
    const current = () => run.current.generation === generation;
    run.current.busy = true;
    run.current.stop = false;
    setCheckStartedAt(new Date().toISOString());
    setCheckCount(only?.length ?? scan.entries.length);
    setCheckKeys(requested ?? null);
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
      const retained = carryOver(next.entries, new Map(auditReport(scan, results, applied, kept)));
      setResults(retained.results); setApplied(retained.applied); setKept(retained.kept); setSelected(new Set());
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
        const answered = indexes.filter((_, offset) => batch[offset]);
        setApplied(without(answered)); setKept(without(answered));
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
            // Every later entry would fail the same way: stop, and offer the install once.
            if (isMissingPaperToolsError(result.message) && current()) {
              if (!run.current.stop) props.onMissingPaperTools?.(result.message);
              run.current.stop = true;
            }
            if (current()) {
              setResults(previous => ({ ...previous, [indexes[offset]]: { ...result, checkedAt: new Date().toISOString() } }));
              setApplied(without([indexes[offset]])); setKept(without([indexes[offset]]));
            }
          }
        };
        // Cancellation drains the active group; no further group is scheduled.
        await Promise.all([worker(), worker()]);
        if (batchTask && !run.current.stop) await Promise.race([batchTask, cancelled]);
        if (current()) {
          setWaitingForS2(false);
          if (!run.current.stop) {
            const late = indexes.filter((_, offset) => batch[offset]);
            setApplied(without(late)); setKept(without(late));
          }
          // Apply batch proposals only to this run. Never let a late response
          // from a cancelled audit overwrite a new scan or reviewed result.
          // Read before the updater: a value an updater closes over cannot be reassigned.
          const failure = s2Failure;
          if (!run.current.stop) setResults(previous => {
            const updated = { ...previous };
            entries.forEach((_, offset) => {
              const result = batch[offset] ?? updated[indexes[offset]];
              if (!result) return;
              const checkedAt = batch[offset] ? new Date().toISOString() : updated[indexes[offset]]?.checkedAt;
              updated[indexes[offset]] = { ...result, checkedAt, ...(failure ? {
                sources: [...(result.sources ?? []).filter(source => source.source !== "semanticscholar"), { source: "semanticscholar", outcome: failure === "not_configured" ? "not_configured" : `batch_${failure}` }],
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
          setScan(value); setResults(restored.results); setApplied(restored.applied); setKept(restored.kept); setSelected(new Set());
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
    // eslint-disable-next-line react-hooks-js/exhaustive-deps
  }, [props.open]);

  // `applying` is the row being written, or -1 while applying every fix.
  // Resolves whether every write landed.
  const apply = async (indexes: number[], applyingIndex: number) => {
    if (!scan || loading || busy || applying !== null) return false;
    setApplying(applyingIndex); setError("");
    try {
      const generation = run.current.generation;
      for (const index of indexes) {
        if (run.current.generation !== generation) return false;
        await props.onApply(scan.entries[index], results[index]);
        setApplied(previous => new Set(previous).add(index));
        setScan(previous => previous && ({ ...previous, entries: previous.entries.map((entry, i) => i === index ? { ...entry, bibtex: results[index].after! } : entry) }));
      }
      return true;
    } catch (reason) { setError(String(reason)); return false; }
    finally { setApplying(null); props.onApplied?.(); }
  };

  const hasCandidate = (result?: AuditResult) => result?.candidate != null;
  /** A publisher's notice (a retraction, an expression of concern) on the work itself. */
  const hasNotice = (result?: AuditResult) => !!result?.health && !["unknown", "unavailable"].includes(result.health.kind);
  // Inline references are edited by hand; their verified record is shown for comparison only.
  const updates = Object.keys(results).map(Number).filter(index => !!results[index].after && !hasCandidate(results[index]) && results[index].status !== "conflict" && !applied.has(index) && !scan?.entries[index]?.inline);

  const total = scan?.entries.length ?? 0;
  const bucketOf = (index: number): Bucket => {
    const result = results[index];
    if (applied.has(index)) return "verified";
    if (!result) return "unchecked";
    // An unverified candidate, or a verified work under a publisher's notice, is the writer's call.
    if (hasCandidate(result) || (result.status === "checked" && hasNotice(result))) return kept.has(index) ? "kept" : "review";
    if (result.status === "update" && result.after) return "fix";
    // A search that found no such publication finished, but verified nothing.
    if (result.status === "checked" && result.publicationReason !== "no_match") return "verified";
    return "incomplete";
  };
  const buckets = scan ? scan.entries.map((_, index) => bucketOf(index)) : [];
  const counts = BUCKET_ORDER.reduce((tally, bucket) => ({ ...tally, [bucket]: buckets.filter(value => value === bucket).length }), {} as Record<Bucket, number>);
  // A filter whose last finding was resolved falls back to everything.
  const shownView = view !== "all" && counts[view] === 0 ? "all" : view;
  const shown = scan ? BUCKET_ORDER.flatMap(bucket => shownView === "all" || shownView === bucket
    ? scan.entries.flatMap((_, index) => buckets[index] === bucket ? [index] : [])
    : []) : [];
  const actionable = shown.filter(index => ACTIONABLE.has(buckets[index]));
  // Nothing left to act on: the queue opens on the finished report, not a verified row.
  const settled = !busy && total > 0 && counts.fix + counts.review + counts.incomplete + counts.unchecked === 0;
  const current = openIndex !== null && shown.includes(openIndex) ? openIndex
    : queue && !settled ? actionable[0] ?? shown[0] ?? null : null;
  // A bibliography of hundreds draws its rows as they come near the view,
  // and always as far as the open finding, which Next and Apply move to.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rows = useProgressiveRows({
    total: shown.length,
    reset: shownView,
    scroller: viewportRef,
    estimate: AUDIT_ROW_HEIGHT,
    atLeast: current === null ? 0 : shown.indexOf(current) + 1,
  });

  /** Opens `index` (or closes the open finding) and keeps its row in view and focused. */
  const openFinding = (index: number | null, focus = false) => {
    setOpenIndex(index);
    if (index === null || !focus) return;
    requestAnimationFrame(() => {
      const row = rowButtons.current.get(index);
      row?.scrollIntoView({ block: "nearest" });
      row?.focus({ preventScroll: true });
    });
  };
  /** The next finding to act on after `index`, in the list's order, else the first left. */
  const nextAfter = (index: number) => {
    const rest = actionable.filter(other => other !== index);
    const position = shown.indexOf(index);
    return rest.find(other => shown.indexOf(other) > position) ?? rest[0] ?? null;
  };
  const canApply = (index: number) => buckets[index] === "fix" && !scan?.entries[index]?.inline && !busy && applying === null;
  /** Applies one fix, then moves on to the next finding. */
  const applyAndAdvance = async (index: number) => {
    const next = nextAfter(index);
    if (await apply([index], index)) openFinding(next, true);
  };
  const keep = (index: number, value: boolean) => {
    setKept(previous => { const next = new Set(previous); if (value) next.add(index); else next.delete(index); return next; });
    if (value) openFinding(nextAfter(index), true);
  };

  // J and K walk the list, A or ⌘↩ applies the open fix, S skips to the next
  // finding. Keys typed into a field stay the field's.
  const keyState = useLatestRef({ shown, current, canApply, applyAndAdvance, nextAfter, openFinding });
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Focus inside the sheet, or nowhere once a click let it go; never another surface's.
      if (event.defaultPrevented || !target || (target !== document.body && !target.closest?.(".bibliography-audit"))) return;
      if (target.isContentEditable || target.closest("textarea, select, input:not([type=checkbox])")) return;
      const action = referenceCheckAction(event);
      if (!action) return;
      const state = keyState.current;
      const position = state.current === null ? -1 : state.shown.indexOf(state.current);
      if (action === "next" || action === "previous") {
        const next = state.shown[action === "next" ? Math.min(position + 1, state.shown.length - 1) : Math.max(position - 1, 0)];
        if (next === undefined) return;
        event.preventDefault();
        state.openFinding(next, true);
      } else if (action === "skip") {
        if (state.current === null) return;
        event.preventDefault();
        state.openFinding(state.nextAfter(state.current), true);
      } else if (state.current !== null && state.canApply(state.current)) {
        event.preventDefault();
        void state.applyAndAdvance(state.current);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props.open, keyState]);

  if (!props.open) return null;
  const completed = Object.values(results).filter(result => !busy || (result.checkedAt && result.checkedAt >= checkStartedAt)).length;
  const progressTotal = busy ? checkCount : total;
  const statusLabel = (result: AuditResult | undefined, inline: boolean) => !result ? t`Not checked`
    : result.status === "update" ? inline ? t`Differs from the verified record` : t`Update available`
      : result.publicationReason === "missing_identity" ? t`Reference lacks identifying metadata`
        : result.publicationReason === "no_match" ? t`No matching publication found`
      : result.status === "unavailable" ? result.publicationReason === "identity_conflict" ? t`Candidate does not match reference`
        : result.publicationReason === "metadata_unavailable" ? t`Independent metadata unavailable`
          : result.publicationReason === "sources_unavailable" ? t`Some sources unavailable`
            : result.publicationReason === "official_unavailable" ? t`Official verification incomplete`
            : t`Check incomplete`
        : result.status === "skipped" ? t`Not verified`
          : result.status === "conflict" ? t`Entry changed`
            : t`No update found`;
  const fieldLabels: Record<string, string> = {
    title: t`Title`, author: t`Authors`, year: t`Year`, journal: t`Journal`,
    booktitle: t`Booktitle`, publisher: t`Publisher`, volume: t`Volume`,
    number: t`Number`, pages: t`Pages`, doi: "DOI", url: t`URL`, ENTRYTYPE: t`Entry type`,
    venue: t`Venue`,
  };
  const fieldText = (field: string) => fieldLabels[field] ?? field;
  const publicationMessage = (result: AuditResult) => !result.publicationReason
    ? result.message === "A published version is available." ? t`A published version is available.`
      : result.message === REFERENCE_CHANGED_MESSAGE ? t`Reference changed since the last check. Check this reference again.`
      : result.message === "No update found." ? t`No update found` : auditResultMessage(result.message)
    : result.publicationReason === "identity_conflict" ? t`A source returned a possible record, but its identifying metadata conflicts with this reference.`
      : result.publicationReason === "metadata_unavailable" ? t`No independent metadata was available to verify a possible record. The reference may still be valid.`
        : result.publicationReason === "missing_identity" ? t`Add a title, full authors, and year, or add a DOI or arXiv identifier, before checking this reference.`
          : result.publicationReason === "no_match" || result.publicationReason === "no_published_version" ? t`No matching publication was found in the sources checked.`
      : result.publicationReason === "sources_unavailable" ? t`Some sources could not complete the lookup. This does not mean the reference is incorrect.`
        : result.publicationReason === "official_unavailable" ? t`An index matched this reference, but the official proceedings could not be reached to confirm it. This does not mean the reference is incorrect.`
        : result.publicationReason === "ambiguous" ? t`The results did not identify a unique matching publication.`
          : t`The publication lookup could not be completed. Try again later.`;
  const sourceNames: Record<string, string> = {
    dblp: t`DBLP`, semanticscholar: t`Semantic Scholar`, googlescholar: t`Google Scholar`,
    crossref: t`Crossref`, unpaywall: t`Unpaywall`, openalex: t`OpenAlex`,
  };
  const sourceName = (source: string) => sourceNames[source] ?? auditSourceName(source);
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
    record: t`Record identity`, arxiv: t`arXiv identifier`,
  };
  const bucketNames: Record<Bucket, string> = {
    fix: t`Fixes to review`, review: t`Need your eyes`, incomplete: t`Couldn't finish`,
    unchecked: t`Not checked yet`, kept: t`Kept as written`, verified: t`Verified`,
  };
  const coverage = scan?.coverage ?? [];
  const lastChecked = Object.values(results).map(result => result.checkedAt ?? "").filter(Boolean).sort().at(-1);
  const list = (items: string[]) => items.join(i18n.locale.startsWith("zh") ? "、" : ", ");

  // The report's first line says what the writer has to do, in the title's serif.
  const findings = [
    counts.fix > 0 && (counts.fix === 1 ? t`1 fix to review` : t`${counts.fix} fixes to review`),
    counts.review > 0 && (counts.review === 1 ? t`1 needs your eyes` : t`${counts.review} need your eyes`),
  ].filter(Boolean).join(" · ");
  const leftOver = [
    counts.incomplete > 0 && t`${counts.incomplete} couldn't finish`,
    counts.unchecked > 0 && t`${counts.unchecked} not checked`,
  ].filter(Boolean).join(" · ");
  const verdict = busy ? scan ? t`Checking ${completed} of ${progressTotal}…` : t`Reading the bibliography…`
    : !scan ? loading ? t`Reading the bibliography…` : t`Check references`
      : total === 0 ? t`No references to check`
        : counts.unchecked === total ? total === 1 ? t`1 reference, not checked yet` : t`${total} references, not checked yet`
          : findings || (leftOver ? t`Nothing to fix · ${leftOver}`
            : counts.kept > 0 ? t`Nothing left to review · ${counts.kept} kept as written`
              : total === 1 ? t`The reference is verified` : t`All ${total} references verified`);

  /** One line saying what a finding is about before it is opened. */
  const summaryOf = (index: number): string => {
    const result = results[index];
    const entry = scan!.entries[index];
    const bucket = buckets[index];
    if (!result || bucket === "verified" || bucket === "unchecked") return "";
    if (bucket === "kept") return hasCandidate(result) ? t`You kept your entry over an unverified record` : t`You read the publisher's notice and kept citing it`;
    if (bucket === "review" && !hasCandidate(result)) return "";
    if (bucket === "review") {
      const reasons = result.candidate?.reasons;
      return Array.isArray(reasons) && reasons.length
        ? t`${list(reasons.map(reason => reasonLabels[reason] ?? reason))} differ from a source's record`
        : statusLabel(result, !!entry.inline);
    }
    if (bucket === "fix") {
      const fields = list(result.changes.map(change => fieldText(change.field).toLocaleLowerCase(i18n.locale)));
      if (entry.inline) return t`Your ${BIBITEM} differs: ${fields}`;
      const venue = result.changes.find(change => ["booktitle", "journal"].includes(change.field) && change.after);
      if (venue && result.changes.some(change => change.field === "ENTRYTYPE")) {
        const published = venue.after.replace(/[{}]/g, "");
        return t`Published version: ${published}`;
      }
      if (result.changes.length === 1) {
        const [change] = result.changes;
        const before = (change.before || "—").replace(/--/g, "–");
        const after = (change.after || "—").replace(/--/g, "–");
        return `${fieldText(change.field)} ${before} → ${after}`;
      }
      return t`Updates ${fields}`;
    }
    if (result.status === "conflict") return t`Changed since the last check`;
    const silent = [...new Set((result.sources ?? []).filter(source => isSilent(source.outcome)).map(source => sourceName(source.source)))];
    return silent.length ? t`No answer from ${list(silent)}` : statusLabel(result, !!entry.inline);
  };

  // Each state has its own shape as well as its colour (see `.bibliography-audit-mark`).
  const glyph = (state: Mark) => state === "verified" || state === "kept" ? <Check size={12} strokeWidth={2.5} />
    : state === "fix" ? <X size={12} strokeWidth={2.5} />
      : state === "review" ? <span>!</span>
        : state === "incomplete" ? <span>?</span>
          : <svg className="bibliography-audit-ring" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
            {state === "checking" && <circle className="bibliography-audit-mark-track" cx="8" cy="8" r="6.25" />}
            <circle cx="8" cy="8" r="6.25" strokeDasharray={state === "checking" ? "11 28.3" : "2.45 2.46"} strokeLinecap={state === "checking" ? "round" : undefined} />
          </svg>;
  const mark = (state: Mark) => <span className="bibliography-audit-mark" data-mark={state} aria-hidden="true">{glyph(state)}</span>;
  /** Waiting on the running check: not yet answered since it started. */
  const isChecking = (index: number) => {
    const checkedAt = results[index]?.checkedAt;
    return busy && (!checkKeys || checkKeys.has(auditKey(scan!.entries[index]))) && !(checkedAt && checkedAt >= checkStartedAt);
  };

  const sources = (result: AuditResult) => !!result.sources?.length && <dl className="bibliography-audit-sources">
    {result.sources.map(source => <div key={source.source}>
      <dt>{sourceName(source.source)}</dt>
      <dd>{sourceOutcome(result, source.outcome)}</dd>
    </div>)}
  </dl>;
  const healthNotice = (result: AuditResult) => {
    const health = result.health;
    const notice = health && !["unknown", "unavailable"].includes(health.kind);
    const link = health?.link && /^https?:\/\//i.test(health.link) ? health.link : undefined;
    if (!health || (!notice && !link)) return null;
    return <div className="bibliography-audit-notice" data-tone={!notice ? "neutral" : health.kind === "retracted" ? "danger" : "warning"}>
      {notice && <p><AlertTriangle size={13} aria-hidden="true" />{t`Publisher notice`}: {health.updateType || health.kind}</p>}
      {link && <a href={link} onClick={(event) => {
        event.preventDefault();
        void openUrl(link).catch(reason => setError(String(reason)));
      }}>{t`Open notice`}<ExternalLink size={12} aria-hidden="true" /></a>}
    </div>;
  };
  /** The verdict's reasoning: the sources asked, what they said, and when; `message` unless the finding already says it. */
  const details = (result: AuditResult, message: boolean) => <Disclosure className="bibliography-audit-more" summary={t`Details`}>
    <div className="bibliography-audit-more-body">
      {message && <p>{publicationMessage(result)}</p>}
      {sources(result)}
      {!!result.disagreements?.length && <p>{t`The conference's own citation export and Crossref disagree on: ${result.disagreements.map(fieldText).join(", ")}. The conference export is kept.`}</p>}
      {result.health && <p className="bibliography-audit-meta">{t`Health checked at`}: <time dateTime={result.health.checkedAt}>{new Date(result.health.checkedAt).toLocaleString(i18n.locale)}</time>{result.health.stale ? ` · ${t`Stale result`}` : ""}</p>}
      {result.checkedAt && <p className="bibliography-audit-meta">{t`Last checked`}: <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString(i18n.locale)}</time></p>}
    </div>
  </Disclosure>;
  /** The printed reference with its fix marked, and what print does not show. */
  const typesetCard = (fix: TypesetFix) => <>
    <div className="bibliography-audit-typeset"><InlineEdits text={fix.text} edits={fix.edits} /></div>
    {fix.unprinted.length > 0 && <p className="bibliography-audit-note">{t`Also changes: ${list(fix.unprinted)}`}</p>}
  </>;
  /** Where the open finding sits among those like it; choosing it moves on. */
  const step = (index: number) => {
    const peers = shown.filter(other => buckets[other] === buckets[index]);
    const next = nextAfter(index);
    const position = peers.indexOf(index) + 1;
    return peers.length > 1 && <button type="button" className="bibliography-audit-step" disabled={next === null} aria-label={t`Next finding`} onClick={() => openFinding(next, true)}>
      {t`${position} of ${peers.length}`}<ArrowDown size={11} aria-hidden="true" />
    </button>;
  };
  const skip = (index: number) => {
    const next = nextAfter(index);
    return next !== null && <Button size="compact" variant="ghost" onClick={() => openFinding(next, true)}>{t`Skip`}</Button>;
  };
  const goTo = (entry: AuditEntry, label: string, variant: "tinted" | "ghost") => props.onOpenSource && entry.line !== undefined
    && <Button size="compact" variant={variant} onClick={() => props.onOpenSource!(entry.path, entry.line!)}>{label}</Button>;
  const recheck = (index: number, label: string) => <Button size="compact" variant="ghost" disabled={busy || applying !== null} onClick={() => void start([index])}>
    <RotateCcw size={12} aria-hidden="true" />{label}
  </Button>;
  const bibtex = (label: string | null, text: string) => <div className="bibliography-audit-source">{label && <span>{label}</span>}<pre>{text}</pre></div>;

  /** The open finding: the change as printed, what to do about it, and the evidence. */
  const detailFor = (index: number) => {
    const entry = scan!.entries[index];
    const result = results[index];
    const bucket = buckets[index];
    const isApplied = applied.has(index);
    // The scan is the source of truth until an accepted proposal is written.
    // Candidate records are comparison-only and must never displace it.
    const currentBibtex = isApplied && result?.after && !hasCandidate(result) ? result.after : entry.bibtex;
    const writtenLabel = entry.inline ? t`Reference as written` : t`Current BibTeX`;
    const writtenText = entry.inline ?? currentBibtex;
    const written = <Disclosure className="bibliography-audit-more" summary={writtenLabel}>{bibtex(null, writtenText)}</Disclosure>;
    if (!result) return <div className="bibliography-audit-detail">
      <p className="bibliography-audit-note">{t`This reference has not been checked against the publication sources yet.`}</p>
      <div className="bibliography-audit-detail-actions">{recheck(index, t`Check this reference`)}</div>
      {written}
    </div>;
    const candidate = result.candidate && typeof result.candidate === "object"
      && Array.isArray(result.candidate.changes) && Array.isArray(result.candidate.reasons)
      ? result.candidate : undefined;
    return <div className="bibliography-audit-detail">
      {bucket === "fix" && !entry.inline && <>
        {typesetCard(typesetBibFix(entry.bibtex, result.after!, result.changes, fieldText))}
        <div className="bibliography-audit-detail-actions">
          {/* eslint-disable-next-line lingui/no-unlocalized-strings -- key names for assistive tech, from REFERENCE_CHECK_SHORTCUTS */}
          <Button size="compact" variant="tinted" disabled={!canApply(index)} aria-keyshortcuts="A Meta+Enter" onClick={() => void applyAndAdvance(index)}>
            {applying === index ? <InfinityLoader size={12} /> : <Check size={12} aria-hidden="true" />}{t`Apply`}
            <span aria-hidden="true">{renderKeycaps(comboKeys(parseKeyName(REFERENCE_CHECK_SHORTCUTS.applyChord.key)), "bibliography-audit-shortcut", "run")}</span>
          </Button>
          {skip(index)}
          {step(index)}
        </div>
      </>}
      {bucket === "fix" && entry.inline && <>
        {typesetCard(typesetInlineFix(entry.inline, result.changes, fieldText))}
        <p className="bibliography-audit-note">{t`${entry.path} keeps its own reference list. Lattice compares it with the verified record but never edits it: change the ${BIBITEM} by hand, or copy the corrected one.`}</p>
        <div className="bibliography-audit-detail-actions">
          {goTo(entry, t`Go to ${BIBITEM} in ${entry.path}`, "tinted")}
          <CopyButton className={buttonClassName({ variant: "ghost", size: "compact" })} iconSize={12} text={correctedBibitem(entry.key, entry.inline, result.after!, result.changes)} title={t`Copy corrected ${BIBITEM}`}>
            {t`Copy corrected ${BIBITEM}`}
          </CopyButton>
          {skip(index)}
          {step(index)}
        </div>
      </>}
      {bucket === "fix" && <Disclosure className="bibliography-audit-more" summary={t`Fields and BibTeX`}>
        <div className="bibliography-audit-more-body">
          <dl className="bibliography-audit-fields">{result.changes.map(change => <div key={change.field}>
            <dt>{fieldText(change.field)}</dt>
            <dd><del>{change.before || "—"}</del><ArrowRight size={11} aria-label={t`becomes`} /><ins>{change.after || "—"}</ins></dd>
          </div>)}</dl>
          {bibtex(entry.inline ? t`Verified record (BibTeX)` : t`Proposed BibTeX`, result.after!)}
          {bibtex(writtenLabel, writtenText)}
        </div>
      </Disclosure>}
      {(bucket === "review" || bucket === "kept") && <>
        <p className="bibliography-audit-note">{!hasCandidate(result)
          ? bucket === "kept" ? t`You read the publisher's notice and kept citing this paper.` : t`The publisher has issued a notice about this paper. Read it before you keep citing it.`
          : bucket === "kept"
            ? t`You kept your entry. The source's record was not verified, and Lattice never applies it.`
            : t`A source returned a record that differs from yours. It was not verified, so Lattice won't apply it: read both and keep yours, or edit the entry.`}</p>
        {!hasCandidate(result) && healthNotice(result)}
        {candidate && candidate.changes.map((change, changeIndex) => {
          const words = wordDifference(change.before || "—", change.after || "—");
          const source = result.sources?.find(item => item.outcome.startsWith("candidate"))?.source;
          return <div key={`${change.field}:${changeIndex}`} className="bibliography-audit-compare">
            <p className="bibliography-audit-compare-field">{fieldText(change.field)}</p>
            <div><span>{t`Yours`}</span><p>{words.ours.map((word, i) => word.differs ? <mark key={i}>{word.word}</mark> : word.word)}</p></div>
            <div><span>{source ? t`Source · ${sourceName(source)} · not verified` : t`Source · not verified`}</span><p>{words.theirs.map((word, i) => word.differs ? <mark key={i}>{word.word}</mark> : word.word)}</p></div>
          </div>;
        })}
        {candidate && candidate.reasons.length > 0 && <p className="bibliography-audit-note">{t`Conflicting or insufficient fields`}: {list(candidate.reasons.map(reason => reasonLabels[reason] ?? reason))}</p>}
        <div className="bibliography-audit-detail-actions">
          {bucket === "review"
            ? <Button size="compact" variant="tinted" onClick={() => keep(index, true)}><Check size={12} aria-hidden="true" />{t`Keep mine`}</Button>
            : <Button size="compact" variant="ghost" onClick={() => keep(index, false)}>{t`Review again`}</Button>}
          {goTo(entry, entry.inline ? t`Go to ${BIBITEM} in ${entry.path}` : t`Open entry`, "ghost")}
          {bucket === "review" && skip(index)}
          {bucket === "review" && step(index)}
        </div>
        {candidate?.bibtex && <Disclosure className="bibliography-audit-more" summary={t`Unverified candidate BibTeX`}>{bibtex(null, candidate.bibtex)}</Disclosure>}
      </>}
      {bucket === "incomplete" && <>
        <p className="bibliography-audit-note">{publicationMessage(result)}</p>
        {sources(result)}
        <div className="bibliography-audit-detail-actions">{recheck(index, t`Check again`)}</div>
      </>}
      {bucket === "verified" && <>
        <p className="bibliography-audit-note">{isApplied ? t`Applied. The entry now matches the verified record.` : publicationMessage(result)}</p>
        <div className="bibliography-audit-detail-actions">{recheck(index, t`Check again`)}</div>
      </>}
      {!((bucket === "review" || bucket === "kept") && !hasCandidate(result)) && healthNotice(result)}
      {bucket !== "incomplete" && details(result, bucket !== "verified")}
      {bucket !== "fix" && written}
    </div>;
  };

  const selectable = !busy && applying === null;
  const segments = (["verified", "kept", "fix", "review", "incomplete", "unchecked"] as const).filter(bucket => counts[bucket] > 0);
  const tabs = [
    { value: "all", label: <>{t`All`}<span className="bibliography-audit-tab-count">{total}</span></> },
    ...BUCKET_ORDER.filter(bucket => counts[bucket] > 0).map(bucket => ({
      value: bucket,
      label: <>{mark(bucket)}{bucketNames[bucket]}<span className="bibliography-audit-tab-count">{counts[bucket]}</span></>,
    })),
  ];
  const hints = (["next", "previous", "apply", "skip"] as const).map(action => {
    const { key, label } = REFERENCE_CHECK_SHORTCUTS[action];
    return <span key={action}>{renderKeycaps(comboKeys(parseKeyName(key)))}{i18n._(label)}</span>;
  });
  // Nothing left to act on: the research desk's reading glass says the report is done.
  const cleanNote = settled && <div className="bibliography-audit-clean">
    <ResearchArt drawing={REFERENCE_CHECK} />
    <p>{counts.kept > 0
      ? t`Nothing left to review. Every other reference matched a verified record.`
      : t`Every reference matched a verified record. Check again after you edit the bibliography.`}</p>
  </div>;
  // A running check or a selection waiting to be applied must survive a stray click outside.
  const dirty = busy || applying !== null || selected.size > 0;
  return <SheetDialog className="bibliography-audit" label={t`Check references`} dirty={dirty} onClose={props.onClose}>
    <PanelHeader className="drawer-header" icon={<ClipboardCheck size={16} />} title={t`Check references`} onClose={props.onClose} />
    <div className="bibliography-audit-overview">
      <div className="bibliography-audit-verdict-row">
        <h2 className="bibliography-audit-verdict" role="status">{busy && <InfinityLoader size={16} />}<span>{verdict}</span></h2>
        <div className="bibliography-audit-actions">
          {busy
            ? <Button size="compact" variant="ghost" disabled={stopping} onClick={() => { run.current.stop = true; cancelWait.current(); setStopping(true); }}>{stopping ? t`Stopping…` : t`Cancel check`}</Button>
            : <Button size="compact" variant="ghost" onClick={() => void start()} disabled={!scan || loading || applying !== null}><RotateCcw size={12} aria-hidden="true" />{counts.unchecked === total ? t`Check all` : t`Check again`}</Button>}
          {updates.length > 0 && !busy && <Button size="compact" variant="tinted" disabled={applying !== null} onClick={() => void apply(updates, -1)}>
            {applying === -1 ? <InfinityLoader size={12} /> : <Check size={12} aria-hidden="true" />}{updates.length === 1 ? t`Apply 1 fix` : t`Apply ${updates.length} fixes`}
          </Button>}
        </div>
      </div>
      {(coverage.length > 0 || lastChecked) && <p className="bibliography-audit-coverage">
        {coverage.map((file, index) => <Fragment key={`${file.kind}:${file.path}`}>
          {index > 0 && " · "}
          <span className="bibliography-audit-file">{file.path}</span> {file.kind === "inline"
            ? file.entries === 1 ? t`1 ${BIBITEM} in the document, compared, never edited` : t`${file.entries} ${BIBITEM} in the document, compared, never edited`
            : file.entries === 1 ? t`1 entry` : t`${file.entries} entries`}
        </Fragment>)}
        {lastChecked && !busy && <>{coverage.length > 0 && " · "}{t`checked`} <time dateTime={lastChecked}>{new Date(lastChecked).toLocaleString(i18n.locale, { dateStyle: "medium", timeStyle: "short" })}</time></>}
      </p>}
      {waitingForS2 && <p className="bibliography-audit-coverage" role="status">{t`Partial results for ${completed} of ${progressTotal} references`} · {t`Waiting for Semantic Scholar…`}</p>}
      {scan && total > 0 && (busy || counts.unchecked < total) && <div
        className="bibliography-audit-bar"
        role="progressbar"
        aria-label={t`Reference check progress`}
        aria-valuemin={0}
        aria-valuemax={Math.max(progressTotal, 1)}
        aria-valuenow={waitingForS2 ? undefined : busy ? completed : total - counts.unchecked}
      >
        {segments.map(bucket => <span key={bucket} data-bucket={bucket} style={{ flexGrow: counts[bucket] }} />)}
      </div>}
      {scan && total > 0 && counts.unchecked < total && <SlidingTabs
        className="bibliography-audit-tabs"
        tabClassName="bibliography-audit-tab"
        ariaLabel={t`Show`}
        value={shownView}
        onChange={(value) => { setView(value as Bucket | "all"); }}
        items={tabs}
      />}
      {selected.size > 0 && scan && <div className="bibliography-audit-selection">
        <CheckboxField className="bibliography-audit-select-all" label={t`Select all`} aria-label={t`Select all references`} disabled={!selectable} checked={selected.size === total} indeterminate={selected.size < total} onChange={event => setSelected(event.target.checked ? new Set(scan.entries.map((_, index) => index)) : new Set())} />
        <span className="bibliography-audit-selection-count">{t`${selected.size} selected`}</span>
        <Button size="compact" variant="ghost" disabled={!selectable} onClick={() => void start([...selected])}>{t`Check selected`}</Button>
        <Button size="compact" variant="ghost" onClick={() => setSelected(new Set())}>{t`Clear`}</Button>
      </div>}
      {!queue && cleanNote}
    </div>
    <div className="bibliography-audit-body" data-layout={queue ? "queue" : "list"}>
    <ScrollArea className="bibliography-audit-scroll" viewportClassName="bibliography-audit-viewport" viewportRef={viewportRef}>
    <div className="bibliography-audit-results">
    {error && <p role="alert" className="bibliography-audit-alert" data-tone="danger">{error}</p>}
    {storageFailed && <p role="alert" className="bibliography-audit-alert">{t`Could not save the report on this device. Keep this window open to retain the results.`}</p>}
    {scan && scan.issues.length > 0 && shownView === "all" && <Disclosure className="bibliography-audit-local"
      summary={<><AlertTriangle size={13} aria-hidden="true" /><span>{scan.issues.length === 1 ? t`1 thing to tidy in the bibliography` : t`${scan.issues.length} things to tidy in the bibliography`}</span></>}>
      <ul>{scan.issues.map((issue, index) => <li key={index}><code>{issue.path}{issue.key ? ` · ${issue.key}` : ""}</code><p>{auditIssueText(issue)}</p></li>)}</ul>
    </Disclosure>}
    {shown.slice(0, rows.shown).map((index, position) => {
      const entry = scan!.entries[index];
      const result = results[index];
      const bucket = buckets[index];
      const isApplied = applied.has(index);
      const open = current === index;
      const summary = summaryOf(index);
      const checking = isChecking(index);
      // The mark's name, as its tooltip and for a screen reader unless the summary already says it.
      const status = checking ? t`Checking…` : isApplied ? t`Update applied` : bucket === "kept" ? t`Kept as written` : statusLabel(result, !!entry.inline);
      const health = result?.health;
      const notice = health && !["unknown", "unavailable"].includes(health.kind);
      const head = shownView === "all" && (position === 0 || buckets[shown[position - 1]] !== bucket);
      return <Fragment key={`${entry.path}:${entry.key}:${index}`}>
        {head && <h3 className="bibliography-audit-group">{mark(bucket)}{bucketNames[bucket]}<span>{counts[bucket]}</span></h3>}
        <article className="bibliography-audit-row" data-bucket={bucket} data-open={open || undefined} data-selecting={selected.size > 0 || undefined}>
          <Checkbox className="bibliography-audit-check" aria-label={t`Select ${entry.key}`} checked={selected.has(index)} disabled={!selectable} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(index); else next.delete(index); return next; })} />
          <span className="bibliography-audit-glyph" title={status}>{mark(checking ? "checking" : bucket)}{status !== summary && <span className="sr-only">{status}</span>}</span>
          <button
            type="button"
            className="bibliography-audit-open"
            ref={node => { if (node) rowButtons.current.set(index, node); else rowButtons.current.delete(index); }}
            aria-expanded={queue ? undefined : open}
            aria-current={queue && open ? "true" : undefined}
            onClick={() => openFinding(open && !queue ? null : index)}
          >
            <span className="bibliography-audit-title" title={entry.title || entry.key}>{entry.title || entry.key}</span>
            <span className="bibliography-audit-meta">
              <code>{entry.key}</code> · {entry.path}{entry.line !== undefined ? `:${entry.line}` : ""}
              {entry.inline && <span className="bibliography-audit-tag">{BIBITEM}</span>}
              {isApplied && <span className="bibliography-audit-tag" data-tone="success"><Check size={11} aria-hidden="true" />{t`Applied`}</span>}
            </span>
            {summary && <span className="bibliography-audit-summary">{summary}</span>}
            {notice && <span className="bibliography-audit-health" data-tone={health.kind === "retracted" ? "danger" : "warning"}><AlertTriangle size={12} aria-hidden="true" />{t`Publisher notice`}: {health.updateType || health.kind}</span>}
          </button>
          <div className="bibliography-audit-row-actions">
            {!queue && !open && bucket === "fix" && !entry.inline && <Button size="compact" variant="tinted" disabled={!canApply(index)} onClick={() => void applyAndAdvance(index)}>
              {applying === index ? <InfinityLoader size={12} /> : null}{t`Apply`}
            </Button>}
            <ChevronRight size={14} className="bibliography-audit-row-chevron" aria-hidden="true" />
          </div>
          {!queue && open && detailFor(index)}
        </article>
      </Fragment>;
    })}
    {rows.spacer && <div className="bibliography-audit-rest" {...rows.spacer} />}
    </div>
    </ScrollArea>
    {queue && <section className="bibliography-audit-pane" aria-label={t`Open finding`}>
      {current !== null && scan ? <>
        <p className="bibliography-audit-pane-step">{bucketNames[buckets[current]]}</p>
        <h3 className="bibliography-audit-pane-title">{scan.entries[current].title || scan.entries[current].key}</h3>
        <p className="bibliography-audit-meta"><code>{scan.entries[current].key}</code> · {scan.entries[current].path}{scan.entries[current].line !== undefined ? `:${scan.entries[current].line}` : ""}</p>
        {detailFor(current)}
        <p className="bibliography-audit-hints">{hints}</p>
      </> : cleanNote || (scan && total > 0 && <p className="bibliography-audit-pane-empty">{t`Choose a reference to see what was checked.`}</p>)}
    </section>}
    </div>
  </SheetDialog>;
}
