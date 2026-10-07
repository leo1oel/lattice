// Vitest empties CSS imports, so read the stylesheets off disk.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { spring as solveSpring } from "motion"
import { spring, springExit } from "../components/ui/motion-values"

const read = (file: string) => String(readFileSync(file, "utf8"))

const foundations = read("src/styles/foundations.css")
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

/** Every stylesheet and every component that declares CSS in a template literal. */
function collectSources(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`
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

/**
 * The animated product icons are hand-rebuilt from author-provided sources (see
 * THIRD_PARTY_NOTICES.md) and their keyframes are the artwork: ~200 per-glyph
 * easing curves and durations that reproduce the original motion frame for
 * frame, not interface motion timed off the UI scale. The same sheet also holds
 * the clamp that stops every one of those animations when the user asks for
 * reduced motion, which is the one place `!important` is the answer — it must
 * beat animations declared on the elements themselves. Only those two rules are
 * waived; spacing and type in this file are held to the contract like anywhere
 * else.
 */
const VENDOR_ICON_CSS = "src/animated-icons/bakai-icons.css"

/**
 * The perf-lab harness never ships (only VITE_PERF_LAB builds include it). Its
 * CSS strings are measurement switches that knock app styles out on purpose,
 * so `!important` and raw values there are the point, not a contract breach.
 */
const PERF_LAB_HARNESS = "src/platform/perf-lab-harness.ts"

const sources = collectSources("src").filter((file) => file !== PERF_LAB_HARNESS).map((file) => {
  const text = read(file)
  return { file, text, rules: stripComments(text) }
})

/** `file: declaration` for every `pattern` match whose captured value `offends`, outside `exempt` files. */
function offenders(pattern: RegExp, offends: (value: string) => boolean, exempt: (file: string) => boolean) {
  return sources
    .filter(({ file }) => !exempt(file))
    .flatMap(({ file, rules }) =>
      [...rules.matchAll(pattern)].filter((match) => offends(match[1])).map((match) => `${file}: ${match[0].trim()}`),
    )
}

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
  // The elevation ladder's stacks; feature code takes a level (`--elevation-*`).
  "shadow-ring",
  "shadow-raised",
  "shadow-popover",
  "shadow-floating",
  "shadow-dialog",
  "shadow-pdf-page",
]

/**
 * Custom properties a library or our own runtime sets, so no stylesheet declares
 * them: Radix and Tailwind internals, Pierre's own tree variables, PDF.js page
 * scaling, and values written as inline style from TypeScript.
 */
const EXTERNAL_PREFIXES = [
  "--radix-",
  "--tw-",
  "--cm-",
  "--color-",
  "--trees-",
  "--total-scale-factor",
  "--scroll-area-thumb-",
  // Shiki dual themes write the dark-variant tokens as inline styles on spans.
  "--shiki-",
]

describe("design token contract", () => {
  it("keeps the palette out of feature code and maps every semantic role onto it in one place", () => {
    const pattern = new RegExp(`var\\(--(${PALETTE.join("|")})[,)]`)
    const offenders = sources
      .filter(({ file }) => !APP_CSS_FILES.has(file) && file !== "src/styles/foundations.css")
      .filter(({ file }) => file !== "src/index.css")
      .filter(({ text }) => pattern.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])

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
    for (const match of read("src/index.css").matchAll(/(--[a-z0-9-]+)\s*:/gi)) declared.add(match[1])

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
    expect(foundations).toMatch(/--navigation-action-size: var\(--control-height-compact\)/)
    expect(foundations).toMatch(/--navigation-header-height: 40px/)
    expect(foundations).toMatch(/--titlebar-height: 40px/)
  })

  it("keeps single-line controls on the 28px compact and 30px default scale, with one Settings type contract", () => {
    expect(foundations).toMatch(/--control-height-compact: 28px/)
    expect(foundations).toMatch(/--control-height-default: 30px/)
    // Square icon controls and toolbar buttons stand on the same two steps.
    expect(foundations).toMatch(/--control-size-icon: var\(--control-height-compact\)/)
    expect(foundations).toMatch(/--control-size-icon-large: var\(--control-height-default\)/)
    expect(foundations).toMatch(/--toolbar-icon-height: var\(--control-height-compact\)/)
    expect(foundations).toMatch(/--settings-control-height: var\(--control-height-default\)/)
    // Every Settings control shares one typography contract.
    expect(foundations).toMatch(/--settings-control-font-family: var\(--ui-font\)/)
    expect(foundations).toMatch(/--settings-control-font-size: var\(--type-body-compact-size\)/)
    expect(foundations).toMatch(/--settings-control-line-height: var\(--type-body-compact-line-height\)/)
    expect(foundations).toMatch(/--settings-control-font-weight: var\(--type-body-weight\)/)
    expect(read("src/styles/dialogs.css")).toContain('[data-slot="select-content"][data-settings-control="true"]')
  })

  it("shares the soft selected state across compact sidebar selectors", () => {
    const chrome = read("src/components/ui/chrome.css")
    expect(chrome).toMatch(
      /\.ui-compact-selectable:is\([^}]+\) \{[^}]*background: var\(--control-active-soft\);[^}]*color: var\(--control-active\)/,
    )
    expect(chrome).not.toMatch(/\.ui-compact-selectable[^}]*\{[^}]*background: var\(--control-active\);/)
  })

  it("shares flat drawer-view tabs between Project history and Git workspace", () => {
    expect(read("src/app/app-history-drawers.tsx")).toContain('tabClassName="drawer-view-tab"')
    expect(read("src/history/history-drawer.tsx")).toContain('tabClassName="drawer-view-tab"')
    const workspacePanels = read("src/styles/workspace-panels.css")
    for (const rule of [
      /\.drawer-view-tab \{[^}]*border: 0;[^}]*background: transparent;/,
      /\.drawer-view-tab\.active \{[^}]*color: var\(--text-primary\);[^}]*background: transparent;/,
      /\.agent-git-workspace-header \{[^}]*padding: 0 var\(--space-4\);/,
    ]) expect(workspacePanels).toMatch(rule)
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
    // Start at a rule boundary so a failed match doesn't rescan the same long
    // declaration or template literal from every character in the source.
    const cancelled = sources.filter(({ rules }) =>
      [...rules.matchAll(/(?:^|[{}])([^{}]*):focus-visible[^{]*\{[^}]*outline:\s*none/g)].some(
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
    const onScale = (value: string) =>
      // Negative values are optical nudges rather than scale steps.
      !/-\d/.test(value) && [...value.matchAll(/(\d+)px/g)].some((raw) => SCALE.includes(Number(raw[1])))
    // The scale itself owns raw values.
    expect(offenders(SPACING, onScale, (file) => file.endsWith("foundations.css"))).toEqual([])
  })

  it("times motion off the shared scale", () => {
    const MOTION =
      /\b(?:transition|animation)(?:-duration|-timing-function)?:\s*([^;{}"']+);/g
    const offScale = (value: string) =>
      /cubic-bezier/.test(value) ||
      [...value.matchAll(/(\d*\.?\d+)(ms|s)\b/g)].some((time) => {
        const ms = Number(time[1]) * (time[2] === "s" ? 1000 : 1)
        // Ambient loops and the reduced-motion clamp are outside the UI scale.
        return ms >= 10 && ms <= 400
      })
    const exempt = (file: string) => file.endsWith("foundations.css") || file === VENDOR_ICON_CSS
    expect(offenders(MOTION, offScale, exempt)).toEqual([])
  })

  it("takes a spring tier whole, its duration and curve together", () => {
    // In a shorthand the first time is the duration, and it is a tier
    // (`var(--motion-moderate)`), never a bare duration that could meet another
    // tier's curve. A bare `--duration-*` there is a delay.
    const SHORTHAND = /\b(?:transition|animation):\s*([^;{}"'`]+)/g
    const durationFirst = (value: string) =>
      value.split(/,(?![^(]*\))/).some((item) =>
        /^[^]*?(?:\d*\.?\d+m?s\b|var\(--(?:motion|duration)-)/.exec(item)?.[0].endsWith("var(--duration-") ||
        item.split("var(--motion-").length > 2)
    expect(offenders(SHORTHAND, durationFirst, (file) => file.endsWith("foundations.css"))).toEqual([])

    // The curves stay in foundations; the one way to name one elsewhere is a
    // Tailwind pair, next to its own tier's duration.
    const loneCurves = sources
      .filter(({ file }) => !file.endsWith("foundations.css"))
      .flatMap(({ file, rules }) =>
        [...rules.matchAll(/var\(--ease-([a-z-]+)\)/g)]
          .filter((match) => !rules.slice(Math.max(0, match.index - 48), match.index).includes(`duration-[var(--duration-${match[1]})] ease-[`))
          .map((match) => `${file}: ${match[0]}`),
      )
    expect(loneCurves).toEqual([])
  })

  it("samples the CSS spring curves from the springs motion/react runs", () => {
    const supported = foundations.slice(foundations.indexOf("@supports (transition-timing-function: linear(0, 1))"))
    const declared = (name: string, text = foundations) => new RegExp(`${name}:\\s*([^;]+);`).exec(text)?.[1]
    for (const [tier, { duration, bounce }] of Object.entries(spring)) {
      const ms = duration * 1000
      expect(declared(`--duration-${tier}`)).toBe(`${ms}ms`)
      expect(declared(`--duration-${tier}-exit`)).toBe(`${springExit[tier as keyof typeof springExit].duration * 1000}ms`)
      // One sample every 10ms of the spring motion solves for this tier.
      const generator = solveSpring({ keyframes: [0, 1], duration: ms, bounce })
      const samples = Math.round(ms / 10) + 1
      const points = Array.from({ length: samples }, (_, index) => Number(generator.next((ms * index) / (samples - 1)).value.toFixed(3)))
      expect(declared(`--ease-${tier}`, supported), `--ease-${tier}`).toBe(`linear(${points.join(", ")})`)
    }
  })

  it("sizes interface text through the shared type scale", () => {
    const RAW_SIZE =
      /(?:font-size:\s*|font:\s*["'`]?(?:\d+\s+)?|text-\[)(\d*\.?\d+)px/g
    const exempt = (file: string) => file.endsWith("foundations.css")
    expect(offenders(RAW_SIZE, () => true, exempt)).toEqual([])
    // Tailwind's own scale is a second set of sizes beside the roles.
    const TAILWIND_SIZE = /["'`\s](text-(xs|sm|base|lg|[2-9]?xl))(?=["'`\s])/g
    expect(offenders(TAILWIND_SIZE, () => true, (file) => !/\.tsx?$/.test(file))).toEqual([])
  })

  it("derives nested radii instead of restating them", () => {
    const surfaces = read("src/styles/surfaces.css")
    expect(surfaces).toMatch(/--nested-radius: calc\(var\(--surface-radius\) - var\(--surface-inset\)\)/)

    // A container that declares one half of the pair must declare the other,
    // or the derived radius silently resolves to nothing.
    for (const { file, rules } of sources) {
      const count = (property: string) => rules.split(`${property}:`).length - 1
      expect(count("--surface-radius"), file).toBe(count("--surface-inset"))
    }

    // Every consumer sits in a declared scope, or carries a fallback.
    const scopes = [...surfaces.matchAll(/^\s{2}\.([a-z-]+),?$/gm)].map((match) => match[1])
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
      /cm-|data-slot|data-type=|data-lattice|data-virtualizer|data-unmodified|data-code|data-error-wrapper|trees-|diffs-|katex|shiki|reveal|react-joyride|spreadsheet-univer-host|:host|prefers-reduced-motion|reordering-tabs|split-canvas|data-file-tree|\brow-(?:cite|delete|edit-bib)\b/

    const offenders: string[] = []
    for (const { file, rules } of sources) {
      if (file === VENDOR_ICON_CSS) continue
      for (const block of rules.split("}")) {
        if (!block.includes("!important")) continue
        if (FOREIGN.test(block)) continue
        offenders.push(`${file}: ${block.trim().split("\n")[0].slice(0, 80)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("keeps host CSS out of the embedded Synara document, and the surface visible while panels resize", () => {
    // The iframe is a hard boundary: the host may size and frame it, never style
    // through it. Anything past the frame travels over the bridge instead.
    expect(stripComments(appCss)).not.toMatch(/iframe\s+(?:[.#a-z]|\[)/)
    expect(stripComments(appCss)).not.toMatch(/\.synara-[a-z-]*\s+\.(?!synara)/)
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
