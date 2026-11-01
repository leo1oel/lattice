// The harness's module mocks register as it loads: import it before anything it mocks.
import {
  emitTauriEvent, openAgentFrame, postWindowMessage, postedOfType, projectCommands, refreshableProject, waitForSelectedTab, windowApi,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { renderApp } = appHarness({ documentCanvas });

// The wire protocol as Synara's latticeHostShortcuts.ts speaks it, spelled out so the test pins it.
const LATTICE_HOST_SHORTCUTS_REQUEST = "lattice:request-host-shortcuts";
const LATTICE_HOST_SHORTCUTS = "lattice:host-shortcuts";
const SYNARA_HOST_SHORTCUT = "synara:host-shortcut";

/** A key as the Synara frame forwards it (Synara's latticeHostShortcuts.ts). */
const forwarded = (key: string, code: string, modifiers: { shiftKey?: boolean } = {}) => ({
  type: SYNARA_HOST_SHORTCUT, version: 1, key, code, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers,
});
const paletteInput = () => screen.queryByRole("searchbox", { name: "Command palette" });
const documentTab = (name: string) => screen.queryByRole("tab", { name });

describe("Lattice's shortcuts with focus in a Synara frame", () => {
  it("runs a key pressed in the Agent panel, and tells the frame which keys are Lattice's", async () => {
    renderApp(projectCommands());
    await screen.findByRole("button", { name: "Switch project" });
    const { frame, postMessage } = await openAgentFrame({ ready: true });

    // The bug: a key pressed in the frame's document never reaches the window's shortcuts.
    act(() => {
      frame.contentWindow!.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(paletteInput()).toBeNull();

    // The frame asks for the keys it must leave to Lattice: ⌘K and ⌘P among them.
    postMessage.mockClear();
    postWindowMessage(frame.contentWindow, { type: LATTICE_HOST_SHORTCUTS_REQUEST, version: 1 });
    const [list] = postedOfType<{ shortcuts: Array<{ key: string; mod: boolean; shift: boolean }> }>(postMessage, LATTICE_HOST_SHORTCUTS);
    expect(list.shortcuts).toEqual(expect.arrayContaining([
      { key: "k", mod: true, ctrl: false, shift: false, alt: false },
      { key: "p", mod: true, ctrl: false, shift: false, alt: false },
      { key: ",", mod: true, ctrl: false, shift: false, alt: false },
    ]));
    // Text editing stays with the frame.
    expect(list.shortcuts.some((combo) => ["c", "v", "z", "a", "f"].includes(combo.key) && combo.mod && !combo.shift)).toBe(false);

    // A key it hands back runs as if pressed beside the frame.
    postWindowMessage(frame.contentWindow, forwarded("k", "KeyK"));
    expect(await screen.findByRole("searchbox", { name: "Command palette" })).toBeInTheDocument();
  });

  it("ignores a forwarded key from another origin or for a key Lattice does not run", async () => {
    renderApp(projectCommands());
    await screen.findByRole("button", { name: "Switch project" });
    const { frame } = await openAgentFrame({ ready: true });
    postWindowMessage(frame.contentWindow, forwarded("k", "KeyK"), "https://evil.example");
    postWindowMessage(window, forwarded("k", "KeyK"));
    // ⌘J is not one of Lattice's keys, whatever the frame says.
    postWindowMessage(frame.contentWindow, forwarded("j", "KeyJ"));
    postWindowMessage(frame.contentWindow, { ...forwarded("k", "KeyK"), version: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(paletteInput()).toBeNull();
  });

  it("runs a key pressed in the Git drawer", async () => {
    renderApp({ ...projectCommands(), git_status: () => ({
      available: true, repository: true, branch: "main", remote: "origin", remoteUrl: "git@github.com:leo1oel/lattice.git", files: [],
    }) });
    await screen.findByRole("button", { name: "Switch project" });
    fireEvent.click(screen.getByRole("button", { name: "Git status and commit" }));
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="Changes"]');
      expect(element).not.toBeNull();
      return element!;
    });
    postWindowMessage(frame.contentWindow, forwarded("k", "KeyK"));
    expect(await screen.findByRole("searchbox", { name: "Command palette" })).toBeInTheDocument();
  });
});

describe("⌘W", () => {
  it("closes the document tab, and the window only once no tab is left", async () => {
    renderApp(refreshableProject());
    await waitForSelectedTab("main.tex");
    windowApi.close.mockClear();

    // The bug: ⌘W was the menu's Close Window, which closed the whole project.
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    await waitFor(() => expect(documentTab("main.tex")).toBeNull());
    expect(windowApi.close).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "w", metaKey: true });
    await waitFor(() => expect(windowApi.close).toHaveBeenCalledOnce());
  });

  it("does the same from File ▸ Close Tab, for a ⌘W no page listener took", async () => {
    renderApp(refreshableProject());
    await waitForSelectedTab("main.tex");
    windowApi.close.mockClear();
    emitTauriEvent("close-tab", null);
    await waitFor(() => expect(documentTab("main.tex")).toBeNull());
    expect(windowApi.close).not.toHaveBeenCalled();
    emitTauriEvent("close-tab", null);
    await waitFor(() => expect(windowApi.close).toHaveBeenCalledOnce());
  });
});
