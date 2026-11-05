import { describe, expect, it } from "vitest";
import { historyAnswer } from "./history";
import { MockProject } from "./project";
import { versionsAnswer } from "./versions";

const ROOT = "/project";

function setup() {
  let clock = Date.parse("2026-11-04T10:00:00Z");
  const now = () => new Date(clock);
  const project = new MockProject({ root: ROOT, id: "p", name: "P", files: new Map([["main.tex", "one"], ["notes.md", "notes"]]) });
  const history = historyAnswer({ project, now });
  const versions = versionsAnswer({ project, now });
  const save = (path: string, content: string) => history("write_project_file", { path, content, projectRoot: ROOT });
  return { project, history, versions, save, wait: (ms: number) => { clock += ms; } };
}

describe("the mock backend's history", () => {
  it("folds saves of one file moments apart, as history.rs does, and drops an edit typed back out", () => {
    const { history, save, wait } = setup();
    save("main.tex", "two");
    wait(10_000);
    save("main.tex", "three");
    expect(history("list_history", undefined)).toEqual([expect.objectContaining({ label: "Edit main.tex", files: ["main.tex"] })]);
    const [{ id }] = history("list_history", undefined) as Array<{ id: string }>;
    expect(history("get_history_entry", { transactionId: id })).toEqual({ id, changes: [{ path: "main.tex", before: "one", after: "three" }] });
    wait(60_000);
    save("main.tex", "four");
    expect(history("list_history", undefined)).toHaveLength(2);
    save("main.tex", "three");
    expect(history("list_history", undefined)).toHaveLength(1);
  });

  it("puts an entry's file back as a restore entry, and refuses one edited since", () => {
    const { project, history, save, wait } = setup();
    save("main.tex", "two");
    const [{ id }] = history("list_history", undefined) as Array<{ id: string }>;
    expect(history("revert_history_file", { transactionId: id, path: "main.tex" })).toMatchObject({ label: "Restore main.tex from Edit main.tex", undoOf: id });
    expect(project.text("main.tex")).toBe("one");
    wait(60_000);
    save("notes.md", "more");
    const [newest] = history("list_history", undefined) as Array<{ id: string }>;
    project.files.set("notes.md", "edited elsewhere");
    expect(() => history("revert_history_file", { transactionId: newest!.id, path: "notes.md" })).toThrow(/changed after this history entry/);
    history("delete_history_entry", { transactionId: id });
    expect((history("list_history", undefined) as Array<{ id: string }>).map((entry) => entry.id)).not.toContain(id);
  });
});

describe("the mock backend's versions", () => {
  it("saves only a changed project, compares any two versions, and restores forward", () => {
    const { project, versions, save } = setup();
    expect(versions("git_auto_commit", { message: "Saved version" })).toBeNull();
    save("main.tex", "two");
    project.files.set("extra.tex", "new");
    expect(versions("git_status", undefined)).toMatchObject({ files: [{ path: "extra.tex", status: "untracked" }, { path: "main.tex", status: "modified" }] });
    const saved = versions("git_auto_commit", { message: "Saved version" }) as string;
    const [, first] = versions("git_log", { limit: 10 }) as Array<{ hash: string }>;
    expect(versions("git_compare_files", { from: first!.hash, to: null })).toEqual([{ path: "extra.tex", kind: "added" }, { path: "main.tex", kind: "modified" }]);
    expect(versions("git_show_diff", { rev: saved, path: "main.tex" })).toEqual({ before: "one", after: "two", binary: false });

    versions("git_restore_project", { rev: first!.hash });
    expect(project.text("main.tex")).toBe("one");
    expect(project.files.has("extra.tex")).toBe(false);
    expect((versions("git_log", { limit: 10 }) as Array<{ message: string }>)[0]!.message).toBe(`Restore project to ${first!.hash.slice(0, 7)}`);
  });
});
