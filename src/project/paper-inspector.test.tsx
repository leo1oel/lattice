import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary } from "../app-types";
import { PaperInspector } from "./paper-inspector";
import type { SymbolOccurrence } from "./references-panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(cleanup);

const paper: PaperSummary = { arxivId: "", title: "Sparse bounds", citationKey: "smith", hasFullText: false, hasBlog: false };
const MAIN = "\\section{A}\nAs shown \\citep[p.~5]{smith}.";

it("shows the page each use cites in a project with no citation reasons", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => (
    command === "read_project_file" && (args as { path: string }).path === "main.tex" ? MAIN : null
  ));
  const usages: SymbolOccurrence[] = [{ kind: "citation", symbol: "smith", role: "reference", path: "main.tex", line: 2, snippet: "As shown \\citep[p.~5]{smith}." }];
  render(
    <PaperInspector
      projectKey="/project" paper={paper} venue="" usages={usages} usageRevision={1}
      onEdit={vi.fn()} onOpenUse={vi.fn()} onClose={vi.fn()}
    />,
  );
  expect(await screen.findByText("main.tex:2 · p. 5")).toBeTruthy();
});
