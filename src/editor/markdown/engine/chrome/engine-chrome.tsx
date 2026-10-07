/**
 * The visual engine's editing chrome, assembled: the extensions it adds to
 * the editor and the React layer that draws it (spec R-CHR, R-INL-6/7).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the chrome's extensions and its layer are built together */
import { Extension, type AnyExtension, type Editor } from "@tiptap/core";
import type { PaperSummary } from "../../../../app-types";
import type { VisualMarkdownEditorProps } from "../../visual-editor-props";
import { ENGINE_SHORTCUTS } from "../engine-shortcuts";
import { BlockControls, BlockMoveKeymap } from "./block-controls";
import { createChromeHost, type ChromeHost } from "./chrome-host";
import { FindBar, FindReplace, findShortcuts } from "./find-replace";
import { EngineInputRules } from "./input-rules";
import { LinkEditor, LinkHoverCard, requestLinkEditor } from "./link-chrome";
import { EmojiPickerPopover, ImageFilePicker } from "./pickers";
import { ChangePopover, CommentCard, CommentComposer } from "./review-chrome";
import {
  CitationMenu, WikiLinkMenu, citationExtension, paperDropExtension, wikiLinkExtension, type PageSuggestion,
} from "./references";
import { SelectionToolbar } from "./selection-toolbar";
import type { SlashItem } from "./slash-items";
import { SlashMenu, slashExtension } from "./slash-menu";
import { createMenuStore, type MenuStore } from "./suggestion-menu";

export type Chrome = {
  host: ChromeHost;
  slash: MenuStore<SlashItem>;
  wiki: MenuStore<PageSuggestion>;
  citation: MenuStore<PaperSummary>;
};

export function createChrome(props: VisualMarkdownEditorProps): Chrome {
  return { host: createChromeHost(props), slash: createMenuStore(), wiki: createMenuStore(), citation: createMenuStore() };
}

/** Everything the chrome adds to the editor itself: menus, shortcuts, input rules, drops. */
export function chromeExtensions(chrome: Chrome): AnyExtension[] {
  return [
    slashExtension(chrome.slash, chrome.host),
    wikiLinkExtension(chrome.wiki, chrome.host),
    citationExtension(chrome.citation, chrome.host),
    paperDropExtension(chrome.host),
    EngineInputRules,
    FindReplace,
    findShortcuts(chrome.host),
    BlockMoveKeymap,
    Extension.create({
      name: "latticeLinkShortcut",
      addKeyboardShortcuts: () => ({
        [ENGINE_SHORTCUTS.link.keys[0]]: ({ editor }) => editor.isEditable && requestLinkEditor(editor as Editor, chrome.host),
      }),
    }),
  ];
}

/** The chrome drawn over and around the editor surface. */
export function EngineChrome({ editor, chrome, layer }: { editor: Editor; chrome: Chrome; layer: HTMLElement | null }) {
  return (
    <>
      <SlashMenu editor={editor} store={chrome.slash} />
      <WikiLinkMenu editor={editor} store={chrome.wiki} />
      <CitationMenu editor={editor} store={chrome.citation} />
      <SelectionToolbar editor={editor} host={chrome.host} />
      <LinkEditor editor={editor} host={chrome.host} />
      <LinkHoverCard editor={editor} host={chrome.host} />
      <EmojiPickerPopover editor={editor} host={chrome.host} />
      <ImageFilePicker editor={editor} host={chrome.host} />
      <CommentCard editor={editor} host={chrome.host} />
      <ChangePopover editor={editor} host={chrome.host} />
      <CommentComposer editor={editor} host={chrome.host} />
      <BlockControls editor={editor} layer={layer} host={chrome.host} />
    </>
  );
}

/** The find bar, placed by the host ahead of the article so it can stick to the top of the view. */
export function EngineFindBar({ editor, chrome }: { editor: Editor; chrome: Chrome }) {
  return <FindBar editor={editor} host={chrome.host} />;
}
