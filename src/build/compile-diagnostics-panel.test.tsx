import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { activateAppLocale } from "../i18n";
import { CompileDiagnosticsPanel } from "./compile-diagnostics-panel";
import { useCompileRepair } from "./use-compile-repair";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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

  it("announces a rejected repair in Chinese and leaves retry available", async () => {
    await activateAppLocale("zh-CN");
    vi.mocked(invoke).mockRejectedValueOnce("The workspace already has an active writer.");
    function RepairPanel() {
      const repair = useCompileRepair({
        projectRoot: "/paper", rootDocument: "main.tex", runtimeMode: "auto", enabled: true,
        save: async () => true, onComplete: async () => {},
      });
      return <CompileDiagnosticsPanel {...props} repair={repair.state} fixDisabled={repair.busy}
        onFixAll={() => void repair.start(diagnostics)} />;
    }
    try {
      render(<RepairPanel />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "全部修正" })); });
      expect(screen.getByRole("status")).toHaveTextContent("修正尚未启动：此项目中有其他 Agent 任务正在运行或等待你的回应。请打开 Agent，完成或停止该任务后，再点击「全部修正」。");
      expect(screen.getByRole("button", { name: "全部修正" })).toBeEnabled();
      expect(screen.queryByText("The workspace already has an active writer.")).not.toBeInTheDocument();
    } finally {
      cleanup();
      await activateAppLocale("en");
      vi.mocked(invoke).mockReset();
    }
  });

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
