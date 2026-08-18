import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootErrorFallback } from "./root-error-boundary";

afterEach(cleanup);

describe("RootErrorFallback", () => {
  it("offers recovery actions and keeps technical details collapsed", () => {
    render(
      <RootErrorFallback
        error={new Error("renderer failed")}
        onRestart={vi.fn()}
        onCopyDetails={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveAccessibleName("Lattice couldn’t open this window");
    expect(screen.getByRole("button", { name: "Restart Lattice" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy error details" })).toBeInTheDocument();
    expect(screen.getByText("Technical details").closest("details")).not.toHaveAttribute("open");
  });

  it("restarts and copies the captured error", async () => {
    const onRestart = vi.fn();
    const onCopyDetails = vi.fn().mockResolvedValue(undefined);
    render(
      <RootErrorFallback
        error={new Error("renderer failed")}
        onRestart={onRestart}
        onCopyDetails={onCopyDetails}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restart Lattice" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy error details" }));

    expect(onRestart).toHaveBeenCalledOnce();
    await waitFor(() => expect(onCopyDetails).toHaveBeenCalledWith(expect.stringContaining("renderer failed")));
    expect(await screen.findByRole("button", { name: "Error details copied" })).toBeInTheDocument();
  });

  it("explains how to recover when automatic actions fail", async () => {
    render(
      <RootErrorFallback
        error={new Error("renderer failed")}
        onRestart={vi.fn().mockRejectedValue(new Error("restart denied"))}
        onCopyDetails={vi.fn().mockRejectedValue(new Error("clipboard denied"))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restart Lattice" }));
    expect(await screen.findByText("Lattice couldn’t restart automatically. Quit and reopen it manually.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy error details" }));
    expect(await screen.findByText("Couldn’t copy the details. Expand Technical details and copy them manually.")).toBeInTheDocument();
  });
});
