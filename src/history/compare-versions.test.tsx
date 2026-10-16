import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryDrawer } from "./history-drawer";
import { clearAppLogs, formatAppLogs } from "../telemetry/app-log-store";
import type { GitLogEntry } from "../app-types";
import { invokeCalls, mockInvoke, mockListen, type CommandTable } from "../platform/tauri-test-mocks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

const entry = (hash: string, message: string, day: number): GitLogEntry => ({
  hash, shortHash: hash.slice(0, 7), authorName: "Mina Park", timestamp: `2026-06-${String(day).padStart(2, "0")}T10:00:00Z`, message,
  files: [{ path: "main.tex", kind: "modified" }],
});

/** Newest first, as git lists them: a named version, an automatic one, the submission. */
const versions = [
  entry("a".repeat(40), "Rebuttal draft", 20),
  entry("b".repeat(40), "Auto-saved version", 10),
  entry("c".repeat(40), "Submitted to NeurIPS", 2),
];

const before = "\\section{Introduction}\nAdditive attention let a decoder look at encoder states.\n\n\\section{Method}\nAttention maps explain predictions.\n";
const after = "\\section{Introduction}\nAdditive attention let a decoder retrieve different encoder states.\n\n\\section{Method}\nAttention maps describe routing weights.\n";

function mockRepository(extra: CommandTable = {}) {
  mockInvoke({
    git_status: { available: true, repository: true, branch: "main", files: [] },
    git_log: versions,
    git_compare_files: [{ path: "main.tex", kind: "modified" }, { path: "refs.bib", kind: "modified" }],
    git_compare_file: ({ path }: Record<string, unknown>) => (path === "main.tex"
      ? { before, after, binary: false }
      : { before: "@article{a}\n", after: "@article{b}\n", binary: false }),
    ...extra,
  });
}

function renderCompare(onOpenFile = vi.fn()) {
  render(
    <HistoryDrawer
      history={[]}
      onClose={() => undefined}
      onRevert={() => undefined}
      onDelete={() => undefined}
      onOpenFile={onOpenFile}
      overleafProjectRoot="/papers/attention"
      rootDocument="main.tex"
    />,
  );
}

async function openCompare() {
  fireEvent.click(await screen.findByRole("button", { name: "Compare…" }));
  return screen.getByRole("table", { name: "Versions to compare" });
}

afterEach(() => {
  cleanup();
  clearAppLogs();
  vi.resetAllMocks();
});

describe("CompareVersions", () => {
  it("picks from the version list itself, never a reversed range, and folds automatic versions away", async () => {
    mockRepository();
    renderCompare();
    const picker = await openCompare();

    // Now, then the versions someone named; the automatic one waits behind a switch.
    const rows = within(picker).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.querySelector("b")?.textContent)).toEqual(["Now", "Rebuttal draft", "Submitted to NeurIPS"]);
    // Defaults: the newest named version to now.
    expect(screen.getByRole("radio", { name: "From Rebuttal draft" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "To Now" })).toBeChecked();
    // Now can never be the older side, and To can never sit below From.
    expect(screen.getByRole("radio", { name: "From Now" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "To Submitted to NeurIPS" })).toBeDisabled();
    await waitFor(() => expect(invokeCalls("git_compare_files")).toEqual([{ from: "a".repeat(40), to: null }]));

    fireEvent.click(screen.getByRole("radio", { name: "From Submitted to NeurIPS" }));
    await waitFor(() => expect(invokeCalls("git_compare_files").at(-1)).toEqual({ from: "c".repeat(40), to: null }));
    expect(screen.getByRole("radio", { name: "To Rebuttal draft" })).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: "To Rebuttal draft" }));
    await waitFor(() => expect(invokeCalls("git_compare_files").at(-1)).toEqual({ from: "c".repeat(40), to: "a".repeat(40) }));
    expect(rows[1]).toHaveAttribute("data-in-range");
    expect(rows[0]).not.toHaveAttribute("data-in-range");

    fireEvent.click(screen.getByRole("button", { name: "Show 1 automatic versions" }));
    expect(within(picker).getByText("Auto-saved version")).toBeInTheDocument();
  });

  it("reaches a named version older than the first page of the log", async () => {
    const submitted = entry("d".repeat(40), "Submitted to NeurIPS", 1);
    const history = [
      entry("a".repeat(40), "Rebuttal draft", 20),
      ...Array.from({ length: 150 }, (_, index) => entry(String(index).padStart(40, "0"), "Auto-saved version", 10)),
      submitted,
    ];
    mockRepository({ git_log: ({ limit }: Record<string, unknown>) => history.slice(0, limit as number) });
    renderCompare();
    await openCompare();
    expect(screen.queryByRole("radio", { name: "From Submitted to NeurIPS" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load older versions" }));
    fireEvent.click(await screen.findByRole("radio", { name: "From Submitted to NeurIPS" }));
    await waitFor(() => expect(invokeCalls("git_compare_files").at(-1)).toEqual({ from: submitted.hash, to: null }));
    expect(screen.queryByRole("button", { name: "Load older versions" })).not.toBeInTheDocument();
  });

  it("keeps a picked version picked when later reads of the log leave it out", async () => {
    const submitted = entry("d".repeat(40), "Submitted to NeurIPS", 1);
    const history = [
      entry("a".repeat(40), "Rebuttal draft", 20),
      ...Array.from({ length: 98 }, (_, index) => entry(String(index).padStart(40, "0"), "Auto-saved version", 10)),
      submitted,
      entry("f".repeat(40), "Initialize version tracking", 1),
    ];
    let compare: (args: Record<string, unknown>) => unknown = () => [{ path: "main.tex", kind: "modified" }];
    mockRepository({
      git_log: ({ limit }: Record<string, unknown>) => history.slice(0, limit as number),
      git_compare_files: (args: Record<string, unknown>) => compare(args),
    });
    const emit = mockListen();
    renderCompare();
    await openCompare();
    fireEvent.click(screen.getByRole("radio", { name: "From Submitted to NeurIPS" }));
    await waitFor(() => expect(invokeCalls("git_compare_files").at(-1)).toEqual({ from: submitted.hash, to: null }));

    // A version saved on top pushes it out of the page read.
    history.unshift(entry("e".repeat(40), "Camera-ready draft", 21));
    emit({ root: "/papers/attention", paths: ["main.tex"] });
    expect(await screen.findByText("Camera-ready draft")).toBeInTheDocument();
    expect(invokeCalls("git_log").at(-1)).toEqual({ limit: 100 });
    expect(screen.getByRole("radio", { name: "From Submitted to NeurIPS" })).toBeChecked();
    expect(invokeCalls("git_compare_files").at(-1)).toEqual({ from: submitted.hash, to: null });

    // Gone from history altogether (an amend or a reset): said, not swapped for another version.
    history.splice(0, history.length, ...Array.from({ length: 150 }, (_, index) => entry(`b${String(index).padStart(39, "0")}`, "Auto-saved version", 22)));
    compare = () => Promise.reject(new Error("Unknown version dddddddd"));
    emit({ root: "/papers/attention", paths: ["main.tex"] });
    expect(await screen.findByText("Unknown version dddddddd")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "From Submitted to NeurIPS" })).toBeChecked();
    expect(invokeCalls("git_compare_files").slice(1).every((call) => call.from === submitted.hash)).toBe(true);
  });

  it("reads the root document's changes as prose with counts, sections and a stepper, or as source", async () => {
    mockRepository();
    const onOpenFile = vi.fn();
    renderCompare(onOpenFile);
    await openCompare();

    expect(await screen.findByText("2 changed paragraphs")).toBeInTheDocument();
    expect(screen.getByText("+5")).toBeInTheDocument();
    expect(screen.getByText("−4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "main.tex" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "§1 Introduction · Line 2" })).toBeInTheDocument();
    expect(document.querySelector(".compare-passage del")?.textContent).toBe("look at");
    expect(document.querySelector(".compare-passage ins")?.textContent).toBe("retrieve different");

    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "§2 Method · Line 5" }));
    expect(onOpenFile).toHaveBeenCalledWith("main.tex", 5);

    fireEvent.click(screen.getByRole("button", { name: "refs.bib" }));
    await waitFor(() => expect(invokeCalls("git_compare_file").at(-1)).toMatchObject({ path: "refs.bib", to: null }));
  });

  it("reads Now again in place when the project's sources change", async () => {
    let current = after;
    mockRepository({ git_compare_file: () => ({ before, after: current, binary: false }) });
    const emit = mockListen();
    renderCompare();
    await openCompare();
    expect(await screen.findByText("2 changed paragraphs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();

    // A version commit or a build touches nothing the comparison reads.
    emit({ root: "/papers/attention", paths: [".git/index", "main.aux", "main.pdf", "main.synctex.gz"] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(invokeCalls("git_compare_files")).toHaveLength(1);

    // A figure PDF is a source; reading again keeps the place in the changes.
    emit({ root: "/papers/attention", paths: ["figures/attn.pdf"] });
    await waitFor(() => expect(invokeCalls("git_compare_files")).toHaveLength(2));
    expect(screen.queryByText("Comparing…")).not.toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();

    current = after.replace("retrieve different", "look at");
    emit({ root: "/papers/attention", paths: ["main.tex"] });
    expect(await screen.findByText("1 changed paragraph")).toBeInTheDocument();
    expect(screen.queryByText("Loading diff…")).not.toBeInTheDocument();
  });

  it("exports the PDF with the chosen marks and says where it went", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockRepository({ export_changes_pdf: () => new Promise((resolve) => { finish = resolve; }) });
    renderCompare();
    await openCompare();
    await screen.findByText("2 changed paragraphs");

    fireEvent.click(screen.getByRole("button", { name: "Export PDF with changes…" }));
    const sheet = screen.getByRole("dialog", { name: "Export PDF with changes marked" });
    expect(within(sheet).getByText("Saved as main-changes.pdf beside main.pdf.", { exact: false })).toBeInTheDocument();
    // The preview draws the comparison's own first change.
    await waitFor(() => expect(sheet.querySelector(".export-changes-page ins")?.textContent).toBe("retrieve different"));
    fireEvent.click(within(sheet).getByRole("tab", { name: "Underline only" }));
    fireEvent.click(within(sheet).getByRole("switch", { name: "Only pages with changes" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Export PDF" }));

    expect(await within(sheet).findByRole("button", { name: "Exporting…" })).toBeDisabled();
    expect(invokeCalls("export_changes_pdf")).toEqual([{
      projectRoot: "/papers/attention",
      from: "a".repeat(40),
      to: null,
      options: { colour: false, keepDeleted: true, marginBars: true, onlyChangedPages: true },
    }]);
    finish({ path: "main-changes.pdf", simplified: false });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(formatAppLogs()).toContain("Saved main-changes.pdf");
  });

  it("numbers the preview's citations on through every passage", async () => {
    const cited = before
      .replace("look at", "look at~\\cite{bahdanau2015}")
      .replace("explain predictions", "explain predictions~\\cite{jain2019}");
    const edited = after
      .replace("retrieve different", "retrieve different~\\cite{bahdanau2015}")
      .replace("describe routing weights", "describe routing weights~\\cite{jain2019}");
    mockRepository({ git_compare_file: () => ({ before: cited, after: edited, binary: false }) });
    renderCompare();
    await openCompare();
    await screen.findByText("2 changed paragraphs");
    fireEvent.click(screen.getByRole("button", { name: "Export PDF with changes…" }));
    const sheet = screen.getByRole("dialog", { name: "Export PDF with changes marked" });
    await waitFor(() => expect(sheet.querySelectorAll(".export-changes-page p")).toHaveLength(2));
    const pages = [...sheet.querySelectorAll(".export-changes-page p")].map((page) => page.textContent);
    expect(pages[0]).toContain("[1]");
    expect(pages[1]).toContain("[2]");
  });

  it("keeps the sheet open with the reason when the export fails", async () => {
    mockRepository({ export_changes_pdf: () => Promise.reject(new Error("The PDF with changes marked did not build: Undefined control sequence.")) });
    renderCompare();
    await openCompare();
    fireEvent.click(await screen.findByRole("button", { name: "Export PDF with changes…" }));
    const sheet = screen.getByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Export PDF" }));
    expect(await within(sheet).findByText("The PDF with changes marked did not build: Undefined control sequence.")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Export PDF" })).toBeEnabled();
  });
});
