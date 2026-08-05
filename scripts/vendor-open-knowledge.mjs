#!/usr/bin/env node
/**
 * Vendor the Open Knowledge editor UI (app layer) into src/open-knowledge-app/.
 *
 * Mirrors the pinned upstream clone at ~/.cache/research-writer/open-knowledge
 * (see LOCK file for the exact commit). Files listed in MANIFEST are copied
 * verbatim from packages/app/src/, with ONLY these deterministic import-specifier
 * rewrites (no other edits — do not hand-edit vendored files):
 *
 *   '@/…'                      -> '@ok-app/…'   (upstream app alias -> vendored tree)
 *   '@inkeep/open-knowledge-core' -> '@ok-core' (local vendored core barrel)
 *   '@lingui/core/macro'       -> '@ok-app/shims/lingui-core-macro'
 *   '@lingui/react/macro'      -> '@ok-app/shims/lingui-react-macro'
 *   '@lingui/core'             -> '@ok-app/shims/lingui-core'
 *
 * Local seam files (facades/stubs/shims) live in the same tree but are NOT in
 * the manifest and are never overwritten by this script. Each carries a
 * "Local seam — not upstream code" header.
 *
 * Usage: node scripts/vendor-open-knowledge.mjs [--check]
 *   --check: verify vendored files match upstream+rewrites without writing.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const UPSTREAM = path.join(homedir(), ".cache/research-writer/open-knowledge");
const SRC = path.join(UPSTREAM, "packages/app/src");
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEST = path.join(REPO, "src/open-knowledge-app");
const LOCK = path.join(REPO, "open-knowledge-app.lock.json");

/** Files copied verbatim (modulo import rewrites) from packages/app/src/. */
const MANIFEST = [
  // block controls (+ / grip) and keyboard block navigation
  "editor/extensions/drag-handle.ts",
  "editor/extensions/block-mover.ts",
  "editor/block-ux/keyboard-nav.ts",
  // table chrome: row/column three-dot handles, drag reorder, insert bars
  "editor/table-controls/TableCellHandles.tsx",
  "editor/table-controls/useTableDragReorder.tsx",
  "editor/extensions/table-insert-controls.ts",
  "editor/extensions/table-insert-commands.ts",
  "editor/extensions/frozen-table-headers.ts",
  "editor/table-cell-context.ts",
  // find/replace extension (TableCellHandles + bubble-menu-state read its state)
  "editor/find-replace/find-types.ts",
  "editor/find-replace/literal-matcher.ts",
  "editor/find-replace/tiptap-find-replace-extension.ts",
  // slash command menu
  "editor/extensions/slash-command.ts",
  "editor/extensions/suggestion-allow.ts",
  "editor/extensions/suggestion-floating-ui.ts",
  "editor/extensions/editor-mode-context.ts",
  "editor/literal-text-context.ts",
  "editor/slash-command/items.tsx",
  "editor/slash-command/component-items.tsx",
  "editor/slash-command/embed-starter-items.tsx",
  "editor/slash-command/apply-item.ts",
  "editor/slash-command/SlashCommandMenu.tsx",
  "editor/slash-command/emoji-picker-event.ts",
  // bubble menu (incl. footnote button)
  "editor/bubble-menu/BubbleMenuBar.tsx",
  "editor/bubble-menu/BlockTypeSelector.tsx",
  "editor/bubble-menu/InlineFormatButtons.tsx",
  "editor/bubble-menu/FootnoteBubbleButton.tsx",
  "editor/bubble-menu/LinkEditPopover.tsx",
  "editor/bubble-menu/link-edit-popover-events.ts",
  "editor/bubble-menu/bubble-menu-clip.ts",
  "editor/bubble-menu/bubble-menu-state.ts",
  "editor/bubble-menu/ImageAlignButtons.tsx",
  "editor/bubble-menu/FileBubbleButtons.tsx",
  // footnotes
  "editor/extensions/footnote-anchor-scroll.ts",
  // link editing support
  "editor/extensions/link-edit-autoopen.ts",
  "editor/extensions/mark-identity.ts",
  "editor/extensions/doc-context.ts",
  "editor/clipboard/lone-url.ts",
  "editor/gfm-link-detector.ts",
  "editor/internal-link-helpers.ts",
  "editor/link-path-suggestions.tsx",
  "editor/link-path-suggestions-core.ts",
  "editor/safe-navigation-url.ts",
  "editor/asset-dispatch/index.ts",
  "editor/asset-dispatch/dispatcher.ts",
  "editor/asset-dispatch/registry.ts",
  "editor/asset-dispatch/types.ts",
  // interaction layer (dialogs/popovers used by slash + link UI)
  "editor/interaction-layer.tsx",
  "editor/interaction-layer-host.ts",
  // registry metadata + component decoration (index.ts vendored below with
  // the componentMap pack)
  "editor/registry/icons.ts",
  "editor/registry/types.ts",
  "editor/registry/lucide-svg.ts",
  // code block: language dropdown, copy button, lowlight highlight, preview
  "editor/extensions/code-block.ts",
  "editor/extensions/CodeBlockView.tsx",
  "editor/extensions/code-block-languages.ts",
  "editor/extensions/code-block-meta.ts",
  "editor/extensions/code-block-lowlight-plugin.ts",
  "editor/extensions/preview-iframe-header.ts",
  "editor/extensions/preview-live-tokens.ts",
  // rawMdxFallback NodeView: upstream nested-CodeMirror editor for broken /
  // unregistered MDX source, incl. the blur-time parse upgrade. Collab
  // boundary is cut by local seams at the upstream paths:
  //   - editor/utils/get-ydoc.ts        -> always-undefined (no Collaboration ext)
  //   - editor/plugins/{wiki,md}-link-source.ts, agent-flash-source.ts
  //                                     -> inert [] extensions (host-coupled trees)
  //   - lib/config-provider.ts          -> minimal useConfigContext (wordWrap default)
  "editor/extensions/RawMdxFallbackCMView.tsx",
  "editor/extensions/nested-cm-extensions.ts",
  "editor/extensions/cm-theme.ts",
  "editor/markdown-code-languages.ts",
  "editor/utils/severity.ts",
  "editor/utils/get-editor-view.ts",
  "editor/components/ResizeHandles.tsx",
  "editor/components/PreviewBlockedNotice.tsx",
  "editor/components/CodePreviewEditModal.tsx",
  "editor/components/CodeMirrorPropInput.tsx",
  // emoji insertion (slash "/emoji" -> caret-anchored frimousse picker)
  "editor/components/EmojiInsertPopover.tsx",
  "components/emoji-picker.tsx",
  // pure editor behavior extensions (no collab/server deps)
  "editor/extensions/formatting-shortcuts.ts",
  "editor/extensions/tab-focus-trap.ts",
  "editor/extensions/table-row-enter.ts",
  "editor/extensions/heading-anchors.ts",
  "editor/extensions/wiki-link-helpers.ts",
  "editor/page-list-cache.ts",
  // typed-shorthand input rules ($…$ math, [text](url) links); their
  // undo-isolation import is rewritten to the plain-dispatch seam below
  "editor/math-input-rule.ts",
  "editor/inline-link-input-rule.ts",
  // inline math: upstream KaTeX NodeView + the PropPanel editing chain it
  // opens on click / slash-insert. PropPanel drags in the descriptor prop
  // inputs (color/icon/src pickers) and the upload helper; the upload path
  // only activates for asset-type props, never for mathInline's string prop.
  "editor/extensions/math-inline.ts",
  "editor/extensions/MathInlineView.tsx",
  "editor/components/PropPanel.tsx",
  "editor/components/ColorPickerInput.tsx",
  "editor/components/IconPickerInput.tsx",
  "editor/components/SrcAutocomplete.tsx",
  "editor/components/lucide-icon-allowlist.ts",
  "editor/image-upload/upload-file.ts",
  "editor/image-upload/upload-failure.ts",
  "editor/image-upload/current-doc-name.ts",
  "editor/http-client.ts",
  "editor/utils/editor-strings.ts",
  "editor/utils/filter-assets-by-accept.ts",
  "editor/utils/validate-css-length.ts",
  "editor/utils/validate-media-url.ts",
  "components/ui/badge.tsx",
  "components/ui/collapsible.tsx",
  "components/ui/select.tsx",
  "components/ui/switch.tsx",
  // misc editor helpers used by the above
  "editor/utils/alignable-descriptors.ts",
  "editor/utils/animate-align-change.ts",
  "editor/components/File.tsx",
  "hooks/use-is-embedded.ts",
  "lib/workspace-paths.ts",
  // shared app libs
  "lib/keyboard-shortcuts.ts",
  "lib/doc-hash.ts",
  "lib/external-link.ts",
  "lib/utils.ts",
  // UI primitives (upstream shadcn variants — kept separate from our own src/components/ui)
  "components/ui/button.tsx",
  "components/ui/dropdown-menu.tsx",
  "components/ui/kbd.tsx",
  "components/ui/tooltip.tsx",
  "components/ui/separator.tsx",
  "components/ui/input.tsx",
  "components/ui/popover.tsx",
  "components/ui/command.tsx",
  "components/ui/dialog.tsx",
  "components/ui/toast-outside-guard.ts",
  "components/file-entry-icon.tsx",
  "components/file-tree-rename-validation.ts",
  // jsxComponent rendering: upstream NodeView + the full canonical
  // component pack (Callout, Accordion, Tabs, media, Math, Mermaid, …).
  // Collab-boundary cuts (see REWRITES + local seams):
  //   - Mirror.tsx reads other docs over Hocuspocus/Yjs -> local placeholder
  //   - observers.ts (markUserTyping) -> local no-collab seam
  //   - clipboard/index.ts barrel (OPT_OUT_ATTR only) -> local seam
  //   - bridge-id-plugin's ySyncPluginKey -> inert stub key (its no-Yjs
  //     nonce + tr.mapping fallback path becomes the whole behavior)
  "editor/extensions/JsxComponentView.tsx",
  "editor/components/componentMap.tsx",
  "editor/components/Accordion.tsx",
  "editor/components/AlignBlock.tsx",
  "editor/components/Audio.tsx",
  "editor/components/Callout.tsx",
  "editor/components/Embed.tsx",
  "editor/components/Image.tsx",
  "editor/components/Math.tsx",
  "editor/components/Mermaid.tsx",
  "editor/components/MirrorSource.tsx",
  "editor/components/Pdf.tsx",
  "editor/components/pdf-layout.ts",
  "editor/components/Tab.tsx",
  "editor/components/Tabs.tsx",
  "editor/components/Video.tsx",
  "editor/components/DescriptorPlaceholder.tsx",
  "editor/components/jsx-host-context.tsx",
  "components/ui/loading-image.tsx",
  "editor/registry/index.ts",
  "editor/registry/resolve-descriptor-placeholder.ts",
  "editor/extensions/media-render-props.ts",
  "editor/extensions/autonomous-fragment-edit.ts",
  "editor/extensions/selection-state-plugin.ts",
  "editor/extensions/bridge-id-plugin.ts",
  "editor/hooks/use-block-selection.ts",
  "editor/utils/reconstruct-source.ts",
  "editor/utils/sanitize-url.ts",
  "editor/utils/md-singleton.ts",
];

/** Asset directories copied recursively as-is (no rewrites). */
const ASSET_DIRS = ["editor/slash-command/preview-assets"];

const REWRITES = [
  [/from '@\//g, "from '@ok-app/"],
  [/from "@\//g, 'from "@ok-app/'],
  [/from '@inkeep\/open-knowledge-core'/g, "from '@ok-core'"],
  [/from "@inkeep\/open-knowledge-core"/g, 'from "@ok-core"'],
  [/from '@lingui\/core\/macro'/g, "from '@ok-app/shims/lingui-core-macro'"],
  [/from '@lingui\/react\/macro'/g, "from '@ok-app/shims/lingui-react-macro'"],
  [/from '@lingui\/core'/g, "from '@ok-app/shims/lingui-core'"],
  // The slash menu must use the host's actual Lattice scrollbar rather than a
  // browser-native approximation. Keep the upstream listbox as the scroll
  // owner, hide only its native track, and paint ExternalScrollbar as a sibling
  // so the menu's dimensions, content, and interaction styling stay unchanged.
  [
    /import \{ useEffect, useId, useRef \} from 'react';/g,
    "import { useCallback, useEffect, useId, useRef } from 'react';\nimport { ExternalScrollbar } from '../../../components/ui/external-scrollbar';",
  ],
  [
    /  const \{ t \} = useLingui\(\);\n  const activeDescendant =/g,
    "  const { t } = useLingui();\n  const getScrollViewport = useCallback(() => containerRef.current, []);\n  const activeDescendant =",
  ],
  [
    /    <div className="flex items-start gap-2">\n(      <div\n        ref=\{containerRef\}[\s\S]*?\n      <\/div>)\n      \{hasAnyPreview \? \(/g,
    (_match, listbox) => {
      const hostListbox = listbox
        .replace(
          'className="w-56 overflow-y-auto subtle-scrollbar rounded-lg border bg-popover p-1 shadow-md"',
          'className="slash-command-scroll-viewport w-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"',
        )
        .replace(/^/gm, '  ');
      return `    <div className="flex items-start gap-2">
      <div className="relative w-56">
${hostListbox}
        <ExternalScrollbar getViewport={getScrollViewport} />
      </div>
      {hasAnyPreview ? (`;
    },
  ],
  // The HTML/source modal uses the same externally painted Lattice track.
  // CodeMirror remains the scroll owner; only its browser-native bar is hidden.
  [
    /import \{ mermaid \} from 'codemirror-lang-mermaid';\nimport \{ type ReactNode, useEffect, useRef, useState \} from 'react';\nimport \{ Button \} from '@ok-app\/components\/ui\/button';/g,
    "import { mermaid } from 'codemirror-lang-mermaid';\nimport { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';\nimport { Button } from '@ok-app/components/ui/button';\nimport { ExternalScrollbar } from '../../../components/ui/external-scrollbar';",
  ],
  [
    /  const initialValueRef = useRef\(initialValue\);\n  useEffect\(\(\) => \{/g,
    "  const initialValueRef = useRef(initialValue);\n  const sourceSurfaceRef = useRef<HTMLDivElement>(null);\n  const getSourceViewport = useCallback(\n    () => sourceSurfaceRef.current?.querySelector<HTMLElement>('.cm-scroller') ?? null,\n    [],\n  );\n  useEffect(() => {",
  ],
  [
    /          <div\n            ref=\{setHostRef\}\n            className="ok-codepreview-cm min-h-\[260px\] flex-1 overflow-hidden rounded-md border border-border md:min-h-0"([\s\S]*?)            data-language=\{language\}\n          \/>/g,
    "          <div\n            ref={sourceSurfaceRef}\n            className=\"ok-codepreview-cm relative min-h-[260px] flex-1 overflow-hidden rounded-md border border-border md:min-h-0\"$1            data-language={language}\n          >\n            <div ref={setHostRef} className=\"size-full overflow-hidden\" />\n            <ExternalScrollbar getViewport={getSourceViewport} />\n          </div>",
  ],
  // next-themes is upstream's theme provider; the host toggles
  // :root[data-theme] instead, so route through a local shim.
  [/from 'next-themes'/g, "from '@ok-app/shims/next-themes'"],
  // Tag vendored Radix portal surfaces (dropdowns, tooltips) so
  // editor-theme-seam.css can scope upstream tokens + fonts to them without
  // touching the host app's own Radix popups, which use identical
  // data-slot names. Upstream renders these into document.body, outside
  // the .tiptap-editor scope.
  [/data-slot="dropdown-menu-content"/g, 'data-slot="dropdown-menu-content" data-ok-vendor=""'],
  [/data-slot="dropdown-menu-sub-content"/g, 'data-slot="dropdown-menu-sub-content" data-ok-vendor=""'],
  [/data-slot="tooltip-content"/g, 'data-slot="tooltip-content" data-ok-vendor=""'],
  [/data-slot="popover-content"/g, 'data-slot="popover-content" data-ok-vendor=""'],
  [/data-slot="dialog-content"/g, 'data-slot="dialog-content" data-ok-vendor=""'],
  [/data-slot="dialog-overlay"/g, 'data-slot="dialog-overlay" data-ok-vendor=""'],
  // Upstream bug fix: cmdk@1.1.x always renders data-disabled="true"/"false"
  // (never omits the attribute), but Tailwind's bare `data-disabled:` variant
  // is a PRESENCE match — so every CommandItem gets pointer-events:none and
  // 50% opacity in a real browser (jsdom tests pass because jsdom does no
  // hit-testing). Match the value explicitly, like canonical shadcn does.
  [
    /data-disabled:pointer-events-none data-disabled:opacity-50/g,
    "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
  ],
  // Upstream PropPanel dismisses every single-line field on Enter, including
  // the Return macOS uses to commit an IME candidate. Keep that composition
  // event away from JsxComponentView's close -> NodeSelection restoration;
  // keyCode 229 covers WebKit builds that clear isComposing too early.
  [
    /if \(e\.key === 'Enter'\) \{\n(\s+)e\.preventDefault\(\);\n(\s+)onDismiss\(\);/g,
    "if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && !composingRef.current) {\n$1e.preventDefault();\n$2onDismiss();",
  ],
  // WebKit may emit compositionend immediately before the Enter keydown that
  // committed a candidate. Preserve composition state through that event turn
  // and wire the handlers to every single-line PropPanel input.
  [
    /  const handleDismissKeyDown = onDismiss/g,
    "  const composingRef = useRef(false);\n  const compositionClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);\n  const handleCompositionStart = () => {\n    if (compositionClearTimerRef.current) clearTimeout(compositionClearTimerRef.current);\n    compositionClearTimerRef.current = null;\n    composingRef.current = true;\n  };\n  const handleCompositionEnd = () => {\n    if (compositionClearTimerRef.current) clearTimeout(compositionClearTimerRef.current);\n    compositionClearTimerRef.current = setTimeout(() => {\n      composingRef.current = false;\n      compositionClearTimerRef.current = null;\n    }, 0);\n  };\n  const handleDismissKeyDown = onDismiss",
  ],
  [
    /onKeyDown=\{handleDismissKeyDown\}/g,
    "onKeyDown={handleDismissKeyDown}\n              onCompositionStart={handleCompositionStart}\n              onCompositionEnd={handleCompositionEnd}",
  ],
  // Closing Callout properties must return to its editable body, not force a
  // NodeSelection that renders the whole component as a collapsed highlight.
  // Other composite blocks retain upstream's block-selection behavior.
  [
    /        \} else \{\n          editor\.chain\(\)\.setNodeSelection\(p\)\.run\(\);\n        \}/g,
    "        } else if (descriptor.name === 'Callout') {\n          const $inside = editor.state.doc.resolve(Math.min(p + 1, editor.state.doc.content.size));\n          const nextSel = TextSelection.near($inside, 1);\n          editor.view.dispatch(editor.state.tr.setSelection(nextSel).scrollIntoView());\n        } else {\n          editor.chain().setNodeSelection(p).run();\n        }",
  ],
  // ReactRenderer owns its mounted child. Destroy that React tree before the
  // imperative popup host is removed, otherwise React 19 later attempts a
  // second removeChild during a Markdown -> .tex unmount.
  [
    /              \/\/ Positioning cleanup first \(stop autoUpdate → remove popup DOM\)\n              destroySuggestionPopup\(posState\);\n              doPosition = null;\n              \/\/ React cleanup last — if destroy\(\) throws, DOM is already clean\n              renderer\?\.destroy\(\);\n              renderer = null;/g,
    "              // React owns the renderer element, so unmount it while its\n              // popup container is still attached. Then remove the host DOM.\n              renderer?.destroy();\n              renderer = null;\n              destroySuggestionPopup(posState);\n              doPosition = null;",
  ],
  [
    / \* Clean up a suggestion popup\. Order: stop positioning → remove DOM → caller destroys renderer\./g,
    " * Clean up a suggestion popup after the caller has destroyed its ReactRenderer.",
  ],
  // JsxComponentView's popover `onCloseAutoFocus` calls `editor.view.focus()`
  // — Radix fires close-autofocus during React teardown too (editor unmounted
  // with the popover open), and TipTap's `editor.view` getter throws once the
  // editor is destroyed. Same guard as MathInlineView below.
  [
    /e\.preventDefault\(\);\n(\s+)editor\.view\.focus\(\);/g,
    "e.preventDefault();\n$1if (editor.isDestroyed) return;\n$1editor.view.focus();",
  ],
  // undo-isolation imports @tiptap/y-tiptap + yjs for the y-undo capture
  // split; this host has no Yjs editor binding (string-based collab), so
  // upstream's documented fallback ("absent a y-undo binding the dispatch
  // happens plain") is the whole behavior. Route to a plain-dispatch seam
  // instead of adding yjs to the bundle.
  [/from '\.\/undo-isolation'/g, "from './undo-isolation-plain'"],
  // sonner is upstream's toast stack; the host surfaces toasts through its
  // app-log store. Route through a local shim with the same `toast` surface.
  [/from 'sonner'/g, "from '@ok-app/shims/sonner'"],
  // Host KaTeX macros (user-defined LaTeX macros from the project) must flow
  // into the vendored inline-math renderer; upstream has no macros concept.
  // Inject a seam import + per-render macros lookup into the lazy KaTeX
  // factory (MathInlineView.tsx is the only manifest file matching either
  // pattern).
  [
    /const { default: katex } = await import\('katex'\);/g,
    "const { default: katex } = await import('katex');\n  const { getHostKatexMacros } = await import('@ok-app/shims/katex-macros');",
  ],
  [/strict: 'ignore',/g, "strict: 'ignore',\n      macros: getHostKatexMacros(),"],
  // Research Writer reads project assets through a Tauri command rather than
  // Open Knowledge's HTTP asset route. Keep the upstream Image renderer, but
  // resolve its authored project path to the host-provided data URL first.
  [
    /import \{ LoadingImage \} from '@ok-app\/components\/ui\/loading-image';/g,
    "import { LoadingImage } from '@ok-app/components/ui/loading-image';\nimport { useProjectImageSrc } from '../../../project-image-host';",
  ],
  [
    /function BareImg\(props: ImageProps\) \{\n  return \(\n    <LoadingImage\n      src=\{props\.src === undefined \? undefined : toDesktopAssetHref\(props\.src\)\}/g,
    "function BareImg(props: ImageProps) {\n  const src = useProjectImageSrc(props.src);\n  return (\n    <LoadingImage\n      src={src === undefined ? undefined : toDesktopAssetHref(src)}",
  ],
  // upload-file keeps `accept` on its public signature for call-site
  // stability (upstream biome-ignores the unused param); this host compiles
  // with noUnusedParameters, so underscore-prefix it deterministically.
  [
    /  accept: readonly string\[\],\n  deps: UploadFileDeps = {},/g,
    "  _accept: readonly string[],\n  deps: UploadFileDeps = {},",
  ],
  // MathInlineView's popover `onCloseAutoFocus` runs `editor.view.dispatch`
  // + `editor.view.focus()` — but Radix fires close-autofocus during React
  // teardown too (document closed / editor unmounted with the popover open),
  // and TipTap's `editor.view` getter throws once the editor is destroyed.
  // Bail out early when there is no live editor to focus.
  [
    /e\.preventDefault\(\);\n(\s+)const p = typeof getPos === 'function' \? getPos\(\) : undefined;/g,
    "e.preventDefault();\n$1if (editor.isDestroyed) return;\n$1const p = typeof getPos === 'function' ? getPos() : undefined;",
  ],
  // pdfjs-dist v6 (host) removed PDFDocumentProxy.destroy(); the
  // supported teardown is loadingTask.destroy() (upstream pins v5).
  [/await doc\.destroy\(\);/g, "await doc.loadingTask.destroy();"],
  [/void activeDoc\.destroy\(\);/g, "void activeDoc.loadingTask.destroy();"],
  // Mirror reads other documents through a Hocuspocus/Yjs provider pool
  // (use-mirror-source.ts) — collab boundary. Route componentMap to a local
  // placeholder that renders the descriptor as unsupported in this host.
  [/import { Mirror } from '\.\/Mirror\.tsx';/g, "import { Mirror } from './Mirror-host.tsx';"],
  // bridge-id-plugin keys stable jsxComponent identity off y-prosemirror's
  // binding when present. This host has no y-sync plugin, so route the key
  // import to an inert stub — getState() is always undefined and the
  // plugin's documented no-Yjs fallback (nonce + tr.mapping remap) becomes
  // the whole behavior. Correct here: remote edits arrive as full-document
  // setMarkdownWithoutHistory replaces, not incremental Yjs churn.
  [/from '@tiptap\/y-tiptap'/g, "from '@ok-app/shims/y-sync-stub'"],
  // BubbleMenuBar's virtual element reads `editor.view.dom` during render —
  // the one unguarded `editor.view` access in the vendored tree (TipTap v3's
  // view proxy throws pre-mount; upstream's own bubble-menu-clip.ts wraps the
  // same access in try/catch, and everything else goes through
  // getEditorView()). Upstream avoids the crash purely by render timing,
  // which React 19 concurrent rendering in this host does not guarantee.
  [
    /contextElement: editor\.view\.dom,/g,
    "contextElement: (editor as unknown as { editorView?: { dom: HTMLElement } }).editorView?.dom,",
  ],
  // TipTap v3 portals BubbleMenuBar itself directly to document.body, outside
  // the editor's [data-ok-vendor] theme scope. Tag the portal root so the
  // vendored controls inherit the same runtime tokens and scoped Preflight
  // reset as the editor instead of WebKit's dark default button face.
  [
    /data-testid="bubble-menu-bar"\n(\s+)appendTo=/g,
    'data-testid="bubble-menu-bar"\n$1data-ok-vendor=""\n$1appendTo=',
  ],
  // Link is part of the same inline-action run as Highlight and the following
  // footnote/source actions. Upstream inserts a group separator here, whose
  // width and margins make this one button gap visibly larger than the rest.
  [
    /(\s+<InlineFormatButtons key=\{tooltipKey\} editor=\{editor\} \/>)\n\s+<Separator orientation="vertical" className="mx-0\.5 h-5 data-vertical:self-center" \/>/g,
    '$1',
  ],
  // The host toolbar already owns the canonical tooltip surface. Route every
  // Markdown bubble-menu tooltip through that exact component instead of
  // restyling Open Knowledge's arrowed tooltip in parallel.
  [/from '@ok-app\/components\/ui\/tooltip'/g, "from '@/components/ui/tooltip'"],
  [
    /import \{ Trans, useLingui \} from '@ok-app\/shims\/lingui-react-macro';\nimport type \{ Editor \} from '@tiptap\/react';\nimport \{ ArrowUpRight, CornerDownLeft, Link, Trash2 \} from 'lucide-react';/g,
    "import { Trans, useLingui } from '@ok-app/shims/lingui-react-macro';\nimport type { Editor } from '@tiptap/react';\nimport { readText } from '@tauri-apps/plugin-clipboard-manager';\nimport { ArrowUpRight, CornerDownLeft, Link, Trash2 } from 'lucide-react';",
  ],
  [
    /    text = await navigator\.clipboard\.readText\(\);\n  \} catch \(error\) \{\n    \/\/ Expected denials \(permission, insecure context, empty clipboard\) arrive\n    \/\/ as DOMExceptions and degrade silently by design\. Anything else — a\n    \/\/ polyfill or CSP failure that would make pre-fill always-empty — warns\n    \/\/ \(debug is suppressed by default console filters\) so it is\n    \/\/ field-diagnosable\.\n    if \(!\(error instanceof DOMException\)\) \{\n      console\.warn\('\[link-popover\] clipboard pre-fill read failed unexpectedly', error\);\n    \}\n    return;/g,
    "    // WebKit's navigator.clipboard.readText() inserts a native “Paste”\n    // confirmation affordance between the button and the field. The desktop\n    // host already owns clipboard permission, so use its API and keep opening\n    // the field a single, uninterrupted action.\n    text = await readText();\n  } catch {\n    // Clipboard access is optional pre-fill. If unavailable, leave the input\n    // open and empty without surfacing an error or changing interaction state.\n    return;",
  ],
  [
    /import \{ Button \} from '@ok-app\/components\/ui\/button';\nimport \{ Kbd \} from '@ok-app\/components\/ui\/kbd';\nimport \{ Tooltip, TooltipContent, TooltipTrigger \} from '@\/components\/ui\/tooltip';/g,
    "import { Button } from '@ok-app/components/ui/button';\nimport { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';",
  ],
  [/  formatShortcutLabel,\n/g, ''],
  [
    /<span className="capitalize">\{action\.name\}<\/span>\n              <Kbd aria-label=\{formatShortcutLabel\(action\.shortcutId\)\}>\n                \{formatShortcut\(action\.shortcutId\)\}\n              <\/Kbd>/g,
    '<span className="capitalize">{action.name} ({formatShortcut(action.shortcutId)})</span>',
  ],
  [
    /<Trans>Link<\/Trans>\n        <Kbd>\{formatShortcut\('add-link'\)}<\/Kbd>/g,
    "<span><Trans>Link</Trans> ({formatShortcut('add-link')})</span>",
  ],
  [
    /<Superscript className="size-3\.5" aria-hidden="true" \/>/g,
    '<Superscript className="size-4" aria-hidden="true" />',
  ],
  // DollarMath and MathFence are ordinary display-equation source forms, not
  // user-facing component concepts. Keep their edit affordance descriptive
  // instead of exposing the internal compatibility descriptor name.
  [
    /(  const editableSource: \{ propName: string; language: 'mermaid' \| 'latex' \} \| null =[\s\S]*?        : null;)\n  const \[editModalOpen,/g,
    "$1\n  const editableSourceLabel =\n    descriptor.name === 'Math' ||\n    descriptor.name === 'DollarMath' ||\n    descriptor.name === 'MathFence'\n      ? t`Edit display equation`\n      : t`Edit ${descriptor.displayName ?? descriptor.name} source`;\n  const [editModalOpen,",
  ],
  [/aria-label=\{t`Edit \$\{descriptor\.displayName \?\? descriptor\.name\} source`\}/g, 'aria-label={editableSourceLabel}'],
  [/title=\{t`Edit \$\{descriptor\.displayName \?\? descriptor\.name\} source`\}/g, 'title={editableSourceLabel}'],
  [
    /size="sm"\n(\s+)className="gap-1 px-2 text-sm font-medium text-accent-foreground\/80"/g,
    'size="sm"\n$1data-testid="block-type-selector"\n$1className="gap-1 px-2 text-sm font-medium text-accent-foreground/80"',
  ],
  // The upstream in-toolbar link field carries its own nested Tailwind frame,
  // which conflicts visually with the host's compact selection toolbar.
  // Replace only the presentation classes; link behavior remains upstream.
  [
    /<div className="flex items-center gap-0\.5">\n(\s+)<div className="flex items-center gap-1\.5 rounded-md border bg-background px-2 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring\/50">/g,
    '<div className="visual-bubble-link-editor">\n$1<div className="visual-bubble-link-field">',
  ],
  [
    /className="h-5 w-44 rounded-none border-none bg-transparent px-0 py-0 text-sm placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"/g,
    'className="visual-bubble-link-input"',
  ],
  [/placeholder=\{t`Paste link`\}/g, 'placeholder={t`Link URL`}'],
  [/const suggestionTriggered = emptyTriggered \|\| pathTargetTriggered;/g, 'const suggestionTriggered = !emptyTriggered && pathTargetTriggered;'],
  [/\(emptyTriggered \|\| slashTriggered\) &&/g, 'slashTriggered &&'],
  // Plain Markdown stores only highlight presence, so keep the upstream
  // one-click interaction and give the visual mark one fixed host color.
  [
    /editor\.chain\(\)\.focus\(\)\.toggleHighlight\(\)\.run\(\)/g,
    "editor.chain().focus().toggleHighlight({ color: '#FFD875' }).run()",
  ],
  // Mermaid stays a normal code block. Add it to the existing HTML-style
  // language picker + eye-toggle preview path and render MermaidView in the
  // preview surface instead of an iframe.
  [
    /  \{ value: 'markdown', label: 'Markdown', aliases: \['md', 'mdx'\] \},/g,
    "  { value: 'markdown', label: 'Markdown', aliases: ['md', 'mdx'] },\n  { value: 'mermaid', label: 'Mermaid', aliases: ['diagram', 'flowchart'] },",
  ],
  [
    / \* Includes `html`\/`htm` \(what users type\) AND `xml` \(highlight\.js's canonical\n \* key — `normalizeCodeLanguage` rewrites `html` → `xml` for token coloring\)\./g,
    " * Includes HTML/XML aliases and Mermaid. `normalizeCodeLanguage` rewrites\n * `html` to `xml` for token coloring, while Mermaid keeps its own language ID.",
  ],
  [
    /export const PREVIEWABLE_LANGUAGES = new Set\(\['html', 'htm', 'xml'\]\);/g,
    "export const PREVIEWABLE_LANGUAGES = new Set(['html', 'htm', 'xml', 'mermaid']);",
  ],
  [
    /import \{ ResizeHandles \} from '\.\.\/components\/ResizeHandles\.tsx';/g,
    "import { ResizeHandles } from '../components/ResizeHandles.tsx';\nimport { MermaidView } from '../components/Mermaid.tsx';",
  ],
  [
    /  const previewActive = shouldShowPreview\(normalized, rawMeta\);/g,
    "  const previewActive = shouldShowPreview(normalized, rawMeta);\n  const isMermaidPreview = normalized === 'mermaid';",
  ],
  [
    /(          )<iframe\n            title=\{t`HTML preview`\}\n            ref=\{previewFrameRef\}([\s\S]*?            onLoad=\{\(\) => \{[\s\S]*?            \}\}\n          )\/>/g,
    "$1{isMermaidPreview ? (\n$1  <div\n$1    role=\"group\"\n$1    aria-label={t`Mermaid preview`}\n$1    className=\"flex size-full min-h-0 items-stretch justify-stretch\"\n$1  >\n$1    <MermaidView chart={node.textContent} className=\"size-full rounded-none border-0\" />\n$1  </div>\n$1) : (\n$1  <iframe\n$1    title={t`HTML preview`}\n$1    ref={previewFrameRef}$2  />\n$1)}",
  ],
  [/\{previewActive && blockedRequests \? \(/g, '{previewActive && !isMermaidPreview && blockedRequests ? ('],
  [
    /aria-label=\{previewToggled \? t`Hide HTML preview` : t`Show HTML preview`\}/g,
    "aria-label={\n              previewToggled\n                ? isMermaidPreview\n                  ? t`Hide Mermaid preview`\n                  : t`Hide HTML preview`\n                : isMermaidPreview\n                  ? t`Show Mermaid preview`\n                  : t`Show HTML preview`\n            }",
  ],
];

function rewrite(content) {
  let out = content;
  for (const [re, to] of REWRITES) out = out.replace(re, to);
  return out;
}

const check = process.argv.includes("--check");
const upstreamCommit = execSync("git rev-parse HEAD", { cwd: UPSTREAM }).toString().trim();

let mismatches = 0;
const lockFiles = {};

for (const rel of MANIFEST) {
  const srcPath = path.join(SRC, rel);
  const destPath = path.join(DEST, rel);
  if (!existsSync(srcPath)) {
    console.error(`MISSING upstream file: ${rel}`);
    process.exitCode = 1;
    continue;
  }
  const content = rewrite(readFileSync(srcPath, "utf8"));
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  lockFiles[rel] = hash;
  if (check) {
    const current = existsSync(destPath) ? readFileSync(destPath, "utf8") : null;
    if (current !== content) {
      console.error(`DRIFT: ${rel}`);
      mismatches++;
    }
  } else {
    mkdirSync(path.dirname(destPath), { recursive: true });
    writeFileSync(destPath, content);
  }
}

for (const rel of ASSET_DIRS) {
  const srcPath = path.join(SRC, rel);
  const destPath = path.join(DEST, rel);
  if (!existsSync(srcPath)) {
    console.error(`MISSING upstream dir: ${rel}`);
    process.exitCode = 1;
    continue;
  }
  if (!check) cpSync(srcPath, destPath, { recursive: true });
  for (const f of readdirSync(srcPath)) {
    if (statSync(path.join(srcPath, f)).isFile()) {
      lockFiles[`${rel}/${f}`] = createHash("sha256")
        .update(readFileSync(path.join(srcPath, f)))
        .digest("hex")
        .slice(0, 16);
    }
  }
}

if (!check) {
  writeFileSync(
    LOCK,
    `${JSON.stringify(
      {
        upstream: "https://github.com/inkeep/open-knowledge",
        commit: upstreamCommit,
        sourceRoot: "packages/app/src",
        vendoredAt: new Date().toISOString(),
        note: "Regenerate with: node scripts/vendor-open-knowledge.mjs. Do not hand-edit vendored files; local seams live alongside but are not in this lock.",
        files: lockFiles,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Vendored ${Object.keys(lockFiles).length} files from ${upstreamCommit}`);
} else if (mismatches) {
  console.error(`${mismatches} vendored file(s) drifted from upstream+rewrites`);
  process.exitCode = 1;
} else {
  console.log("All vendored files match upstream+rewrites");
}
