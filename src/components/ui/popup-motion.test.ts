// Vitest replaces every CSS import with an empty string — `?raw` included —
// so these stylesheet-wide invariants have to read the files off disk.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import motionOwner from "./popup-motion.ts?raw"
import dropdown from "./dropdown-menu.tsx?raw"
import context from "./context-menu.tsx?raw"
import select from "./select.tsx?raw"
import popover from "./popover.tsx?raw"
import app from "../../App.tsx?raw"
import bibEntryDialog from "../../bib-entry-dialog.tsx?raw"
import latexToolbar from "../../latex-selection-toolbar.tsx?raw"

/**
 * Every stylesheet under `src/`, named relative to it. The list comes from a
 * lazy glob (never invoked, so nothing is imported) rather than a hand-written
 * array, so a new stylesheet is held to these invariants the moment it lands.
 */
function stylesheets(): { name: string; source: string }[] {
  // Glob keys are relative to this file: `../../App.css`, `./chrome.css`.
  const here = "components/ui/"
  return Object.keys(import.meta.glob("../../**/*.css"))
    .map((path) => (path.startsWith("./") ? `${here}${path.slice(2)}` : path.slice("../../".length)))
    // Vendored Open Knowledge editor CSS is pinned byte-faithful upstream
    // styling (plus its theme seam) and is exempt from host-owned CSS
    // invariants; theme normalization is deferred by explicit user decision.
    .filter((name) => !name.startsWith("open-knowledge-app/"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, source: String(readFileSync(`src/${name}`, "utf8")) }))
}

describe("shared popup motion", () => {
  it("is owned by every Radix popup wrapper, including submenu surfaces", () => {
    for (const source of [dropdown, context, select, popover]) {
      expect(source).toContain("popupMotionClassName")
    }
    expect(dropdown.match(/popupMotionClassName/g)).toHaveLength(3)
    expect(context.match(/popupMotionClassName/g)).toHaveLength(3)
  })

  it("loads one shared popup-motion stylesheet", () => {
    expect(motionOwner).toContain('import "./popup-motion.css"')
    expect(motionOwner).toContain('const popupMotionClassName = "popup-motion"')
  })

  it("has no liquid opt-ins or wrappers and preserves Popper spacing", () => {
    const sources = [dropdown, context, select, popover, app, latexToolbar]
    for (const source of sources) expect(source).not.toMatch(/liquid-panel|\bliquid\b/i)
    expect(select).toContain("data-[side=bottom]:translate-y-1")
  })

  // The hand-written menus used to inline the animation shorthand rather than
  // wear the class. They then drifted: they got the open animation but never
  // the `[data-state="closed"]` half, and this stylesheet had to name them
  // one by one to keep them honest under reduced motion.
  it("is worn by the hand-written menus instead of being copied into CSS", () => {
    expect(bibEntryDialog).toContain("popupMotionClassName")

    const copies = stylesheets()
      .filter(({ name }) => name !== "components/ui/popup-motion.css")
      .filter(({ source }) => /animation:[^;]*popup-motion-/.test(source))
      .map(({ name }) => name)
    expect(copies).toEqual([])
  })

  it("styles nothing but its own class", () => {
    const { source } = stylesheets().find(({ name }) => name === "components/ui/popup-motion.css")!
    const selectors = new Set(source.match(/\.[a-z][a-z0-9-]*/g))
    expect([...selectors]).toEqual([".popup-motion"])
  })

  it("uses the shared disclosure duration and subtle travel in both directions", () => {
    const { source } = stylesheets().find(({ name }) => name === "components/ui/popup-motion.css")!
    expect(source).toMatch(/popup-motion-open var\(--duration-disclosure\) var\(--ease-out\)/)
    expect(source).toMatch(/popup-motion-close var\(--duration-disclosure\) var\(--ease-out\)/)
    expect(source).toContain("translateY(-4px) scale(.97)")
    // Durations come off the shared scale, never as a local number.
    expect(source).not.toMatch(/\d+ms/)
  })
})

describe("stylesheet-wide invariants", () => {
  // A local block can never beat the universal `!important` rule in the app's
  // adaptive stylesheet, so every one written since has been dead on arrival —
  // and unnoticed long enough that the last set named a deleted component.
  it("keeps the reduced-motion policy in exactly one place", () => {
    const owners = stylesheets()
      .filter(({ source }) => source.includes("prefers-reduced-motion"))
      .map(({ name }) => name)
    expect(owners).toEqual(["styles/adaptive-feedback.css"])
  })

  // Small values are fine: they only order siblings inside a local stacking
  // context. Anything that means to float over the app belongs on the ladder
  // in `styles/foundations.css`, where it can be read against its neighbours.
  it("routes app-level stacking through the z-index ladder", () => {
    const bare = stylesheets().flatMap(({ name, source }) =>
      [...source.matchAll(/z-index:\s*(\d+)/g)]
        .filter((match) => Number(match[1]) >= 50)
        .map((match) => `${name}: ${match[0]}`),
    )
    expect(bare).toEqual([])
  })
})
