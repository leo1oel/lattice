import { Suspense } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { chunk, lazyChunk } from "../lib/lazy-chunk";
import { RootErrorBoundary } from "../telemetry/root-error-boundary";
import { ChunkGate } from "./chunk-gate";

vi.mock("../telemetry/app-log-store", () => ({ addAppLog: vi.fn() }));

afterEach(cleanup);

// The PDF panel's shape: a gate that starts the load, and a lazy component
// that asks for the same chunk once the gate opens on its failure. The crash
// page and the log must carry the error the module's evaluation threw (#506:
// a missing built-in in PDF.js), not one from importing it a second time.
it("shows and logs the chunk's own failure when its module fails to evaluate", async () => {
  const { addAppLog } = await import("../telemetry/app-log-store");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const load = vi.fn()
    .mockRejectedValueOnce(new ReferenceError("Can't find variable: Iterator"))
    .mockRejectedValue(new ReferenceError("Cannot access uninitialized variable."));
  const source = chunk<{ Viewer: () => null }>(load);
  const Viewer = lazyChunk(source, (module) => module.Viewer);
  render(
    <RootErrorBoundary>
      <ChunkGate chunk={source} fallback={<p>loading</p>}>
        <Suspense fallback={<p>suspended</p>}>
          <Viewer />
        </Suspense>
      </ChunkGate>
    </RootErrorBoundary>,
  );
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Can't find variable: Iterator"));
  expect(load).toHaveBeenCalledTimes(1);
  expect(addAppLog).toHaveBeenCalledWith(expect.objectContaining({
    level: "error",
    detail: expect.stringContaining("Can't find variable: Iterator"),
  }));
});
