import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LATTICE_OUTSIDE_POINTER_DOWN,
  SYNARA_POPUP_OPEN,
  useSynaraPopupDismissalBridge,
} from "./synara-popup-dismissal";
import { mountSynaraFrames, postFromFrame, postUntrusted, SYNARA_TEST_ORIGIN } from "./synara-frame-test-utils";

afterEach(() => {
  document.body.replaceChildren();
});

function mountBridge() {
  const frames = mountSynaraFrames();
  const hook = renderHook(() => useSynaraPopupDismissalBridge({ frameRef: frames.frameRef, origin: SYNARA_TEST_ORIGIN }));
  const postMessage = vi.spyOn(frames.frameWindow, "postMessage");
  const editor = document.createElement("button");
  document.body.append(editor);
  const reached: string[] = [];
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    editor.addEventListener(type, () => reached.push(type));
  }
  const press = () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      editor.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  };
  return { ...frames, ...hook, postMessage, reached, press };
}

describe("Synara popup dismissal bridge", () => {
  it("leaves presses alone while no Synara popup is open", () => {
    const { postMessage, reached, press, unmount } = mountBridge();
    press();
    expect(postMessage).not.toHaveBeenCalled();
    expect(reached).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    unmount();
  });

  it("sends a press outside the frame to it, and the press only closes the popup", () => {
    const frames = mountBridge();
    const { frameWindow, postMessage, reached, press, unmount } = frames;
    // Only the trusted frame can claim an open popup.
    postUntrusted(frames, { type: SYNARA_POPUP_OPEN, open: true });
    press();
    expect(postMessage).not.toHaveBeenCalled();
    reached.length = 0;

    postFromFrame(frameWindow, { type: SYNARA_POPUP_OPEN, open: true });
    press();
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: LATTICE_OUTSIDE_POINTER_DOWN }, SYNARA_TEST_ORIGIN);
    expect(reached).toEqual([]);

    // The flag is spent: the next press is the user's own.
    press();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(reached).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    unmount();
  });

  it("forgets an open popup the frame closed or lost to a reload", () => {
    const { frameWindow, postMessage, press, unmount } = mountBridge();
    postFromFrame(frameWindow, { type: SYNARA_POPUP_OPEN, open: true });
    postFromFrame(frameWindow, { type: SYNARA_POPUP_OPEN, open: false });
    press();
    postFromFrame(frameWindow, { type: SYNARA_POPUP_OPEN, open: true });
    postFromFrame(frameWindow, { type: "synara:embed-ready" });
    press();
    expect(postMessage).not.toHaveBeenCalled();
    unmount();
  });
});
