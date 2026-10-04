import { renderApp, projectCommands } from "./app-test-utils";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

// Its own suite so the first open below is the cold one: App's lazy Settings
// has not loaded in this module graph yet, so it suspends before it mounts.
it("returns focus to the project switcher when Settings, opened from its menu by keyboard, closes on Escape", async () => {
  renderApp(projectCommands());
  const trigger = await screen.findByRole("button", { name: "Switch project" });
  for (const load of ["cold", "warm"]) {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("menuitem")[0]).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    const settingsItem = screen.getByRole("menuitem", { name: "Settings" });
    await waitFor(() => expect(settingsItem).toHaveFocus());
    fireEvent.keyDown(settingsItem, { key: "Enter" });

    const search = await screen.findByRole("searchbox", { name: "Search settings" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger, `${load} load`).toHaveFocus());
  }
});
