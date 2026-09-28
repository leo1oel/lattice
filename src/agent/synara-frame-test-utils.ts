import { act } from "@testing-library/react";

/** Shared by the Synara bridge tests: a trusted frame, an untrusted sibling, and message helpers. */
export const SYNARA_TEST_ORIGIN = "http://127.0.0.1:4317";

export function mountSynaraFrames() {
  const frame = document.createElement("iframe");
  const other = document.createElement("iframe");
  document.body.append(frame, other);
  return { frameRef: { current: frame }, frameWindow: frame.contentWindow!, otherWindow: other.contentWindow! };
}

export function postFromFrame(source: Window, data: unknown, origin = SYNARA_TEST_ORIGIN): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
  });
}

/** The same payload from the wrong frame, then from the right frame at the wrong origin. */
export function postUntrusted(frames: ReturnType<typeof mountSynaraFrames>, data: unknown): void {
  postFromFrame(frames.otherWindow, data);
  postFromFrame(frames.frameWindow, data, "http://malicious.invalid");
}
