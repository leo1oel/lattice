import {
  emitTauriEvent, expectEditorText, invokeCalls, openAgentFrame, pause, postWindowMessage, projectCommands, projectSnapshot,
  ROOT, synaraHook, tauriEventApi, type Commands,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { forEachDiagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CitationInfo } from "../editor/latex/latex-text";

const { renderApp } = appHarness({ documentCanvas });

const SOURCE = "As shown by \\cite{fresh2026}.";
const UNKNOWN = "Unknown citation key “fresh2026”.";
const citation = (key: string): CitationInfo => ({ key, title: "", authors: "", year: "", venue: "" });

function diagnostics(view: EditorView) {
  const found: string[] = [];
  forEachDiagnostic(view.state, (diagnostic) => found.push(diagnostic.message));
  return found;
}

/**
 * Opens a document citing a key its bibliography lacks, and waits for the
 * editor to flag it. `bibliography.keys` is what each list_citations read
 * finds on disk; a test adds the key behind the editor's back.
 */
async function openWithUnknownCitation(
  bibliography: { keys: string[] } = { keys: [] },
  extra: Commands = {},
) {
  renderApp({
    ...projectCommands(projectSnapshot(), SOURCE),
    list_citations: () => bibliography.keys.map(citation),
    ...extra,
  });
  const view = await expectEditorText(SOURCE);
  await waitFor(() => expect(diagnostics(view)).toEqual([UNKNOWN]), { timeout: 3_000 });
  await waitFor(() => expect(tauriEventApi.handlers.get("project-fs-changed")?.size).toBeGreaterThan(0));
  return { view, bibliography, reads: () => invokeCalls("list_citations").length };
}

describe("the citation index follows the .bib on disk", () => {
  // A reference manager's auto-export (Better BibTeX), a git pull, or the
  // agent writes the .bib; nothing is saved in the editor.
  it("reads the keys again when the watcher reports a .bib changed", async () => {
    const { view, bibliography, reads } = await openWithUnknownCitation();
    const before = reads();
    bibliography.keys = ["fresh2026"];
    // An export lands in several bursts; the bibliography is read once for them.
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["refs.bib"] });
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["refs.bib"] });
    await waitFor(() => expect(diagnostics(view)).toEqual([]), { timeout: 3_000 });
    expect(reads()).toBe(before + 1);
    expect(invokeCalls("list_papers").length).toBeGreaterThan(1);
  });

  it("reads the keys again when the watcher cannot say what changed", async () => {
    const { view, bibliography } = await openWithUnknownCitation();
    bibliography.keys = ["fresh2026"];
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: null });
    await waitFor(() => expect(diagnostics(view)).toEqual([]), { timeout: 3_000 });
  });

  it("leaves the bibliography alone when only other files changed", async () => {
    const { reads } = await openWithUnknownCitation();
    const before = reads();
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["main.pdf", "figures/plot.png"] });
    emitTauriEvent("project-fs-changed", { root: "/elsewhere", paths: ["refs.bib"] });
    await pause(1_000);
    expect(reads()).toBe(before);
  });

  it("reads the keys again as soon as the agent's bibliography tool writes the .bib", async () => {
    const bibliography = { keys: [] as string[] };
    const { view } = await openWithUnknownCitation(bibliography, {
      agent_bibliography_mutation: () => {
        bibliography.keys = ["fresh2026"];
        return { action: "cite", key: "fresh2026" };
      },
    });
    await screen.findByRole("button", { name: "Switch project" });
    const { frame, postMessage } = await openAgentFrame({ ready: true });
    postWindowMessage(frame.contentWindow, {
      type: "synara:bibliography-tool-request", version: 1, id: "cite-fresh", action: "cite",
      params: { query: "Fresh results 2026" }, workspaceRoot: ROOT, expiresAt: Date.now() + 10_000,
    });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "lattice:bibliography-tool-result", id: "cite-fresh", ok: true,
    }), synaraHook.runtime.origin));
    // No watcher burst: the agent's own write is enough.
    await waitFor(() => expect(diagnostics(view)).toEqual([]), { timeout: 3_000 });
  });
});
