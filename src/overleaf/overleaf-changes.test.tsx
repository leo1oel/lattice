import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverleafChangesPanel } from "./overleaf-changes";
import type { TrackedChange } from "./use-overleaf-realtime";

const SOURCE = "The quick brown fox jumps over the lazy dog";

const change = (overrides: Partial<TrackedChange> = {}): TrackedChange => ({
  id: "c1", position: 4, text: "quick", deletion: false, userId: "user-1", timestamp: "2026-07-01T10:00:00.000Z", hue: 200, ...overrides,
});

const resolves = () => vi.fn().mockResolvedValue(undefined);
const panel = (overrides: Partial<Parameters<typeof OverleafChangesPanel>[0]> = {}) => (
  <OverleafChangesPanel
    changes={[change()]} source={SOURCE} authorName={() => "Ada Lovelace"} documentOpen canAct busy={null} error={null}
    onAccept={resolves()} onReject={resolves()} onReveal={vi.fn()} {...overrides}
  />
);

describe("Overleaf changes panel", () => {
  beforeEach(cleanup);

  it("quotes the suggestion in context and reveals it when clicked", () => {
    const onReveal = vi.fn();
    render(panel({ onReveal }));
    expect(screen.getByText("quick")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("suggests inserting")).toBeInTheDocument();
    fireEvent.click(screen.getByText("quick"));
    expect(onReveal).toHaveBeenCalledWith(4);
  });

  it("accepts and rejects one suggestion through its own row", async () => {
    const onAccept = resolves();
    const onReject = resolves();
    render(panel({ onAccept, onReject }));

    fireEvent.click(screen.getByRole("button", { name: /Accept$/ }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith(["c1"]));

    fireEvent.click(screen.getByRole("button", { name: /Reject$/ }));
    await waitFor(() => expect(onReject).toHaveBeenCalledWith([change()]));
  });

  it("sends every id in a single call when accepting all", async () => {
    const onAccept = resolves();
    const changes = [change({ id: "a" }), change({ id: "b", position: 20, text: "lazy" })];
    render(panel({ changes, onAccept }));

    fireEvent.click(screen.getByRole("button", { name: /Accept all/ }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
    expect(onAccept).toHaveBeenCalledWith(["a", "b"]);
  });

  it.each([
    ["this account cannot act", { canAct: false }],
    ["the document is not open, even if the account otherwise could", { documentOpen: false }],
  ])("disables accept and reject when %s", (_label, overrides) => {
    render(panel(overrides));
    expect(screen.getByRole("button", { name: /Accept$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Reject$/ })).toBeDisabled();
  });
});
