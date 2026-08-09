import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronUp, Replace, ReplaceAll, X } from "lucide-react";
import { getFindReplaceState } from "@ok-app/editor/find-replace/tiptap-find-replace-extension";
import { IconButton } from "./components/ui/icon-button";

type FindSnapshot = ReturnType<typeof getFindReplaceState>;

function selectedSingleLineText(editor: Editor): string {
  const { from, to, empty } = editor.state.selection;
  if (empty) return "";
  const text = editor.state.doc.textBetween(from, to, "\n");
  return text.length <= 120 && !text.includes("\n") ? text : "";
}

export function VisualMarkdownFindReplace({
  editor,
  editable,
  editorRoot,
}: {
  editor: Editor;
  editable: boolean;
  editorRoot: RefObject<HTMLElement | null>;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [snapshot, setSnapshot] = useState<FindSnapshot>(() => getFindReplaceState(editor.state));
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const update = () => setSnapshot(getFindReplaceState(editor.state));
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  const show = useCallback((withReplace: boolean) => {
    const seed = open ? getFindReplaceState(editor.state).query : selectedSingleLineText(editor);
    setSnapshot(getFindReplaceState(editor.state));
    setOpen(true);
    setReplaceOpen((current) => current || withReplace);
    if (!open && seed) editor.commands.setFindQuery(seed);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, [editor, open]);

  const close = useCallback(() => {
    editor.commands.clearFindMatches();
    setOpen(false);
    setReplaceOpen(false);
    requestAnimationFrame(() => editor.commands.focus());
  }, [editor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = editorRoot.current;
      if (!root || !root.contains(event.target as Node)) return;
      const key = event.key.toLowerCase();
      const primary = event.metaKey || event.ctrlKey;
      const openFind = primary && key === "f" && !event.shiftKey && !event.altKey;
      const macOS = /Mac|iPhone|iPad/.test(navigator.platform);
      const openReplace = (event.metaKey && event.altKey && key === "f" && !event.shiftKey)
        || (!macOS && event.ctrlKey && !event.metaKey && !event.altKey && key === "h" && !event.shiftKey);
      const navigate = open && ((primary && key === "g" && !event.altKey) || event.key === "F3");
      if (openFind || openReplace) {
        event.preventDefault();
        event.stopPropagation();
        show(openReplace);
      } else if (navigate) {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) editor.commands.selectPreviousFindMatch();
        else editor.commands.selectNextFindMatch();
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [close, editor, editorRoot, open, show]);

  if (!open) return null;
  const count = snapshot.matches.length;
  const resultLabel = count ? `${snapshot.activeIndex + 1} of ${count}` : snapshot.query ? "No matches" : "0 matches";
  const navigate = (previous: boolean) => previous
    ? editor.commands.selectPreviousFindMatch()
    : editor.commands.selectNextFindMatch();

  return (
    <div className="visual-find-anchor">
      <div className="visual-find-panel" role="search" aria-label="Find in document">
        <div className="visual-find-row">
          <label className="sr-only" htmlFor={`${inputId}-find`}>Find</label>
          <input
            id={`${inputId}-find`}
            ref={findInputRef}
            type="search"
            placeholder="Find"
            value={snapshot.query}
            onChange={(event) => editor.commands.setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                navigate(event.shiftKey);
              }
            }}
          />
          <span className="visual-find-count" role="status" aria-live="polite">{resultLabel}</span>
          <IconButton size="compact" label="Previous match" onClick={() => navigate(true)} disabled={!count}><ChevronUp aria-hidden="true" /></IconButton>
          <IconButton size="compact" label="Next match" onClick={() => navigate(false)} disabled={!count}><ChevronDown aria-hidden="true" /></IconButton>
          <IconButton size="compact" label="Close find" onClick={close}><X aria-hidden="true" /></IconButton>
        </div>
        <div className="visual-find-options">
          <button type="button" aria-pressed={snapshot.options.caseSensitive} onClick={() => editor.commands.setFindOptions({ caseSensitive: !snapshot.options.caseSensitive }, 0)}>Match case</button>
          <button type="button" aria-pressed={snapshot.options.wholeWord} onClick={() => editor.commands.setFindOptions({ wholeWord: !snapshot.options.wholeWord }, 0)}>Whole word</button>
          {!replaceOpen && <button type="button" onClick={() => setReplaceOpen(true)}>Replace</button>}
        </div>
        {replaceOpen && (
          <div className="visual-find-row visual-replace-row">
            <label className="sr-only" htmlFor={`${inputId}-replace`}>Replace with</label>
            <input id={`${inputId}-replace`} placeholder="Replace with" value={replacement} onChange={(event) => setReplacement(event.target.value)} />
            <IconButton size="compact" label="Replace current match" disabled={!editable || !count} onClick={() => editor.commands.replaceCurrentFindMatch(replacement)}><Replace aria-hidden="true" /></IconButton>
            <IconButton size="compact" label="Replace all matches" disabled={!editable || !count} onClick={() => editor.commands.replaceAllFindMatches(replacement)}><ReplaceAll aria-hidden="true" /></IconButton>
          </div>
        )}
      </div>
    </div>
  );
}
