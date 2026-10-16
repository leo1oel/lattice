/**
 * Linked library: the .bib file a reference manager keeps up to date (a
 * Zotero or Paperpile export), linked to the project's bibliography. Opening
 * the sheet reads the file and lays out what taking it in would change, in
 * four kinds — new papers, fields the library updated, fields the writer
 * changed here as well, papers the library dropped — and nothing reaches the
 * project's .bib until the writer applies the changes they ticked. Unticked
 * changes are not offered again: the link remembers the library as it was
 * when the writer last looked (papers/linked-library.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowRight, Check, FileText, Link2 } from "lucide-react";
import { relativeTime, toMessage } from "../app-utils";
import { showError, showNotice } from "../app/notify";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { InfinityLoader } from "../components/ui/activity-icons";
import { InlineMessage } from "../components/ui/inline-message";
import { PanelHeader } from "../components/ui/panel-header";
import { ResearchArt } from "../components/ui/research-art";
import { CARD_INDEX } from "../components/ui/research-art-card-index";
import { SheetDialog } from "../components/ui/sheet-dialog";
import type { SymbolOccurrence } from "../project/references-panel";
import {
  applyLibraryChanges, compareLibrary, ENTRY_TYPE_FIELD,
  type LibraryChange, type LibraryChangeKind, type LinkedBibliography,
} from "./linked-library";
import "./add-papers-sheet.css";
import "./linked-library-sheet.css";

type Tab = "all" | LibraryChangeKind;

type Loaded = {
  source: string;
  library: string;
  /** The library as last taken in, or null before the first update from this file. */
  base: string | null;
  changes: LibraryChange[];
};

type State =
  | { phase: "loading" }
  | { phase: "unlinked" }
  | { phase: "failed"; source: string | null; error: string }
  | { phase: "ready"; loaded: Loaded };

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

class SourceUnreadable extends Error {
  constructor(reason: unknown) {
    super(toMessage(reason));
  }
}

/** Read the library and the project's .bib, and compare them against the base. */
async function readChanges({ source, into, base, projectRoot }: {
  source: string; into: string; base: string | null; projectRoot: string;
}): Promise<{ library: string; changes: LibraryChange[] }> {
  const [library, local, usages] = await Promise.all([
    // Tagged, so the sheet can tell a library that is gone from a project file that is.
    invoke<string>("read_bibliography_source", { source }).catch((reason: unknown) => Promise.reject(new SourceUnreadable(reason))),
    invoke<string>("read_project_file", { path: into, projectRoot }),
    invoke<SymbolOccurrence[]>("list_citation_usages").catch(() => [] as SymbolOccurrence[]),
  ]);
  const changes = compareLibrary({
    base, library, local, libraryName: fileName(source), localName: fileName(into),
    cited: new Set(usages.map((usage) => usage.symbol)),
  });
  return { library, changes };
}

export function LinkedLibrarySheet(props: {
  projectRoot: string;
  /** The project's primary bibliography, which a new link updates. */
  bibliography: string;
  /** Write the project's .bib from its text on disk now, as one undoable edit. */
  onRewrite: (path: string, change: (current: string) => string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const { projectRoot, bibliography, onRewrite, onClose } = props;
  const [link, setLink] = useState<LinkedBibliography | null>(null);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<Tab>("all");
  const [busy, setBusy] = useState(false);
  const target = link?.target ?? bibliography;
  // A newer read (another file chosen, Try again) supersedes an older one still answering.
  const generation = useRef(0);

  const load = useCallback((source: string, current: LinkedBibliography | null) => {
    const run = ++generation.current;
    setState({ phase: "loading" });
    const into = current?.target ?? bibliography;
    const base = current?.source === source ? current.baseline : null;
    if (!into) {
      setState({ phase: "failed", source, error: t`This project has no primary bibliography.` });
      return;
    }
    readChanges({ source, into, base, projectRoot }).then(({ library, changes }) => {
      if (run !== generation.current) return;
      // New papers come in unless unticked; a library's update does once the
      // link has a base to tell it from the writer's own edits. A field the
      // writer changed stays theirs, and nothing is removed, until ticked.
      setSelected(new Set(changes
        .filter((change) => change.kind === "new" || (change.kind === "updated" && base !== null))
        .map((change) => change.id)));
      setTab("all");
      setState({ phase: "ready", loaded: { source, library, base, changes } });
    }, (reason: unknown) => {
      if (run !== generation.current) return;
      const message = toMessage(reason);
      // A cloud folder not synced yet, an external drive not mounted, a file renamed.
      const error = reason instanceof SourceUnreadable && /\(os error 2\)/.test(message)
        ? t`Can't find ${fileName(source)}. It may have been moved or renamed, or its drive is not connected.`
        : message;
      setState({ phase: "failed", source, error });
    });
  }, [bibliography, projectRoot, t]);

  useEffect(() => {
    let live = true;
    invoke<LinkedBibliography | null>("read_linked_bibliography").then((current) => {
      if (!live) return;
      setLink(current);
      if (current) load(current.source, current);
      else setState({ phase: "unlinked" });
    }, (reason: unknown) => {
      if (live) setState({ phase: "failed", source: null, error: toMessage(reason) });
    });
    return () => { live = false; };
  }, [load]);

  const choose = async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      title: t`Choose your library's .bib file`,
      filters: [{ name: "BibTeX", extensions: ["bib"] }],
    }).catch((reason: unknown) => {
      showError(toMessage(reason));
      return null;
    });
    if (typeof picked === "string") load(picked, link);
  };

  const unlink = () => {
    setBusy(true);
    invoke("unlink_bibliography", { projectRoot }).then(() => {
      showNotice(t`Unlinked. ${target} stays as it is.`);
      onClose();
    }, (reason: unknown) => {
      showError(toMessage(reason));
      setBusy(false);
    });
  };

  const loaded = state.phase === "ready" ? state.loaded : null;
  const changes = useMemo(() => loaded?.changes ?? [], [loaded]);
  const chosen = changes.filter((change) => selected.has(change.id) && !(change.kind === "removed" && change.cited));

  const apply = () => {
    if (!loaded || busy) return;
    setBusy(true);
    const library = fileName(loaded.source);
    const rewrite = chosen.length ? onRewrite(target, (current) => applyLibraryChanges(current, loaded.library, chosen)) : Promise.resolve(false);
    rewrite.then(async (changed) => {
      setLink(await invoke<LinkedBibliography>("save_linked_bibliography", {
        projectRoot, source: loaded.source, target, baseline: loaded.library,
      }));
      showNotice(changed
        ? t`Updated ${target} from ${library}. Undo it from History.`
        : link?.source === loaded.source ? t`${library} is up to date.` : t`Linked ${library} to ${target}.`);
      onClose();
    }).catch((reason: unknown) => {
      showError(toMessage(reason));
      setBusy(false);
    });
  };

  const counts: Record<Tab, number> = { all: changes.length, new: 0, updated: 0, conflict: 0, removed: 0 };
  for (const change of changes) counts[change.kind] += 1;
  const tabs = ([
    ["all", t`All`], ["new", t`New`], ["updated", t`Updated`], ["conflict", t`Changed here`], ["removed", t`Removed from library`],
  ] as Array<[Tab, string]>).filter(([id]) => id === "all" || counts[id] > 0);
  const shown = tab === "all" ? changes : changes.filter((change) => change.kind === tab);
  const moveTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const at = tabs.findIndex(([id]) => id === tab);
    const next = Number.isFinite(step) ? (at + step + tabs.length) % tabs.length : step > 0 ? tabs.length - 1 : 0;
    setTab(tabs[next][0]);
    event.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  };
  const toggle = (id: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });

  const kindLabels: Record<LibraryChangeKind, string> = {
    new: t`New`, updated: t`Updated`, conflict: t`Changed here`, removed: t`Removed from library`,
  };
  const fieldLabel = (name: string) => name === ENTRY_TYPE_FIELD ? t`entry type` : name;
  const none = t`none`;
  const source = loaded?.source ?? (state.phase === "failed" ? state.source : null) ?? link?.source ?? null;
  const updated = link && source === link.source ? relativeTime(new Date(link.updatedAt).toISOString()) : null;

  const summary = state.phase !== "ready"
    ? ""
    : changes.length
      ? t`${chosen.length} of ${changes.length} selected`
      : updated ? t`Nothing has changed since you last updated, ${updated}.` : t`Nothing to change — ${target} already matches.`;
  const relinking = !link || link.source !== loaded?.source;
  const action = !changes.length
    ? relinking ? t`Link` : t`Done`
    : chosen.length === 1 ? t`Apply 1 change` : chosen.length ? t`Apply ${chosen.length} changes` : t`Skip these changes`;

  return (
    <SheetDialog className="add-papers-sheet linked-library-sheet" label={t`Linked library`} dirty={changes.length > 0} onClose={onClose}>
      <PanelHeader className="drawer-header" icon={<Link2 size={16} />} title={t`Linked library`} onClose={onClose} />
      <div className="add-papers-body linked-library-body">
        {source && (
          <div className="linked-library-source">
            <FileText size={16} className="linked-library-source-icon" aria-hidden="true" />
            <span className="linked-library-source-text">
              <strong title={source}>{fileName(source)}</strong>
              <span title={source}>
                <ArrowRight size={11} aria-hidden="true" className="linked-library-into" />
                {updated ? t`Updates ${target} · last updated ${updated}` : t`Will update ${target}`}
              </span>
            </span>
            <span className="linked-library-source-actions">
              <Button variant="ghost" size="compact" disabled={busy} onClick={() => void choose()}>{t`Choose another…`}</Button>
              {link && <Button variant="ghost" size="compact" disabled={busy} onClick={unlink}>{t`Unlink`}</Button>}
            </span>
          </div>
        )}
        {state.phase === "loading" && (
          <div className="linked-library-loading" role="status">
            <InfinityLoader size={14} />
            {source ? t`Reading ${fileName(source)}…` : t`Reading the link…`}
          </div>
        )}
        {state.phase === "unlinked" && (
          <div className="add-papers-empty">
            <ResearchArt drawing={CARD_INDEX} />
            <div className="linked-library-intro">
              <p>{t`Link the .bib file your reference manager keeps up to date, such as a Zotero or Paperpile export. Whenever you choose, Lattice shows what changed there and brings in what you tick to ${target}. Your citation keys and your own edits stay.`}</p>
              <Button variant="primary" onClick={() => void choose()}>{t`Choose .bib file…`}</Button>
            </div>
          </div>
        )}
        {state.phase === "failed" && (
          <div className="linked-library-failed">
            <InlineMessage level="error">{state.error}</InlineMessage>
            <p>{t`${target} has not been changed.`}</p>
            <span>
              {state.source && <Button variant="secondary" size="compact" onClick={() => load(state.source!, link)}>{t`Try again`}</Button>}
              <Button variant="ghost" size="compact" onClick={() => void choose()}>{t`Locate the file…`}</Button>
            </span>
          </div>
        )}
        {loaded && !changes.length && (
          <div className="linked-library-loading" data-settled="">
            <Check size={14} aria-hidden="true" />
            {t`Up to date`}
          </div>
        )}
        {loaded && changes.length > 0 && (
          <>
            <div className="add-papers-tabs" role="tablist" aria-label={t`Show changes`} onKeyDown={moveTab}>
              {tabs.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
                  <span className="add-papers-tab-label">{label}</span>
                  <span className="add-papers-tab-count">{counts[id].toLocaleString()}</span>
                </button>
              ))}
            </div>
            <p className="linked-library-hint">
              {loaded.base === null
                ? t`First update from this file: where an entry differs here, your version stays unless you tick it.`
                : t`What you leave unticked is not offered again.`}
            </p>
            <ol className="add-papers-rows linked-library-rows" role="tabpanel">
              {shown.map((change) => {
                const locked = change.kind === "removed" && change.cited;
                return (
                  <li key={change.id} data-kind={change.kind}>
                    <label className="linked-library-row">
                      <Checkbox
                        checked={selected.has(change.id) && !locked}
                        disabled={locked || busy}
                        onChange={(event) => toggle(change.id, event.target.checked)}
                      />
                      <span className="add-papers-main">
                        <strong title={change.title}>{change.title}</strong>
                        <span>
                          <code>{change.key}</code>
                          {change.kind === "removed" && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="linked-library-note">{locked ? t`Cited in the paper, so it stays` : t`Tick to remove it here too`}</span>
                            </>
                          )}
                        </span>
                      </span>
                      <span className="linked-library-kind" data-kind={change.kind}>{kindLabels[change.kind]}</span>
                    </label>
                    {change.fields.length > 0 && (
                      <dl className="linked-library-fields">
                        {change.fields.map((field) => (
                          <div key={field.name} data-conflict={field.conflict || undefined}>
                            <dt>{fieldLabel(field.name)}</dt>
                            <dd>
                              <span className="linked-library-value" data-side="here" title={field.local ?? undefined}>
                                {field.conflict && <em>{t`Yours`}</em>}
                                {field.local ?? none}
                              </span>
                              <ArrowRight size={11} aria-hidden="true" />
                              <span className="linked-library-value" data-side="library" title={field.library ?? undefined}>
                                {field.library ?? none}
                              </span>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
      <div className="table-generator-actions add-papers-footer">
        <span className="add-papers-summary" role="status">{summary}</span>
        <Button variant="ghost" onClick={onClose}>{t`Cancel`}</Button>
        {loaded && (
          <Button variant="primary" disabled={busy} onClick={apply}>
            {busy && <InfinityLoader size={14} />}
            {action}
          </Button>
        )}
      </div>
    </SheetDialog>
  );
}
