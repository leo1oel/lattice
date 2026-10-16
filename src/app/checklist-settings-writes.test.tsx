import { act, cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectManifest, ProjectSnapshot } from "../app-types";
import type { ManuscriptChecklistPanel } from "../project/manuscript-checklist";
import { AppEditorPanels } from "./app-editor-panels";
import { showError } from "./notify";

type ChecklistProps = ComponentProps<typeof ManuscriptChecklistPanel>;
const checklist = vi.hoisted(() => ({ props: null as ChecklistProps | null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./notify", () => ({ showError: vi.fn() }));
vi.mock("../trellis/trellis-controller", () => ({ useTrellisController: () => null }));
vi.mock("../project/manuscript-checklist", () => ({
  ManuscriptChecklistPanel: (props: ChecklistProps) => {
    checklist.props = props;
    return null;
  },
}));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(showError).mockReset();
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const snapshot = (name: string) => ({
  root: `/${name}`,
  files: [],
  manifest: { projectId: name, name, rootDocuments: [{ path: `${name}.tex` }] },
}) as unknown as ProjectSnapshot;
const answered = (name: string, change: Partial<ProjectManifest>) => ({ ...snapshot(name).manifest, ...change });
const DEADLINE = { venue: "ICLR", kind: "paper", due: "2027-01-01T23:59" } as const;

/** The panels open on project A's checklist; `current` is what the window shows. */
function renderPanels() {
  const window = { current: snapshot("A"), generation: 0 };
  const captureProjectScope = () => {
    const { root } = window.current;
    const generation = window.generation;
    return () => window.current.root === root && window.generation === generation;
  };
  const open = (name: string) => {
    window.generation += 1;
    window.current = snapshot(name);
  };
  const props = {
    project: window.current, captureProjectScope,
    setProject: (update: (current: ProjectSnapshot | null) => ProjectSnapshot | null) => {
      window.current = update(window.current)!;
    },
    activeFile: "A.tex", activeSource: "", openTabs: ["A.tex"], build: null, bodyBoundary: null, pdfPageCount: null,
    projectWordCount: null, todoHits: [], unusedSymbols: { labels: [], citations: [] }, editorCommentAuthorId: "me",
    openProjectFile: vi.fn(),
    tools: { isOpen: { checklist: true }, loading: null, close: vi.fn(), open: vi.fn() },
    comments: { comments: [], rounds: [], panelOpen: false },
    annotationRounds: { subscribe: () => () => undefined, getSnapshot: () => ({ roundsOpen: false }) },
  } as unknown as ComponentProps<typeof AppEditorPanels>;
  render(<AppEditorPanels {...props} />);
  return { window, open };
}

it("installs no manifest a deadline or budget write answers after its project closed", async () => {
  for (const [save, switches] of [
    ["deadline", ["B"]], ["deadline", ["B", "A"]], ["budgets", ["B"]], ["budgets", ["B", "A"]],
  ] as const) {
    const write = deferred<ProjectManifest>();
    vi.mocked(invoke).mockReset().mockReturnValue(write.promise);
    const { window, open } = renderPanels();
    act(() => {
      if (save === "deadline") checklist.props!.onSaveDeadline(DEADLINE);
      else checklist.props!.onSaveBudgets(8000, 9);
    });
    await act(async () => undefined);
    expect(invoke).toHaveBeenCalledTimes(1);
    switches.forEach(open);
    const landed = window.current;
    await act(async () => {
      write.resolve(answered("A", save === "deadline" ? { deadline: DEADLINE } : { wordBudget: 8000, pageBudget: 9 }));
      await write.promise;
    });
    expect(window.current).toBe(landed);
    cleanup();
  }
});

it("installs every settings answer in the order written, and the project's own failures", async () => {
  const older = deferred<ProjectManifest>();
  const newer = deferred<ProjectManifest>();
  vi.mocked(invoke).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const { window, open } = renderPanels();
  act(() => {
    checklist.props!.onSaveBudgets(8000, null);
    checklist.props!.onSaveDeadline(DEADLINE);
  });
  await act(async () => {
    older.resolve(answered("A", { wordBudget: 8000 }));
    await older.promise;
  });
  expect(window.current.manifest).toMatchObject({ name: "A", wordBudget: 8000 });
  await act(async () => {
    newer.resolve(answered("A", { wordBudget: 8000, deadline: DEADLINE }));
    await newer.promise;
  });
  expect(window.current.manifest).toMatchObject({ name: "A", wordBudget: 8000, deadline: DEADLINE });

  const failing = deferred<ProjectManifest>();
  vi.mocked(invoke).mockReturnValueOnce(failing.promise);
  act(() => { checklist.props!.onSaveDeadline(null); });
  await act(async () => undefined);
  expect(invoke).toHaveBeenCalledWith("set_project_deadline", { deadline: null });
  open("B");
  await act(async () => {
    failing.reject(new Error("disk full"));
    await failing.promise.catch(() => undefined);
  });
  expect(showError).not.toHaveBeenCalled();
});

it("runs every manifest write one after another, the newest answer holding them all", async () => {
  const items = deferred<ProjectManifest>();
  const deadline = deferred<ProjectManifest>();
  vi.mocked(invoke).mockReturnValueOnce(items.promise).mockReturnValueOnce(deadline.promise);
  const { window } = renderPanels();
  const item = { id: "a", title: "All authors confirmed", status: "confirmed" } as const;
  act(() => {
    checklist.props!.onSaveItems([item]);
    checklist.props!.onSaveDeadline(DEADLINE);
  });
  await act(async () => undefined);
  expect(vi.mocked(invoke).mock.calls).toEqual([["set_submission_items", { items: [item] }]]);
  await act(async () => {
    items.resolve(answered("A", { submissionItems: [item] }));
    await items.promise;
  });
  expect(vi.mocked(invoke).mock.calls[1]).toEqual(["set_project_deadline", { deadline: DEADLINE }]);
  await act(async () => {
    deadline.resolve(answered("A", { submissionItems: [item], deadline: DEADLINE }));
    await deadline.promise;
  });
  expect(window.current.manifest).toMatchObject({ submissionItems: [item], deadline: DEADLINE });
});

it("never sends a write still queued when its project closed", async () => {
  const items = deferred<ProjectManifest>();
  vi.mocked(invoke).mockReturnValueOnce(items.promise);
  const { open } = renderPanels();
  const item = { id: "a", title: "All authors confirmed", status: "confirmed" } as const;
  let saved: Promise<boolean> | undefined;
  act(() => {
    checklist.props!.onSaveItems([item]);
    saved = checklist.props!.onSaveItems([{ ...item, status: "todo" }]);
    checklist.props!.onSaveDeadline(DEADLINE);
  });
  await act(async () => undefined);
  open("B");
  await act(async () => {
    items.resolve(answered("A", { submissionItems: [item] }));
    await saved;
  });
  expect(await saved).toBe(false);
  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  expect(showError).not.toHaveBeenCalled();
});

it("runs item writes one after another, so an older one never lands over a newer", async () => {
  const first = deferred<ProjectManifest>();
  const second = deferred<ProjectManifest>();
  vi.mocked(invoke).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { window } = renderPanels();
  const item = { id: "a", title: "All authors confirmed", status: "todo" } as const;
  act(() => {
    checklist.props!.onSaveItems([item]);
    checklist.props!.onSaveItems([{ ...item, status: "confirmed" }]);
  });
  await act(async () => undefined);
  expect(vi.mocked(invoke).mock.calls).toEqual([["set_submission_items", { items: [item] }]]);
  await act(async () => {
    first.resolve(answered("A", { submissionItems: [item] }));
    await first.promise;
  });
  expect(vi.mocked(invoke).mock.calls[1]).toEqual(["set_submission_items", { items: [{ ...item, status: "confirmed" }] }]);
  await act(async () => {
    second.resolve(answered("A", { submissionItems: [{ ...item, status: "confirmed" }] }));
    await second.promise;
  });
  expect(window.current.manifest.submissionItems).toEqual([{ ...item, status: "confirmed" }]);
});
