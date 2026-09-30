import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmAction } from "../app-utils";
import {
  LATTICE_CONFIRMATION_ACK,
  LATTICE_CONFIRMATION_RESPONSE,
  parseSynaraConfirmationRequest,
  SYNARA_CONFIRMATION_REQUEST,
  useSynaraConfirmationBridge,
} from "./synara-confirmations";
import { mountSynaraFrames, postFromFrame, postUntrusted, SYNARA_TEST_ORIGIN } from "./synara-frame-test-utils";

vi.mock("../app-utils", async (importOriginal) => ({ ...await importOriginal<typeof import("../app-utils")>(), confirmAction: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function mountBridge() {
  const frames = mountSynaraFrames();
  const hook = renderHook(() => useSynaraConfirmationBridge({ frameRef: frames.frameRef, origin: SYNARA_TEST_ORIGIN }));
  return { ...frames, unmount: hook.unmount };
}

describe("Synara confirmation bridge", () => {
  it("accepts bounded confirmation requests and rejects malformed payloads", () => {
    const request = { type: SYNARA_CONFIRMATION_REQUEST, id: "delete-thread-1", message: "Delete thread “Draft”?" };
    expect(parseSynaraConfirmationRequest(request)).toEqual(request);
    expect(parseSynaraConfirmationRequest({ ...request, id: "" })).toBeNull();
    expect(parseSynaraConfirmationRequest({ ...request, message: "" })).toBeNull();
  });

  it("uses Lattice confirmation UI for the trusted frame only and returns the result to it", async () => {
    vi.mocked(confirmAction).mockResolvedValue(true);
    const frames = mountBridge();
    const { frameWindow, unmount } = frames;
    const postMessage = vi.spyOn(frameWindow, "postMessage");
    // The wrong source or origin is ignored.
    postUntrusted(frames, { type: SYNARA_CONFIRMATION_REQUEST, id: "untrusted", message: "Delete everything?" });
    expect(confirmAction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();

    postFromFrame(frameWindow, {
      type: SYNARA_CONFIRMATION_REQUEST,
      id: "delete-thread-1",
      message: "Delete thread “Draft”?\nThis cannot be undone.",
    });

    expect(postMessage).toHaveBeenCalledWith({ type: LATTICE_CONFIRMATION_ACK, id: "delete-thread-1" }, SYNARA_TEST_ORIGIN);
    expect(confirmAction).toHaveBeenCalledExactlyOnceWith("Delete thread “Draft”?\nThis cannot be undone.");
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      { type: LATTICE_CONFIRMATION_RESPONSE, id: "delete-thread-1", confirmed: true },
      SYNARA_TEST_ORIGIN,
    ));
    unmount();
  });
});
