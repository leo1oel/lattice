import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { activateAppLocale } from "../i18n";
import { installPdfTextLayerSelection } from "../pdf/pdf-text-layer-selection";
import { CompileDiagnosticsPanel } from "./compile-diagnostics-panel";
import { useCompileRepair } from "./use-compile-repair";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

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

describe("raw build log", () => {
  afterEach(cleanup);

  // As reported: an rc-file failure leaves only the log, the panel sits above
  // the PDF toolbar and the stale PDF's text layer, and the copied "log" ended
  // "…problem with rc file 1 / 29%000001002Under review as a conference paper".
  const log = [
    "playwright._impl._errors.Error: BrowserType.launch: Executable doesn't exist at /Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "Latexmk: Initialization file './.latexmkrc' gave an error:",
    "     Probe SVG conversion failed",
    "",
    "Latexmk: Stopping because of problem with rc file",
  ].join("\n");

  function renderAbovePdf() {
    // The text layer reports its selection to the native copy monitor.
    vi.mocked(invoke).mockResolvedValue(undefined);
    const view = render(<>
      <CompileDiagnosticsPanel {...props} diagnostics={[]} log={log} expanded />
      <div className="pdf-toolbar"><span className="pdf-page-display">1 / 29</span><span>%</span></div>
      <div className="textLayer"><span>000</span><span>001</span><span>Under review as a conference paper</span></div>
    </>);
    const uninstall = installPdfTextLayerSelection(view.container.querySelector(".textLayer") as HTMLElement);
    return { ...view, uninstall: () => { uninstall(); vi.mocked(invoke).mockReset(); } };
  }

  it("keeps Command-A inside the log instead of reaching the PDF below it", () => {
    const { uninstall } = renderAbovePdf();
    try {
      const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Raw build log" });
      expect(field).toHaveAttribute("readonly");
      expect(field.value).toBe(log);
      field.focus();
      fireEvent.keyDown(field, { key: "a", metaKey: true });
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe(log.length);
      expect(document.getSelection()?.toString() ?? "").not.toMatch(/1 \/ 29|Under review/);
    } finally {
      uninstall();
    }
  });

  it("copies exactly the log", async () => {
    vi.mocked(writeText).mockResolvedValue();
    const { uninstall } = renderAbovePdf();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Copy build log" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(log));
    } finally {
      uninstall();
      vi.mocked(writeText).mockReset();
    }
  });
});
