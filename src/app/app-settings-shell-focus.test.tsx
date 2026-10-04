import { renderApp, projectCommands } from "./app-test-utils";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

// Settings' chunk is held back until `release`, so it opens behind its loading
// shell; the module is still the real Settings.
const settingsChunk = vi.hoisted(() => {
  let release = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release: () => release() };
});
vi.mock("../settings/settings-dialog", async (importOriginal) => {
  const actual = await importOriginal();
  await settingsChunk.ready;
  return actual;
});

// Transformed ahead, so the released chunk arrives inside the card's minimum time.
beforeAll(async () => { await vi.importActual("../settings/settings-dialog"); });

const shellCard = () => document.querySelector<HTMLElement>(".tool-loading-shell-card");

async function openSettingsFromProjectMenu() {
  const trigger = await screen.findByRole("button", { name: "Switch project" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  await waitFor(() => expect(screen.getAllByRole("menuitem")[0]).toHaveFocus());
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  const settingsItem = screen.getByRole("menuitem", { name: "Settings" });
  await waitFor(() => expect(settingsItem).toHaveFocus());
  fireEvent.keyDown(settingsItem, { key: "Enter" });
  await waitFor(() => expect(shellCard()).not.toBeNull());
  await waitFor(() => expect(shellCard()).toHaveFocus());
  return trigger;
}

// Both tests run before the chunk is released: the first, by cancelling, never sees it.
it("returns focus to the project switcher when Settings' loading card, opened from its menu, closes on Escape", async () => {
  renderApp(projectCommands());
  const trigger = await openSettingsFromProjectMenu();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(shellCard()).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("hands focus to the real Settings only once its loading card has gone, and back to the project switcher after", async () => {
  renderApp(projectCommands());
  const trigger = await openSettingsFromProjectMenu();
  const focusedUnderCard: Element[] = [];
  const onFocusIn = (event: FocusEvent) => {
    if (shellCard() && event.target !== shellCard()) focusedUnderCard.push(event.target as Element);
  };
  document.addEventListener("focusin", onFocusIn);
  settingsChunk.release();
  const search = await screen.findByRole("searchbox", { name: "Search settings", hidden: true });
  // Settings is in, under the card for the rest of the card's minimum time.
  expect(shellCard()).not.toBeNull();
  expect(search.closest("[inert]")).not.toBeNull();
  await waitFor(() => expect(shellCard()).toBeNull());
  expect(search.closest("[inert]")).toBeNull();
  await waitFor(() => expect(search).toHaveFocus());
  document.removeEventListener("focusin", onFocusIn);
  expect(focusedUnderCard).toEqual([]);
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
});
