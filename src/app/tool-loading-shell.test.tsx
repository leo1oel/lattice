import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy, Suspense, useCallback, useState, useTransition, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModalDialog } from "../components/ui/modal-dialog";
import { SettingsLoadingShell, ToolLoadingShell } from "./tool-loading-shell";
import { useLoadingShell } from "./use-loading-shell";

type SettingsProps = { covered: boolean; onClose: () => void };

// The real Settings' hand-off from its shell is App's (`app-settings-shell-focus.test.tsx`).
function SettingsStandIn({ covered, onClose }: SettingsProps) {
  return (
    <ModalDialog label="Settings" covered={covered} onClose={onClose}>
      <input aria-label="Search settings" />
    </ModalDialog>
  );
}

// A fresh chunk per test: a lazy component, once loaded, stays loaded.
let releaseSettings = () => {};
let SettingsDialog: ComponentType<SettingsProps>;

// Settings as App wires it: a transition opens it, the shell follows it.
function Harness() {
  const [open, setOpen] = useState(false);
  const [opening, startOpen] = useTransition();
  const late = useLoadingShell(opening, opening || open);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <textarea aria-label="Document" />
      <button type="button" onClick={() => startOpen(() => setOpen(true))}>open settings</button>
      {late && (
        <SettingsLoadingShell label="Settings" message="Loading settings…" backdrop={!open} onClose={close} />
      )}
      <Suspense fallback={null}>
        {open && <SettingsDialog covered={late} onClose={close} />}
      </Suspense>
    </>
  );
}

const shellCard = () => document.querySelector<HTMLElement>(".tool-loading-shell-card");

async function openFromTheDocument() {
  render(<Harness />);
  const documentField = screen.getByLabelText<HTMLTextAreaElement>("Document");
  documentField.focus();
  fireEvent.click(screen.getByText("open settings"));
  // The click itself does not move focus in jsdom: the document still has it.
  documentField.focus();
  await act(() => vi.advanceTimersByTimeAsync(150));
  return documentField;
}

beforeEach(() => {
  vi.useFakeTimers();
  SettingsDialog = lazy(() => new Promise<{ default: ComponentType<SettingsProps> }>((resolve) => {
    releaseSettings = () => resolve({ default: SettingsStandIn });
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("closes Settings' loading card on Escape and withdraws the pending open", async () => {
  await openFromTheDocument();
  expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  await act(async () => releaseSettings());
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.queryByLabelText("Search settings")).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
});

it("holds the keyboard in Settings' loading card and gives focus back when it is closed", async () => {
  const documentField = await openFromTheDocument();
  const card = shellCard()!;
  // Keys go to the card, not to the document it covers, and Tab cannot leave it.
  expect(document.activeElement).toBe(card);
  expect(card.getAttribute("aria-modal")).toBe("true");
  expect(fireEvent.keyDown(card, { key: "Tab" })).toBe(false);
  expect(fireEvent.keyDown(card, { key: "Tab", shiftKey: true })).toBe(false);
  fireEvent.keyDown(document, { key: "Escape" });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(shellCard()).toBeNull();
  expect(document.activeElement).toBe(documentField);
});

it("says what each loading shell is loading, in a polite live region", async () => {
  await openFromTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(16));
  expect(screen.getByRole("status").textContent).toBe("Loading settings…");
  expect(screen.getByRole("status").closest("[aria-busy='true']")).toBeNull();
  cleanup();

  render(<ToolLoadingShell className="project-history-drawer" label="Project history" message="Loading project history…" onClose={() => {}} />);
  await act(() => vi.advanceTimersByTimeAsync(16));
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Loading project history…");
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(status.closest("[aria-busy='true']")).toBeNull();
  expect(screen.getByRole("complementary", { name: "Project history" }).contains(status)).toBe(true);
});
