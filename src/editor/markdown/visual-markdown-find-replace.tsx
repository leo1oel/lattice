import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { CaseSensitive, ChevronDown, ChevronUp, Replace, ReplaceAll, WholeWord, X } from "lucide-react";
import { getFindReplaceState } from "@ok-app/editor/find-replace/tiptap-find-replace-extension";
import { IconButton } from "../../components/ui/icon-button";

type FindSnapshot = ReturnType<typeof getFindReplaceState>;

function liveCommands(editor: Editor): Editor["commands"] | null {
  return editor.isDestroyed ? null : editor.commands;
}

const selectMatch = (editor: Editor, previous: boolean) =>
  previous ? liveCommands(editor)?.selectPreviousFindMatch() : liveCommands(editor)?.selectNextFindMatch();

const FIND_OPTIONS: ReadonlyArray<readonly ["caseSensitive" | "wholeWord", MessageDescriptor, typeof CaseSensitive]> = [
  ["caseSensitive", msg`Match case`, CaseSensitive],
  ["wholeWord", msg`Whole word`, WholeWord],
];

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
  const { i18n, t } = useLingui();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [snapshot, setSnapshot] = useState<FindSnapshot>(() => getFindReplaceState(editor.state));
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const update = () => setSnapshot(getFindReplaceState(editor.state));
    editor.on("transaction", update);
    return () => void editor.off("transaction", update);
  }, [editor]);

  const show = useCallback((withReplace: boolean) => {
    const seed = open ? getFindReplaceState(editor.state).query : selectedSingleLineText(editor);
    setSnapshot(getFindReplaceState(editor.state));
    setOpen(true);
    setReplaceOpen((current) => current || withReplace);
    if (!open && seed) liveCommands(editor)?.setFindQuery(seed);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, [editor, open]);

  const close = useCallback(() => {
    liveCommands(editor)?.clearFindMatches();
    setOpen(false);
    setReplaceOpen(false);
    requestAnimationFrame(() => liveCommands(editor)?.focus());
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
      const action = openFind || openReplace ? () => show(openReplace)
        : navigate ? () => selectMatch(editor, event.shiftKey)
          : open && event.key === "Escape" ? close
            : null;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [close, editor, editorRoot, open, show]);

  if (!open) return null;
  const count = snapshot.matches.length;
  const current = snapshot.activeIndex + 1;
  const resultLabel = count ? t`${current} of ${count}` : snapshot.query ? t`No matches` : t`0 matches`;

  return (
    <div className="visual-find-anchor">
      <div className="visual-find-panel" role="search" aria-label={t`Find in document`}>
        <div className="visual-find-row">
          <label className="sr-only" htmlFor={`${inputId}-find`}><Trans>Find</Trans></label>
          <input
            id={`${inputId}-find`}
            ref={findInputRef}
            type="search"
            placeholder={t`Find`}
            value={snapshot.query}
            onChange={(event) => liveCommands(editor)?.setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                selectMatch(editor, event.shiftKey);
              }
            }}
          />
          <span className="visual-find-count" role="status" aria-live="polite">{resultLabel}</span>
          <IconButton size="compact" label={t`Previous match`} onClick={() => selectMatch(editor, true)} disabled={!count}><ChevronUp aria-hidden="true" /></IconButton>
          <IconButton size="compact" label={t`Next match`} onClick={() => selectMatch(editor, false)} disabled={!count}><ChevronDown aria-hidden="true" /></IconButton>
          <IconButton size="compact" label={t`Close find`} onClick={close}><X aria-hidden="true" /></IconButton>
        </div>
        <div className="visual-find-options">
          {FIND_OPTIONS.map(([option, label, Icon]) => (
            <IconButton
              key={option}
              size="compact"
              label={i18n._(label)}
              aria-pressed={snapshot.options[option]}
              onClick={() => liveCommands(editor)?.setFindOptions({ [option]: !snapshot.options[option] }, 0)}
            ><Icon aria-hidden="true" /></IconButton>
          ))}
          {!replaceOpen && (
            <IconButton size="compact" label={t`Show replace`} onClick={() => setReplaceOpen(true)}>
              <Replace aria-hidden="true" />
            </IconButton>
          )}
        </div>
        {replaceOpen && (
          <div className="visual-find-row visual-replace-row">
            <label className="sr-only" htmlFor={`${inputId}-replace`}><Trans>Replace with</Trans></label>
            <input id={`${inputId}-replace`} placeholder={t`Replace with`} value={replacement} onChange={(event) => setReplacement(event.target.value)} />
            <IconButton size="compact" label={t`Replace current match`} disabled={!editable || !count} onClick={() => liveCommands(editor)?.replaceCurrentFindMatch(replacement)}><Replace aria-hidden="true" /></IconButton>
            <IconButton size="compact" label={t`Replace all matches`} disabled={!editable || !count} onClick={() => liveCommands(editor)?.replaceAllFindMatches(replacement)}><ReplaceAll aria-hidden="true" /></IconButton>
          </div>
        )}
      </div>
    </div>
  );
}
