/**
 * External link metadata for the hover card (spec R-CHR-4): an LRU of
 * successes, one fetch per URL at a time, and nothing for a blocked,
 * malformed or aborted answer.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLinkPreviews, loadLinkPreview, PREVIEW_CACHE_LIMIT } from "./link-preview";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function heldAnswer() {
  let resolve!: (value: unknown) => void;
  invoke.mockReturnValue(new Promise((done) => { resolve = done; }));
  return (value: unknown) => resolve(value);
}

beforeEach(() => clearLinkPreviews());
afterEach(() => invoke.mockReset());

describe("link previews (R-CHR-4)", () => {
  it("keeps successes, refreshing an entry on use before evicting the least recent", async () => {
    invoke.mockImplementation(async (_command: string, args: { url: string }) => ({ ok: true, metadata: { domain: args.url } }));
    for (let index = 0; index < PREVIEW_CACHE_LIMIT; index += 1) await loadLinkPreview(`https://example.com/${index}`);
    await loadLinkPreview("https://example.com/0");
    await loadLinkPreview("https://example.com/new");
    expect(invoke).toHaveBeenCalledTimes(PREVIEW_CACHE_LIMIT + 1);
    await loadLinkPreview("https://example.com/0");
    expect(invoke).toHaveBeenCalledTimes(PREVIEW_CACHE_LIMIT + 1);
    await loadLinkPreview("https://example.com/1");
    expect(invoke).toHaveBeenCalledTimes(PREVIEW_CACHE_LIMIT + 2);
  });

  it("shares one fetch between concurrent requests for a URL", async () => {
    const answer = heldAnswer();
    const first = loadLinkPreview("https://example.com/shared");
    const second = loadLinkPreview("https://example.com/shared");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("link_preview", { url: "https://example.com/shared" });
    answer({ ok: true, metadata: { domain: "example.com" } });
    await expect(Promise.all([first, second])).resolves.toEqual([{ domain: "example.com" }, { domain: "example.com" }]);
  });

  it("yields nothing for a blocked answer and asks again next time; a malformed answer yields nothing", async () => {
    invoke.mockResolvedValue({ ok: false, reason: "blocked" });
    await expect(loadLinkPreview("https://blocked.example")).resolves.toBeNull();
    await expect(loadLinkPreview("https://blocked.example")).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
    invoke.mockResolvedValue({ ok: true, metadata: {} });
    await expect(loadLinkPreview("https://example.com/malformed")).resolves.toBeNull();
    invoke.mockRejectedValue(new Error("offline"));
    await expect(loadLinkPreview("https://example.com/offline")).resolves.toBeNull();
  });

  it("yields nothing when the request is aborted while the host is still answering", async () => {
    const answer = heldAnswer();
    const controller = new AbortController();
    const result = loadLinkPreview("https://example.com/slow", controller.signal);
    controller.abort();
    answer({ ok: true, metadata: { domain: "example.com" } });
    await expect(result).resolves.toBeNull();
  });
});
