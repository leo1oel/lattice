import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofreadPrompt } from "../../src/agent/agent-proofread";
import mainTex from "../../src-tauri/templates/tutorial/main.tex?raw";
import referencesBib from "../../src-tauri/templates/tutorial/references.bib?raw";
import overrides from "./content/overrides.json";
import { installDemoBackend } from "./demo-backend";

/** The tutorial's sources as the demo opens them, with its edits made. */
function tutorial() {
  const files = new Map<string, string | Uint8Array>([["main.tex", mainTex], ["references.bib", referencesBib]]);
  for (const { file, find, replace } of overrides.edits) files.set(file, String(files.get(file)).replace(find, () => replace));
  return files;
}

/** The demo's worked example, the paragraph it marks for trying the agent, as the visitor selects it. */
const EXAMPLE = /Consider the four-token fragment[\s\S]*?inspect that distinction\./.exec(tutorial().get("main.tex") as string)![0];

describe("the web demo's backend", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    document.documentElement.lang = "en";
    installDemoBackend(tutorial());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A command's answer, the pauses that stand in for the network run out. */
  async function answer<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    // Settled before the timers run, so a refusal is the test's to read, not an unhandled rejection.
    const settled = invoke<T>(command, args).then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.runAllTimersAsync();
    const outcome = await settled;
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  it("says Overleaf sync runs on the Mac instead of answering the sign-in with nothing", async () => {
    await expect(answer("overleaf_begin_login", { title: "Sign in to Overleaf" })).rejects.toThrow(/Overleaf sync runs in Lattice on your Mac/);
    document.documentElement.lang = "zh-CN";
    await expect(answer("overleaf_poll_login")).rejects.toThrow(/Overleaf 同步在 Mac 上的 Lattice 里运行/);
  });

  it("looks up the papers it cites and holds, and says adding any other needs the Mac", async () => {
    // Cited by the tutorial, by every spelling of its arXiv ID.
    for (const query of ["arXiv:2005.14165", "2005.14165", "https://arxiv.org/abs/2005.14165v2"]) {
      expect(await answer("resolve_citation_query", { query })).toMatchObject({ key: "brown2020language", title: "Language Models are Few-Shot Learners", year: "2020" });
    }
    // Its library's own paper, which Find literature can add too, and a title.
    expect(await answer("resolve_citation_query", { query: "1906.04341" })).toMatchObject({ key: "clark2019what" });
    expect(await answer("resolve_citation_query", { query: "attention is not not explanation" })).toMatchObject({ doi: "10.18653/v1/D19-1002" });
    await expect(answer("resolve_citation_query", { query: "2401.00001" })).rejects.toThrow(/Adding new papers needs Lattice on your Mac/);
  });

  it("adds a paper it knows to the library and cites it in the bibliography and History", async () => {
    const added = await answer<Record<string, unknown>>("import_reference", { input: "1906.04341", requestId: "r1" });
    expect(added).toMatchObject({ citationKey: "clark2019what", alreadyImported: false, paperPath: ".research/papers/1906.04341/paper.md" });
    expect(await answer<string>("read_project_file", { path: "references.bib" })).toContain("@inproceedings{clark2019what,");
    expect(await answer<Array<{ label: string; actor: string }>>("list_history")).toEqual([expect.objectContaining({ label: "Cite clark2019what", actor: "citation" })]);
    expect(await answer<Array<{ citationKey: string }>>("list_papers")).toEqual(expect.arrayContaining([expect.objectContaining({ citationKey: "clark2019what" })]));
    // Cited already, but not in the library: added there, its text left to the Mac.
    expect(await answer("import_reference", { input: "arXiv:2005.14165", requestId: "r2" })).toMatchObject({
      citationKey: "brown2020language", fetchError: "Downloading the full text needs Lattice on your Mac.",
    });
    await expect(answer("import_reference", { input: "10.1000/unknown", requestId: "r3" })).rejects.toThrow(/needs Lattice on your Mac/);
  });

  it("records the visitor's saves in History and tracks them as versions", async () => {
    const edited = (tutorial().get("main.tex") as string).replace("teh softmax", "the softmax");
    await answer("write_project_file", { path: "main.tex", content: edited, projectRoot: "/Lattice Tutorials/Understanding Attention" });
    const [entry] = await answer<Array<{ id: string; label: string; files: string[] }>>("list_history");
    expect(entry).toMatchObject({ label: "Edit main.tex", files: ["main.tex"] });
    expect(await answer("get_history_entry", { transactionId: entry!.id })).toMatchObject({ changes: [{ path: "main.tex", after: edited }] });

    expect(await answer("git_status")).toMatchObject({ available: true, repository: true, files: [{ path: "main.tex", status: "modified" }] });
    const hash = await answer<string>("git_auto_commit", { message: "Saved version", author: null });
    expect(await answer<Array<{ hash: string; message: string }>>("git_log", { limit: 100 })).toEqual([
      expect.objectContaining({ hash, message: "Saved version", files: [{ path: "main.tex", kind: "modified" }] }),
      expect.objectContaining({ message: "Initialize version tracking" }),
    ]);
  });

  it("rewrites the worked example as the instruction asks, and says when the answers are scripted", async () => {
    const rewrite = async (instruction: string, excerpt: string) => {
      const { taskId } = await answer<{ taskId: string }>("agent_text_task", { action: "start", prompt: proofreadPrompt(excerpt, "main.tex", { instruction }) });
      vi.advanceTimersByTime(5_000);
      return answer<{ status: string; text?: string; message?: string }>("agent_text_task", { action: "status", taskId });
    };
    const passive = await rewrite("Use the passive voice", EXAMPLE);
    expect(passive.text).toContain("Concentration is altered by changing the softmax temperature");
    expect((await rewrite("改用被动语态", EXAMPLE)).text).toContain("is considered here");
    expect((await rewrite("Translate into Chinese", EXAMPLE)).text).toContain("考虑由四个词元组成的片段");
    expect(await rewrite("Use the passive voice", "Attention maps are not explanations.")).toMatchObject({
      status: "failed", message: expect.stringContaining("Rewrite is scripted in this demo"),
    });
  });

  it("reports each reference's whole title to the citation audit, its braces kept", async () => {
    const scan = await answer<{ entries: Array<{ key: string; title: string }> }>("bibliography_audit_scan");
    expect(scan.entries.find((entry) => entry.key === "dao2022flashattention")?.title)
      .toBe("{FlashAttention}: Fast and Memory-Efficient Exact Attention with {IO}-Awareness");
  });
});
