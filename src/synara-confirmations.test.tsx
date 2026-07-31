import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmAction } from "./app-utils";
import {
  LATTICE_CONFIRMATION_ACK,
  LATTICE_CONFIRMATION_RESPONSE,
  parseSynaraConfirmationRequest,
  SYNARA_CONFIRMATION_REQUEST,
  useSynaraConfirmationBridge,
} from "./synara-confirmations";

vi.mock("./app-utils", () => ({ confirmAction: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("Synara confirmation bridge", () => {
  it("accepts bounded confirmation requests and rejects malformed payloads", () => {
    expect(
      parseSynaraConfirmationRequest({
        type: SYNARA_CONFIRMATION_REQUEST,
        id: "delete-thread-1",
        message: "Delete thread “Draft”?",
      }),
    ).toEqual({
      type: SYNARA_CONFIRMATION_REQUEST,
      id: "delete-thread-1",
      message: "Delete thread “Draft”?",
    });
    expect(
      parseSynaraConfirmationRequest({
        type: SYNARA_CONFIRMATION_REQUEST,
        id: "",
        message: "Delete thread?",
      }),
    ).toBeNull();
    expect(
      parseSynaraConfirmationRequest({
        type: SYNARA_CONFIRMATION_REQUEST,
        id: "delete-thread-1",
        message: "",
      }),
    ).toBeNull();
  });

  it("uses Lattice confirmation UI and returns the result to the trusted frame", async () => {
    vi.mocked(confirmAction).mockResolvedValue(true);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const frameWindow = iframe.contentWindow;
    expect(frameWindow).not.toBeNull();
    const postMessage = vi.spyOn(frameWindow!, "postMessage");
    const frameRef = { current: iframe };
    const { unmount } = renderHook(() =>
      useSynaraConfirmationBridge({
        frameRef,
        origin: "http://127.0.0.1:4317",
      }),
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frameWindow,
          origin: "http://127.0.0.1:4317",
          data: {
            type: SYNARA_CONFIRMATION_REQUEST,
            id: "delete-thread-1",
            message: "Delete thread “Draft”?\nThis cannot be undone.",
          },
        }),
      );
    });

    expect(postMessage).toHaveBeenCalledWith(
      { type: LATTICE_CONFIRMATION_ACK, id: "delete-thread-1" },
      "http://127.0.0.1:4317",
    );
    expect(confirmAction).toHaveBeenCalledWith(
      "Delete thread “Draft”?\nThis cannot be undone.",
    );
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        {
          type: LATTICE_CONFIRMATION_RESPONSE,
          id: "delete-thread-1",
          confirmed: true,
        },
        "http://127.0.0.1:4317",
      ),
    );
    unmount();
  });

  it("ignores confirmation requests from the wrong source or origin", () => {
    const iframe = document.createElement("iframe");
    const otherIframe = document.createElement("iframe");
    document.body.append(iframe, otherIframe);
    const frameRef = { current: iframe };
    const { unmount } = renderHook(() =>
      useSynaraConfirmationBridge({
        frameRef,
        origin: "http://127.0.0.1:4317",
      }),
    );
    const payload = {
      type: SYNARA_CONFIRMATION_REQUEST,
      id: "untrusted",
      message: "Delete everything?",
    };

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: otherIframe.contentWindow,
          origin: "http://127.0.0.1:4317",
          data: payload,
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          origin: "http://malicious.invalid",
          data: payload,
        }),
      );
    });

    expect(confirmAction).not.toHaveBeenCalled();
    unmount();
  });
});
