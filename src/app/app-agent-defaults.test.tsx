import { chooseProjectMenuItem, findFrame, findSettingsDialog, postWindowMessage, projectCommands, synaraHook } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { settingsDialog } from "./app-test-settings";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { isSynaraSettingsTab, loadSettingsTab, persistSettingsTab } from "../settings/app-settings";

const { renderApp } = appHarness({ settingsDialog });

it("opens Agent defaults as General in the existing agent settings frame", async () => {
  renderApp(projectCommands());
  await chooseProjectMenuItem("Settings");
  await findSettingsDialog(60_000);
  fireEvent.click(screen.getByRole("button", { name: "Agent defaults" }));
  const frame = await findFrame("Synara Agent defaults settings");
  expect(new URL(frame.src).searchParams.get("section")).toBe("general");
  expect(synaraHook.enabledCalls).toContain(true);
  const src = frame.src;
  const posted = vi.spyOn(frame.contentWindow!, "postMessage");
  postWindowMessage(frame.contentWindow, { type: "synara:embed-ready" });
  await waitFor(() => expect(posted).toHaveBeenCalledWith(
    expect.objectContaining({ type: "lattice:set-settings-section", section: "general" }),
    new URL(src).origin,
  ));
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  await waitFor(() => expect(posted).toHaveBeenCalledWith(
    expect.objectContaining({ type: "lattice:set-settings-section", section: "providers" }),
    new URL(src).origin,
  ));
  expect(await findFrame("Synara Providers settings")).toBe(frame);
  expect(frame.src).toBe(src);
}, 60_000);

it("restores Agent defaults as an agent page that starts its runtime", () => {
  persistSettingsTab("agent-defaults");
  expect(loadSettingsTab()).toBe("agent-defaults");
  expect(isSynaraSettingsTab(loadSettingsTab())).toBe(true);
});
