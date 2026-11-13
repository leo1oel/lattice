/**
 * Add papers: one sheet for every way of adding. Paste anything — DOIs, arXiv
 * IDs, links, titles or BibTeX, one per line or a whole .bib — and each
 * reference becomes a card, looked up as it lands. What the library already
 * holds is set aside, a title that matches more than one record waits for a
 * choice, and nothing is written until the writer adds; then the papers
 * import a few at a time, each with its own progress and a retry if it
 * fails, and the sheet can close while the writer keeps writing. An
 * identifier is addable before its lookup answers (the import resolves it
 * itself), so a paste and Enter add the lot. Whether the batch also saves
 * each paper's full text is the switch beside the box, remembered for next time.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { BookMarked, Check, CircleAlert, CircleDot, Library, Link2, PenLine, Plus, RotateCw } from "lucide-react";
import type { PaperSummary } from "../app-types";
import { addQueueRunning, clearAddQueue, getAddQueue, retryAddItem, subscribeAddQueue, type PaperAddRequest } from "./add-papers-queue";
import { saveFullTextSetting } from "./save-full-text-setting";
import { useSharedSetting } from "../settings/shared-setting";
import { CheckboxField } from "../components/ui/checkbox-field";
import { Button } from "../components/ui/button";
import { PanelHeader } from "../components/ui/panel-header";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { ResearchArt } from "../components/ui/research-art";
import { CATALOGUE_DRAWER } from "../components/ui/research-art-catalogue-drawer";
import { InfinityLoader } from "../components/ui/activity-icons";
import { CopyButton } from "../components/copy-button";
import { hostErrorMessage } from "../app-utils";
import type { ResolvedCitationDraft } from "./bib-entry-dialog";
import { CitationCandidates } from "./citation-candidates";
import {
  bylineOf, findInLibrary, identityOfInput, parsePastedReferences, recordOfResolved,
  type PastedReference, type ReferenceKind,
} from "./paper-add";
import { paperShortAuthors } from "./paper-identity";
import { ZoteroBrowser, type ZoteroBrowserHandle, type ZoteroPaper } from "./zotero-browser";
import "./add-papers-sheet.css";
import { joinPhrases } from "../i18n";

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
  /** An import holds the pipeline: the Papers box's, Find literature's, or this sheet's batch. */
  importing: boolean;
  onResolve: (query: string) => Promise<ResolvedCitationDraft>;
  onAdd: (items: PaperAddRequest[]) => void;
  onStop: () => void;
  onEnterManually: () => void;
  /** Open the linked library: a reference manager's .bib, whose changes come in on request. */
  onLinkLibrary: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  // The batch being added, kept while it runs even if the sheet closed and reopened.
  const queue = useSyncExternalStore(subscribeAddQueue, getAddQueue);
  const [saveFullText, setSaveFullText] = useSharedSetting(saveFullTextSetting);
  const onClose = () => {
    clearAddQueue();
    props.onClose();
  };
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
  // The Zotero library, browsed in place of the paste box (zotero-browser.tsx).
  const [zotero, setZotero] = useState(false);
  const [zoteroTicked, setZoteroTicked] = useState(0);
  const zoteroRef = useRef<ZoteroBrowserHandle>(null);
  const [lookups, setLookups] = useState<Record<string, Lookup>>({});
  // Lookups sent and not yet answered; their rows read as looking up meanwhile.
  const pendingRef = useRef(new Set<string>());
  // The record the writer chose for a title that matched several, by row.
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [choosing, setChoosing] = useState<{ id: string; index: number } | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  // The cards as they were when the writer added: once a paper lands in the
  // library its card must not turn into "Already in Papers" under its own progress.
  const [addedFrom, setAddedFrom] = useState<Row[]>([]);
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
      // The rows read the answer while rendering, where a throw takes down the
      // whole window; an answer that is not a record is a failed lookup.
      onResolve(reference.input).then(
        (resolved: unknown) => answer(resolved && typeof resolved === "object"
          ? { state: "done", resolved: resolved as ResolvedCitationDraft }
          : { state: "failed", error: t`The lookup returned no record.` }),
        (reason: unknown) => answer({ state: "failed", error: hostErrorMessage(reason) }),
      );
    }
  }, [onResolve, rows, t]);

  const queued = queue.length > 0;
  const importingElsewhere = props.importing && !addQueueRunning();
  const adding = queue.some((item) => item.state === "waiting" || item.state === "adding");
  const progress = new Map(queue.map((item) => [item.id, item]));
  const count = (state: RowState) => rows.filter((row) => row.state === state).length;
  const counts = { all: rows.length, new: count("new"), duplicate: count("duplicate"), choose: count("choose") };
  const resolving = count("resolving");
  const failed = count("failed");
  // An identifier still being looked up is addable already: its import
  // resolves it anyway. A title waits for its lookup, which may need a choice.
  const addable = rows.filter((row) => (row.state === "new" && row.importInput)
    || (row.state === "resolving" && row.reference.kind !== "title"));
  const shown = tab === "all" ? rows : rows.filter((row) => row.state === tab);
  // A tab with nothing in it is left out (All aside, and the one in view).
  const tabs: Array<[Tab, string]> = ([["all", t`All`], ["new", t`New`], ["duplicate", t`Already in Papers`], ["choose", t`Several matches`]] as Array<[Tab, string]>)
    .filter(([id]) => id === "all" || id === tab || counts[id] > 0);
  const kindLabels: Record<ReferenceKind, string> = { arxiv: "arXiv", doi: "DOI", url: t`Link`, bibtex: "BibTeX", title: t`Title` };

  // Opened with references already addable (a list pasted into the Papers
  // box), the Add button takes the focus, so Enter adds them all; otherwise
  // the box does. Decided once, as the sheet opens.
  const [focusAdd] = useState(() => addable.length > 0);
  const add = () => {
    if (!addable.length || adding || importingElsewhere) return;
    setAddedFrom(addable);
    props.onAdd(addable.map((row) => ({
      id: row.reference.id,
      input: row.importInput ?? row.reference.input,
      label: row.title,
    })));
  };
  // Ticked Zotero papers go to the same queue, each with its PDF attachment
  // and its annotations (a paper Papers holds brings only those); the sheet
  // then shows them being added.
  const addFromZotero = (papers: ZoteroPaper[], dataDir: string | null) => {
    if (!papers.length || adding || importingElsewhere) return;
    const id = (paper: ZoteroPaper) => `zotero:${paper.item.citationKey}`;
    setAddedFrom(papers.map((paper): Row => ({
      reference: { id: id(paper), kind: "bibtex", input: paper.item.bibtex, label: paper.item.citationKey },
      state: "new", title: paper.title, byline: paper.byline,
    })));
    props.onAdd(papers.map((paper) => ({
      id: id(paper),
      input: paper.item.bibtex,
      label: paper.title,
      pdf: paper.item.pdf ?? undefined,
      existing: paper.existing?.citationKey,
      annotations: paper.item.annotations ? { item: paper.item.key, dataDir } : undefined,
    })));
    setZotero(false);
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
    ? queue.map((item) => addedFrom.find((row) => row.reference.id === item.id)
      ?? { reference: { id: item.id, kind: "title" as const, input: item.input, label: item.label }, state: "new" as const, title: item.label, byline: "" })
    : null;
  // A row added before its lookup answered takes the title its import found.
  const listed = (batch ?? shown).map((row) => {
    const item = progress.get(row.reference.id);
    if (item?.title) return { ...row, title: item.title, byline: row.state === "resolving" ? "" : row.byline };
    return row.state === "resolving" && batch ? { ...row, byline: "" } : row;
  });
  const done = queue.filter((item) => item.state === "added").length;

  const summary = queued
    ? adding
      ? t`Added ${done} of ${queue.length}`
      : done === queue.length
        ? done === 1 ? t`Added 1 paper` : t`Added ${done} papers`
        : t`Added ${done} of ${queue.length}`
    : joinPhrases([
        counts.duplicate === 1 ? t`1 already in Papers is skipped` : counts.duplicate ? t`${counts.duplicate} already in Papers are skipped` : "",
        counts.choose === 1 ? t`1 waits for your choice` : counts.choose ? t`${counts.choose} wait for your choice` : "",
        failed === 1 ? t`1 not found` : failed ? t`${failed} not found` : "",
        resolving ? t`Looking up ${resolving}…` : "",
      ]);

  const stateOf = (row: Row) => {
    const item = progress.get(row.reference.id);
    if (item) {
      if (item.state === "added") {
        return (
          <span className="add-papers-state" data-tone={item.alreadyImported ? undefined : "done"}>
            {!item.alreadyImported && <Check size={12} aria-hidden="true" />}
            <span className="add-papers-state-label">{item.alreadyImported ? t`Already in Papers` : t`Added`}</span>
            {item.citationKey && <CiteCopy citationKey={item.citationKey} />}
          </span>
        );
      }
      if (item.state === "adding") return <span className="add-papers-state" data-tone="active"><InfinityLoader size={12} />{t`Adding…`}</span>;
      if (item.state === "waiting") return <span className="add-papers-state"><CircleDot size={12} aria-hidden="true" />{t`Waiting`}</span>;
      if (item.state === "failed") {
        return (
          <span className="add-papers-state" data-tone="failed" title={item.note}>
            <CircleAlert size={12} aria-hidden="true" />
            {t`Couldn't add`}
            <RetryButton onRetry={() => retryAddItem(item.id)} />
          </span>
        );
      }
      return <span className="add-papers-state">{t`Not added`}</span>;
    }
    if (row.state === "resolving") return <span className="add-papers-state"><InfinityLoader size={12} /></span>;
    if (row.state === "failed") {
      const { id } = row.reference;
      return (
        <span className="add-papers-state" data-tone="failed" title={row.error}>
          <CircleAlert size={12} aria-hidden="true" />
          {t`Not found`}
          <RetryButton onRetry={() => setLookups((current) => {
            const rest = { ...current };
            delete rest[id];
            return rest;
          })} />
        </span>
      );
    }
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
    <SheetDialog
      className="add-papers-sheet"
      label={t`Add papers`}
      dirty={(Boolean(text.trim()) && !queued) || (zotero && !batch && zoteroTicked > 0)}
      onClose={onClose}
      onEscapeKeyDown={(event) => {
        // Escape steps back inside the Zotero browser before it closes the sheet.
        if (!zotero || batch) return;
        event.preventDefault();
        if (!zoteroRef.current?.escape()) setZotero(false);
      }}
    >
      <PanelHeader className="drawer-header" icon={<BookMarked size={16} />} title={t`Add papers`} onClose={onClose} />
      {zotero && !batch ? (
        <ZoteroBrowser handle={zoteroRef} papers={props.papers} busy={importingElsewhere || adding} onAdd={addFromZotero} onTicked={setZoteroTicked} onBack={() => setZotero(false)} />
      ) : (<>
      <div className="add-papers-body">
        {!batch && (
          <label className="add-papers-paste">
            <span>{t`Paste references`}</span>
            <textarea
              autoFocus={!focusAdd}
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
            <Button variant="ghost" size="compact" onClick={props.onLinkLibrary}>
              <Link2 size={13} aria-hidden="true" />
              {t`Linked library…`}
            </Button>
            <Button variant="ghost" size="compact" onClick={() => setZotero(true)}>
              <Library size={13} aria-hidden="true" />
              {t`Zotero…`}
            </Button>
            <CheckboxField
              className="add-papers-full-text"
              checked={saveFullText}
              onChange={(event) => setSaveFullText(event.target.checked)}
              label={t`Also save full text (Markdown)`}
            />
          </div>
        )}
        {!(batch ?? rows).length ? (
          <div className="add-papers-empty">
            <ResearchArt drawing={CATALOGUE_DRAWER} />
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
            <Button variant="secondary" onClick={onClose}>{t`Close`}</Button>
          </>
        ) : queued ? (
          <Button variant="primary" onClick={onClose}>{t`Done`}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>{t`Cancel`}</Button>
            <Button
              autoFocus={focusAdd}
              variant="primary"
              disabled={!addable.length || importingElsewhere}
              title={importingElsewhere ? t`Another paper is being added` : undefined}
              onClick={add}
            >
              <Plus size={14} aria-hidden="true" />
              {addable.length === 1 ? t`Add 1 paper` : addable.length ? t`Add ${addable.length} papers` : t`Add papers`}
            </Button>
          </>
        )}
      </div>
      </>)}
    </SheetDialog>
  );
}

/** Tries a failed lookup or import again. */
function RetryButton({ onRetry }: { onRetry: () => void }) {
  const { t } = useLingui();
  return (
    <button type="button" className="add-papers-retry" onClick={onRetry} title={t`Try again`} aria-label={t`Try again`}>
      <RotateCw size={11} aria-hidden="true" />
    </button>
  );
}

/** The row's citation key, which copies the whole \cite command a manuscript needs. */
function CiteCopy({ citationKey }: { citationKey: string }) {
  const { t } = useLingui();
  const command = `\\cite{${citationKey}}`;
  return (
    <CopyButton className="add-papers-cite" text={command} iconSize={11} title={t`Copy \\cite command`} aria-label={t`Copy ${command}`}>
      {/* A long key truncates; hovering it shows the whole key (the button copies it whole). */}
      <code title={citationKey}>{citationKey}</code>
    </CopyButton>
  );
}
