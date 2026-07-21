import { useMemo, useState } from "react";
import { Copy, Highlighter, StickyNote, Trash2, X } from "lucide-react";
import type { PdfMark } from "./pdf-annotations";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export function marksToMarkdown(marks: PdfMark[]): string {
  if (!marks.length) return "";
  return marks
    .map((mark) => {
      const kind = mark.kind === "note" ? "Note" : "Highlight";
      const note = mark.note.trim() ? `\n\n> ${mark.note.trim()}` : "";
      return `### ${kind} · p.${mark.page}\n\n${mark.text.trim() || "(empty)"}${note}`;
    })
    .join("\n\n");
}

export function PdfAnnotationsPanel(props: {
  marks: PdfMark[];
  onClose: () => void;
  onOpen: (mark: PdfMark) => void;
  onDelete: (id: string) => void;
  onUpdate: (mark: PdfMark) => void;
  onSendToAgent: (mark: PdfMark) => void;
  onJumpSource?: (mark: PdfMark) => void;
}) {
  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "highlight" | "note">("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const [notice, setNotice] = useState("");

  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return props.marks.filter((mark) => {
      if (kindFilter !== "all" && mark.kind !== kindFilter) return false;
      if (!query) return true;
      return (
        mark.text.toLocaleLowerCase().includes(query)
        || mark.note.toLocaleLowerCase().includes(query)
        || `p.${mark.page}`.includes(query)
      );
    });
  }, [filter, kindFilter, props.marks]);

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="history-drawer pdf-marks-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div><Highlighter size={16} /><span>PDF marks</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
        <p className="drawer-copy">
          Highlights and sticky notes are stored in `.research/pdf-annotations.json` with the project.
        </p>
        <div className="pdf-marks-toolbar">
          <input
            type="search"
            placeholder="Filter marks…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="pdf-marks-kind-filter">
            {([
              ["all", "All"],
              ["highlight", "Highlights"],
              ["note", "Notes"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={kindFilter === id ? "active" : ""}
                onClick={() => setKindFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="pdf-marks-export"
            disabled={!props.marks.length}
            title="Copy all marks as Markdown"
            onClick={() => {
              void writeText(marksToMarkdown(props.marks)).then(() => {
                setNotice("Copied marks as Markdown.");
              }).catch(() => {
                setNotice("Could not copy marks.");
              });
            }}
          >
            <Copy size={13} /> Copy Markdown
          </button>
        </div>
        {notice ? <p className="git-notice">{notice}</p> : null}
        <div className="pdf-marks-list">
          {visible.map((mark) => (
            <article className="pdf-mark-item" key={mark.id}>
              <button type="button" className="pdf-mark-body" onClick={() => props.onOpen(mark)}>
                <div className="pdf-mark-meta">
                  {mark.kind === "note" ? <StickyNote size={12} /> : <Highlighter size={12} />}
                  <span>p.{mark.page}</span>
                  <i className={`pdf-mark-swatch ${mark.color}`} aria-hidden="true" />
                </div>
                <strong>{mark.text || "(empty)"}</strong>
                {editingId !== mark.id && mark.note ? <p>{mark.note}</p> : null}
              </button>
              {editingId === mark.id ? (
                <div className="pdf-mark-edit">
                  <textarea
                    rows={3}
                    value={draftNote}
                    placeholder="Add a note…"
                    onChange={(event) => setDraftNote(event.target.value)}
                  />
                  <div className="pdf-mark-actions">
                    <button
                      type="button"
                      onClick={() => {
                        props.onUpdate({ ...mark, note: draftNote.trim(), kind: draftNote.trim() ? "note" : mark.kind });
                        setEditingId(null);
                      }}
                    >
                      Save note
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="pdf-mark-actions">
                  <button
                    type="button"
                    title="Edit note"
                    onClick={() => {
                      setEditingId(mark.id);
                      setDraftNote(mark.note);
                    }}
                  >
                    Note
                  </button>
                  <button type="button" title="Send text to agent" onClick={() => props.onSendToAgent(mark)}>
                    Agent
                  </button>
                  {props.onJumpSource && (
                    <button type="button" title="Jump to LaTeX source" onClick={() => props.onJumpSource?.(mark)}>
                      Source
                    </button>
                  )}
                  <button type="button" className="danger" title="Delete mark" onClick={() => props.onDelete(mark.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </article>
          ))}
          {!props.marks.length && (
            <p className="empty-history">No PDF marks yet. Select text in the PDF and choose Highlight or Note.</p>
          )}
          {props.marks.length > 0 && !visible.length && (
            <p className="empty-history">No marks match this filter.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
