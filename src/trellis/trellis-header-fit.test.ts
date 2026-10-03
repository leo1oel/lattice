import { describe, expect, it } from "vitest";
import { planHeader, type HeaderMeasure } from "@danfessler/trellis";

// planHeader is the Trellis patch's header fit (patches/@danfessler__trellis@0.2.0.patch):
// it decides, per panel and frame, how the tabs and the header's action row
// share the bar. The measurements below are a document panel's in the app
// (a 2px tab gap, file tabs with an 80px minimum, a 60px icon-and-close
// floor and a 120px natural width) holding a .tex file and a Markdown note,
// with the action row's Edit / Split / Preview named, Build's row whole,
// without its label, and gone.
const DOCUMENT_CHROME: [number, number, number, number] = [214, 126, 81, 45];
const TOOLS = ["named", null, "icon", "hidden"] as const;

function fileTabs(count: number, natural = 120): HeaderMeasure {
  return {
    chrome: DOCUMENT_CHROME,
    gap: 2,
    items: Array.from({ length: count }, (_, i) => ({ viewId: `file:${i}`, atomic: false as const, min: 80, floor: 60, natural })),
  };
}

/** The bar's width the tabs take beside the action row as planned. */
function laidOut(header: HeaderMeasure, width: number, squeeze = 0) {
  const plan = planHeader(header, width, squeeze);
  const state = TOOLS.indexOf(plan.tools);
  const named = plan.tools === "named";
  const tabs = header.items.reduce((sum, item) => sum + (
    item.atomic ? (named ? item.full : item.compact) : named ? item.natural : Math.min(item.min, plan.tabMin ?? item.min)
  ), 0);
  return { plan, used: header.chrome[state] + header.gap * Math.max(0, header.items.length - 1) + tabs - squeeze };
}

describe("planHeader", () => {
  it("keeps every file tab clear of Build where seven tabs at 80px did not fit (Beta r11)", () => {
    // r11: a 575px document panel with seven file tabs. At their 80px minimum
    // the tabs needed 698px, so the strip scrolled and the last tabs sat
    // clipped at Build's edge, as if covered by it.
    const header = fileTabs(7);
    expect(header.chrome[0] + 7 * 80 + 6 * 2).toBeGreaterThan(575);
    const { plan, used } = laidOut(header, 575);
    expect(plan.tools).toBeNull();
    expect(plan.tabMin).toBe(62);
    expect(used).toBeLessThanOrEqual(575);
  });

  it("takes Build's label, then the whole action row, away before tabs would run under it", () => {
    // Text labels off still fits seven tabs at their floor...
    expect(planHeader(fileTabs(7), 515)).toMatchObject({ tools: "icon", tabMin: 60 });
    // ...and with less room the row goes (the panel menu repeats it).
    expect(planHeader(fileTabs(7), 468)).toMatchObject({ tools: "hidden", tabMin: 60 });
  });

  it("never lays out tabs under the action row, at any width or tab count", () => {
    for (let count = 1; count <= 12; count += 1) {
      for (let width = 120; width <= 900; width += 7) {
        const { plan, used } = laidOut(fileTabs(count), width);
        // With the row hidden, too many tabs scroll in a strip that reaches
        // the menu; with any row shown, they all fit beside it.
        if (plan.tools !== "hidden") expect(used, `${count} tabs in ${width}px`).toBeLessThanOrEqual(width + 0.5);
      }
    }
  });

  it("leaves a header that fits alone", () => {
    expect(planHeader(fileTabs(4), 454)).toEqual({ labelled: 0, tools: null, tabMin: null, min: 452 });
  });

  it("drops named tabs' labels before any tool gives way", () => {
    const header: HeaderMeasure = {
      chrome: [104, 104, 104, 45],
      gap: 2,
      items: [
        { viewId: "project", atomic: true, full: 106, compact: 32 },
        { viewId: "agent", atomic: true, full: 64, compact: 32 },
      ],
    };
    expect(planHeader(header, 250)).toMatchObject({ labelled: 1, tools: null });
    expect(planHeader(header, 220)).toMatchObject({ labelled: 0, tools: null });
    expect(planHeader(header, 150)).toMatchObject({ labelled: 0, tools: "hidden" });
  });

  it("gives a divider's rubber band to the tabs, not the action row", () => {
    // Squeezed 40px under a 452px minimum: the tabs shrink, Build stays.
    const { plan, used } = laidOut(fileTabs(4), 412, 40);
    expect(plan).toMatchObject({ tools: null, tabMin: null });
    expect(used).toBeLessThanOrEqual(412);
  });

  it("names the modes only where every tab keeps its natural width beside them", () => {
    // Two 120px tabs beside the named row need 214 + 2 + 240 = 456px.
    expect(planHeader(fileTabs(2), 456)).toMatchObject({ tools: "named", tabMin: null });
    // A pixel less and the names give way while the tabs still have room to
    // spare: no tab narrows for a name.
    expect(planHeader(fileTabs(2), 455)).toMatchObject({ tools: null, tabMin: null });
    // Long titles (natural width at the 200px cap) need the room for themselves.
    expect(planHeader(fileTabs(2, 200), 600)).toMatchObject({ tools: null });
    expect(planHeader(fileTabs(2, 200), 616)).toMatchObject({ tools: "named" });
  });

  it("never counts the modes' names in the panel's minimum", () => {
    for (const width of [300, 456, 900]) expect(planHeader(fileTabs(2), width).min).toBe(126 + 2 + 160);
  });

  it("names the modes only once every named tab shows its own name", () => {
    const header: HeaderMeasure = {
      chrome: [200, 120, 90, 45],
      gap: 2,
      items: [
        { viewId: "project", atomic: true, full: 106, compact: 32 },
        { viewId: "file:0", atomic: false, min: 80, floor: 60, natural: 120 },
      ],
    };
    expect(planHeader(header, 428)).toMatchObject({ labelled: 1, tools: "named" });
    expect(planHeader(header, 427)).toMatchObject({ labelled: 1, tools: null });
  });

  it("caps the header's share of the panel minimum at 480px", () => {
    expect(planHeader(fileTabs(4), 900).min).toBe(452);
    expect(planHeader(fileTabs(9), 900).min).toBe(480);
  });
});
