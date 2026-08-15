// Vitest empties CSS imports, so read the stylesheets off disk.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (file: string) => String(readFileSync(file, "utf8"))

const foundations = read("src/styles/foundations.css")
const dialogs = read("src/styles/dialogs.css")
const chrome = read("src/components/ui/chrome.css")
const workspacePanels = read("src/styles/workspace-panels.css")
const settingsDialog = read("src/settings-dialog.tsx")
const APP_CSS_FILES = new Set([
  "src/App.css",
  "src/styles/theme.css",
  "src/styles/app-shell.css",
  "src/styles/editor-workspace.css",
  "src/styles/workspace-panels.css",
  "src/styles/dialogs.css",
  "src/styles/adaptive-feedback.css",
])
const appCss = [...APP_CSS_FILES].map(read).join("\n")
const tailwindTheme = read("src/index.css")

/** Every stylesheet and every component that declares CSS in a template literal. */
function collectSources(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`
    // Vendored Open Knowledge code carries upstream's styling (pinned
    // byte-faithful editor CSS, embedded preview-starter CSS and the like)
    // and is not held to this app's design token contract. This includes the
    // editor-theme-seam, whose values intentionally mirror upstream's raw
    // tokens; theme normalization is deferred by explicit user decision.
    if (full === "src/open-knowledge-core") continue
    if (full === "src/open-knowledge-app") continue
    if (statSync(full).isDirectory()) {
      collectSources(full, files)
      continue
    }
    if (/\.(css|tsx|ts)$/.test(entry) && !/\.test\.(tsx|ts)$/.test(entry)) files.push(full)
  }
  return files
}

/** Comments describe the contract; only declarations are evidence of it. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "")

const sources = collectSources("src").map((file) => ({
  file,
  text: read(file),
  rules: stripComments(read(file)),
}))

/** Palette names are raw theme values; only the app theme and foundations may name them. */
const PALETTE = [
  "bg",
  "panel",
  "panel-strong",
  "chrome-surface",
  "sidebar",
  "side-surface",
  "line",
  "line-strong",
  "text",
  "muted",
  "faint",
  "chrome-text",
  "accent",
  "accent-soft",
  "accent-contrast",
  "danger",
  "success",
  "warning",
]

/**
 * Custom properties a library or our own runtime sets, so no stylesheet declares
 * them: Radix and Tailwind internals, Pierre's own tree variables, PDF.js page
 * scaling, and values written as inline style from TypeScript.
 */
const EXTERNAL_PREFIXES = [
  "--radix-",
  "--tw-",
  // Vendored Open Knowledge editor hooks: referenced with fallbacks in
  // index.css, defined only inside src/open-knowledge-app (excluded from
  // this scan) so upstream editor scopes can re-route colliding token names.
  "--ok-",
  "--cm-",
  "--color-",
  "--trees-",
  "--total-scale-factor",
  "--scroll-area-thumb-",
  "--bk-speed",
  // Shiki dual themes write the dark-variant tokens as inline styles on spans.
  "--shiki-",
]

describe("design token contract", () => {
  it("keeps the palette out of feature code", () => {
    const pattern = new RegExp(`var\\(--(${PALETTE.join("|")})[,)]`)
    const offenders = sources
      .filter(({ file }) => !APP_CSS_FILES.has(file) && file !== "src/styles/foundations.css")
      .filter(({ file }) => file !== "src/index.css")
      .filter(({ text }) => pattern.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it("maps every semantic role onto the palette in one place", () => {
    // The palette is declared in theme.css; foundations is the only translator.
    for (const role of ["--surface-app", "--border-subtle", "--text-primary", "--control-active"]) {
      expect(foundations).toContain(`${role}:`)
      expect(appCss).not.toContain(`${role}:`)
    }
  })

  it("resolves every referenced custom property", () => {
    const declared = new Set<string>()
    for (const { text } of sources) {
      for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:/gi)) declared.add(match[1])
    }
    for (const match of tailwindTheme.matchAll(/(--[a-z0-9-]+)\s*:/gi)) declared.add(match[1])
    // The vendored tree is excluded from the scan, but index.css imports the
    // seam stylesheet directly, so its declarations (e.g. --muted-foreground)
    // are live everywhere and legitimate to reference from app CSS.
    const editorThemeSeam = read("src/open-knowledge-app/editor-theme-seam.css")
    for (const match of editorThemeSeam.matchAll(/(--[a-z0-9-]+)\s*:/gi)) declared.add(match[1])

    const missing = new Map<string, string>()
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/var\((--[a-z0-9-]+)/gi)) {
        const name = match[1]
        if (declared.has(name)) continue
        if (EXTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
        if (!missing.has(name)) missing.set(name, file)
      }
    }
    expect(Object.fromEntries(missing)).toEqual({})
  })

  it("shares one height across the navigation controls", () => {
    expect(foundations).toMatch(/--navigation-action-size: var\(--navigation-control-height\)/)
    expect(foundations).toMatch(/--navigation-header-height: 40px/)
    expect(foundations).toMatch(/--titlebar-height: 40px/)
  })

  it("keeps single-line controls on the 28px compact and 30px default scale", () => {
    expect(foundations).toMatch(/--control-height-compact: 28px/)
    expect(foundations).toMatch(/--control-height-default: 30px/)
    expect(foundations).toMatch(/--control-height-form: var\(--control-height-default\)/)
    expect(foundations).toMatch(/--form-control-height-form: var\(--control-height-form\)/)
    expect(foundations).toMatch(/--settings-control-height: var\(--control-height-default\)/)
  })

  it("gives every Settings control one typography contract", () => {
    expect(foundations).toMatch(/--settings-control-font-family: var\(--ui-font\)/)
    expect(foundations).toMatch(/--settings-control-font-size: var\(--type-label-size\)/)
    expect(foundations).toMatch(/--settings-control-line-height: var\(--type-label-line-height\)/)
    expect(foundations).toMatch(/--settings-control-font-weight: var\(--type-body-weight\)/)
    expect(dialogs).toContain('[data-slot="select-content"][data-settings-control="true"]')
    expect(settingsDialog.match(/data-settings-control="true"/g)).toHaveLength(5)
  })

  it("shares the soft selected state across compact sidebar selectors", () => {
    expect(chrome).toMatch(
      /\.ui-compact-selectable:is\([^}]+\) \{[^}]*background: var\(--control-active-soft\);[^}]*color: var\(--control-active\)/,
    )
    expect(chrome).not.toMatch(/\.ui-compact-selectable[^}]*\{[^}]*background: var\(--control-active\);/)

    for (const file of [
      "src/insert-palette.tsx",
      "src/editor-comments-panel.tsx",
      "src/history-drawer.tsx",
      "src/overleaf-comments.tsx",
    ]) {
      expect(read(file), file).toContain("ui-compact-selectable")
    }
  })

  it("shares flat drawer-view tabs between Project history and Git workspace", () => {
    expect(read("src/App.tsx")).toContain('tabClassName="drawer-view-tab"')
    expect(read("src/history-drawer.tsx")).toContain('tabClassName="drawer-view-tab"')
    expect(workspacePanels).toMatch(
      /\.drawer-view-tab \{[^}]*border: 0;[^}]*background: transparent;/,
    )
    expect(workspacePanels).toMatch(
      /\.drawer-view-tab\.active \{[^}]*color: var\(--text-primary\);[^}]*background: transparent;/,
    )
    expect(workspacePanels).toMatch(
      /\.agent-git-workspace-header \{[^}]*padding: 0 var\(--space-4\);/,
    )
  })

  it("draws keyboard focus exactly once", () => {
    const globalRing =
      /:where\(button:not\(\.project-title\):not\(\.overleaf-toolbar-menu-button\), a, select, \[role="button"\], \[tabindex\]:not\(\.ProseMirror\):not\(\[tabindex="-1"\]\):not\(\[role="menuitem"\]\)\):focus-visible \{\s*outline: var\(--focus-ring-width\) solid var\(--focus-ring\);\s*outline-offset: var\(--focus-ring-offset\);/
    expect(appCss).toMatch(globalRing)
    expect(appCss).not.toMatch(/\[tabindex\]\):focus-visible/)
    expect(appCss).toMatch(/\.project-title:hover, \.project-title:focus-visible, \.project-title\[aria-expanded="true"\] \{ background: var\(--chrome-hover-surface\); \}/)
    expect(appCss).toMatch(/\.canvas-actions \.overleaf-toolbar-menu-button:focus-visible \{ background: var\(--chrome-hover-surface\); color: var\(--text-primary\); \}/)

    // No control may cancel the ring or re-implement it as a shadow. Text entry
    // and composite active rows are excluded from the ring by design, so a field
    // may still suppress the native halo on its own selector. Composite controls
    // must express focus with their existing fill rather than another outline.
    const cancelled = sources.filter(({ rules }) =>
      [...rules.matchAll(/([^{}]*):focus-visible[^{]*\{[^}]*outline:\s*none/g)].some(
        (match) => !/input|textarea|search/i.test(match[1]),
      ),
    )
    expect(cancelled.map(({ file }) => file)).toEqual([])

    const shadowRing = sources.filter(
      ({ file, rules }) =>
        !APP_CSS_FILES.has(file) && /:focus-visible[^{]*\{[^}]*box-shadow:\s*0 0 0/.test(rules),
    )
    expect(shadowRing.map(({ file }) => file)).toEqual([])
  })

  it("spends spacing through the scale, not through literals", () => {
    const SCALE = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32]
    const SPACING =
      /\b(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?:\s*([^;{}]+);/g

    const offenders: string[] = []
    for (const { file, rules } of sources) {
      // The scale itself, and the dev-only icon playground, own raw values.
      if (file.endsWith("foundations.css") || file.includes("icon-lab")) continue
      for (const match of rules.matchAll(SPACING)) {
        const value = match[1]
        // Negative values are optical nudges rather than scale steps.
        if (/-\d/.test(value)) continue
        for (const raw of value.matchAll(/(\d+)px/g)) {
          if (SCALE.includes(Number(raw[1]))) offenders.push(`${file}: ${match[0].trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("times motion off the shared scale", () => {
    const MOTION =
      /\b(?:transition|animation)(?:-duration|-timing-function)?:\s*([^;{}"']+);/g

    const offenders: string[] = []
    for (const { file, rules } of sources) {
      if (file.endsWith("foundations.css") || file.includes("icon-lab")) continue
      for (const match of rules.matchAll(MOTION)) {
        const value = match[1]
        for (const time of value.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) {
          const ms = Number(time[1]) * (time[2] === "s" ? 1000 : 1)
          // Ambient loops and the reduced-motion clamp are outside the UI scale.
          if (ms >= 10 && ms <= 400) offenders.push(`${file}: ${match[0].trim()}`)
        }
        if (/cubic-bezier/.test(value)) offenders.push(`${file}: ${match[0].trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("sizes interface text through the shared type scale", () => {
    const RAW_SIZE =
      /(?:font-size:\s*|font:\s*["'`]?(?:\d+\s+)?|text-\[)(\d*\.?\d+)px/g

    const offenders: string[] = []
    for (const { file, rules } of sources) {
      if (file.endsWith("foundations.css") || file.includes("icon-lab")) continue
      for (const match of rules.matchAll(RAW_SIZE)) {
        offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("derives nested radii instead of restating them", () => {
    const surfaces = read("src/styles/surfaces.css")
    expect(surfaces).toMatch(
      /--nested-radius: calc\(var\(--surface-radius\) - var\(--surface-inset\)\)/,
    )

    // A container that declares one half of the pair must declare the other,
    // or the derived radius silently resolves to nothing.
    for (const { file, rules } of sources) {
      const radiusScopes = [...rules.matchAll(/--surface-radius:/g)].length
      const insetScopes = [...rules.matchAll(/--surface-inset:/g)].length
      expect({ file, radiusScopes, insetScopes }).toEqual({
        file,
        radiusScopes: insetScopes,
        insetScopes,
      })
    }

    // Every consumer sits in a declared scope, or carries a fallback.
    const scopes = [
      ...read("src/styles/surfaces.css").matchAll(/^\s{2}\.([a-z-]+),?$/gm),
    ].map((match) => match[1])
    expect(scopes).toContain("ui-segmented")
    expect(scopes).toContain("quick-open-list")
  })

  it("reserves !important for surfaces the app does not own", () => {
    // `!important` is a statement that something outside this codebase is
    // competing: CodeMirror, Radix, the Pierre tree and diff, a shadow root, or
    // the reduced-motion clamp that has to beat every animation there is.
    // Between two rules the app owns, the answer is specificity, not force.
    // `split-canvas` and the tree search input are the inline-style cases: the
    // resizer and the vendor component write the property on the element, and an
    // inline value beats every selector there is.
    const FOREIGN =
      /cm-|data-slot|data-type=|data-lattice|data-virtualizer|data-unmodified|data-code|data-error-wrapper|trees-|diffs-|katex|shiki|react-joyride|spreadsheet-univer-host|:host|prefers-reduced-motion|reordering-tabs|split-canvas|data-file-tree|\brow-(?:cite|delete|edit-bib)\b/

    const offenders: string[] = []
    for (const { file, rules } of sources) {
      if (file.includes("icon-lab")) continue
      for (const block of rules.split("}")) {
        if (!block.includes("!important")) continue
        if (FOREIGN.test(block)) continue
        offenders.push(`${file}: ${block.trim().split("\n")[0].slice(0, 80)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("keeps host CSS out of the embedded Synara document", () => {
    // The iframe is a hard boundary: the host may size and frame it, never style
    // through it. Anything past the frame travels over the bridge instead.
    expect(appCss).not.toMatch(/iframe\s+(?:[.#a-z]|\[)/)
    expect(appCss).not.toMatch(/\.synara-[a-z-]*\s+\.(?!synara)/)
  })

  it("keeps the embedded Synara surface visible while panels resize", () => {
    // The iframe should follow the divider continuously instead of being hidden
    // behind a host pseudo-element for the duration of the drag.
    expect(appCss).not.toMatch(/body\.resizing-panels\s+\.synara-frame-shell::/)
  })

  it("routes the third-party file tree through override tokens", () => {
    expect(appCss).toMatch(/--trees-[a-z-]+-override:/)
    // Pierre's own class names stay out of host stylesheets.
    const pierreInternals = sources.filter(
      ({ file, text }) => file.endsWith(".css") && /\.pierre-|\.trees-/.test(text),
    )
    expect(pierreInternals.map(({ file }) => file)).toEqual([])
  })
})
