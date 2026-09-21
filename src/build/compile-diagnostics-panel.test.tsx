import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompileDiagnosticsPanel } from "./compile-diagnostics-panel";

const diagnostics = [
  { level: "error", message: "Undefined control sequence", file: "main.tex", line: 42 },
  { level: "warning", message: "Undefined reference", file: "results.tex", line: 17 },
];
const props = {
  diagnostics, log: "Build output", success: false, expanded: false,
  onExpandedChange: vi.fn(), onSelect: vi.fn(), onInstallDependency: vi.fn(), onDismiss: vi.fn(),
};

describe("batch repair controls", () => {
  afterEach(cleanup);

  it("offers one repair action even when collapsed and replaces it in-place while busy", () => {
    const onFixAll = vi.fn();
    const onCancelRepair = vi.fn();
    const onOpenRepair = vi.fn();
    const { rerender } = render(<CompileDiagnosticsPanel {...props} onFixAll={onFixAll} />);
    fireEvent.click(screen.getByRole("button", { name: "Fix all" }));
    expect(onFixAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Fix" })).not.toBeInTheDocument();
    rerender(<CompileDiagnosticsPanel {...props} onFixAll={onFixAll} onCancelRepair={onCancelRepair}
      onOpenRepair={onOpenRepair} repair={{ status: "running", threadId: "repair" }} />);
    expect(screen.queryByRole("button", { name: "Fix all" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Repairing…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel repair" }));
    fireEvent.click(screen.getByRole("button", { name: "View repair" }));
    expect(onCancelRepair).toHaveBeenCalledTimes(1);
    expect(onOpenRepair).toHaveBeenCalledTimes(1);
    rerender(<CompileDiagnosticsPanel {...props} onFixAll={onFixAll} onCancelRepair={onCancelRepair}
      repair={{ status: "compiling", threadId: "repair" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Recompiling…");
    expect(screen.queryByRole("button", { name: "Cancel repair" })).not.toBeInTheDocument();
  });

  it("keeps approval and error details accessible, and respects write restrictions", () => {
    const { rerender } = render(<CompileDiagnosticsPanel {...props} onFixAll={vi.fn()} fixDisabled />);
    expect(screen.getByRole("button", { name: "Fix all" })).toBeDisabled();
    rerender(<CompileDiagnosticsPanel {...props} repair={{ status: "awaiting-approval", threadId: "task" }} onOpenRepair={vi.fn()} />);
    expect(screen.getByText("Open the repair task to continue.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View repair" })).toBeEnabled();
    rerender(<CompileDiagnosticsPanel {...props} repair={{ status: "failed", message: "No diagnostics were submitted." }} />);
    expect(screen.getByRole("status")).toHaveTextContent("No diagnostics were submitted.");
    rerender(<CompileDiagnosticsPanel {...props} diagnostics={[{ level: "info", message: "Note" }]} onFixAll={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Fix all" })).not.toBeInTheDocument();
  });
});
