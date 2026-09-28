import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { detectClipboardPrefillUrl } from "@ok-app/editor/clipboard/lone-url";
import { isAllowedLinkUri } from "../../open-knowledge-core/extensions/link-fidelity";
import { isPaperCitationHref, PaperCitation } from "../../open-knowledge-core/extensions/paper-citation";
import { listen } from "../dom-utils";
import { VISUAL_LINK_INSERT_EVENT } from "./visual-slash-items";

function caretAnchor(editor: Editor) {
  const coordinates = editor.view.coordsAtPos(editor.state.selection.from);
  return { left: Math.max(16, Math.min(coordinates.left, window.innerWidth - 376)), bottom: coordinates.bottom };
}

/** URL (and, for a paper citation, title) editor opened by `openVisualLinkInsert`. */
export function VisualLinkInsertPopover({
  editor,
  onOpenChange,
}: {
  editor: Editor;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [url, setUrl] = useState("");
  const [citationTitle, setCitationTitle] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      if ((event as CustomEvent<{ editor?: Editor }>).detail?.editor !== editor) return;
      const currentUrl = String(editor.getAttributes("link").href ?? "");
      setUrl(currentUrl);
      setCitationTitle(editor.isActive(PaperCitation.name) ? String(editor.getAttributes(PaperCitation.name).label) : null);
      setAnchor(caretAnchor(editor));
      onOpenChange(true);
      if (!currentUrl) {
        void readText()
          .then((text) => {
            const href = detectClipboardPrefillUrl(text);
            if (href) setUrl((value) => value || href);
          })
          .catch(() => undefined);
      }
    };
    window.addEventListener(VISUAL_LINK_INSERT_EVENT, handleOpen);
    return () => window.removeEventListener(VISUAL_LINK_INSERT_EVENT, handleOpen);
  }, [editor, onOpenChange]);

  const anchorOpen = anchor !== null;
  useEffect(() => {
    if (!anchorOpen) return;
    let frame: number | null = null;
    const scheduleReposition = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const next = caretAnchor(editor);
        setAnchor((current) => (
          !current || (current.left === next.left && current.bottom === next.bottom) ? current : next
        ));
      });
    };
    const stops = [
      listen(document, [["scroll", scheduleReposition, { capture: true, passive: true }]]),
      listen(window, [["resize", scheduleReposition]]),
    ];
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      stops.forEach((stop) => stop());
    };
  }, [anchorOpen, editor]);

  const close = useCallback(() => {
    setAnchor(null);
    onOpenChange(false);
  }, [onOpenChange]);
  const apply = useCallback((restoreEditorFocus = true) => {
    const href = url.trim();
    if (href && !isAllowedLinkUri(href)) return;
    const chain = editor.chain();
    if (restoreEditorFocus) chain.focus();
    if (citationTitle !== null) {
      const label = citationTitle || String(editor.getAttributes(PaperCitation.name).label);
      const node = editor.state.doc.nodeAt(editor.state.selection.from)!;
      const marks = node.marks.filter((mark) => mark.type.name !== "link").map((mark) => mark.toJSON());
      if (href) marks.push({ type: "link", attrs: { ...editor.getAttributes("link"), href } });
      // setLink only rewrites text marks. Replace the selected leaf explicitly
      // so its title and URL change together in one undoable transaction.
      chain.insertContent(isPaperCitationHref(href)
        ? { type: "paperCitation", attrs: { label }, marks }
        : { type: "text", text: label, marks }).run();
    } else if (href) chain.setLink({ href }).run();
    else chain.unsetLink().run();
    close();
  }, [close, editor, url, citationTitle]);
  const remove = useCallback(() => {
    const chain = editor.chain().focus();
    if (citationTitle !== null) {
      chain.insertContent({ type: "text", text: citationTitle || editor.getAttributes(PaperCitation.name).label, marks: [] });
    }
    chain.unsetLink().run();
    close();
  }, [close, editor, citationTitle]);

  useEffect(() => {
    if (!anchorOpen) return;
    const applyOnOutsidePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node && formRef.current?.contains(event.target))) apply(false);
    };
    document.addEventListener("pointerdown", applyOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", applyOnOutsidePointerDown, true);
  }, [anchorOpen, apply]);

  if (!anchor) return null;
  return (
    <form
      ref={formRef}
      className="visual-link-insert-popover"
      data-citation={citationTitle !== null ? "" : undefined}
      style={{ left: anchor.left, top: anchor.bottom + 6 }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
        editor.commands.focus();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      {citationTitle !== null && (
        <input
          aria-label={t`Citation title`}
          placeholder={t`Citation title`}
          value={citationTitle}
          onChange={(event) => setCitationTitle(event.target.value)}
        />
      )}
      <input autoFocus aria-label={t`Link URL`} placeholder={t`Link URL`} value={url} onChange={(event) => setUrl(event.target.value)} />
      {editor.isActive("link") && <button className="secondary" type="button" onClick={remove}><Trans>Remove</Trans></button>}
      <button type="submit"><Trans>Done</Trans></button>
    </form>
  );
}
