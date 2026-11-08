import { chooseProjectMenuItem, findSettingsDialog, projectCommands } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { settingsDialog } from "./app-test-settings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { renderApp } = appHarness({ settingsDialog });

// The user agents of the windows Lattice ships in: WebKitGTK in the Linux
// AppImage, WKWebView on macOS. An Android browser, which opens only the web
// demo, also names Linux.
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const MACOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

const userAgents: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const userAgent of userAgents.splice(0)) userAgent.mockRestore();
});

async function openAppUpdates(userAgent: string) {
  userAgents.push(vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent));
  renderApp(projectCommands());
  await chooseProjectMenuItem("Settings");
  await findSettingsDialog();
  fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
}

// Linux releases carry no updater archive and latest.json has no Linux entry
// (docs/release-process.md): a check there could only fail.
it("on Linux, says Lattice updates by hand and links to the releases instead of offering a check", async () => {
  await openAppUpdates(LINUX);
  expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
  expect(screen.queryByText("Automatic updates")).not.toBeInTheDocument();
  expect(screen.getByText("Lattice on Linux doesn’t update itself. Download new versions from GitHub Releases.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "GitHub Releases" }));
  expect(openUrl).toHaveBeenCalledWith("https://github.com/leo1oel/lattice/releases/latest");
});

it.each([["macOS", MACOS], ["Android", ANDROID]])("on %s, offers the update mode and Check for updates", async (_, userAgent) => {
  await openAppUpdates(userAgent);
  expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
  expect(screen.getByText("Automatic updates")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "GitHub Releases" })).not.toBeInTheDocument();
});


it("on Windows, links to official releases without enabling the macOS updater", async () => {
  await openAppUpdates("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36");
  expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "GitHub Releases" }));
  expect(openUrl).toHaveBeenCalledWith("https://github.com/leo1oel/lattice/releases/latest");
});
