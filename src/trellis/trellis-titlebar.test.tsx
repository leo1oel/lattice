import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TrellisController } from "./trellis-controller";
import { TrellisTitlebar } from "./trellis-titlebar";

afterEach(cleanup);

// Vitest empties CSS imports, so load the stylesheets off disk into jsdom's
// CSSOM: the assertions read parsed rules and computed styles, not source text.
function loadSheet(file: string): CSSRule[] {
  const style = document.createElement("style");
  style.textContent = readFileSync(file, "utf8");
  document.head.append(style);
  return [...style.sheet!.cssRules];
}
const trellisRules = loadSheet("src/trellis/trellis.css");
const shellRules = loadSheet("src/styles/app-shell.css");

const styleRules = (rules: Iterable<CSSRule>) => [...rules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
const containerRules = (rules: CSSRule[], name: string) => rules.filter((rule): rule is CSSContainerRule => rule instanceof CSSContainerRule && rule.containerName === name);
const maxWidth = (rule: CSSContainerRule) => Number(/max-width:\s*(\d+)px/.exec(rule.containerQuery)?.[1]);

/** The computed container of an element, from the shorthand or its longhands. */
function containerOf(element: Element) {
  const style = getComputedStyle(element);
  const [name = "", type = ""] = style.getPropertyValue("container").split("/").map((part) => part.trim());
  return { name: name || style.getPropertyValue("container-name"), type: type || style.getPropertyValue("container-type") };
}

/** The width of the `trellis-titlebar` container step that hides `selector`. */
function hiddenBelow(selector: string): number {
  const steps = containerRules(trellisRules, "trellis-titlebar").filter((step) => styleRules(step.cssRules).some((rule) => rule.selectorText === selector && rule.style.display === "none"));
  expect(steps).toHaveLength(1);
  return maxWidth(steps[0]);
}

describe("titlebar panel controls in a narrow window", () => {
  // At the window's 640px minimum (and in a browser tab, which has no floor)
  // the controls used to spill under the canvas actions beside them, so a
  // click on Maximize landed on Editor comments and Reset layout on Open from
  // Overleaf. The bar is now sized by what the canvas actions leave and clips
  // what does not fit; groups are shed by the bar's own width before that.
  it("takes only the room the canvas actions leave, and never paints over them", () => {
    const { container } = render(<div className="titlebar"><button className="project-title" /><TrellisTitlebar controller={new TrellisController()} /></div>);
    const bar = container.querySelector(".trellis-titlebar")!;
    expect(containerOf(bar)).toEqual({ name: "trellis-titlebar", type: "inline-size" });
    expect(getComputedStyle(bar).overflow).toBe("hidden");
    expect(getComputedStyle(bar).minWidth).toBe("0px");
    // A viewport query cannot know how much of the bar the project name, the
    // traffic lights or interface zoom take, so none may size these controls.
    const mediaRules = trellisRules.filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule);
    for (const rule of mediaRules.flatMap((media) => styleRules(media.cssRules))) {
      expect(rule.selectorText).not.toMatch(/trellis-titlebar|trellis-preset/);
    }
    // A long project name gives way first, measured on the bar too.
    expect(containerOf(container.querySelector(".titlebar")!)).toEqual({ name: "titlebar", type: "inline-size" });
    const clamps = containerRules(shellRules, "titlebar").flatMap((step) => styleRules(step.cssRules)).filter((rule) => rule.selectorText === ".project-title");
    expect(clamps.map((rule) => rule.style.maxWidth)).toEqual(["var(--titlebar-project-title-max-width-compact)"]);
  });

  it("sheds the layout actions first, then the panel toggles, then the Panels label", () => {
    const layoutActions = hiddenBelow(".trellis-titlebar-layout-actions");
    const panelToggles = hiddenBelow(".trellis-titlebar-panel-toggles");
    const panelsLabel = hiddenBelow(".trellis-titlebar-menu > span");
    expect(layoutActions).toBeGreaterThan(panelToggles);
    expect(panelToggles).toBeGreaterThan(panelsLabel);
  });

  it("keeps every shed control's action in the Panels menu", () => {
    const { container } = render(<TrellisTitlebar controller={new TrellisController()} />);
    const shed = (selector: string) => [...container.querySelectorAll(`${selector} button`)].map((button) => button.getAttribute("aria-label"));
    expect(shed(".trellis-titlebar-layout-actions")).toEqual(["Maximize focused panel", "Reset layout"]);
    expect(shed(".trellis-titlebar-panel-toggles")).toEqual(["Show Project", "Show Papers", "Show Agent"]);

    const panels = screen.getByRole("button", { name: "Panels" });
    // The trigger keeps its name once only the icon is left.
    expect(panels.querySelector("span")).toHaveTextContent("Panels");
    fireEvent.pointerDown(panels, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = within(screen.getByRole("menu"));
    for (const name of ["Project", "Papers", "Agent", "Maximize focused panel", "Reset layout"]) {
      expect(menu.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
  });
});
