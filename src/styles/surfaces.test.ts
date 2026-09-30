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
const surfacesCss = read("src/styles/surfaces.css")
const menuSurface = read("src/components/ui/menu-surface.ts")
const spreadsheetEditor = read("src/editor/spreadsheet/spreadsheet-editor.tsx")

type Pattern = string | RegExp

/** `css` carries every `has` pattern and none of the `lacks` ones; strings match verbatim. */
function expectRules(css: string, has: Pattern[], lacks: Pattern[] = []) {
  for (const pattern of has) {
    if (typeof pattern === "string") expect(css).toContain(pattern)
    else expect(css).toMatch(pattern)
  }
  for (const pattern of lacks) {
    if (typeof pattern === "string") expect(css).not.toContain(pattern)
    else expect(css).not.toMatch(pattern)
  }
}

describe("shared surface contracts", () => {
  it("is owned by App.css instead of being restated per feature", () => {
    expectRules(appCss, ['@import "./styles/surfaces.css"', ".history-drawer"])
    expectRules(surfacesCss, [
      ".modal,",
      ".resizable-drawer {",
      "padding: var(--drawer-content-inset)",
      "@keyframes drawer-in",
    ])
  })

  // Feature rules should only add layout/sizing after the shared chrome lands.
  it("routes shared floating chrome through shadow-plugin and keeps frosted hover cards in one place", () => {
    const floatingChrome =
      /border:\s*1px solid var\(--border-strong\);[^}]*background:\s*var\(--surface-panel-raised\);[^}]*box-shadow:\s*var\(--shadow\)/
    const drawerChrome =
      /background:\s*var\(--surface-input\);[^}]*box-shadow:\s*var\(--shadow\);[^}]*padding:\s*14px;[^}]*animation:\s*drawer-in/
    expect(read("src/index.css")).toContain('@import "shadow-plugin"')
    expectRules(surfacesCss, ["@apply smooth-shadow-ring-lg", "@apply smooth-shadow-lg"])
    expectRules(appCss, [], [floatingChrome, drawerChrome, /@keyframes drawer-in/])
    expect(read("tools/icon-lab/icon-lab.css")).not.toMatch(floatingChrome)
    // The frosted hover-card chrome lives in one place too.
    const frostedChrome =
      /background:\s*color-mix\(in srgb, var\(--surface-panel-raised\)\s*97%,\s*transparent\);[^}]*backdrop-filter:\s*blur\(14px\)/
    expect(surfacesCss).toMatch(frostedChrome)
    expect(appCss).not.toMatch(frostedChrome)
  })

  // One feature rule per decision, each pinned where a regression once landed.
  it.each<[string, Pattern[], Pattern[]?]>([
    ["keeps PDF.js annotation layers below application drawers", [
      /\.pdf-preview \{[^}]*position:\s*relative;[^}]*isolation:\s*isolate;/,
      /\.drawer-backdrop \{[^}]*z-index:\s*var\(--z-drawer-backdrop\);/,
    ]],
    ["lets a Paper reader fill its document panel", [
      /\.canvas-body > \.paper-reader-shell \{[^}]*flex:\s*1 1 0;[^}]*height:\s*0;/,
    ]],
    ["keeps drawer controls clear of surrounding dividers", [
      /\.history-filters \{[^}]*margin:\s*var\(--space-6\) 0/,
      /\.editor-comments-content \.pdf-marks-toolbar \{[^}]*margin-top:\s*var\(--drawer-content-inset\)/,
      /\.literature-search \{[^}]*margin:\s*var\(--drawer-content-inset\) 0 var\(--drawer-section-gap\)/,
    ]],
    ["keeps the spreadsheet formula controls level and off pure white", [
      /\[data-u-comp="defined-name"\] \{ padding-block: 0 !important; \}/,
      '[data-u-comp="formula-bar"] > div:first-child { flex: 0 0 calc(6rem + 4px); }',
      /\[data-u-comp="defined-name"\] input,[^}]+background: #FAFAFA !important;/,
    ]],
    ["gives the spreadsheet ribbon a slightly deeper neutral surface", [
      /\[data-u-comp="ribbon-header-menu"\] \+ div:has\(> \[data-u-comp="ribbon-toolbar"\]\) \{\s*background: #F4F4F5;/,
    ]],
    ["matches spreadsheet toolbar artwork to Lattice icon sizing", [
      '.spreadsheet-univer-host [data-u-comp="ribbon-toolbar"] { translate: 0 .5px; }',
      /\[data-u-comp="ribbon-toolbar"\] svg \{[^}]*display: block;[^}]*width: 14px;\s*height: 14px;[^}]*align-self: center;/,
      /\.univerjs-icon-font-color-double-icon,[\s\S]+\.univerjs-icon-paint-bucket-double-icon[\s\S]+\{\s*width: 16px;\s*height: 16px;/,
      /\.univerjs-icon-paint-bucket-double-icon \{\s*translate: -3% 0;/,
      /\.univerjs-icon-paint-bucket-double-icon path:last-child \{\s*stroke: var\(--border-strong\);\s*stroke-width: \.5;/,
      /button:not\(:disabled\),[\s\S]+\.univer-toolbar-button-selector-root,[\s\S]+\.univer-toolbar-selector-root[\s\S]+:hover \{\s*background: var\(--toolbar-hover-surface\) !important;/,
      /\[data-u-command="univer\.command\.undo"\],[\s\S]+\[data-u-command="univer\.command\.redo"\][\s\S]+:disabled \{\s*color: color-mix\(in srgb, var\(--text-primary\) 32%, transparent\) !important;/,
    ]],
    ["matches spreadsheet selectors and sidebar actions to Lattice controls", [
      /\[data-u-comp="sidebar"\] \[data-u-comp="select"\] \{[^}]*height: var\(--control-height-default\);[^}]*border-radius: var\(--form-control-select-radius\) !important;/,
      /\[data-u-comp="sidebar"\] \[data-u-comp="button"\] \{[^}]*height: var\(--control-height-default\);[^}]*border-radius: var\(--radius-control\) !important;/,
      /\[data-u-comp="button"\]\.univer-bg-primary-600 \{[^}]*background: var\(--text-primary\) !important;[^}]*color: var\(--surface-app\) !important;/,
      /div:has\(> \[data-u-comp="button"\] \+ \[data-u-comp="button"\]\) \{[^}]*gap: var\(--space-4\);/,
    ]],
    ["keeps spreadsheet menu labels left and selection marks right", [
      /\[data-slot="dropdown-menu-content"\]\.univer-text-sm[^}]+\{[^}]*border-radius: var\(--spreadsheet-menu-radius\) !important;[^}]*background: var\(--surface-panel-raised\) !important;/,
      // Select choices, Number Formats rows and Font Family rows share one
      // trailing check; the Font Family one sits flush right.
      /\[data-slot="dropdown-menu-radio-item"\][\s\S]+\[data-slot="dropdown-menu-checkbox-item"\][\s\S]+\)\[data-state="checked"\]::after \{[^}]*top: 50%;[^}]*right: var\(--gap-inline\);[^}]*background: var\(--control-active\);[^}]*mask: url\("data:image\/svg\+xml/,
      /\.univer-relative\.univer-flex:has\(> svg\.univer-absolute\)::after,[^{]+\{[^}]*background: var\(--control-active\);[^}]*mask: url\("data:image\/svg\+xml/,
      /\.univer-relative\.univer-flex:has\(> svg\.univer-absolute\)::after \{[^}]*right: 0;/,
      /\.univer-relative\.univer-flex\.univer-pl-6 \{[^}]*padding-left: 0 !important;/,
      /\[data-slot="dropdown-menu-checkbox-item"\][\s\S]+\) \{[^}]*padding: 0 var\(--space-3\) !important;/,
      /ul\.univer-list-none button \{[^}]*padding: 0 var\(--space-3\) !important;/,
      /\[data-slot="dropdown-menu-item"\]:has\(ul\.univer-list-none\)[\s\S]+ul\.univer-list-none button:is\(:hover, :focus-visible\) \{[^}]*background: var\(--control-active-soft\) !important;/,
    ]],
    ["removes the speech-bubble arrow from Univer tooltips", [
      'body > [role="tooltip"].univer-bg-gray-700 > div + div { display: none; }',
    ]],
    // A single-line toast centres icon, message and dismiss against each other;
    // `start` used to leave 16px of text riding above the 24px dismiss button.
    // Past one line, they pin to the title's line box instead, so the icon does
    // not drift to the middle of a paragraph — and that 16px has to be real.
    ["puts a notification's icon, message and dismiss on one axis", [
      /\.app-toast \{[^}]*align-items: center/,
      ".app-toast.expanded { align-items: start; }",
      /\.app-toast\.expanded > button \{ margin-top: calc\(\(var\(--type-label-line-height\) - var\(--control-size-icon-compact\)\) \/ 2\)/,
      /\.app-toast strong \{[^}]*line-height: var\(--type-label-line-height\)/,
    ]],
  ])("%s", (_name, has, lacks) => expectRules(appCss, has, lacks))

  it("keeps elevated menus and Settings free of hard outer frames, and menus on the app scrollbar", () => {
    expectRules(menuSurface, ["smooth-shadow-lg"], [" border border-border ", "smooth-shadow-ring-lg", /shadow-\[/])
    expect(surfacesCss).toMatch(/\.settings-modal \{\s*@apply smooth-shadow-xl;\s*background: var\(--surface-panel-raised\);\s*\}/)
    const borderedSurfaces = surfacesCss.slice(0, surfacesCss.indexOf("/* Settings deliberately"))
    expect(borderedSurfaces).not.toContain(".settings-modal")
    // The project menu does not hardcode the popover surface colour either.
    expect(read("src/project/project-dialogs.tsx")).not.toMatch(/bg-\[#F9F9FA\]|dark:bg-popover/)
    // Menu viewports inherit the app scrollbar.
    expect(menuSurface).not.toContain("scrollbar-width:none")
    expect(surfacesCss).not.toContain('[data-slot="dropdown-menu-content"]::-webkit-scrollbar')
  })

  it("matches spreadsheet sidebars to Lattice close and scrollbar chrome", () => {
    expectRules(appCss, [
      /\[data-u-comp="sidebar"\][^}]+button\[aria-label="Close sidebar"\] \{[^}]*width: var\(--control-size-icon\);[^}]*height: var\(--control-size-icon\);[^}]*border-radius: var\(--radius-icon\);/,
      /button\[aria-label="Close sidebar"\]::before \{[^}]*width: 16px;[^}]*height: 16px;[^}]*mask: url\("data:image\/svg\+xml/,
      // The sidebar and the function picker inside it hide their native bars
      // in favour of the shared ExternalScrollbar.
      /\[data-u-comp="sheets-formula-functions-panel"\] ul\.univer-overflow-y-auto,[^{]+\{[^}]*scrollbar-width: none !important;/,
      /\[data-u-comp="sidebar"\] > section \{[^}]*scrollbar-width: none !important;/,
      /\.spreadsheet-editor-root > \.external-scrollbar,[^}]+\.spreadsheet-functions-scrollbar-surface \{[^}]*z-index: var\(--z-spreadsheet-scrollbar\);/,
      /\[data-u-comp="sidebar"\] kbd \{[^}]*font-size: var\(--type-body-size\);/,
    ])
    expectRules(spreadsheetEditor, [
      "<ExternalScrollbar getViewport={getSidebarScrollViewport} />",
      "functionsPanelOpen && (",
      "<ExternalScrollbar getViewport={getFunctionsScrollViewport} />",
    ])
    expectRules(read("src/components/ui/scroll-area.css"), [
      /\.lattice-scrollbar\[data-orientation="vertical"\] \.lattice-scrollbar-thumb \{[^}]*width: 4px;/,
      /\.lattice-scrollbar\[data-orientation="vertical"\]:hover \.lattice-scrollbar-thumb \{[^}]*width: 6px;/,
    ])
  })

  // One appearance for anything the app tells you. There used to be five: the
  // toast stack, three fixed banners next to it, and a bespoke coloured <p> in
  // every panel that needed a line of feedback. Each rule below is one of those
  // ways staying gone.
  it("has a single notification surface", () => {
    // The banners that sat beside the toast stack in a different shape.
    const banners = [".error-banner", ".warning-banner", ".notice-banner"]
    expectRules(appCss, [], banners)
    expectRules(surfacesCss, [], banners)
    // The updater keeps its own component — it owns a progress bar and an
    // Install button — but not its own shape.
    expectRules(read("src/telemetry/app-updater.css"), [
      /\.app-update-banner \{[^}]*width: 320px/,
      /\.app-update-banner \{[^}]*border-radius: 11px/,
    ])
    expectRules(appCss, [/\.app-toast \{[^}]*border-radius: 11px/, /\.app-toast-stack \{[^}]*width: 320px/])
  })

  it("draws in-place messages through the shared inline component", () => {
    const inlineMessage = read("src/components/ui/inline-message.tsx")
    expectRules(inlineMessage, [
      "stylex.create",
      /stylex\.props\(\s*styles\.root,/,
      // Same status roles as the toast, so the two read as one system.
      ...["info", "success", "warning", "error"].map((level) => `${level}Icon:`),
    ])
    expect(read("src/components/ui/chrome.css")).not.toContain(".ui-inline-message {")
    // Feature stylesheets may add spacing and a plate; they may not restate the
    // colour, which is what made every panel's error look slightly different.
    const featureCss = [
      "src/overleaf/overleaf-connect.css",
      "src/overleaf/overleaf-collab.css",
      "src/overleaf/overleaf-review.css",
      "src/overleaf/overleaf-history.css",
      "src/history/conflict-resolver.css",
      "src/pdf/pdf-viewer.css",
    ].map(read).join("\n")
    expectRules(featureCss, [], [
      ".overleaf-error",
      ".overleaf-chat-error",
      ".overleaf-change-error",
      ".overleaf-review-error",
      ".overleaf-history-error",
      ".overleaf-history-notice",
      ".conflict-error",
      ".pdf-save-notice",
    ])
    expectRules(appCss, [], [".welcome-error", ".settings-notice", ".math-preview-error"])
  })
})
