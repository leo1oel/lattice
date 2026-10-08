// Vitest empties CSS imports, so read the files off disk.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (file: string) => String(readFileSync(file, "utf8"))
const appCssFiles = [
  "src/App.css",
  "src/styles/theme.css",
  "src/styles/app-shell.css",
  "src/styles/editor-workspace.css",
  "src/styles/workspace-panels.css",
  "src/styles/dialogs.css",
  "src/styles/adaptive-feedback.css",
]
const appCss = appCssFiles.map(read).join("\n")
const surfacesCss = read("src/styles/surfaces.css")
const toastCss = read("src/telemetry/toast-stack.css")
const foundations = read("src/styles/foundations.css")
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

type Rgba = [number, number, number, number]

function parseStylesheet(css: string) {
  const style = document.createElement("style")
  style.textContent = css
  document.head.append(style)
  const sheet = style.sheet!
  style.remove()
  return sheet
}

/** Style rules in source order, through @layer/@supports but not @media. */
function styleRules(sheet: CSSStyleSheet | CSSGroupingRule): CSSStyleRule[] {
  return [...sheet.cssRules].flatMap((rule) =>
    rule instanceof CSSStyleRule ? [rule]
    : rule instanceof CSSMediaRule ? []
    : "cssRules" in rule ? styleRules(rule as CSSGroupingRule)
    : [])
}

function splitTopLevel(list: string) {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let at = 0; at < list.length; at += 1) {
    if (list[at] === "(") depth += 1
    else if (list[at] === ")") depth -= 1
    else if (list[at] === "," && depth === 0) {
      parts.push(list.slice(start, at).trim())
      start = at + 1
    }
  }
  return [...parts, list.slice(start).trim()]
}

function specificity(selector: string): number {
  let score = 0
  const rest = selector
    .replace(/:where\((?:[^()]|\([^()]*\))*\)/g, " ")
    .replace(/:(?:not|is|has)\(((?:[^()]|\([^()]*\))*)\)/g, (_, inner: string) => {
      score += Math.max(...splitTopLevel(inner).map(specificity))
      return " "
    })
    .replace(/\[[^\]]*\]/g, () => {
      score += 100
      return " "
    })
  score += (rest.match(/#[\w-]+/g) ?? []).length * 10_000
  score += (rest.match(/\.[\w-]+|(?<!:):[\w-]+/g) ?? []).length * 100
  score += (rest.match(/(?:^|[\s>+~])[a-z][\w-]*|::[\w-]+/gi) ?? []).length
  return score
}

/** The declarations that win on `element`, with `background-color` folded into `background`. */
function cascade(rules: CSSStyleRule[], element: Element, hover: boolean) {
  const winners = new Map<string, { value: string; weight: number }>()
  for (const rule of rules) {
    const weights = splitTopLevel(rule.selectorText).flatMap((selector) => {
      if (!hover && selector.includes(":hover")) return []
      try {
        return element.matches(selector.replaceAll(":hover", "")) ? [specificity(selector)] : []
      } catch {
        return []
      }
    })
    if (weights.length === 0) continue
    const weight = Math.max(...weights)
    for (let index = 0; index < rule.style.length; index += 1) {
      const property = rule.style[index]
      const value = rule.style.getPropertyValue(property).trim()
      if (!property.startsWith("background") && weight >= (winners.get(property)?.weight ?? -1)) winners.set(property, { value, weight })
    }
    for (const property of ["background", "background-color"]) {
      const value = rule.style.getPropertyValue(property).trim()
      if (value && weight >= (winners.get("background")?.weight ?? -1)) winners.set("background", { value, weight })
    }
  }
  return new Map([...winners].map(([name, { value }]) => [name, value]))
}

function resolveVars(value: string, declared: Map<string, string>): string {
  const resolved = value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const token = declared.get(name)
    if (token === undefined) throw new Error(`${name} is not declared`)
    return token
  })
  return resolved === value ? value : resolveVars(resolved, declared)
}

function parseColor(value: string): Rgba {
  const color = value.trim().toLowerCase()
  if (color === "transparent") return [0, 0, 0, 0]
  const short = /^#([0-9a-f]{3})$/.exec(color)?.[1]
  const hex = short ? [...short].map((digit) => digit + digit).join("") : /^#([0-9a-f]{6})$/.exec(color)?.[1]
  if (hex) return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)).concat(1) as Rgba
  const rgb = /^rgba?\(([^)]*)\)$/.exec(color)?.[1]
  if (rgb) {
    const [r, g, b, a = 1] = rgb.split(/[\s,/]+/).map(Number)
    return [r, g, b, a]
  }
  const mix = /^color-mix\(in srgb,(.*)\)$/.exec(color)?.[1]
  if (mix) {
    const [first, second] = splitTopLevel(mix).map((stop) => {
      const [, swatch, percent] = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(stop)!
      return { color: parseColor(swatch), share: percent === undefined ? undefined : Number(percent) / 100 }
    })
    const share = first.share ?? 1 - (second.share ?? 0.5)
    const alpha = first.color[3] * share + second.color[3] * (1 - share)
    const channel = (at: number) =>
      alpha === 0 ? 0 : (first.color[at] * first.color[3] * share + second.color[at] * second.color[3] * (1 - share)) / alpha
    return [channel(0), channel(1), channel(2), alpha]
  }
  throw new Error(`unsupported colour ${value}`)
}

/** `top` composited over an opaque `base`. */
function over(top: Rgba, base: Rgba): Rgba {
  return [0, 1, 2].map((at) => top[at] * top[3] + base[at] * (1 - top[3])).concat(1) as Rgba
}

function contrast(first: Rgba, second: Rgba) {
  const luminance = (color: Rgba) => {
    const [r, g, b] = color.slice(0, 3).map((value) => {
      const channel = value / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
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
  it("stands every floating surface on one elevation ladder and keeps frosted hover cards in one place", () => {
    // Each level is its edge plus one shadow, defined once; the palette holds a
    // stack per level for each theme, and nothing pulls in a shadow utility kit.
    for (const level of ["raised", "popover", "floating", "dialog"]) {
      expect(foundations).toContain(`--elevation-${level}: 0 0 0 1px var(--elevation-ring), var(--elevation-${level}-shadow);`)
      expect(foundations).toContain(`--elevation-${level}-shadow: var(--shadow-${level});`)
    }
    expect(read("src/index.css")).not.toMatch(/shadow-plugin/)
    expect(read("src/App.css")).not.toMatch(/shadow-plugin/)
    const levelOf = (selector: string) =>
      new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:,\\n[^{]*| )\\{[^}]*box-shadow: var\\(--elevation-([a-z]+)\\)`, "m").exec(surfacesCss)?.[1]
    expect(levelOf(".modal")).toBe("dialog")
    expect(levelOf(".settings-modal")).toBe("dialog")
    expect(levelOf(".app-toast")).toBe("floating")
    expect(levelOf(".file-tree-context-menu")).toBe("popover")
    expect(surfacesCss).toMatch(/\.resizable-drawer \{[^}]*box-shadow: var\(--elevation-floating\);[^}]*animation: drawer-in/)
    expectRules(appCss, [], [/@keyframes drawer-in/, /@apply smooth-shadow/])
    // The frosted hover-card chrome lives in one place too.
    const frostedChrome =
      /background:\s*color-mix\(in srgb, var\(--surface-elevated\)\s*97%,\s*transparent\);[^}]*box-shadow: var\(--elevation-popover\);[^}]*backdrop-filter:\s*blur\(14px\)/
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
      /\[data-slot="dropdown-menu-content"\]\.univer-text-sm[^}]+\{[^}]*border-radius: var\(--spreadsheet-menu-radius\) !important;[^}]*background: var\(--surface-elevated\) !important;[^}]*box-shadow: var\(--elevation-popover\) !important;/,
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
  ])("%s", (_name, has, lacks) => expectRules(appCss, has, lacks))

  it("keeps elevated menus and Settings free of hard outer frames, and menus on the app scrollbar", () => {
    // The ring is the edge: no border on top of it.
    expectRules(menuSurface, ["[box-shadow:var(--elevation-popover)]"], [" border border-border ", /smooth-shadow/])
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
    // The update banner was the last card beside the stack; toasts carry
    // progress and actions now, so the update is a toast like the rest.
    expect(existsSync("src/telemetry/app-updater.css")).toBe(false)
    expectRules(appCss, [], [/\.app-update-banner/, /\.app-toast(?:-stack)?\s*[{.,]/])
    expectRules(toastCss, [/\.app-toast \{[^}]*border-radius: var\(--radius-surface\)/, /\.app-toast-viewport \{[^}]*width: 320px/])
  })

  // A single-line toast centres icon, message and dismiss against each other;
  // `start` used to leave 16px of text riding above the 24px dismiss button.
  // Past one line, they pin to the title's line box instead, so the icon does
  // not drift to the middle of a paragraph — and that 16px has to be real.
  it("puts a notification's icon, message and dismiss on one axis", () => {
    expectRules(toastCss, [
      /\.app-toast-content \{[^}]*align-items: center/,
      ".app-toast.multiline .app-toast-content { align-items: start; }",
      /\.app-toast\.multiline \.app-toast-content > button \{ margin-top: calc\(\(var\(--type-body-compact-line-height\) - var\(--control-size-icon-compact\)\) \/ 2\)/,
      /\.app-toast-title \{[^}]*line-height: var\(--type-body-compact-line-height\)/,
    ])
  })

  // Collapsed, the cards behind the front one keep its height and show a
  // sliver each; fanned out, each takes its own height one gap apart.
  it("compresses the stack into a pile and fans it out from Base UI's measurements", () => {
    expectRules(toastCss, [
      /\.app-toast \{[^}]*height: var\(--toast-frontmost-height, var\(--toast-height\)\)/,
      /\.app-toast \{[^}]*var\(--toast-index\) \* var\(--toast-peek\)/,
      /\.app-toast\[data-expanded\] \{[^}]*height: var\(--toast-height\);[^}]*var\(--toast-offset-y\) \+ var\(--toast-index\) \* var\(--toast-gap\)/,
      ".app-toast-content[data-behind]:not([data-expanded]) { opacity: 0; }",
    ])
    // Frosted, at the floating level, edge tinted by severity.
    expect(surfacesCss).toMatch(/\.app-toast \{[^}]*backdrop-filter: blur\(20px\)/)
    for (const level of ["info", "success", "warning", "error"]) expect(surfacesCss).toContain(`.app-toast.${level} { box-shadow: 0 0 0 1px`)
  })

  it("draws in-place messages through the shared inline component", () => {
    // Same status roles as the toast, so the two read as one system.
    expectRules(read("src/components/ui/chrome.css"), [
      ".ui-inline-message {",
      ...["info", "success", "warning", "error"].map((level) => `.ui-inline-message.${level} .ui-inline-message-icon`),
    ])
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

  // --control-active is the dark fill in light mode and the pale fill in dark
  // mode, so a hardcoded white label (or a hover that swaps in the pale
  // secondary wash) left enabled primary actions at ~1.25:1 in one theme.
  it("labels every --control-active fill with its paired contrast token", () => {
    const offenders = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".css"))
      .flatMap((file) =>
        styleRules(parseStylesheet(read(`src/${file}`)))
          .filter(({ style }) =>
            ["background", "background-color"].some((property) =>
              /^var\(--control-active\)(\s|$)/.test(style.getPropertyValue(property).trim())),
          )
          .filter(({ style }) => !["", "transparent", "var(--control-active-contrast)"].includes(style.getPropertyValue("color").trim()))
          .map(({ selectorText }) => `${file}: ${selectorText}`),
      )
    expect(offenders).toEqual([])
  })

  it.each(["light", "dark"])("keeps the enabled comment Reply action legible at rest and on hover in the %s theme", (theme) => {
    const rules = styleRules(parseStylesheet(["src/styles/foundations.css", ...appCssFiles].map(read).join("\n")))
    document.body.innerHTML = '<div class="editor-comment-reply-actions"><button class="primary">Reply</button></div>'
    const button = document.querySelector("button")!
    document.documentElement.dataset.theme = theme
    try {
      const tokens = cascade(rules, document.documentElement, false)
      for (const hover of [false, true]) {
        const declared = new Map([...tokens, ...cascade(rules, button, hover)])
        const page = parseColor(resolveVars("var(--surface-app)", declared))
        const fill = over(parseColor(resolveVars(declared.get("background") ?? "transparent", declared)), page)
        const label = over(parseColor(resolveVars(declared.get("color") ?? "", declared)), fill)
        expect(contrast(label, fill), hover ? "hover" : "rest").toBeGreaterThanOrEqual(4.5)
      }
    } finally {
      delete document.documentElement.dataset.theme
      document.body.innerHTML = ""
    }
  })

  // The accent is also text (outline links, roles, active toolbar icons), so
  // every preset must read on every tint's surfaces, and carry its label.
  it.each(["light", "dark"])("keeps every accent preset legible on every tint and under its label in the %s theme", (mode) => {
    const blocks = [...read("src/styles/theme.css").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(([, selector, body]) => ({ dark: selector.includes('data-theme="dark"'), body }))
      .filter(({ dark }) => dark === (mode === "dark"))
    const values = (pattern: RegExp) => blocks.flatMap(({ body }) => [...body.matchAll(pattern)].map((match) => match[1]))
    const accents = values(/--accent(?:-graphite)?:\s*(#[0-9a-f]{6});/gi)
    const labels = values(/--accent-contrast:\s*(#[0-9a-f]{6});/gi)
    const surfaces = values(/--(?:bg|panel|panel-strong|chrome-surface|side-surface|editor-bg):\s*(#[0-9a-f]{6});/gi)
    expect(accents).toHaveLength(7)
    expect(labels).toHaveLength(1)
    expect(surfaces.length).toBeGreaterThanOrEqual(25)
    for (const accent of accents) {
      expect(contrast(parseColor(accent), parseColor(labels[0])), accent).toBeGreaterThanOrEqual(4.5)
      for (const surface of surfaces) {
        expect(contrast(parseColor(accent), parseColor(surface)), `${accent} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
