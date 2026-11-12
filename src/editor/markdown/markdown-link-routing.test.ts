import { afterEach, describe, expect, it, vi } from "vitest";
import { openMarkdownLink } from "./markdown-link-routing";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const openUrl = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
const notifyError = vi.hoisted(() => vi.fn());
vi.mock("../../telemetry/app-notify", () => ({ notifyError }));

afterEach(() => vi.clearAllMocks());

const ZOTERO = "zotero://open-pdf/library/items/PDF00001?page=3&annotation=ANNHIGH1";

describe("a link in a note", () => {
  it("into Zotero's PDF reader goes to the backend, which opens only that kind", async () => {
    invoke.mockResolvedValue(undefined);
    openMarkdownLink("notes/Lee2024Sparse.md", ZOTERO);
    expect(invoke).toHaveBeenCalledWith("open_zotero_link", { url: ZOTERO });
    expect(openUrl).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("into Zotero says so when Zotero cannot be reached", async () => {
    invoke.mockRejectedValue("Lattice couldn't open Zotero: no application knows zotero://");
    openMarkdownLink("notes/Lee2024Sparse.md", ZOTERO);
    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith("Papers", "Could not open Zotero", {
      detail: "Lattice couldn't open Zotero: no application knows zotero://",
    }));
  });

  it("to a paper's kept PDF, from the project root, opens that project file", () => {
    const onOpenProjectPath = vi.fn();
    openMarkdownLink("notes/deep/Lee2024Sparse.md", "/.research/papers/web-0123456789abcdef/original.pdf#page=3", onOpenProjectPath);
    expect(onOpenProjectPath).toHaveBeenCalledWith(".research/papers/web-0123456789abcdef/original.pdf");
  });

  it("of any other zotero:// kind opens nothing", () => {
    openMarkdownLink("notes/Lee2024Sparse.md", "zotero://select/library/items/PDF00001");
    expect(invoke).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
