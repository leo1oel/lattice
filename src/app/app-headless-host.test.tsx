// The harness's module mocks register as it loads: import it before anything it mocks.
import { browserRuntime, projectCommands, projectSnapshot } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { markHeadlessHost } from "../platform/headless-host";

const { renderApp } = appHarness();

/** A file of its own: being a headless host's tab is page-lifetime state. */
it("offers no way back to a Lattice app in a headless host's tab, from the toolbar or the palette", async () => {
  browserRuntime.hosted = true;
  markHeadlessHost();
  renderApp({ ...projectCommands(projectSnapshot({ files: [] })), return_to_desktop: null });
  await screen.findByRole("button", { name: "Switch project" });
  expect(screen.queryByRole("button", { name: "Open in Lattice app" })).toBeNull();
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
  fireEvent.change(await screen.findByRole("searchbox", { name: "Command palette" }), { target: { value: "Open in Lattice" } });
  expect(screen.queryByRole("option", { name: /Open in Lattice app/ })).toBeNull();
});
