import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { DesktopPetSettings } from "./desktop-pet-settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const runtime = vi.hoisted(() => ({ browser: false }));
vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: () => runtime.browser }));
beforeEach(() => { runtime.browser = false; vi.mocked(invoke).mockReset(); vi.mocked(open).mockReset(); });
afterEach(cleanup);

it("does not offer native windows or issue native pet commands from a browser client", () => {
  runtime.browser = true;
  render(<DesktopPetSettings />);
  expect(screen.queryByRole("switch", { name: "Show desktop companion" })).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
});

it("imports a local package, enables it, and reflects native hide without exposing raw file paths", async () => {
  let snapshot = { enabled: false, name: null as string | null };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "desktop_pet_status") return snapshot;
    if (command === "desktop_pet_import") snapshot = { ...snapshot, name: "Angry sample" };
    if (command === "desktop_pet_set_enabled") snapshot = { ...snapshot, enabled: (args as { enabled: boolean }).enabled };
  });
  render(<DesktopPetSettings />);
  expect(await screen.findByRole("switch", { name: "Show desktop companion" })).toBeDisabled();
  vi.mocked(open).mockResolvedValue("/tmp/pet/pet.json");
  fireEvent.click(screen.getByRole("button", { name: "Import pet" }));
  await screen.findByText("Angry sample");
  expect(invoke).toHaveBeenCalledWith("desktop_pet_import", { path: "/tmp/pet/pet.json" });
  const toggle = screen.getByRole("switch", { name: "Show desktop companion" });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(screen.queryByText("/tmp/pet/pet.json")).not.toBeInTheDocument();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
});

it("preserves the old enabled pet when importing fails and permits retry after cancellation", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "desktop_pet_import") throw new Error("The spritesheet must stay inside the pet package folder");
    return { enabled: true, name: "Existing pet" };
  });
  render(<DesktopPetSettings />);
  await screen.findByText("Existing pet");
  vi.mocked(open).mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole("button", { name: "Import pet" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Import pet" })).toBeEnabled());
  expect(invoke).not.toHaveBeenCalledWith("desktop_pet_import", expect.anything());
  vi.mocked(open).mockResolvedValueOnce("/tmp/invalid/pet.json");
  fireEvent.click(screen.getByRole("button", { name: "Import pet" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("inside the pet package"));
  expect(screen.getByRole("switch", { name: "Show desktop companion" })).toBeChecked();
  expect(screen.getByText("Existing pet")).toBeInTheDocument();
});

it("waits for native readiness before checking the switch and keeps a timed-out attempt off until a successful retry", async () => {
  let enabled = false;
  let finish!: () => void;
  let fail!: (reason: Error) => void;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "desktop_pet_status") return { enabled, name: "Existing pet" };
    if (command === "desktop_pet_set_enabled") return new Promise<void>((resolve, reject) => {
      finish = () => { enabled = true; resolve(); }; fail = reject;
    });
  });
  render(<DesktopPetSettings />);
  await screen.findByText("Existing pet");
  const toggle = screen.getByRole("switch", { name: "Show desktop companion" });
  fireEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeDisabled();
  fail(new Error("The desktop companion did not finish loading. Try enabling it again."));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("did not finish loading"));
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeEnabled();
  fireEvent.click(toggle);
  finish();
  await waitFor(() => expect(toggle).toBeChecked());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
