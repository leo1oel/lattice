import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TexDependencyInstaller, type TexDependencyInstallStatus } from "./tex-dependency-installer";

function renderInstaller(status: Omit<TexDependencyInstallStatus, "missingFile">) {
  const onClose = vi.fn();
  const onRetry = vi.fn();
  render(<TexDependencyInstaller status={{ missingFile: "newtxmath.sty", ...status }} onClose={onClose} onRetry={onRetry} />);
  return { onClose, onRetry };
}

describe("TexDependencyInstaller", () => {
  it("shows native package installation progress without a Terminal handoff", () => {
    renderInstaller({ progress: { stage: "installing-dependency", progress: 0.64 }, installing: true, error: null });

    expect(screen.getByText(/newtxmath\.sty/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "LaTeX package installation progress" }))
      .toHaveAttribute("aria-valuenow", "64");
    expect(document.querySelector(".tex-setup-progress-fill")).toHaveStyle({ width: "64%" });
    expect(screen.queryByText(/Terminal/)).not.toBeInTheDocument();
  });

  it("allows a failed installation to be retried or closed", () => {
    const { onClose, onRetry } = renderInstaller({
      progress: { stage: "searching-packages", progress: 0.02 },
      installing: false,
      error: "The TeX Live repository could not be searched.",
    });

    expect(screen.getByRole("alert")).toHaveTextContent("repository could not be searched");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledWith("newtxmath.sty");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
