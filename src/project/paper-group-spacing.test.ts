// Vitest empties CSS imports, so read the stylesheet off disk.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Every style rule in `list`, inside @media, @container and @layer blocks too. */
function styleRules(list: CSSRuleList): CSSStyleRule[] {
  return Array.from(list).flatMap((rule) => (
    rule instanceof CSSStyleRule ? [rule] : rule instanceof CSSGroupingRule ? styleRules(rule.cssRules) : []
  ));
}

/**
 * A grouped Papers list as PaperShelf draws it: the hover surface's anchor,
 * then (once a row is lit) the fill, a div, ahead of each group's heading and
 * list.
 */
function groupedList(lit: boolean): HTMLElement {
  const rows = document.createElement("div");
  rows.className = "paper-rows fluid-hover-surface";
  rows.innerHTML = `
    <span hidden aria-hidden="true"></span>
    ${lit ? '<div data-slot="fluid-hover-highlight" class="fluid-hover-highlight"></div>' : ""}
    <div class="paper-group" data-slot="paper-group-label"><span class="paper-group-name">2025</span></div>
    <div role="list" class="paper-group-list"><div class="paper-row" data-paper-key="a"></div></div>
    <div class="paper-group" data-slot="paper-group-label"><span class="paper-group-name">2024</span></div>
    <div role="list" class="paper-group-list"><div class="paper-row" data-paper-key="b"></div></div>`;
  return rows;
}

describe("the Papers list's group headings", () => {
  it("take the same rules whether or not the hover fill is in the list", () => {
    // The fill mounts as the first div of .paper-rows when the pointer lights
    // a row and leaves when it crosses a heading. A heading picked by
    // :first-of-type took the in-between groups' 16px margin while it was
    // there, so every row moved 12px each time the fill came or went, and the
    // list shook under a pointer moving down over the headings.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(readFileSync("src/styles/app-shell.css", "utf8"));
    const rules = styleRules(sheet.cssRules).filter((rule) => rule.selectorText.includes("paper-group"));
    const matched = (lit: boolean) => {
      const list = groupedList(lit);
      document.body.append(list);
      const headings = [...list.querySelectorAll(".paper-group")].map((heading) => (
        rules.filter((rule) => heading.matches(rule.selectorText)).map((rule) => rule.cssText)
      ));
      list.remove();
      return headings;
    };

    const resting = matched(false);
    // The first heading has its own, smaller margin above it.
    expect(resting[0]).not.toEqual(resting[1]);
    expect(matched(true)).toEqual(resting);
  });
});
