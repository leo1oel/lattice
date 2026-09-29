/**
 * Pickers the slash menu opens: the emoji picker, which inserts the chosen
 * emoji as plain Unicode at the caret in one edit (spec R-CHR-7, R-FMT-19),
 * and the image file picker, which imports through the host and writes the
 * returned path relative to the current file (R-FMT-3).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { EmojiPicker } from "frimousse";
import { projectAssetMarkdownHref } from "../../markdown-link-routing";
import type { ChromeHost } from "./chrome-host";

function useRequest(host: ChromeHost) {
  return useSyncExternalStore(host.subscribe, () => host.request, () => host.request);
}

export function EmojiPickerPopover({ editor, host }: { editor: Editor; host: ChromeHost }) {
  const { t, i18n } = useLingui();
  const request = useRequest(host);
  const at = request?.kind === "emoji" ? request.at : null;
  const [element, setElement] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!element || at == null || editor.isDestroyed) return;
    const caret = editor.view.coordsAtPos(Math.min(at, editor.state.doc.content.size));
    const reference = { getBoundingClientRect: () => new DOMRect(caret.left, caret.top, 1, caret.bottom - caret.top) };
    void computePosition(reference, element, { placement: "bottom-start", strategy: "fixed", middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })] })
      .then(({ x, y }) => {
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
      });
  }, [at, editor, element]);

  useEffect(() => {
    if (at == null) return;
    const close = (event: PointerEvent) => {
      if (element && !element.contains(event.target as Node)) host.clear();
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [at, element, host]);

  if (at == null) return null;
  const insert = (emoji: string) => {
    const position = Math.min(at, editor.state.doc.content.size);
    const transaction = editor.state.tr.insertText(emoji, position);
    transaction.setSelection(TextSelection.create(transaction.doc, position + emoji.length));
    editor.view.dispatch(transaction);
    host.clear();
    editor.view.focus();
  };
  return createPortal(
    <div ref={setElement} className="lx-md-emoji-picker" data-testid="emoji-picker-popover" style={{ position: "fixed", left: 0, top: 0 }}>
      <EmojiPicker.Root
        className="lx-md-emoji-root"
        locale={i18n.locale.startsWith("zh") ? "zh" : "en"}
        columns={9}
        onEmojiSelect={({ emoji }) => insert(emoji)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            host.clear();
            editor.view.focus();
          }
        }}
      >
        <EmojiPicker.Search className="lx-md-emoji-search" placeholder={t`Search emoji`} aria-label={t`Search emoji`} autoFocus />
        <EmojiPicker.Viewport className="lx-md-emoji-viewport">
          <EmojiPicker.Loading className="lx-md-emoji-status">{t`Loading…`}</EmojiPicker.Loading>
          <EmojiPicker.Empty className="lx-md-emoji-status">{t`No results`}</EmojiPicker.Empty>
          <EmojiPicker.List
            className="lx-md-emoji-list"
            components={{
              CategoryHeader: ({ category, ...props }) => <div className="lx-md-emoji-category" {...props}>{category.label}</div>,
              Emoji: ({ emoji, ...props }) => <button type="button" className="lx-md-emoji" {...props}>{emoji.emoji}</button>,
            }}
          />
        </EmojiPicker.Viewport>
      </EmojiPicker.Root>
    </div>,
    document.body,
  );
}

/** The file picker behind the slash Image item, when the host can import files. */
export function ImageFilePicker({ editor, host }: { editor: Editor; host: ChromeHost }) {
  const { t } = useLingui();
  const request = useRequest(host);
  const input = useRef<HTMLInputElement>(null);
  const image = request?.kind === "image" ? request : null;

  useEffect(() => {
    const element = input.current;
    if (!image || !element) return;
    const cancel = () => host.clear();
    element.addEventListener("cancel", cancel);
    element.click();
    return () => element.removeEventListener("cancel", cancel);
  }, [host, image]);

  return (
    <input
      ref={input}
      type="file"
      accept="image/*"
      hidden
      aria-label={t`Choose image to upload`}
      onChange={(event) => {
        const file = event.target.files?.[0];
        const importAsset = host.props().onImportAsset;
        host.clear();
        event.target.value = "";
        if (!file || !importAsset || !image) return;
        let position = image.at;
        const track = ({ transaction, appendedTransactions }: { transaction: Transaction; appendedTransactions: Transaction[] }) => {
          for (const applied of [transaction, ...appendedTransactions]) position = applied.mapping.map(position);
        };
        editor.on("transaction", track);
        void importAsset(file).finally(() => editor.off("transaction", track)).then((path) => {
          if (!path || editor.isDestroyed) return;
          const src = projectAssetMarkdownHref(host.props().activePath, path);
          const node = editor.schema.nodes.image!.create({ src, html: true });
          editor.view.dispatch(editor.state.tr.insert(Math.min(position, editor.state.doc.content.size), node));
        });
      }}
    />
  );
}
