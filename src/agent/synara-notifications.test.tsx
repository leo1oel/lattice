import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastStack } from "../telemetry/toast-stack";
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
  render(<ToastStack />);
  return { ...frames, unmount: hook.unmount };
}

describe("Synara notification messages", () => {
  beforeEach(clearAppLogs);
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  it("accepts bounded updates and dismissals, rejecting malformed levels, identifiers, and timeouts", () => {
    expect(parseSynaraNotificationMessage(piUpdateFailure)).toEqual(piUpdateFailure);
    const base = { ...piUpdateFailure, id: "notification", level: "info", title: "Notice", detail: "" };
    expect(parseSynaraNotificationMessage({ ...base, id: "" })).toBeNull();
    expect(parseSynaraNotificationMessage({ ...base, level: "critical" })).toBeNull();
    expect(parseSynaraNotificationMessage({ ...base, timeoutMs: Infinity })).toBeNull();
    // Dismissals are accepted without trusting unrelated fields.
    const dismissal = { type: SYNARA_EMBEDDED_NOTIFICATION, operation: "dismiss", id: "pi-update" };
    expect(parseSynaraNotificationMessage({ ...dismissal, title: "<script>" })).toEqual(dismissal);
  });

  it("shows only trusted iframe messages in the app toast stack and returns dismissals", async () => {
    const frames = mountBridge();
    const { frameWindow, unmount } = frames;
    const postMessage = vi.spyOn(frameWindow, "postMessage");
    // The same payload from the wrong source or origin is ignored.
    postUntrusted(frames, { ...piUpdateFailure, id: "untrusted", title: "Should not render", detail: "", timeoutMs: 0 });
    expect(screen.queryByText("Should not render")).toBeNull();

    postFromFrame(frameWindow, piUpdateFailure);
    const toast = document.querySelector<HTMLElement>("[data-app-toast]")!;
    expect(toast).toHaveTextContent("Could not update Pi");
    // An urgent toast is announced through Base UI's alert region.
    expect(screen.getByRole("alert")).toHaveTextContent("NotFound: ChildProcess.spawn (pi update)");

    postFromFrame(frameWindow, { type: SYNARA_EMBEDDED_NOTIFICATION, operation: "dismiss", id: "pi-update" });
    expect(toast).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification", hidden: true }));
    expect(postMessage).toHaveBeenCalledWith(
      { type: "lattice:embedded-notification-action", id: "pi-update", action: "dismiss" },
      SYNARA_TEST_ORIGIN,
    );
    await waitFor(() => expect(toast).not.toBeInTheDocument());
    expect(screen.queryByText("Could not update Pi")).toBeNull();
    unmount();
  });

  it("draws a loading notification as running work and follows Synara closing it", async () => {
    const { frameWindow, unmount } = mountBridge();
    postFromFrame(frameWindow, { type: SYNARA_EMBEDDED_NOTIFICATION, operation: "upsert", id: "pi-loading", level: "loading", title: "Installing Pi…", detail: "", timeoutMs: 5000 });

    const loading = [...document.querySelectorAll<HTMLElement>("[data-app-toast]")].find((element) => element.textContent?.includes("Installing Pi…"))!;
    expect(loading.querySelector("[role=progressbar]")).not.toHaveAttribute("aria-valuenow");
    // Unlike a finite notification, a running one goes when Synara says it is done.
    postFromFrame(frameWindow, { type: SYNARA_EMBEDDED_NOTIFICATION, operation: "dismiss", id: "pi-loading" });
    await waitFor(() => expect(screen.queryByText("Installing Pi…")).toBeNull());
    unmount();
  });
});
