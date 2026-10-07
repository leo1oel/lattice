import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { TrellisController } from "../trellis/trellis-controller";
import { useFocusModeEscape } from "./use-focus-mode-escape";

describe("leaving focus mode with Escape", () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  const setup = (active = true) => {
    const controller = new TrellisController();
    const calls: boolean[] = [];
    controller.installHandlers({ focus: (on) => calls.push(on) });
    renderHook(() => useFocusModeEscape(controller, active));
    return calls;
  };

  it("leaves on an Escape nothing else took, and only while focus mode is on", () => {
    const calls = setup();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(calls).toEqual([false]);
    const idle = setup(false);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(idle).toEqual([]);
  });

  it("stays for an Escape a surface handled, one with modifiers, one composing, and Vim's", () => {
    const calls = setup();
    const handled = document.createElement("div");
    handled.addEventListener("keydown", (event) => event.preventDefault());
    document.body.append(handled);
    fireEvent.keyDown(handled, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "Escape", isComposing: true });
    const vim = document.createElement("div");
    vim.className = "cm-editor cm-vimMode";
    document.body.append(vim);
    fireEvent.keyDown(vim, { key: "Escape" });
    expect(calls).toEqual([]);
  });

  it("stays while a dialog or menu that Escape closes is open, even one that closes without saying so", () => {
    const calls = setup();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    // Closes on the key in the capture phase, after focus mode looked, without marking it handled.
    document.addEventListener("keydown", () => dialog.remove(), { capture: true, once: true });
    document.body.append(dialog);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(calls).toEqual([]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(calls).toEqual([false]);
  });
});
