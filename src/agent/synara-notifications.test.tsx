import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppToastStack } from "../telemetry/app-log";
import { clearAppLogs } from "../telemetry/app-log-store";
import { mountSynaraFrames, postFromFrame, postUntrusted, SYNARA_TEST_ORIGIN } from "./synara-frame-test-utils";
import {
  parseSynaraNotificationMessage,
  SYNARA_EMBEDDED_NOTIFICATION,
  useSynaraNotificationBridge,
} from "./synara-notifications";

const piUpdateFailure = {
  type: SYNARA_EMBEDDED_NOTIFICATION,
  operation: "upsert",
  id: "pi-update",
  level: "error",
  title: "Could not update Pi",
  detail: "NotFound: ChildProcess.spawn (pi update)",
  timeoutMs: 5000,
  copyText: "pi update",
};

function mountBridge() {
  const frames = mountSynaraFrames();
  const hook = renderHook(() => useSynaraNotificationBridge({
    frameRef: frames.frameRef,
    origin: SYNARA_TEST_ORIGIN,
    source: "Synara settings",
  }));
  return { ...frames, unmount: hook.unmount, toasts: render(<AppToastStack />).container };
}

describe("Synara notification messages", () => {
  beforeEach(() => {
    clearAppLogs();
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  it("accepts the bounded provider update failure payload", () => {
    expect(parseSynaraNotificationMessage(piUpdateFailure)).toEqual(piUpdateFailure);
  });

  it("rejects malformed levels, identifiers, and timeouts", () => {
    const base = { ...piUpdateFailure, id: "notification", level: "info", title: "Notice", detail: "" };
    expect(parseSynaraNotificationMessage({ ...base, id: "" })).toBeNull();
    expect(parseSynaraNotificationMessage({ ...base, level: "critical" })).toBeNull();
    expect(parseSynaraNotificationMessage({ ...base, timeoutMs: Infinity })).toBeNull();
  });

  it("accepts dismissals without trusting unrelated fields", () => {
    const dismissal = { type: SYNARA_EMBEDDED_NOTIFICATION, operation: "dismiss", id: "pi-update" };
    expect(parseSynaraNotificationMessage({ ...dismissal, title: "<script>" })).toEqual(dismissal);
  });

  it("shows trusted iframe messages in the app toast stack and returns dismissals", async () => {
    const { frameWindow, toasts, unmount } = mountBridge();
    const postMessage = vi.spyOn(frameWindow, "postMessage");

    postFromFrame(frameWindow, piUpdateFailure);
    expect(toasts.querySelector(".app-toast-stack")).toHaveTextContent("Could not update Pi");
    expect(screen.getByRole("alert")).toHaveTextContent("NotFound: ChildProcess.spawn (pi update)");

    postFromFrame(frameWindow, { type: SYNARA_EMBEDDED_NOTIFICATION, operation: "dismiss", id: "pi-update" });
    expect(screen.getByText("Could not update Pi")).toBeInTheDocument();

    const toast = screen.getByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(postMessage).toHaveBeenCalledWith(
      { type: "lattice:embedded-notification-action", id: "pi-update", action: "dismiss" },
      SYNARA_TEST_ORIGIN,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toast).toHaveAttribute("inert");
    await waitFor(() => expect(screen.queryByText("Could not update Pi")).toBeNull());
    unmount();
  });

  it("ignores the same payload from the wrong source or origin", () => {
    const frames = mountBridge();
    postUntrusted(frames, { ...piUpdateFailure, id: "untrusted", title: "Should not render", detail: "", timeoutMs: 0 });
    expect(screen.queryByText("Should not render")).toBeNull();
    frames.unmount();
  });
});
