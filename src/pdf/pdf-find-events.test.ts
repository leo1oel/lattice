import { expect, it } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";

type FindMatches = { current: number; total: number };

// The PDFSlick mock in pdf-viewer-component.test.tsx imitates this contract;
// pin it against the installed find controller so the two cannot drift.
it("reports a moved selection only through updatefindcontrolstate, and re-reports stale counts on close and while pending", async () => {
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { EventBus, FindState, PDFFindController } = await import("pdfjs-dist/web/pdf_viewer.mjs");
  // use-pdf-document.ts mirrors this value rather than loading the viewer module.
  expect(FindState.PENDING).toBe(3);
  const eventBus = new EventBus();
  const pages = ["lattice one lattice", "nothing here", "lattice three"];
  const linkService = { page: 1, pagesCount: pages.length };
  const controller = new PDFFindController({
    linkService: linkService as unknown as ConstructorParameters<typeof PDFFindController>[0]["linkService"],
    eventBus,
    delay: 0,
  });
  controller.setDocument({
    getPage: async (pageNumber: number) => ({
      getTextContent: async () => ({ items: [{ str: pages[pageNumber - 1], hasEOL: false }] }),
    }),
  } as unknown as PDFDocumentProxy);

  // `latest` is what usePdfDocument forwards: whichever of the two events came
  // last, skipping pending control states.
  let latest: FindMatches | null = null;
  const counts: FindMatches[] = [];
  const states: Array<FindMatches & { state: number }> = [];
  eventBus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: FindMatches }) => {
    counts.push(matchesCount);
    latest = matchesCount;
  });
  eventBus.on("updatefindcontrolstate", ({ matchesCount, state }: { matchesCount: FindMatches; state: number }) => {
    states.push({ ...matchesCount, state });
    if (state !== FindState.PENDING) latest = matchesCount;
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const find = async (type: string, findPrevious = false, query = "lattice") => {
    eventBus.dispatch("find", {
      source: null, type, query, caseSensitive: false, entireWord: false,
      highlightAll: true, findPrevious, matchDiacritics: false,
    });
    await settle();
    return latest;
  };

  expect(await find("")).toEqual({ current: 1, total: 3 });
  const countEvents = counts.length;
  expect(await find("again")).toEqual({ current: 2, total: 3 });
  expect(await find("again")).toEqual({ current: 3, total: 3 });
  expect(await find("again")).toEqual({ current: 1, total: 3 });
  expect(await find("again", true)).toEqual({ current: 3, total: 3 });
  // The running total never mentions the selection moving.
  expect(counts).toHaveLength(countEvents);

  const stateEvents = states.length;
  eventBus.dispatch("findbarclose", { source: null });
  await settle();
  expect(states.slice(stateEvents)).toEqual([{ current: 3, total: 3, state: FindState.FOUND }]);

  // A new query first reports the closed query's selection as pending.
  const beforeNewQuery = states.length;
  expect(await find("", false, "three")).toEqual({ current: 1, total: 1 });
  expect(states[beforeNewQuery]).toEqual({ current: 3, total: 3, state: FindState.PENDING });
});
