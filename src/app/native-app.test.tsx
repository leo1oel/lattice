import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The backend is the seam: every command the offer reaches goes through
 * `invoke`, answered here per command name, and the install's channel is
 * the one the dialog hands over.
 */
const backend = vi.hoisted(() => ({
  answers: new Map<string, (args: Record<string, unknown>) => unknown>(),
  calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    backend.calls.push({ command, args });
    const answer = backend.answers.get(command);
    if (!answer) throw new Error(`Command ${command} not found`);
    return answer(args);
  }),
  Channel: class<T> {
    onmessage: (message: T) => void = () => {};
  },
}));

import { NativeAppDialog } from "./native-app-dialog";
import { declineNativeApp, loadNativeOfferRecord, shouldAutoOfferNativeApp } from "./native-app";
import { NativeAppOffer } from "./native-app-offer";

const OFFER_KEY = "lattice.native-app-offer.v1";
const LAST_RUN_KEY = "lattice.last-run-version.v1";
const RELEASE = { version: "0.19.0", rid: 7 };

const called = (command: string) => backend.calls.filter((call) => call.command === command);

beforeEach(() => {
  backend.answers.clear();
  backend.calls.length = 0;
  backend.answers.set("plugin:resources|close", () => null);
  backend.answers.set("restart_impact", () => ({ terminalCommands: 0, builds: 0, agentTurns: 0 }));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("when the native app is offered by itself", () => {
  it("offers once on the first launch after an update to 0.19.0 or later", () => {
    expect(shouldAutoOfferNativeApp("0.18.4", "0.19.0", {})).toBe(true);
    expect(shouldAutoOfferNativeApp("0.19.0", "0.20.1", {})).toBe(true);
    // Not an update launch: a fresh install, or the same version again.
    expect(shouldAutoOfferNativeApp(null, "0.19.0", {})).toBe(false);
    // Releases before the native app have nothing to offer.
    expect(shouldAutoOfferNativeApp("0.18.3", "0.18.4", {})).toBe(false);
  });

  it("asks again after Not now only once a later update arrives", () => {
    declineNativeApp("later", "0.19.0");
    expect(loadNativeOfferRecord()).toEqual({ declinedAt: "0.19.0" });
    expect(shouldAutoOfferNativeApp("0.18.4", "0.19.0", loadNativeOfferRecord())).toBe(false);
    expect(shouldAutoOfferNativeApp("0.19.0", "0.19.1", loadNativeOfferRecord())).toBe(true);
  });

  it("never asks again after Don't ask again, or once the writer switched", () => {
    declineNativeApp("never", "0.19.0");
    expect(shouldAutoOfferNativeApp("0.19.0", "0.25.0", loadNativeOfferRecord())).toBe(false);
    localStorage.setItem(OFFER_KEY, JSON.stringify({ stop: "switched" }));
    expect(shouldAutoOfferNativeApp("0.19.0", "0.25.0", loadNativeOfferRecord())).toBe(false);
    // A record nobody could have written is no answer.
    localStorage.setItem(OFFER_KEY, "{not json");
    expect(loadNativeOfferRecord()).toEqual({});
  });

  it("waits for What's new to close, and offers only what the check found", async () => {
    localStorage.setItem(LAST_RUN_KEY, "0.18.0");
    backend.answers.set("check_native_app", () => RELEASE);
    const { rerender } = render(<NativeAppOffer whatsNewOpen />);
    await waitFor(() => expect(called("check_native_app")).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<NativeAppOffer whatsNewOpen={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loadNativeOfferRecord().declinedAt).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("the native app offer", () => {
  it("records Not now at the running version and Don't ask again for good", () => {
    const onClose = vi.fn();
    render(<NativeAppDialog release={RELEASE} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(loadNativeOfferRecord().declinedAt).toMatch(/^\d+\.\d+\.\d+$/);
    cleanup();
    render(<NativeAppDialog release={RELEASE} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Don’t ask again" }));
    expect(loadNativeOfferRecord().stop).toBe("never");
    // The release a closed offer held is let go.
    expect(called("plugin:resources|close").map((call) => call.args)).toContainEqual({ rid: 7 });
  });

  it("installs the native release under its own claim, then restarts into it", async () => {
    backend.answers.set("claim_update_install", () => "claimed");
    backend.answers.set("install_update", (args) => {
      const channel = args.onEvent as { onmessage: (event: unknown) => void };
      channel.onmessage({ event: "Started", data: { contentLength: 100 } });
      channel.onmessage({ event: "Progress", data: { chunkLength: 100 } });
      channel.onmessage({ event: "Finished" });
      return null;
    });
    backend.answers.set("restart_lattice", () => null);
    render(<NativeAppDialog release={RELEASE} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch now" }));
    await waitFor(() => expect(called("restart_lattice")).toHaveLength(1));
    // Never the same claim as a classic update to 0.19.0.
    expect(called("claim_update_install")[0]?.args).toEqual({ version: "native 0.19.0" });
    expect(called("install_update")[0]?.args).toMatchObject({ version: "native 0.19.0", rid: 7 });
    expect(loadNativeOfferRecord().stop).toBe("switched");
  });

  it("warns about running work before switching, as a restart does", async () => {
    backend.answers.set("restart_impact", () => ({ terminalCommands: 0, builds: 2, agentTurns: 0 }));
    backend.answers.set("claim_update_install", () => "installed");
    backend.answers.set("restart_lattice", () => null);
    render(<NativeAppDialog release={RELEASE} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch now" }));
    expect(await screen.findByText(/Switching restarts Lattice and stops 2 compiles/)).toBeTruthy();
    expect(called("claim_update_install")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Switch anyway" }));
    await waitFor(() => expect(called("restart_lattice")).toHaveLength(1));
    // Already installed by another window: nothing downloads twice.
    expect(called("install_update")).toHaveLength(0);
  });

  it("says another window is installing instead of installing alongside", async () => {
    backend.answers.set("claim_update_install", () => "busy");
    render(<NativeAppDialog release={RELEASE} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch now" }));
    expect(await screen.findByText(/Another Lattice window is installing an update/)).toBeTruthy();
    expect(called("install_update")).toHaveLength(0);
  });

  it("checks for the release itself when opened from Settings", async () => {
    let found: typeof RELEASE | null = null;
    backend.answers.set("check_native_app", () => found);
    render(<NativeAppDialog release={null} onClose={() => {}} />);
    expect(await screen.findByText(/isn’t available right now/)).toBeTruthy();
    found = RELEASE;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Switch now" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
