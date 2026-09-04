// Vitest empties CSS imports, so read the files off disk.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (file: string) => String(readFileSync(file, "utf8"))
const appCss = [
  "src/App.css",
  "src/styles/theme.css",
  "src/styles/app-shell.css",
  "src/styles/editor-workspace.css",
  "src/styles/workspace-panels.css",
  "src/styles/dialogs.css",
  "src/styles/adaptive-feedback.css",
].map(read).join("\n")
const iconLabCss = String(readFileSync("tools/icon-lab/icon-lab.css", "utf8"))
const surfacesCss = String(readFileSync("src/styles/surfaces.css", "utf8"))
const indexCss = String(readFileSync("src/index.css", "utf8"))
const projectDialogs = String(readFileSync("src/project/project-dialogs.tsx", "utf8"))
const menuSurface = String(readFileSync("src/components/ui/menu-surface.ts", "utf8"))
const spreadsheetEditor = String(readFileSync("src/editor/spreadsheet/spreadsheet-editor.tsx", "utf8"))
const scrollAreaCss = String(readFileSync("src/components/ui/scroll-area.css", "utf8"))

describe("shared surface contracts", () => {
  it("is owned by App.css instead of being restated per feature", () => {
    expect(appCss).toContain('@import "./styles/surfaces.css"')
    expect(surfacesCss).toContain(".modal:not(.collab-drawer-content):not(.overleaf-picker-drawer-content),")
    expect(surfacesCss).toContain(".resizable-drawer,")
    expect(surfacesCss).toContain("padding: var(--drawer-content-inset)")
    expect(appCss).toContain(".history-drawer")
    expect(surfacesCss).toContain("@keyframes drawer-in")
  })

  // Feature rules should only add layout/sizing after the shared chrome lands.
  it("routes shared floating chrome through shadow-plugin", () => {
    const floatingChrome =
      /border:\s*1px solid var\(--border-strong\);[^}]*background:\s*var\(--surface-panel-raised\);[^}]*box-shadow:\s*var\(--shadow\)/
    const drawerChrome =
      /background:\s*var\(--surface-input\);[^}]*box-shadow:\s*var\(--shadow\);[^}]*padding:\s*14px;[^}]*animation:\s*drawer-in/
    expect(indexCss).toContain('@import "shadow-plugin"')
    expect(surfacesCss).toContain("@apply smooth-shadow-ring-lg")
    expect(surfacesCss).toContain("@apply smooth-shadow-lg")
    expect(appCss).not.toMatch(floatingChrome)
    expect(appCss).not.toMatch(drawerChrome)
    expect(appCss).not.toMatch(/@keyframes drawer-in/)
    expect(iconLabCss).not.toMatch(floatingChrome)
  })

  it("keeps the frosted hover-card chrome in one place", () => {
    const frostedChrome =
      /background:\s*color-mix\(in srgb, var\(--surface-panel-raised\)\s*97%,\s*transparent\);[^}]*backdrop-filter:\s*blur\(14px\)/
    expect(surfacesCss).toMatch(frostedChrome)
    expect(appCss).not.toMatch(frostedChrome)
  })

  it("keeps PDF.js annotation layers below application drawers", () => {
    expect(appCss).toMatch(
      /\.pdf-preview \{[^}]*position:\s*relative;[^}]*isolation:\s*isolate;/,
    )
    expect(appCss).toMatch(
      /\.drawer-backdrop \{[^}]*z-index:\s*var\(--z-drawer-backdrop\);/,
    )
  })

  it("lets a Paper reader fill its split pane", () => {
    expect(appCss).toMatch(
      /\.paper-pane > \.paper-reader-shell \{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;/,
    )
  })

  it("does not hardcode the popover surface colour on the project menu", () => {
    expect(projectDialogs).not.toMatch(/bg-\[#F9F9FA\]|dark:bg-popover/)
  })

  it("keeps collaboration helper text clear of its input", () => {
    expect(appCss).toContain(".collab-field > .collab-name-help { margin: 0; }")
    expect(appCss).toContain("gap: var(--drawer-section-gap)")
    expect(appCss).not.toContain(".collab-advanced-toggle")
  })

  it("keeps drawer controls clear of surrounding dividers", () => {
    expect(appCss).toMatch(
      /\.history-filters \{[^}]*margin:\s*var\(--space-6\) 0/,
    )
    expect(appCss).toMatch(
      /\.insert-palette-scroll-content \{[^}]*padding-top:\s*var\(--drawer-content-inset\)/,
    )
    expect(appCss).toMatch(
      /\.editor-comments-drawer \.pdf-marks-toolbar \{[^}]*margin-top:\s*var\(--drawer-content-inset\)/,
    )
    expect(appCss).toMatch(
      /\.literature-search \{[^}]*margin:\s*var\(--drawer-content-inset\) 0 var\(--drawer-section-gap\)/,
    )
  })

  it("lets the insert palette wrap to one column instead of clipping the second", () => {
    expect(appCss).toMatch(
      /\.insert-palette-grid \{[^}]*minmax\(min\(188px, 100%\), 1fr\)/,
    )
    expect(appCss).toMatch(
      /\.insert-palette-groups > section \{[^}]*contain-intrinsic-inline-size:\s*0px;[^}]*min-width:\s*0/,
    )
  })

  it("keeps bibliography form sections from touching", () => {
    expect(appCss).toMatch(
      /\.table-generator, \.project-replace, \.bib-entry-dialog \{[^}]*gap:\s*var\(--space-6\)/,
    )
    expect(appCss).not.toContain(".bib-entry-dialog { gap: 0; }")
  })

  it("keeps shared-room overflow inside dedicated Lattice scrollbar tracks", () => {
    expect(appCss).toMatch(
      /\.collab-recent-scroll \{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*padding-right:\s*var\(--space-5\);[^}]*padding-bottom:\s*var\(--space-5\)/,
    )
    expect(appCss).toMatch(
      /\.collab-recent-scroll-content \{[^}]*width:\s*max-content;[^}]*min-width:\s*100%/,
    )
    expect(appCss).toMatch(
      /\.collab-recent-scroll > \.lattice-scrollbar\[data-orientation="vertical"\] \{[^}]*height:\s*calc\(100% - var\(--space-5\)\)/,
    )
    expect(appCss).toMatch(
      /\.collab-recent-scroll > \.lattice-scrollbar\[data-orientation="horizontal"\] \{[^}]*width:\s*calc\(100% - var\(--space-5\)\)/,
    )
  })

  it("keeps elevated menus and Settings free of hard outer frames", () => {
    expect(menuSurface).not.toContain(" border border-border ")
    expect(menuSurface).toContain("smooth-shadow-lg")
    expect(menuSurface).not.toContain("smooth-shadow-ring-lg")
    expect(menuSurface).not.toMatch(/shadow-\[/)
    expect(surfacesCss).toMatch(/\.settings-modal \{\s*@apply smooth-shadow-xl;\s*background: var\(--surface-panel-raised\);\s*\}/)
    const borderedSurfaces = surfacesCss.slice(0, surfacesCss.indexOf("/* Settings deliberately"))
    expect(borderedSurfaces).not.toContain(".settings-modal")
  })

  it("lets menu viewports inherit the app scrollbar", () => {
    expect(menuSurface).not.toContain("scrollbar-width:none")
    expect(surfacesCss).not.toContain('[data-slot="dropdown-menu-content"]::-webkit-scrollbar')
  })

  it("keeps the spreadsheet formula controls level and off pure white", () => {
    expect(appCss).toMatch(
      /\[data-u-comp="defined-name"\] \{ padding-block: 0 !important; \}/,
    )
    expect(appCss).toContain(
      '[data-u-comp="formula-bar"] > div:first-child { flex: 0 0 calc(6rem + 4px); }',
    )
    expect(appCss).toMatch(
      /\[data-u-comp="defined-name"\] input,[^}]+background: #FAFAFA !important;/,
    )
  })

  it("gives the spreadsheet ribbon a slightly deeper neutral surface", () => {
    expect(appCss).toMatch(
      /\[data-u-comp="ribbon-header-menu"\] \+ div:has\(> \[data-u-comp="ribbon-toolbar"\]\) \{\s*background: #F4F4F5;/,
    )
  })

  it("matches spreadsheet toolbar artwork to Lattice icon sizing", () => {
    expect(appCss).toContain(
      '.spreadsheet-univer-host [data-u-comp="ribbon-toolbar"] { translate: 0 .5px; }',
    )
    expect(appCss).toMatch(
      /\[data-u-comp="ribbon-toolbar"\] svg \{[^}]*display: block;[^}]*width: 14px;\s*height: 14px;[^}]*align-self: center;/,
    )
    expect(appCss).toMatch(
      /\.univerjs-icon-font-color-double-icon,[\s\S]+\.univerjs-icon-paint-bucket-double-icon[\s\S]+\{\s*width: 16px;\s*height: 16px;/,
    )
    expect(appCss).toMatch(
      /\.univerjs-icon-paint-bucket-double-icon \{\s*translate: -3% 0;/,
    )
    expect(appCss).toMatch(
      /\.univerjs-icon-paint-bucket-double-icon path:last-child \{\s*stroke: var\(--border-strong\);\s*stroke-width: \.5;/,
    )
    expect(appCss).toMatch(
      /button:not\(:disabled\),[\s\S]+\.univer-toolbar-button-selector-root,[\s\S]+\.univer-toolbar-selector-root[\s\S]+:hover \{\s*background: var\(--toolbar-hover-surface\) !important;/,
    )
    expect(appCss).toMatch(
      /\[data-u-command="univer\.command\.undo"\],[\s\S]+\[data-u-command="univer\.command\.redo"\][\s\S]+:disabled \{\s*color: color-mix\(in srgb, var\(--text-primary\) 32%, transparent\) !important;/,
    )
  })

  it("matches spreadsheet sidebars to Lattice close and scrollbar chrome", () => {
    expect(appCss).toMatch(
      /\[data-u-comp="sidebar"\][^}]+button\[aria-label="Close sidebar"\] \{[^}]*width: var\(--control-size-icon\);[^}]*height: var\(--control-size-icon\);[^}]*border-radius: var\(--radius-icon\);/,
    )
    expect(appCss).toMatch(
      /button\[aria-label="Close sidebar"\]::before \{[^}]*width: 16px;[^}]*height: 16px;[^}]*mask: url\("data:image\/svg\+xml/,
    )
    expect(spreadsheetEditor).toContain("<ExternalScrollbar getViewport={getSidebarScrollViewport} />")
    expect(scrollAreaCss).toMatch(
      /\.lattice-scrollbar\[data-orientation="vertical"\] \.lattice-scrollbar-thumb \{[^}]*width: 4px;/,
    )
    expect(scrollAreaCss).toMatch(
      /\.lattice-scrollbar\[data-orientation="vertical"\]:hover \.lattice-scrollbar-thumb \{[^}]*width: 6px;/,
    )
    expect(appCss).toMatch(
      /\[data-u-comp="sidebar"\] > section \{[^}]*scrollbar-width: none !important;/,
    )
    expect(appCss).toMatch(
      /\.spreadsheet-editor-root > \.external-scrollbar,[^}]+\.spreadsheet-functions-scrollbar-surface \{[^}]*z-index: var\(--z-spreadsheet-scrollbar\);/,
    )
    expect(appCss).toMatch(
      /\[data-u-comp="sidebar"\] kbd \{[^}]*font-size: var\(--type-body-size\);/,
    )
    expect(spreadsheetEditor).toContain("functionsPanelOpen && (")
    expect(spreadsheetEditor).toContain("<ExternalScrollbar getViewport={getFunctionsScrollViewport} />")
    expect(appCss).toMatch(
      /\[data-u-comp="sheets-formula-functions-panel"\] ul\.univer-overflow-y-auto \{[^}]*scrollbar-width: none !important;/,
    )
  })

  it("matches spreadsheet selectors and sidebar actions to Lattice controls", () => {
    expect(appCss).toMatch(
      /\[data-u-comp="sidebar"\] \[data-u-comp="select"\] \{[^}]*height: var\(--control-height-default\);[^}]*border-radius: var\(--form-control-select-radius\) !important;/,
    )
    expect(appCss).toMatch(
      /\[data-u-comp="sidebar"\] \[data-u-comp="button"\] \{[^}]*height: var\(--control-height-default\);[^}]*border-radius: var\(--radius-control\) !important;/,
    )
    expect(appCss).toMatch(
      /\[data-u-comp="button"\]\.univer-bg-primary-600 \{[^}]*background: var\(--text-primary\) !important;[^}]*color: var\(--surface-app\) !important;/,
    )
    expect(appCss).toMatch(
      /div:has\(> \[data-u-comp="button"\] \+ \[data-u-comp="button"\]\) \{[^}]*gap: var\(--space-4\);/,
    )
  })

  it("keeps spreadsheet menu labels left and selection marks right", () => {
    expect(appCss).toMatch(
      /\[data-slot="dropdown-menu-content"\]\.univer-text-sm[^}]+\{[^}]*border-radius: var\(--spreadsheet-menu-radius\) !important;[^}]*background: var\(--surface-panel-raised\) !important;/,
    )
    expect(appCss).toMatch(
      /\[data-slot="dropdown-menu-radio-item"\][\s\S]+\[data-slot="dropdown-menu-checkbox-item"\][\s\S]+\)\[data-state="checked"\]::after \{[^}]*top: 50%;[^}]*right: var\(--gap-inline\);[^}]*background: var\(--control-active\);[^}]*mask: url\("data:image\/svg\+xml/,
    )
    expect(appCss).toMatch(
      /\.univer-relative\.univer-flex:has\(> svg\.univer-absolute\)::after \{[^}]*right: 0;[^}]*background: var\(--control-active\);[^}]*mask: url\("data:image\/svg\+xml/,
    )
    expect(appCss).toMatch(
      /\.univer-relative\.univer-flex\.univer-pl-6 \{[^}]*padding-left: 0 !important;/,
    )
    expect(appCss).toMatch(
      /\[data-slot="dropdown-menu-checkbox-item"\][\s\S]+\) \{[^}]*padding: 0 var\(--space-3\) !important;/,
    )
    expect(appCss).toMatch(
      /ul\.univer-list-none button \{[^}]*padding: 0 var\(--space-3\) !important;/,
    )
    expect(appCss).toMatch(
      /\[data-slot="dropdown-menu-item"\]:has\(ul\.univer-list-none\)[\s\S]+ul\.univer-list-none button:is\(:hover, :focus-visible\) \{[^}]*background: var\(--control-active-soft\) !important;/,
    )
  })

  it("removes the speech-bubble arrow from Univer tooltips", () => {
    expect(appCss).toContain(
      'body > [role="tooltip"].univer-bg-gray-700 > div + div { display: none; }',
    )
  })

  // One appearance for anything the app tells you. There used to be five: the
  // toast stack, three fixed banners next to it, and a bespoke coloured <p> in
  // every panel that needed a line of feedback. Each rule below is one of those
  // ways staying gone.
  it("has a single notification surface", () => {
    // The banners that sat beside the toast stack in a different shape.
    for (const banner of [".error-banner", ".warning-banner", ".notice-banner"]) {
      expect(appCss).not.toContain(banner)
      expect(surfacesCss).not.toContain(banner)
    }
    // The updater keeps its own component — it owns a progress bar and an
    // Install button — but not its own shape.
    const updaterCss = read("src/telemetry/app-updater.css")
    expect(updaterCss).toMatch(/\.app-update-banner \{[^}]*width: 320px/)
    expect(updaterCss).toMatch(/\.app-update-banner \{[^}]*border-radius: 11px/)
    expect(appCss).toMatch(/\.app-toast \{[^}]*border-radius: 11px/)
    expect(appCss).toMatch(/\.app-toast-stack \{[^}]*width: 320px/)
  })

  it("puts a notification's icon, message and dismiss on one axis", () => {
    // A single-line toast centres all three against each other; `start` used to
    // leave 16px of text riding above the 24px dismiss button beside it.
    expect(appCss).toMatch(/\.app-toast \{[^}]*align-items: center/)
    // Past one line, they pin to the title's line box instead, so the icon does
    // not drift to the middle of a paragraph.
    expect(appCss).toContain(".app-toast.expanded { align-items: start; }")
    expect(appCss).toMatch(
      /\.app-toast\.expanded > button \{ margin-top: calc\(\(var\(--type-label-line-height\) - var\(--control-size-icon-compact\)\) \/ 2\)/,
    )
    // The 16px the offsets are measured against has to be real, not assumed.
    expect(appCss).toMatch(/\.app-toast strong \{[^}]*line-height: var\(--type-label-line-height\)/)
  })

  it("draws in-place messages through the shared inline component", () => {
    const chromeCss = read("src/components/ui/chrome.css")
    const inlineMessage = read("src/components/ui/inline-message.tsx")
    expect(inlineMessage).toContain("stylex.create")
    expect(inlineMessage).toMatch(/stylex\.props\(\s*styles\.root,/)
    expect(chromeCss).not.toContain(".ui-inline-message {")
    // Same status roles as the toast, so the two read as one system.
    for (const level of ["info", "success", "warning", "error"]) {
      expect(inlineMessage).toContain(`${level}Icon:`)
    }
    // Feature stylesheets may add spacing and a plate; they may not restate the
    // colour, which is what made every panel's error look slightly different.
    const featureCss = [
      "src/overleaf/overleaf-connect.css",
      "src/overleaf/overleaf-chat.css",
      "src/overleaf/overleaf-changes.css",
      "src/overleaf/overleaf-review.css",
      "src/overleaf/overleaf-history.css",
      "src/history/conflict-resolver.css",
      "src/pdf/pdf-viewer.css",
    ].map(read).join("\n")
    for (const retired of [
      ".overleaf-error",
      ".overleaf-chat-error",
      ".overleaf-change-error",
      ".overleaf-review-error",
      ".overleaf-history-error",
      ".overleaf-history-notice",
      ".conflict-error",
      ".pdf-save-notice",
    ]) {
      expect(featureCss).not.toContain(retired)
    }
    expect(appCss).not.toContain(".welcome-error")
    expect(appCss).not.toContain(".settings-notice")
    expect(appCss).not.toContain(".math-preview-error")
  })
})
