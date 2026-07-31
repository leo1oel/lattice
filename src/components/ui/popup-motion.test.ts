import { describe, expect, it } from "vitest"
import motionOwner from "./popup-motion.ts?raw"
import dropdown from "./dropdown-menu.tsx?raw"
import context from "./context-menu.tsx?raw"
import select from "./select.tsx?raw"
import popover from "./popover.tsx?raw"
import app from "../../App.tsx?raw"
import latexToolbar from "../../latex-selection-toolbar.tsx?raw"

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
})
