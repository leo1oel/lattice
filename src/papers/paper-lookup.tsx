import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { BookOpen, GripVertical, Pin, PinOff } from "lucide-react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SearchField } from "../components/ui/search-field";
import { beginPaperDrag } from "./paper-drag";
import { PAPER_LOOKUP_OPEN, PAPER_LOOKUP_READY, PAPER_LOOKUP_STATE, type PaperLookupState } from "./use-paper-lookup";
import "./paper-lookup.css";

export default function PaperLookup({ owner }: { owner: string }) {
  const { t } = useLingui();
  const [library, setLibrary] = useState<PaperLookupState | null>(null);
  const [query, setQuery] = useState("");
  const [pinned, setPinned] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<PaperLookupState>(PAPER_LOOKUP_STATE, ({ payload }) => {
      setLibrary(payload);
      document.documentElement.dataset.theme = payload.theme;
    }).then(async (cleanup) => {
      if (disposed) { cleanup(); return; }
      unlisten = cleanup;
      await emitTo(owner, PAPER_LOOKUP_READY);
    }).catch((reason) => setError(String(reason)));
    return () => { disposed = true; unlisten?.(); };
  }, [owner]);
  const tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const papers = library?.papers.filter((paper) => tokens.every((token) =>
    `${paper.title} ${paper.authors ?? ""} ${paper.citationKey ?? ""} ${paper.arxivId} ${paper.doi ?? ""}`.toLocaleLowerCase().includes(token))) ?? [];
  const togglePin = async () => {
    setPinBusy(true);
    try { await getCurrentWindow().setAlwaysOnTop(!pinned); setPinned(!pinned); }
    catch (reason) { setError(String(reason)); }
    finally { setPinBusy(false); }
  };
  return (
    <main className="paper-lookup">
      <header className="paper-lookup-titlebar" data-tauri-drag-region>
        <span data-tauri-drag-region>{t`Paper lookup`}</span>
        <button className="icon-button" aria-label={t`Keep on top`} title={t`Keep on top`} aria-pressed={pinned} disabled={pinBusy} onClick={() => void togglePin()}>
          {pinned ? <Pin size={14} /> : <PinOff size={14} />}
        </button>
      </header>
      <div className="paper-lookup-search">
        <div className="paper-lookup-project"><BookOpen size={14} /><span>{library?.projectRoot.split(/[\\/]/).pop() || t`Papers`}</span></div>
        <SearchField autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onClear={() => setQuery("")} placeholder={t`Search papers, authors, citation keys…`} aria-label={t`Search papers`} clearLabel={t`Clear search`} />
      </div>
      <div className="paper-lookup-list" role="list" aria-label={t`Papers`}>
        {papers.map((paper) => (
          <div role="listitem" key={`${paper.arxivId}:${paper.citationKey}`} className="paper-lookup-row" draggable onDragStart={(event) => beginPaperDrag(event.dataTransfer, library!.projectRoot, paper)}>
            <GripVertical size={13} className="paper-lookup-grip" aria-hidden="true" />
            <button onClick={() => void emitTo(owner, PAPER_LOOKUP_OPEN, { projectRoot: library!.projectRoot, arxivId: paper.arxivId, citationKey: paper.citationKey }).catch((reason) => setError(String(reason)))}>
              <strong>{paper.title}</strong>
              {paper.authors && <span className="paper-lookup-authors">{paper.authors}</span>}
              <small>{paper.citationKey ? `@${paper.citationKey}` : t`No bibliography key`}{paper.hasFullText || paper.hasBlog ? <BookOpen size={11} aria-label={t`Available offline`} /> : null}</small>
            </button>
          </div>
        ))}
        {!papers.length && <p className="paper-lookup-empty">{!library ? t`Connecting to project…` : query ? t`No matching papers` : t`Add papers in the project’s Papers sidebar`}</p>}
      </div>
      {error && <p className="paper-lookup-error" role="alert">{error}</p>}
      <footer><span>{papers.length === 1 ? t`1 paper` : t({ message: `${{ count: papers.length }} papers` })}</span><span>{t`Drag to cite · Click to read`}</span></footer>
    </main>
  );
}
