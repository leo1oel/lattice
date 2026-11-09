import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { createCitationReason, panelCitationReasons } from "../editor/latex/citation-reasons";
import { useCitationReasonSources } from "./use-citation-reason-sources";

afterEach(cleanup);

const CITED = "Prior work \\cite{smith2020} agrees.";
const UNCITED = "Prior work agrees.";

function reasonOn(path: string): EditorComment {
  return createCitationReason({
    path, source: CITED, site: { from: 17, to: 26, key: "smith2020" }, role: "supporting", body: "",
    authorId: "me", authorName: "Me",
  })!;
}

it("lists a reason whose cite is gone from a file not opened this session, read from disk", async () => {
  const intro = reasonOn("intro.tex");
  const methods = reasonOn("methods.tex");
  const gone = reasonOn("old.tex");
  // Only the open file has text in the session; the rest are on disk.
  const sourceFor = (path: string) => (path === "intro.tex" ? CITED : undefined);
  const disk: Record<string, string> = { "methods.tex": UNCITED };
  const readSource = vi.fn(async (path: string) => disk[path] ?? null);
  const reasons = [intro, methods, gone];
  const view = renderHook(() => useCitationReasonSources("/project", reasons, sourceFor, readSource, 1));

  expect(panelCitationReasons(reasons, view.result.current)).toEqual([]);
  await waitFor(() => expect(panelCitationReasons(reasons, view.result.current)).toEqual([methods, gone]));
  expect(readSource.mock.calls.map(([path]) => path).sort()).toEqual(["methods.tex", "old.tex"]);
});

it("drops texts read for another project", async () => {
  const methods = reasonOn("methods.tex");
  const readSource = vi.fn(async () => UNCITED);
  const view = renderHook(({ root }) => useCitationReasonSources(root, [methods], () => undefined, readSource, 1), {
    initialProps: { root: "/a" },
  });
  await waitFor(() => expect(view.result.current("methods.tex")).toBe(UNCITED));
  readSource.mockImplementation(() => new Promise(() => {}));
  view.rerender({ root: "/b" });
  expect(view.result.current("methods.tex")).toBeUndefined();
});

it("reads the files again for a new citation scan, even when an edit kept their length", async () => {
  const methods = reasonOn("methods.tex");
  let disk = CITED;
  const readSource = vi.fn(async () => disk);
  const view = renderHook(({ scan }) => useCitationReasonSources("/project", [methods], () => undefined, readSource, scan), {
    initialProps: { scan: {} },
  });
  await waitFor(() => expect(view.result.current("methods.tex")).toBe(CITED));
  disk = CITED.replace("smith2020", "smith2021");
  view.rerender({ scan: {} });
  await waitFor(() => expect(view.result.current("methods.tex")).toBe(disk));
});
