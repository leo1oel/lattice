// Vitest empties CSS imports, so read the files off disk.
// @ts-expect-error no Node types in this project
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
const iconLabCss = String(readFileSync("src/icon-lab/icon-lab.css", "utf8"))
const surfacesCss = String(readFileSync("src/styles/surfaces.css", "utf8"))
const indexCss = String(readFileSync("src/index.css", "utf8"))
const projectDialogs = String(readFileSync("src/project-dialogs.tsx", "utf8"))
const menuSurface = String(readFileSync("src/components/ui/menu-surface.ts", "utf8"))

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

  it("does not hardcode the popover surface colour on the project menu", () => {
    expect(projectDialogs).not.toMatch(/bg-\[#F9F9FA\]|dark:bg-popover/)
  })

  it("keeps collaboration helper text clear of its input", () => {
    expect(appCss).toContain('.modal.collab-drawer-content > .collab-name-help { margin: var(--space-8) 0 0; }')
    expect(appCss).not.toContain(".collab-advanced-toggle")
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
})
