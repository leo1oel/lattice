// The design calls' hover, press and outline treatments, read off the cascade
// of the real stylesheets in a rendered fixture. Vitest empties CSS imports,
// so the sheets are read off disk and mounted; jsdom never matches :hover or
// :active, so each stated rule is mounted again under a data attribute the
// fixture sets, and the cascade (specificity, source order) stays jsdom's.
import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { PIERRE_TREE_CSS } from "../project/project-tree-css"

const read = (file: string) => String(readFileSync(file, "utf8"))

type State = "hover" | "active"

/** The stylesheet with every :hover / :active rule also reachable through `data-state-*`. */
function withStates(css: string): string {
  const probe = document.createElement("style")
  probe.textContent = css
  document.head.append(probe)
  const rules = [...probe.sheet!.cssRules]
  probe.remove()
  return rules.map((rule) => {
    if (!(rule instanceof CSSStyleRule) || !/:hover|:active/.test(rule.selectorText)) return rule.cssText
    const stated = rule.selectorText.replaceAll(":hover", "[data-state-hover]").replaceAll(":active", "[data-state-active]")
    return `${rule.cssText}\n${stated} { ${rule.style.cssText} }`
  }).join("\n")
}

function mount(css: string) {
  const style = document.createElement("style")
  style.textContent = withStates(css)
  document.head.append(style)
}

function render(html: string) {
  const template = document.createElement("template")
  template.innerHTML = html
  document.body.append(template.content)
}

function setState(element: Element, ...states: State[]) {
  for (const state of ["hover", "active"] as const) element.toggleAttribute(`data-state-${state}`, states.includes(state))
}

/** `value` with every var() replaced by the custom property it names, as inherited at `element`. */
function resolve(value: string, element: Element): string {
  const style = getComputedStyle(element)
  let out = value.trim()
  for (let depth = 0; depth < 16 && out.includes("var("); depth++) {
    out = out.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) =>
      style.getPropertyValue(name).trim() || (fallback ?? "").trim())
  }
  return out.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",")
}

/** A property as the cascade gives it to `element`, its variables resolved. */
function computed(element: Element, property: string): string {
  return resolve(getComputedStyle(element).getPropertyValue(property), element)
}

/** The resolved value of a design token at `element`. */
const token = (element: Element, name: string) => resolve(`var(${name})`, element)

/**
 * The duration of `property`'s transition at `element`, in ms. A duration set
 * on its own applies to every property; jsdom expands a shorthand holding
 * var() into the initial 0s, so that 0s defers to the shorthand's entry.
 */
function transitionMs(element: Element, property: string): number {
  const style = getComputedStyle(element)
  const own = style.getPropertyValue("transition-duration").trim()
  const entry = resolve(style.getPropertyValue("transition"), element).split(",").find((part) => part.startsWith(property))
  const source = own && own !== "0s" ? resolve(own, element) : entry
  const raw = source?.match(/([\d.]+)(ms|s)\b/)
  expect(raw, `the ${property} transition of ${element.outerHTML}`).toBeTruthy()
  return Number(raw![1]) * (raw![2] === "s" ? 1000 : 1)
}

const mixPercent = (value: string) => Number(value.match(/(\d+(?:\.\d+)?)%/)?.[1])

afterEach(() => {
  document.head.replaceChildren()
  document.body.replaceChildren()
})

describe("interaction states", () => {
  it("hovers a PDF toolbar's icon buttons at the sheet's 5%, under their 8% press", () => {
    mount(read("src/styles/foundations.css") + read("src/pdf/pdf-viewer.css"))
    render(`<div class="pdf-toolbar"><button type="button">Zoom</button></div>`)
    const button = document.querySelector("button")!

    setState(button, "hover")
    const hover = computed(button, "background")
    // Design call 5: a toolbar on the sheet hovers at the sheet's icon-button fill.
    expect(hover).toBe(token(button, "--control-hover-surface"))
    expect(mixPercent(hover)).toBe(5)

    setState(button, "hover", "active")
    const press = computed(button, "background")
    expect(press).toBe(token(button, "--control-pressed-surface"))
    expect(mixPercent(press)).toBeGreaterThan(mixPercent(hover))
  })

  it("fades a Project tree row's hover in on the fast tier and out a tier quicker, as the Papers rows do", () => {
    // Pierre mounts the tree's sheet in its shadow root; jsdom does not carry
    // custom properties across that boundary, so the fixture is light DOM.
    mount(read("src/styles/foundations.css") + read("src/styles/app-shell.css") + PIERRE_TREE_CSS)
    render(`<button type="button" data-type="item">main.tex</button><div class="paper-row">Paper</div>`)
    const row = document.querySelector("button")!
    const paper = document.querySelector(".paper-row")!

    const fast = Number.parseFloat(token(row, "--duration-fast"))
    const fastExit = Number.parseFloat(token(row, "--duration-fast-exit"))
    // Design call 7: the exit tier is quicker than the entry tier.
    expect(fastExit).toBeLessThan(fast)

    setState(row, "hover")
    expect(transitionMs(row, "background-color")).toBe(fast)
    setState(row)
    expect(transitionMs(row, "background-color")).toBe(fastExit)
    expect(transitionMs(paper, "background-color")).toBe(fastExit)
  })

  it("lights both outlines in the accent wash, the current section in the accent ink", () => {
    mount(read("src/styles/foundations.css") + read("src/styles/editor-workspace.css"))
    render(`
      <div class="document-outline-popover"><ol class="document-outline-list">
        <li><button type="button" class="active">Introduction</button></li>
        <li><button type="button">Method</button></li>
      </ol></div>
      <div class="latex-outline-rail-scroll">
        <button type="button" class="latex-outline-rail-row" data-item-selected="true">Introduction</button>
        <button type="button" class="latex-outline-rail-row">Method</button>
      </div>`)
    const [current, other] = document.querySelectorAll<HTMLElement>(".document-outline-list button")
    const [railCurrent, railOther] = document.querySelectorAll<HTMLElement>(".latex-outline-rail-row")
    const wash = token(document.body, "--control-active-soft")
    const ink = token(document.body, "--control-active")
    // Design call 6: the accent wash is not the neutral icon-button fill.
    expect(wash).not.toBe(token(document.body, "--control-hover-surface"))

    // The PDF toolbar's Outline.
    expect(token(other, "--fluid-hover-fill")).toBe(wash)
    expect(computed(current, "background")).toBe(wash)
    expect(computed(current, "color")).toBe(ink)
    setState(other, "hover")
    expect(computed(other, "background")).toBe(wash)

    // The LaTeX outline rail.
    expect(token(railOther, "--fluid-hover-fill")).toBe(wash)
    expect(computed(railCurrent, "background")).toBe(wash)
    expect(computed(railCurrent, "color")).toBe(ink)
    setState(railOther, "hover")
    expect(computed(railOther, "background")).toBe(wash)
  })
})
