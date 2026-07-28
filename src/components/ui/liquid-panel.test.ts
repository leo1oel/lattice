import { describe, expect, it } from "vitest"
import source from "./liquid-panel.tsx?raw"
import contextMenu from "./context-menu.tsx?raw"
import dropdownMenu from "./dropdown-menu.tsx?raw"
import popover from "./popover.tsx?raw"
import select from "./select.tsx?raw"

const components = { "dropdown-menu.tsx": dropdownMenu, "context-menu.tsx": contextMenu, "popover.tsx": popover, "select.tsx": select }

describe("liquid panel structure", () => {
  it("keeps the Presence shell visible and clips only the viewport", () => {
    expect(source).toContain('const liquidPanelClassName = "liquid-panel"')
    expect(source).toContain('className="liquid-panel-viewport"')
    for (const file of ["dropdown-menu.tsx", "context-menu.tsx", "popover.tsx", "select.tsx"])
      expect(components[file as keyof typeof components]).toMatch(/LiquidPanelViewport|liquid-panel-viewport/)
    for (const file of [dropdownMenu, contextMenu, select])
      expect(file).not.toMatch(/liquidPanelClassName[\s\S]{0,200}overflow-[xy]-hidden/)
  })

  it("uses four unrotated, externally extended side necks", () => {
    for (const side of ["top", "bottom", "left", "right"])
      expect(source).toContain(`liquid-panel-neck-${side}`)
    expect(source).not.toMatch(/rotate\(/)
    expect(source).toMatch(/y="-8"/)
    expect(source).toMatch(/x="-8"/)
  })

  it("makes the unfiltered shadow a sheet and active-neck twin", () => {
    expect(source).toMatch(/className="liquid-panel-shadow"[\s\S]*liquid-panel-shadow-sheet[\s\S]*<LiquidPanelNecks/)
    expect(source.match(/<LiquidPanelNecks \/>/g)).toHaveLength(2)
  })

  it("provides an expanded sRGB goo filter", () => {
    expect(source).toMatch(/<filter[^>]*x="-40%"[^>]*width="180%"[^>]*colorInterpolationFilters="sRGB"/)
    expect(source).toContain("feGaussianBlur")
    expect(source).toContain("feColorMatrix")
  })

  it("limits liquid popovers to explicit opt-ins", () => {
    expect(popover).toContain("liquid = false")
    expect(popover).toContain("liquid ? liquidPanelClassName")
    expect(popover).toContain("liquid && <LiquidPanelSurface />")
  })
})
