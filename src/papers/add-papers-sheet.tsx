/**
 * Add papers: one sheet for every way of adding. Paste anything — DOIs, arXiv
 * IDs, links, titles or BibTeX, one per line or a whole .bib — and each
 * reference becomes a card, looked up as it lands. What the library already
 * holds is set aside, a title that matches more than one record waits for a
 * choice, and nothing is written until the writer adds; then each paper
 * imports in turn with its own progress, and the sheet can close while the
 * writer keeps writing.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { BookMarked, Check, CircleAlert, CircleDot, PenLine, Plus } from "lucide-react";
import type { PaperSummary } from "../app-types";
import type { PaperAddItem } from "../app/use-reference-import";
import { Button } from "../components/ui/button";
import { PanelHeader } from "../components/ui/panel-header";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { ResearchArt } from "../components/ui/research-art";
import { CATALOGUE_DRAWER } from "../components/ui/research-art-catalogue-drawer";
import { InfinityLoader } from "../components/ui/activity-icons";
import { CopyButton } from "../components/copy-button";
import { toMessage } from "../app-utils";
import type { ResolvedCitationDraft } from "./bib-entry-dialog";
import { CitationCandidates } from "./citation-candidates";
import {
  bylineOf, findInLibrary, identityOfInput, parsePastedReferences, recordOfResolved,
  type PastedReference, type ReferenceKind,
} from "./paper-add";
import { paperShortAuthors } from "./paper-identity";
import "./add-papers-sheet.css";

/** One of each kind the box reads; identifiers and BibTeX read the same in every locale, and so does a cited title. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- examples of what to paste, not prose
const PASTE_EXAMPLE = "10.1038/s41586-021-03819-2\narXiv:1706.03762\nhttps://aclanthology.org/…\nAttention is all you need\n@article{…}";

/** Lookups run a few at a time: a pasted .bib of titles must not fire a hundred requests at once. */
const LOOKUPS_AT_ONCE = 3;

type Lookup =
  | { state: "done"; resolved: ResolvedCitationDraft }
  | { state: "failed"; error: string };

type RowState = "resolving" | "new" | "duplicate" | "choose" | "failed";
type Tab = "all" | "new" | "duplicate" | "choose";

type Row = {
  reference: PastedReference;
  state: RowState;
  title: string;
  byline: string;
  /** The paper already in the library. */
  existing?: PaperSummary;
  candidates?: ResolvedCitationDraft[];
  /** What the import is given once the writer adds. */
  importInput?: string;
  /** Why the lookup failed. */
  error?: string;
};

export function AddPapersSheet(props: {
  seed: string;
  papers: readonly PaperSummary[];
  /** The batch being added, kept while it runs even if the sheet closed and reopened. */
  queue: readonly PaperAddItem[];
  /** Another import holds the pipeline (the Papers box, Find literature). */
  importing: boolean;
  onResolve: (query: string) => Promise<ResolvedCitationDraft>;
  onAdd: (items: Array<Pick<PaperAddItem, "id" | "input" | "label">>) => void;
  onStop: () => void;
  onEnterManually: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState(props.seed);
  // The box is read once typing pauses (a paste at once), so a half-typed
  // DOI is not looked up letter by letter.
  const [settled, setSettled] = useState(props.seed);
  useEffect(() => {
    if (text === settled) return;
    const timer = window.setTimeout(() => setSettled(text), 450);
    return () => window.clearTimeout(timer);
  }, [settled, text]);
  const references = useMemo(() => parsePastedReferences(settled), [settled]);
  const [lookups, setLookups] = useState<Record<string, Lookup>>({});
  // Lookups sent and not yet answered; their rows read as looking up meanwhile.
  const pendingRef = useRef(new Set<string>());
  // The record the writer chose for a title that matched several, by row.
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [choosing, setChoosing] = useState<{ id: string; index: number } | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const rows: Row[] = useMemo(() => references.map((reference): Row => {
    const fromLibrary = (paper: PaperSummary): Row => ({
      reference,
      state: "duplicate",
      existing: paper,
      title: paper.title,
      byline: bylineOf([paperShortAuthors(paper), paper.year]),
    });
    if (reference.record) {
      const existing = findInLibrary(props.papers, reference.record.identity);
      return existing ? fromLibrary(existing) : { reference, state: "new", ...reference.record, importInput: reference.input };
    }
    // An identifier the library already holds needs no lookup.
    const known = reference.kind === "title" ? undefined : findInLibrary(props.papers, identityOfInput(reference.input));
    if (known) return fromLibrary(known);
    const lookup = lookups[reference.id];
    if (!lookup) return { reference, state: "resolving", title: reference.label, byline: t`Looking up…` };
    if (lookup.state === "failed") return { reference, state: "failed", title: reference.label, byline: t`Couldn't find this one`, error: lookup.error };
    const { resolved } = lookup;
    const candidates = resolved.candidates?.length ? resolved.candidates : undefined;
    const pick = candidates?.[chosen[reference.id] ?? -1];
    if (candidates && !pick) {
      return {
        reference, state: "choose", candidates,
        title: reference.label,
        byline: candidates.length === 1 ? t`One record matches` : t`${candidates.length} records match`,
      };
    }
    const record = recordOfResolved(pick ?? resolved);
    const existing = findInLibrary(props.papers, record.identity);
    if (existing) return fromLibrary(existing);
    // An identifier imports as itself, so the pipeline can still fetch its
    // full text; a title imports as the record it resolved to, never as a
    // second search that could land on another work.
    const importInput = reference.kind === "title" || pick ? (pick ?? resolved).bibtex : reference.input;
    return { reference, state: "new", title: record.title || reference.label, byline: record.byline, candidates, importInput };
  }), [chosen, lookups, props.papers, references, t]);

  // Look up what still needs it, a few at a time; each answer re-renders
  // the rows, which starts the next.
  const { onResolve } = props;
  useEffect(() => {
    const pending = pendingRef.current;
    const waiting = rows.filter((row) => row.state === "resolving" && !pending.has(row.reference.id));
    for (const { reference } of waiting.slice(0, Math.max(0, LOOKUPS_AT_ONCE - pending.size))) {
      pending.add(reference.id);
      const answer = (lookup: Lookup) => {
        pending.delete(reference.id);
        if (mounted.current) setLookups((current) => ({ ...current, [reference.id]: lookup }));
      };
      onResolve(reference.input).then(
        (resolved) => answer({ state: "done", resolved }),
        (reason: unknown) => answer({ state: "failed", error: toMessage(reason) }),
      );
    }
  }, [onResolve, rows]);

  const queued = props.queue.length > 0;
  const adding = props.queue.some((item) => item.state === "waiting" || item.state === "adding");
  const progress = new Map(props.queue.map((item) => [item.id, item]));
  const count = (state: RowState) => rows.filter((row) => row.state === state).length;
  const counts = { all: rows.length, new: count("new"), duplicate: count("duplicate"), choose: count("choose") };
  const resolving = count("resolving");
  const failed = count("failed");
  const addable = rows.filter((row) => row.state === "new" && row.importInput);
  const shown = tab === "all" ? rows : rows.filter((row) => row.state === tab);
  const tabs: Array<[Tab, string]> = [["all", t`All`], ["new", t`New`], ["duplicate", t`Already in Papers`], ["choose", t`Choose one`]];
  const kindLabels: Record<ReferenceKind, string> = { arxiv: "arXiv", doi: "DOI", url: t`Link`, bibtex: "BibTeX", title: t`Title` };

  const add = () => {
    if (!addable.length || adding || props.importing) return;
    props.onAdd(addable.map((row) => ({ id: row.reference.id, input: row.importInput ?? row.reference.input, label: row.title })));
  };
  const moveTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const at = tabs.findIndex(([id]) => id === tab);
    const next = Number.isFinite(step) ? (at + step + tabs.length) % tabs.length : step > 0 ? tabs.length - 1 : 0;
    setTab(tabs[next][0]);
    event.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  };

  // While a batch runs (or once it ran), the sheet shows the batch: the rows
  // it was added from, or, reopened later, the queue's own labels.
  const batch = queued
    ? props.queue.map((item) => rows.find((row) => row.reference.id === item.id)
      ?? { reference: { id: item.id, kind: "title" as const, input: item.input, label: item.label }, state: "new" as const, title: item.label, byline: "" })
    : null;
  const listed = batch ?? shown;
  const done = props.queue.filter((item) => item.state === "added").length;
  const position = props.queue.findIndex((item) => item.state === "adding") + 1;

  const summary = queued
    ? adding
      ? t`Adding ${position || done + 1} of ${props.queue.length} — you can keep writing`
      : done === props.queue.length
        ? done === 1 ? t`Added 1 paper` : t`Added ${done} papers`
        : t`Added ${done} of ${props.queue.length}`
    : [
        counts.duplicate === 1 ? t`1 already in Papers is skipped` : counts.duplicate ? t`${counts.duplicate} already in Papers are skipped` : "",
        counts.choose === 1 ? t`1 waits for your choice` : counts.choose ? t`${counts.choose} wait for your choice` : "",
        failed === 1 ? t`1 not found` : failed ? t`${failed} not found` : "",
        resolving ? t`Looking up ${resolving}…` : "",
      ].filter(Boolean).join(" · ");

  const stateOf = (row: Row) => {
    const item = progress.get(row.reference.id);
    if (item) {
      if (item.state === "added") {
        return (
          <span className="add-papers-state" data-tone="done">
            <Check size={12} aria-hidden="true" />
            {t`Added`}
            {item.citationKey && <CiteCopy citationKey={item.citationKey} />}
          </span>
        );
      }
      if (item.state === "adding") return <span className="add-papers-state" data-tone="active"><InfinityLoader size={12} />{t`Adding…`}</span>;
      if (item.state === "waiting") return <span className="add-papers-state"><CircleDot size={12} aria-hidden="true" />{t`Waiting`}</span>;
      if (item.state === "failed") return <span className="add-papers-state" data-tone="failed" title={item.note}><CircleAlert size={12} aria-hidden="true" />{t`Couldn't add`}</span>;
      return <span className="add-papers-state">{t`Not added`}</span>;
    }
    if (row.state === "resolving") return <span className="add-papers-state"><InfinityLoader size={12} /></span>;
    if (row.state === "failed") return <span className="add-papers-state" data-tone="failed" title={row.error}><CircleAlert size={12} aria-hidden="true" />{t`Not found`}</span>;
    if (row.state === "duplicate") {
      const key = row.existing?.citationKey;
      return (
        <span className="add-papers-state">
          <span className="add-papers-state-label">{t`Already in Papers`}</span>
          {key && <CiteCopy citationKey={key} />}
        </span>
      );
    }
    if (row.state === "choose" || row.candidates) {
      const open = choosing?.id === row.reference.id;
      return (
        <span className="add-papers-state">
          {row.state === "new" && <span className="add-papers-state-label" data-tone="new">{t`New`}</span>}
          <button
            type="button"
            className="add-papers-choose"
            data-pending={row.state === "choose" || undefined}
            aria-expanded={open}
            onClick={() => setChoosing(open ? null : { id: row.reference.id, index: chosen[row.reference.id] ?? 0 })}
          >
            {row.state === "choose" ? t`Choose…` : t`Change`}
          </button>
        </span>
      );
    }
    return <span className="add-papers-state" data-tone="new">{t`New`}</span>;
  };

  return (
    <SheetDialog className="add-papers-sheet" label={t`Add papers`} dirty={Boolean(text.trim()) && !queued} onClose={props.onClose}>
      <PanelHeader className="drawer-header" icon={<BookMarked size={16} />} title={t`Add papers`} onClose={props.onClose} />
      <div className="add-papers-body">
        {!batch && (
          <label className="add-papers-paste">
            <span>{t`Paste DOIs, arXiv IDs, links, titles or BibTeX — one per line, or a whole .bib`}</span>
            <textarea
              autoFocus
              rows={rows.length ? 4 : 5}
              value={text}
              spellCheck={false}
              placeholder={PASTE_EXAMPLE}
              onChange={(event) => setText(event.target.value)}
              onPaste={(event) => {
                // A paste is whole: read it now rather than after the pause.
                const target = event.currentTarget;
                window.setTimeout(() => setSettled(target.value), 0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  add();
                }
              }}
            />
          </label>
        )}
        {!batch && (
          <div className="add-papers-manual">
            <Button variant="ghost" size="compact" onClick={props.onEnterManually}>
              <PenLine size={13} aria-hidden="true" />
              {t`Enter manually`}
            </Button>
          </div>
        )}
        {!listed.length ? (
          <div className="add-papers-empty">
            <ResearchArt drawing={CATALOGUE_DRAWER} />
            <p>{t`Each line becomes a card. Lattice looks every one up, sets aside what you already have, and asks when a title matches more than one paper. Nothing is written until you add.`}</p>
          </div>
        ) : (
          <>
            {!batch && (
              <div className="add-papers-tabs" role="tablist" aria-label={t`Show references`} onKeyDown={moveTab}>
                {tabs.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    tabIndex={tab === id ? 0 : -1}
                    onClick={() => setTab(id)}
                  >
                    <span className="add-papers-tab-label">{label}</span>
                    <span className="add-papers-tab-count">{counts[id].toLocaleString()}</span>
                  </button>
                ))}
              </div>
            )}
            <ol className="add-papers-rows" role={batch ? undefined : "tabpanel"} aria-label={batch ? t`Papers being added` : undefined}>
              {listed.map((row) => {
                const open = !batch && choosing?.id === row.reference.id && row.candidates;
                return (
                  <li key={row.reference.id} data-state={progress.get(row.reference.id)?.state ?? row.state}>
                    <div className="add-papers-row">
                      <span className="add-papers-kind">{kindLabels[row.reference.kind]}</span>
                      <span className="add-papers-main">
                        <strong title={row.title}>{row.title}</strong>
                        {(row.byline || progress.get(row.reference.id)?.note) && (
                          <span title={progress.get(row.reference.id)?.note ?? row.error}>
                            {bylineOf([row.byline, progress.get(row.reference.id)?.note])}
                          </span>
                        )}
                      </span>
                      {stateOf(row)}
                    </div>
                    {open && row.candidates && (
                      <div className="add-papers-candidates">
                        <CitationCandidates
                          candidates={row.candidates}
                          chosen={choosing.index}
                          onChoose={(index) => setChoosing({ id: row.reference.id, index })}
                          onUse={(index) => {
                            setChosen((current) => ({ ...current, [row.reference.id]: index }));
                            setChoosing(null);
                          }}
                        />
                        <div className="add-papers-candidates-actions">
                          <Button variant="ghost" size="compact" onClick={() => setChoosing(null)}>{t`Cancel`}</Button>
                          <Button
                            variant="tinted"
                            size="compact"
                            onClick={() => {
                              setChosen((current) => ({ ...current, [row.reference.id]: choosing.index }));
                              setChoosing(null);
                            }}
                          >
                            {t`Use this record`}
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
              {!shown.length && !batch && <li className="add-papers-none">{t`Nothing here`}</li>}
            </ol>
          </>
        )}
      </div>
      <div className="table-generator-actions add-papers-footer">
        <span className="add-papers-summary" role="status">{summary}</span>
        {adding ? (
          <>
            <Button variant="ghost" onClick={props.onStop}>{t`Stop`}</Button>
            <Button variant="secondary" onClick={props.onClose}>{t`Close`}</Button>
          </>
        ) : queued ? (
          <Button variant="primary" onClick={props.onClose}>{t`Done`}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={props.onClose}>{t`Cancel`}</Button>
            <Button
              variant="primary"
              disabled={!addable.length || props.importing}
              title={props.importing ? t`Another paper is being added` : undefined}
              onClick={add}
            >
              <Plus size={14} aria-hidden="true" />
              {addable.length === 1 ? t`Add 1 paper` : addable.length ? t`Add ${addable.length} papers` : t`Add papers`}
            </Button>
          </>
        )}
      </div>
    </SheetDialog>
  );
}

/** The row's citation key, which copies the whole \cite command a manuscript needs. */
function CiteCopy({ citationKey }: { citationKey: string }) {
  const { t } = useLingui();
  const command = `\\cite{${citationKey}}`;
  return (
    <CopyButton className="add-papers-cite" text={command} iconSize={11} title={t`Copy \\cite command`} aria-label={t`Copy ${command}`}>
      <code>{citationKey}</code>
    </CopyButton>
  );
}
