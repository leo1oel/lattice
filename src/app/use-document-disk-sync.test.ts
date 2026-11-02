import { act } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ROOT, renderDocuments } from "./open-documents-test-harness";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { clearAppLogs, getAppLogEntry, getAppToastOptions, getVisibleAppToastIds } from "../telemetry/app-log-store";
import { invokeCalls } from "../platform/tauri-test-mocks";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

// What a vanished file loads on demand, loaded before the clock is faked.
beforeAll(() => import("./vanished-file"));
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
});
afterEach(() => {
  clearAppLogs();
  vi.mocked(saveDialog).mockReset();
});

/** One disk poll (2.5 s), and the second look a missing file gets. */
const nextPoll = () => act(() => vi.advanceTimersByTimeAsync(4_000));

/** The toasts on screen, by title. */
function toasts() {
  return getVisibleAppToastIds().map((id) => ({ ...getAppLogEntry(id)!, options: getAppToastOptions(id) }));
}
const toastTitled = (title: string) => toasts().find((toast) => toast.title === title);

/** intro.tex open over main.tex, its first version seen by the disk poll. */
async function introOpen(disk: Record<string, string> = {}) {
  const docs = renderDocuments({ "main.tex": "Main", "intro.tex": "Intro", ...disk });
  await docs.enter();
  // An open waits for a paint opportunity, on the faked clock.
  await act(async () => {
    const opening = docs.current().openFile("intro.tex");
    await vi.advanceTimersByTimeAsync(100);
    await opening;
  });
  await act(() => vi.advanceTimersByTimeAsync(2_600));
  return docs;
}

describe("an older version restored over the open file", () => {
  it("reloads into a clean buffer, whether it is another file or the same one with an older mtime", async () => {
    const docs = renderDocuments({ "main.tex": "Main" });
    await docs.enter();
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    // `mv main.tex.bak main.tex`
    docs.restoreOlder("main.tex", "Backup");
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    expect(docs.current()).toMatchObject({ text: "Backup", dirty: false });
    // `cp -p`: the same file and size, only the mtime goes back.
    docs.restoreOlder("main.tex", "Backuq", { sameFile: true });
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    expect(docs.current()).toMatchObject({ text: "Backuq", dirty: false });
  });

  it("keeps unsaved typing over it and merges the two on the next save", async () => {
    const docs = renderDocuments({ "main.tex": "One\nTwo" });
    await docs.enter();
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    docs.type("One\nTwo, mine");
    docs.restoreOlder("main.tex", "One, restored\nTwo");
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(docs.current().text).toBe("One\nTwo, mine");
    await act(() => docs.current().save());
    expect(docs.files.get("main.tex")).toBe("One, restored\nTwo, mine");
  });
});

describe("the open file renamed outside Lattice", () => {
  it("follows it with its tab, then keeps following edits made there", async () => {
    const docs = await introOpen();
    docs.renameOutside("intro.tex", "chapters/intro.tex");
    await nextPoll();
    expect(docs.current()).toMatchObject({ file: "chapters/intro.tex", text: "Intro", tabs: ["main.tex", "chapters/intro.tex"] });
    expect(toastTitled("intro.tex was moved to chapters/intro.tex")).toBeDefined();
    docs.touch("chapters/intro.tex", "Intro, by the agent");
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    expect(docs.current()).toMatchObject({ text: "Intro, by the agent", dirty: false });
  });

  it("carries unsaved typing to the new path, never writing the old one back", async () => {
    const docs = await introOpen();
    docs.type("Intro, typing");
    docs.renameOutside("intro.tex", "chapters/intro.tex");
    await nextPoll();
    await act(() => docs.current().save());
    expect(docs.current()).toMatchObject({ file: "chapters/intro.tex", dirty: false });
    expect(docs.files.get("chapters/intro.tex")).toBe("Intro, typing");
    expect(docs.files.has("intro.tex")).toBe(false);
  });

  it("follows by the saved text when Lattice's own save had just replaced the file", async () => {
    const docs = await introOpen();
    docs.type("Intro, saved");
    await act(() => docs.current().save());
    // Moved before the poll saw the file the atomic save wrote.
    docs.renameOutside("intro.tex", "chapters/intro.tex");
    await nextPoll();
    expect(docs.current().file).toBe("chapters/intro.tex");
  });
});

describe("the open file deleted outside Lattice", () => {
  it("closes its tab when nothing is unsaved", async () => {
    const docs = await introOpen();
    docs.deleteOutside("intro.tex");
    docs.setSnapshot(["main.tex"]);
    await nextPoll();
    expect(docs.current()).toMatchObject({ file: "main.tex", text: "Main", tabs: ["main.tex"] });
    expect(toastTitled("intro.tex was deleted")).toBeDefined();
  });

  it("leaves a file deleted and written again within a moment alone", async () => {
    const docs = await introOpen();
    docs.deleteOutside("intro.tex");
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    docs.touch("intro.tex", "Intro, rewritten");
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(docs.current()).toMatchObject({ file: "intro.tex", text: "Intro, rewritten", tabs: ["main.tex", "intro.tex"] });
    expect(toasts()).toEqual([]);
  });

  /** intro.tex deleted (a branch switch) while it holds unsaved typing. */
  async function deletedWhileTyping() {
    const docs = await introOpen();
    docs.type("Intro, unsaved");
    docs.deleteOutside("intro.tex");
    await nextPoll();
    const notice = toastTitled("intro.tex is no longer on disk")!;
    return { docs, notice };
  }

  it("holds unsaved edits with a lasting notice, and stops trying to save them", async () => {
    const { docs, notice } = await deletedWhileTyping();
    expect(docs.current()).toMatchObject({ file: "intro.tex", text: "Intro, unsaved", dirty: true });
    expect(notice).toMatchObject({ level: "warning", options: { timeoutMs: 0 } });
    expect(notice.options?.primaryAction?.label).toBe("Recreate");
    expect(notice.options?.secondaryAction?.label).toBe("Save As…");
    const writes = invokeCalls("write_project_file").length;
    let saved = true;
    await act(async () => { saved = await docs.current().save(); });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(saved).toBe(false);
    expect(invokeCalls("write_project_file")).toHaveLength(writes);
    expect(docs.files.has("intro.tex")).toBe(false);
    // Opening another file must save this one first, so it stays.
    await act(async () => {
      const opening = docs.current().openFile("main.tex");
      await vi.advanceTimersByTimeAsync(100);
      await opening;
    });
    expect(docs.current().file).toBe("intro.tex");
  });

  it("recreates the file where it was", async () => {
    const { docs, notice } = await deletedWhileTyping();
    await act(async () => { await notice.options!.primaryAction!.onClick(); });
    expect(docs.files.get("intro.tex")).toBe("Intro, unsaved");
    expect(docs.current()).toMatchObject({ file: "intro.tex", dirty: false });
    expect(toastTitled("intro.tex is no longer on disk")).toBeUndefined();
    docs.type("Intro, unsaved, and more");
    await act(() => docs.current().save());
    expect(docs.files.get("intro.tex")).toBe("Intro, unsaved, and more");
  });

  it("saves the edits to a new place in the project, and the tab follows", async () => {
    const { docs, notice } = await deletedWhileTyping();
    vi.mocked(saveDialog).mockResolvedValue(`${ROOT}/sections/intro.tex`);
    await act(async () => { await notice.options!.secondaryAction!.onClick(); });
    expect(vi.mocked(saveDialog)).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: `${ROOT}/intro.tex` }));
    expect(docs.files.get("sections/intro.tex")).toBe("Intro, unsaved");
    expect(docs.current()).toMatchObject({ file: "sections/intro.tex", tabs: ["main.tex", "sections/intro.tex"], dirty: false });
    expect(docs.deps.onSaved).toHaveBeenCalledWith(ROOT, ["sections/intro.tex"]);
  });

  it("saves the edits outside the project as a copy and closes the tab; a cancelled panel keeps the choice open", async () => {
    const { docs, notice } = await deletedWhileTyping();
    vi.mocked(saveDialog).mockResolvedValueOnce(null);
    await act(async () => { await notice.options!.secondaryAction!.onClick(); });
    expect(toastTitled("intro.tex is no longer on disk")).toBeDefined();
    expect(docs.current().text).toBe("Intro, unsaved");

    const answer = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args, options) => (
      command === "save_source_copy" ? "/Users/me/Desktop/intro.tex" : answer(command, args, options)
    ));
    vi.mocked(saveDialog).mockResolvedValueOnce("/Users/me/Desktop/intro.tex");
    await act(async () => { await notice.options!.secondaryAction!.onClick(); });
    const [bytes] = vi.mocked(invoke).mock.calls.find(([command]) => command === "save_source_copy")!.slice(1);
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("Intro, unsaved");
    expect(docs.current()).toMatchObject({ file: "main.tex", tabs: ["main.tex"] });
    expect(toastTitled("Saved your edits to /Users/me/Desktop/intro.tex")).toBeDefined();
  });

  it("drops the edits when the writer closes the tab", async () => {
    const { docs } = await deletedWhileTyping();
    await act(() => docs.current().close("intro.tex"));
    expect(docs.current()).toMatchObject({ file: "main.tex", text: "Main", tabs: ["main.tex"] });
    expect(docs.files.has("intro.tex")).toBe(false);
    expect(toastTitled("intro.tex is no longer on disk")).toBeUndefined();
  });

  it("saves into the file again once it comes back, merging with what came back", async () => {
    const { docs } = await deletedWhileTyping();
    // `git checkout -` brings the branch's version back.
    docs.touch("intro.tex", "Intro");
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    expect(toastTitled("intro.tex is no longer on disk")).toBeUndefined();
    await act(() => docs.current().save());
    expect(docs.files.get("intro.tex")).toBe("Intro, unsaved");
  });
});
