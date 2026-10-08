import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { activateAppLocale } from "../i18n";
import { installPdfTextLayerSelection } from "../pdf/pdf-text-layer-selection";
import { CompileDiagnosticsPanel } from "./compile-diagnostics-panel";
import { failedLogAnchor } from "./compile-diagnostics";
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
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "一键修复" })); });
      expect(screen.getByRole("status")).toHaveTextContent("AI 助手正忙，请先结束它的任务再点“一键修复”");
      expect(screen.getByRole("button", { name: "一键修复" })).toBeEnabled();
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
    const uninstall = installPdfTextLayerSelection(view.container.querySelector(".textLayer") as HTMLElement, view.container);
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
});

describe("build output layout", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("groups messages under their file and keeps each location in the button's name", () => {
    const onSelect = vi.fn();
    render(<CompileDiagnosticsPanel {...props} expanded onSelect={onSelect} diagnostics={[
      { level: "warning", message: "Overfull hbox", file: "chapters/ch01.tex", line: 12 },
      { level: "error", message: "Undefined control sequence", file: "chapters/ch01.tex", line: 40 },
      { level: "warning", message: "There were undefined references.", file: "main.tex", line: 4 },
    ]} />);
    const groups = document.querySelectorAll(".compile-diagnostics-group");
    expect([...groups].map((group) => group.querySelector(".compile-diagnostics-file")?.textContent))
      .toEqual(["chapters/ch01.tex2", "main.tex"]);
    expect(within(groups[0] as HTMLElement).getAllByRole("button", { name: /^chapters\/ch01\.tex:/ }).map((button) => button.getAttribute("aria-label")))
      .toEqual(["chapters/ch01.tex:40 Undefined control sequence", "chapters/ch01.tex:12 Overfull hbox"]);
    fireEvent.click(screen.getByRole("button", { name: "main.tex:4 There were undefined references." }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ file: "main.tex", line: 4 }));
  });

  it("opens a failed build's log at TeX's error, with the whole log a click from the clipboard", () => {
    // Lines as latexmk -file-line-error writes them.
    const failedLog = "This is pdfTeX\n(./main.tex\nLaTeX Warning: Reference undefined\n./main.tex:4: Undefined control sequence.\nl.4 \\undefinedmacro\n"
      + "./main.tex:4:  ==> Fatal error occurred, no output PDF file produced!\nLatexmk: Errors, so I did not complete making targets";
    expect(failedLogAnchor(failedLog)).toBe(failedLog.indexOf("./main.tex:4: Undefined"));
    expect(failedLogAnchor("(./main.tex\n! LaTeX Error: File `doesnotexist.sty' not found.\n./main.tex:3: Emergency stop.")).toBe(12);
    expect(failedLogAnchor("(./main.tex\nPackage biblatex Error: Missing backend")).toBe(12);
    // Without an error line, latexmk's own ending says why the run stopped.
    expect(failedLogAnchor("(./main.tex\nLatexmk: Errors, so I did not complete making targets")).toBe(65);

    render(<CompileDiagnosticsPanel {...props} expanded log={failedLog} />);
    fireEvent.click(screen.getByRole("tab", { name: "Log" }));
    expect(screen.getByRole("textbox", { name: "Raw build log" })).toHaveValue(failedLog);
    expect(screen.getByRole("button", { name: "Copy the whole build log" })).toHaveTextContent("Copy log");
    fireEvent.click(screen.getByRole("tab", { name: "Messages" }));
    expect(screen.queryByRole("button", { name: "Copy the whole build log" })).not.toBeInTheDocument();
  });

  it("docks below the page and remembers the choice for the next build", () => {
    const { unmount } = render(<CompileDiagnosticsPanel {...props} expanded />);
    const section = screen.getByRole("region", { name: "Compile diagnostics" });
    expect(section).not.toHaveClass("docked");
    fireEvent.click(screen.getByRole("button", { name: "Dock below the page" }));
    expect(section).toHaveClass("docked");
    unmount();

    render(<CompileDiagnosticsPanel {...props} />);
    expect(screen.getByRole("region", { name: "Compile diagnostics" })).toHaveClass("docked");
    fireEvent.click(screen.getByRole("button", { name: "Float over the page" }));
    expect(screen.getByRole("region", { name: "Compile diagnostics" })).not.toHaveClass("docked");
    // Dismissal stays available in either placement.
    expect(screen.getByRole("button", { name: "Dismiss diagnostics" })).toBeEnabled();
  });
});

