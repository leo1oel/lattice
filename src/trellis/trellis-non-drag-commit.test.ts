import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, type WorkspaceHandle } from "@danfessler/trellis";

const SIZE = { w: 1200, h: 800 };

let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function advance(ms: number) {
  now += ms;
  const due = [...frames.values()];
  frames = new Map();
  for (const cb of due) cb(now);
}

function px(value: string) {
  return Number.parseFloat(value);
}

function surfaces(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>("[data-trellis-part=surface]")].map((shell) => {
    const content = shell.firstElementChild as HTMLElement;
    return { shell, content };
  });
}

describe("non-drag layout commits", () => {
  let host: HTMLElement;
  let ws: WorkspaceHandle;

  beforeEach(() => {
    now = 1000;
    frames = new Map();
    nextFrame = 1;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.trellisPart === "tabs" ? 100 : SIZE.w;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.trellisPart === "tabs" ? 2000 : 0;
    });
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const part = (this as HTMLElement).dataset?.trellisPart;
      const rect = part === "tab" ? { left: 500, width: 80 } : part === "tab-title" ? { left: 0, width: 60 } : { left: 0, width: 0 };
      return { x: rect.left, y: 0, top: 0, bottom: 0, right: rect.left + rect.width, height: 0, ...rect, toJSON() {} } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(SIZE.h);
    host = document.createElement("div");
    document.body.append(host);
    ws = createWorkspace(host, {
      motion: "full",
      navigation: false,
      types: { note: { title: "Note", singleton: true, mount: () => () => {} } },
      defaultLayout: {
        kind: "split",
        axis: "x",
        children: [
          { kind: "panel", views: [{ kind: "view", type: "note", id: "a" }, { kind: "view", type: "note", id: "a2" }] },
          { kind: "panel", views: [{ kind: "view", type: "note", id: "b" }] },
          { kind: "panel", views: [{ kind: "view", type: "note", id: "c" }] },
        ],
      } as never,
    });
    advance(16);
    advance(600);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  const commits: Array<[string, () => unknown, string | null]> = [
    ["dock", () => ws.dock("c", { beside: "a", edge: "bottom" }), null],
    ["float", () => ws.float("b", { x: 300, y: 200, w: 400, h: 300 }), null],
    ["close", () => ws.close("b", { force: true }), "b"],
    ["hide", () => ws.hide("b"), "b"],
  ];

  it.each(commits)("%s lays every view out at its surface size on every frame of the tween", async (_name, commit, leaving) => {
    await commit();
    const seen = new Set<string>();
    for (let t = 0; t < 700; t += 16) {
      advance(16);
      for (const { shell, content } of surfaces(host)) {
        if (shell.style.visibility === "hidden" || shell.dataset.view === leaving) continue;
        expect(px(content.style.width)).toBeCloseTo(px(shell.style.width), 0);
        expect(px(content.style.height)).toBeCloseTo(px(shell.style.height), 0);
        expect(shell.style.clipPath).toBe("");
        seen.add(`${shell.dataset.view}:${shell.style.width}x${shell.style.height}`);
      }
    }
    expect(seen.size).toBeGreaterThan(3);
    const lists = [...host.querySelectorAll<HTMLElement>("[data-trellis-part=tabs]")];
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect(list.scrollLeft).toBeGreaterThan(0);
      for (const tab of list.querySelectorAll<HTMLElement>("[data-trellis-part=tab]"))
        expect(tab.style.getPropertyValue("--trellis-tab-label")).toBe("60px");
    }
  });
});
