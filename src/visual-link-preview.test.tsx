import { invoke } from "@tauri-apps/api/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor } from "@tiptap/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalLinkPreviewCard } from "./visual-link-preview-card.tsx";
import {
  clearLinkPreviewCaches,
  loadLinkPreview,
  SUCCESS_CACHE_MAX_ENTRIES,
} from "./visual-link-preview-data.ts";
import { VisualLinkHover } from "./visual-link-hover.tsx";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  clearLinkPreviewCaches();
  mockedInvoke.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.querySelectorAll(".visual-link-preview-popup").forEach((node) => node.remove());
});

describe("link preview data", () => {
  it("caches successes and touches entries before LRU eviction", async () => {
    mockedInvoke.mockImplementation(async (_command, args) => ({
      ok: true,
      metadata: { domain: String((args as Record<string, unknown> | undefined)?.url) },
    }));
    for (let index = 0; index < SUCCESS_CACHE_MAX_ENTRIES; index += 1) {
      await loadLinkPreview(`https://example.com/${index}`);
    }
    await loadLinkPreview("https://example.com/0");
    await loadLinkPreview("https://example.com/new");
    expect(mockedInvoke).toHaveBeenCalledTimes(SUCCESS_CACHE_MAX_ENTRIES + 1);

    await loadLinkPreview("https://example.com/0");
    await loadLinkPreview("https://example.com/1");
    expect(mockedInvoke).toHaveBeenCalledTimes(SUCCESS_CACHE_MAX_ENTRIES + 2);
  });

  it("coalesces concurrent requests", async () => {
    let resolve!: (value: unknown) => void;
    mockedInvoke.mockReturnValue(new Promise((done) => { resolve = done; }));
    const first = loadLinkPreview("https://example.com/shared");
    const second = loadLinkPreview("https://example.com/shared");
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    resolve({ ok: true, metadata: { domain: "example.com" } });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { domain: "example.com" },
      { domain: "example.com" },
    ]);
  });

  it("returns null and does not cache a blocked response", async () => {
    mockedInvoke.mockResolvedValue({ ok: false, reason: "blocked" });
    await expect(loadLinkPreview("https://blocked.example")).resolves.toBeNull();
    await expect(loadLinkPreview("https://blocked.example")).resolves.toBeNull();
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
  });

  it("returns null for malformed responses", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, metadata: {} });
    await expect(loadLinkPreview("https://example.com/malformed")).resolves.toBeNull();
  });

  it("returns null when aborted while invoke is pending", async () => {
    let resolve!: (value: unknown) => void;
    mockedInvoke.mockReturnValue(new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const result = loadLinkPreview("https://example.com/slow", controller.signal);
    controller.abort();
    resolve({ ok: true, metadata: { domain: "example.com" } });
    await expect(result).resolves.toBeNull();
  });
});

describe("ExternalLinkPreviewCard", () => {
  it("renders metadata and a data-image favicon", () => {
    render(<ExternalLinkPreviewCard metadata={{
      domain: "example.com", title: "Example title", description: "Example description",
      faviconDataUri: "data:image/png;base64,AAAA",
    }} />);
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("Example title")).toBeInTheDocument();
    expect(screen.getByText("Example description")).toBeInTheDocument();
    expect(document.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AAAA");
  });

  it("does not render a remote favicon", () => {
    render(<ExternalLinkPreviewCard metadata={{
      domain: "example.com", faviconDataUri: "https://example.com/favicon.png",
    }} />);
    expect(document.querySelector("img")).toBeNull();
  });
});

function TestEditor({ href }: { href: string }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), VisualLinkHover],
    content: `<p><a href="${href}">Example</a></p>`,
  });
  return <EditorContent editor={editor} />;
}

describe("VisualLinkHover", () => {
  it("opens after dwell and closes after leave grace", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue({ ok: false, reason: "blocked" });
    render(<TestEditor href="https://example.com/article" />);
    const link = screen.getByRole("link", { name: "Example" });
    fireEvent.mouseOver(link);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(document.querySelector(".visual-link-preview-popup")).toHaveTextContent(
      "https://example.com/article",
    );
    fireEvent.mouseOut(link);
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(document.querySelector(".visual-link-preview-popup")).toBeNull();
  });

  it("offers link editing for a relative project link without fetching metadata", async () => {
    vi.useFakeTimers();
    render(<TestEditor href="./notes.md" />);
    fireEvent.mouseOver(screen.getByRole("link", { name: "Example" }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(document.querySelector(".visual-link-preview-popup")).toHaveTextContent("./notes.md");
    expect(screen.getByRole("button", { name: "Edit link" })).toBeInTheDocument();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
