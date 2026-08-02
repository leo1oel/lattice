import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppToastStack } from "./app-log";
import { clearAppLogs } from "./app-log-store";
import {
  parseSynaraNotificationMessage,
  SYNARA_EMBEDDED_NOTIFICATION,
  useSynaraNotificationBridge,
} from "./synara-notifications";

describe("Synara notification messages", () => {
  beforeEach(() => {
    clearAppLogs();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("accepts the bounded provider update failure payload", () => {
    expect(
      parseSynaraNotificationMessage({
        type: SYNARA_EMBEDDED_NOTIFICATION,
        operation: "upsert",
        id: "pi-update",
        level: "error",
        title: "Could not update Pi",
        detail: "NotFound: ChildProcess.spawn (pi update)",
        timeoutMs: 5000,
        copyText: "pi update",
      }),
    ).toEqual({
      type: SYNARA_EMBEDDED_NOTIFICATION,
      operation: "upsert",
      id: "pi-update",
      level: "error",
      title: "Could not update Pi",
      detail: "NotFound: ChildProcess.spawn (pi update)",
      timeoutMs: 5000,
      copyText: "pi update",
    });
  });

  it("rejects malformed levels, identifiers, and timeouts", () => {
    const base = {
      type: SYNARA_EMBEDDED_NOTIFICATION,
      operation: "upsert",
      id: "notification",
      level: "info",
      title: "Notice",
      detail: "",
      timeoutMs: 5000,
    };
    expect(parseSynaraNotificationMessage({ ...base, id: "" })).toBeNull();
    expect(parseSynaraNotificationMessage({ ...base, level: "critical" })).toBeNull();
    expect(parseSynaraNotificationMessage({ ...base, timeoutMs: Infinity })).toBeNull();
  });

  it("accepts dismissals without trusting unrelated fields", () => {
    expect(
      parseSynaraNotificationMessage({
        type: SYNARA_EMBEDDED_NOTIFICATION,
        operation: "dismiss",
        id: "pi-update",
        title: "<script>",
      }),
    ).toEqual({
      type: SYNARA_EMBEDDED_NOTIFICATION,
      operation: "dismiss",
      id: "pi-update",
    });
  });

  it("shows trusted iframe messages in the app toast stack and returns dismissals", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const frameWindow = iframe.contentWindow;
    expect(frameWindow).not.toBeNull();
    const postMessage = vi.spyOn(frameWindow!, "postMessage");
    const frameRef = { current: iframe };
    const { unmount } = renderHook(() =>
      useSynaraNotificationBridge({
        frameRef,
        origin: "http://127.0.0.1:4317",
        source: "Synara settings",
      }),
    );
    const { container } = render(<AppToastStack />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frameWindow,
          origin: "http://127.0.0.1:4317",
          data: {
            type: SYNARA_EMBEDDED_NOTIFICATION,
            operation: "upsert",
            id: "pi-update",
            level: "error",
            title: "Could not update Pi",
            detail: "NotFound: ChildProcess.spawn (pi update)",
            timeoutMs: 5000,
            copyText: "pi update",
          },
        }),
      );
    });

    expect(container.querySelector(".app-toast-stack")).toHaveTextContent(
      "Could not update Pi",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "NotFound: ChildProcess.spawn (pi update)",
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frameWindow,
          origin: "http://127.0.0.1:4317",
          data: {
            type: SYNARA_EMBEDDED_NOTIFICATION,
            operation: "dismiss",
            id: "pi-update",
          },
        }),
      );
    });
    expect(screen.getByText("Could not update Pi")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "lattice:embedded-notification-action",
        id: "pi-update",
        action: "dismiss",
      },
      "http://127.0.0.1:4317",
    );
    expect(screen.queryByText("Could not update Pi")).toBeNull();
    unmount();
  });

  it("ignores the same payload from the wrong source or origin", () => {
    const iframe = document.createElement("iframe");
    const otherIframe = document.createElement("iframe");
    document.body.append(iframe, otherIframe);
    const frameRef = { current: iframe };
    const { unmount } = renderHook(() =>
      useSynaraNotificationBridge({
        frameRef,
        origin: "http://127.0.0.1:4317",
        source: "Synara settings",
      }),
    );
    render(<AppToastStack />);
    const payload = {
      type: SYNARA_EMBEDDED_NOTIFICATION,
      operation: "upsert",
      id: "untrusted",
      level: "error",
      title: "Should not render",
      detail: "",
      timeoutMs: 0,
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

    expect(screen.queryByText("Should not render")).toBeNull();
    unmount();
  });
});
