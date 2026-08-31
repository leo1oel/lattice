import { describe, expect, it } from "vitest";
import {
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
