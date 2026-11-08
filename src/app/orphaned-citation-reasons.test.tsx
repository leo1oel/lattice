import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../app-types";
import { createCitationReason } from "../editor/latex/citation-reasons";
import { AppEditorPanels } from "./app-editor-panels";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../trellis/trellis-controller", () => ({ useTrellisController: () => null }));
vi.mock("../project/submission-review-state", () => ({ useSubmissionReview: () => null }));
afterEach(cleanup);

const CITED = "Prior work \\cite{smith2020} agrees.";

it("counts an orphaned citation reason as a local note in the Overleaf drawer, with no other local notes", async () => {
  const reason = createCitationReason({
    path: "methods.tex", source: CITED, site: { from: 17, to: 26, key: "smith2020" }, role: "counterexample", body: "",
    authorId: "me", authorName: "Me",
  })!;
  // A co-author deleted the cite on Overleaf; the file was not opened this session.
  const readSource = vi.fn(async () => "Prior work agrees.");
  const surface = vi.fn((_panel: unknown, _local: { count: number; open: number }) => null);
  const props = {
    project: { root: "/A", files: [], manifest: { projectId: "A", name: "A", rootDocuments: [] } } as unknown as ProjectSnapshot,
    captureProjectScope: () => () => true, setProject: vi.fn(),
    activeFile: "main.tex", activeSource: "", openTabs: ["main.tex"], build: null, bodyBoundary: null, pdfPageCount: null,
    projectWordCount: null, todoHits: [], unusedSymbols: { labels: [], citations: [] }, editorCommentAuthorId: "me",
    openProjectFile: vi.fn(),
    tools: { isOpen: {}, loading: null, close: vi.fn(), open: vi.fn() },
    comments: { comments: [], citationReasons: [reason], rounds: [], panelOpen: false },
    annotationRounds: { subscribe: () => () => undefined, getSnapshot: () => ({ roundsOpen: false }), readSource },
    renderCommentsSurface: surface,
  } as unknown as ComponentProps<typeof AppEditorPanels>;
  render(<AppEditorPanels {...props} />);
  await waitFor(() => expect(surface.mock.calls.at(-1)?.[1]).toEqual({ count: 1, open: 1 }));
});
