import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TrellisController } from "./trellis-controller";
import { TrellisTitlebar } from "./trellis-titlebar";

afterEach(cleanup);

const css = readFileSync("src/trellis/trellis.css", "utf8");

/** Each `@container trellis-titlebar` step: its width and the selectors it hides. */
const collapseSteps = [...css.matchAll(/@container trellis-titlebar \(max-width: (\d+)px\) \{([^@]*?)\}\s*\}?/g)].map((match) => ({
  width: Number(match[1]),
  hidden: [...match[2].matchAll(/([^{}]+)\{[^}]*\bdisplay: none\b/g)].map((rule) => rule[1].trim()),
}));

describe("titlebar panel controls in a narrow window", () => {
  // At the window's 640px minimum (and in a browser tab, which has no floor)
  // the controls used to spill under the canvas actions beside them, so a
  // click on Maximize landed on Editor comments and Reset layout on Open from
  // Overleaf. The bar is now sized by what the canvas actions leave and clips
  // what does not fit; groups are shed by the bar's own width before that.
  it("takes only the room the canvas actions leave, and never paints over them", () => {
    const bar = /\.trellis-titlebar \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(bar).toMatch(/container: trellis-titlebar \/ inline-size;/);
    expect(bar).toMatch(/overflow: hidden;/);
    expect(bar).toMatch(/min-width: 0;/);
    // A viewport query cannot know how much of the bar the project name, the
    // traffic lights or interface zoom take, so none may size these controls.
    // A long project name gives way first, measured on the bar too.
    const shell = readFileSync("src/styles/app-shell.css", "utf8");
    expect(shell).toMatch(/\.titlebar \{ container: titlebar \/ inline-size;/);
    expect(shell).toMatch(/@container titlebar \(max-width: \d+px\) \{ \.project-title \{ max-width: var\(--titlebar-project-title-max-width-compact\); \} \}/);
    for (const media of css.matchAll(/@media[^{]*\{([^@]*?)\}\s*\}/g)) {
      expect(media[1]).not.toMatch(/trellis-titlebar|trellis-preset/);
    }
  });

  it("sheds the preset labels first, then whole groups, then the Panels label", () => {
    expect(collapseSteps.map((step) => step.width)).toEqual([...collapseSteps.map((step) => step.width)].sort((a, b) => b - a));
    expect(collapseSteps.map((step) => step.hidden)).toEqual([
      [],
      [".trellis-titlebar-layout-actions"],
      [".trellis-titlebar-panel-toggles"],
      [".trellis-titlebar-menu > span"],
    ]);
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
