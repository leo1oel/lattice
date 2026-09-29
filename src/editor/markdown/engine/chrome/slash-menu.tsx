/**
 * The slash menu (spec R-CHR-1): `/` at the start of a line or after a space
 * opens a searchable, grouped list of insertions with a description of the
 * active one. Choosing an item removes the typed `/query`.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the extension and its listbox belong together */
import { useLingui } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { i18n } from "../../../../i18n";
import type { ChromeHost } from "./chrome-host";
import { matchSlashItems, type SlashItem } from "./slash-items";
import { SuggestionListbox, suggestionExtension, type MenuStore } from "./suggestion-menu";

export function slashExtension(store: MenuStore<SlashItem>, host: ChromeHost) {
  return suggestionExtension<SlashItem>({
    name: "latticeSlashMenu",
    char: "/",
    store,
    // Localized labels are read when the menu filters, so a locale change applies at once.
    items: (query) => matchSlashItems(query, (item) => i18n._(item.label)),
    onSelect: (editor, range, item) => item.run(editor, range, host),
    // Not inside code, formulas or source kept verbatim.
    allow: (editor, range) => {
      const parent = editor.state.doc.resolve(range.from).parent;
      return !parent.type.spec.code;
    },
  });
}

export function SlashMenu({ editor, store }: { editor: Editor; store: MenuStore<SlashItem> }) {
  const { t, i18n: active } = useLingui();
  return (
    <SuggestionListbox
      editor={editor}
      store={store}
      label={t`Slash commands`}
      emptyLabel={t`No results`}
      className="lx-md-slash-menu"
      itemKey={(item) => item.id}
      groupOf={(item) => active._(item.group)}
      renderItem={(item) => {
        const Icon = item.icon;
        return (
          <>
            <span className="lx-md-menu-icon" aria-hidden="true"><Icon /></span>
            <span className="lx-md-menu-label">{active._(item.label)}</span>
          </>
        );
      }}
      preview={(item) => {
        const Icon = item.icon;
        return (
          <>
            <span className="lx-md-menu-preview-icon" aria-hidden="true"><Icon /></span>
            <span className="lx-md-menu-preview-title">{active._(item.label)}</span>
            <span className="lx-md-menu-preview-text">{active._(item.description)}</span>
          </>
        );
      }}
    />
  );
}
