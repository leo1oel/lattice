import { describe, expect, it } from "vitest";
import {
  CHROMIUM_WINDOW_CSS,
  isOpenSlidePresenterUrl,
  openSlidePresenterWindowOptions,
} from "./chromium-window-policy.mjs";

const presenterUrl = "http://127.0.0.1:43123/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk%2Fpresenter";

describe("Chromium window policy", () => {
  it("keeps authenticated Open Slide presenters in the bundled Chromium session", () => {
    expect(isOpenSlidePresenterUrl(presenterUrl)).toBe(true);
    expect(openSlidePresenterWindowOptions(presenterUrl)).toMatchObject({
      action: "allow",
      overrideBrowserWindowOptions: {
        title: "Open Slide Presenter",
        width: 1_280,
        height: 800,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      },
    });
  });

  it.each([
    "https://example.com/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk%2Fpresenter",
    "http://localhost:43123/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk%2Fpresenter",
    "http://127.0.0.1:43123/__lattice/bootstrap?next=%2Fs%2Ftalk%2Fpresenter",
    "http://127.0.0.1:43123/__lattice/bootstrap?token=&next=%2Fs%2Ftalk%2Fpresenter",
    "http://127.0.0.1:43123/__lattice/bootstrap?token=one&token=two&next=%2Fs%2Ftalk%2Fpresenter",
    "http://127.0.0.1:43123/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk",
    "http://127.0.0.1:43123/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk%252Fevil%2Fpresenter",
    "http://127.0.0.1:43123/__lattice/bootstrap?token=session-secret&next=%2Fsettings",
  ])("rejects a non-presenter popup: %s", (url) => {
    expect(isOpenSlidePresenterUrl(url)).toBe(false);
    expect(openSlidePresenterWindowOptions(url)).toBeNull();
  });
});

describe("Chromium window CSS", () => {
  // jsdom's CSSOM drops properties it does not know, -webkit-app-region among
  // them, so split the injected stylesheet into its rules here.
  const rules = [...CHROMIUM_WINDOW_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map(([, selector, body]) => ({
      selector: selector.trim(),
      declarations: new Map(body.split(";").map((item) => item.split(":").map((part) => part.trim())).filter(([name]) => name)),
    }));
  /** The `-webkit-app-region` the injected stylesheet gives `element`, by the last matching rule. */
  const appRegion = (element) => rules
    .filter((rule) => element.matches(rule.selector) && rule.declarations.has("-webkit-app-region"))
    .map((rule) => rule.declarations.get("-webkit-app-region"))
    .at(-1) ?? null;

  it("keeps titlebar whitespace draggable without consuming its buttons or drawers", () => {
    document.body.innerHTML = `
      <div class="titlebar-main">
        <div class="trellis-titlebar"><button type="button">Panels</button></div>
      </div>
      <div class="titlebar-drag-area"></div>
      <div class="resizable-drawer"></div>
      <div class="modal-dialog-content"></div>`;
    const titlebar = document.querySelector(".trellis-titlebar");
    expect(appRegion(titlebar)).toBe("drag");
    expect(appRegion(document.querySelector(".titlebar-drag-area"))).toBe("drag");
    expect(appRegion(titlebar.querySelector("button"))).toBe("no-drag");
    expect(appRegion(document.querySelector(".resizable-drawer"))).toBe("no-drag");
    expect(appRegion(document.querySelector(".modal-dialog-content"))).toBe("no-drag");
    document.body.innerHTML = "";
  });

  it("keeps the project switcher's centering gap and a zoom-independent traffic-light inset", () => {
    const rule = (selector) => rules.find((candidate) => candidate.selector === selector)?.declarations;
    // Round 8 centered the switcher with this leading gap; zeroing the
    // navigator's padding here pinned the name against the lights.
    expect(rule(".app-shell.browser-hosted .titlebar-navigator").get("padding")).toBe("0 var(--titlebar-leading-gap) 0 0 !important");
    expect(rule(".app-shell.browser-hosted .traffic-space").get("width")).toBe("calc(70px / var(--lattice-page-zoom, 1)) !important");
  });
});
