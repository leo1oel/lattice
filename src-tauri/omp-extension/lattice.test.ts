import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import latticeExtension from "./lattice";

/**
 * Stands in for the Lattice executable, which is invoked as
 * `<binary> cite <query>` and answers with one line of JSON. The script prints
 * its second argument, so a test decides the answer by passing it as the query.
 */
let fakeLattice = "";
let scriptDir = "";

beforeAll(() => {
  scriptDir = mkdtempSync(join(tmpdir(), "lattice-cite-"));
  fakeLattice = join(scriptDir, "lattice");
  writeFileSync(fakeLattice, "#!/bin/sh\nprintf '%s' \"$2\"\n");
  chmodSync(fakeLattice, 0o755);
});

afterAll(() => {
  rmSync(scriptDir, { recursive: true, force: true });
});

type ToolEvent = { toolName: string; input: Record<string, unknown> };
type HookResult = { block: true; reason: string } | undefined;
type RegisteredTool = {
  name: string;
  description: string;
  loadMode?: string;
  execute: (
    id: string,
    params: { query: string },
    signal?: AbortSignal,
  ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
};

/** The slice of the extension API this file uses, with zod stubbed out. */
function load() {
  let callback: ((event: ToolEvent) => HookResult) | undefined;
  let tool: RegisteredTool | undefined;
  const schema = { describe: () => schema };
  latticeExtension({
    on: (_name: string, next: (event: ToolEvent) => HookResult) => {
      callback = next;
    },
    registerTool: (definition: RegisteredTool) => {
      tool = definition;
    },
    zod: { object: () => schema, string: () => schema },
  } as never);
  if (!callback) throw new Error("The tool hook was not registered.");
  if (!tool) throw new Error("The cite tool was not registered.");
  return { hook: callback, tool };
}

function hook() {
  return load().hook;
}

describe("Lattice OMP extension", () => {
  it("blocks direct bibliography writes and points the agent at the cite tool", () => {
    const result = hook()({ toolName: "edit", input: { path: "references.bib" } });
    expect(result?.block).toBe(true);
    // The refusal is where a model that reached for the file learns what to
    // reach for instead, so it has to name the tool.
    expect(result?.reason).toContain("`cite` tool");
  });

  it("allows bibliography reads and bibcite commands", () => {
    const prehook = hook();
    expect(prehook({ toolName: "bash", input: { command: "cat references.bib" } })).toBeUndefined();
    expect(prehook({ toolName: "bash", input: { command: "bibcite add references.bib 1706.03762" } })).toBeUndefined();
  });

  it("blocks shell commands that bypass bibcite", () => {
    const result = hook()({
      toolName: "bash",
      input: { command: "printf '@article{x}' >> references.bib" },
    });
    expect(result?.block).toBe(true);
    expect(hook()({
      toolName: "bash",
      input: { command: "cat /tmp/entry.bib > references.bib" },
    })?.block).toBe(true);
  });

  it("registers cite as a top-level tool, since the .bib is otherwise closed", () => {
    const { tool } = load();
    expect(tool.name).toBe("cite");
    // Discoverable would mean a model has to go looking for the only way to
    // add a citation at all.
    expect(tool.loadMode).toBe("essential");
    expect(tool.description).toMatch(/arXiv|DOI|title/);
  });

  it("says so plainly when Lattice did not pass its executable", async () => {
    const previous = process.env.LATTICE_BIN;
    delete process.env.LATTICE_BIN;
    const { tool } = load();
    const result = await tool.execute("call-1", { query: "1706.03762" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Papers box");
    if (previous !== undefined) process.env.LATTICE_BIN = previous;
  });

  it("reports the citation key the app returned", async () => {
    const previous = process.env.LATTICE_BIN;
    process.env.LATTICE_BIN = fakeLattice;
    const { tool } = load();
    const result = await tool.execute(
      "call-1",
      { query: '{"title":"Attention Is All You Need","citationKey":"vaswani2017attention","paperPath":".research/papers/1706.03762/paper.md","alreadyImported":false}' },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("\\cite{vaswani2017attention}");
    expect(result.content[0]?.text).toContain(".research/papers/1706.03762/paper.md");
    if (previous === undefined) delete process.env.LATTICE_BIN;
    else process.env.LATTICE_BIN = previous;
  });

  it("admits when a work has no full text rather than implying one", async () => {
    const previous = process.env.LATTICE_BIN;
    process.env.LATTICE_BIN = fakeLattice;
    const { tool } = load();
    const result = await tool.execute(
      "call-1",
      { query: '{"title":"The TeXbook","citationKey":"knuth1984texbook","paperPath":"","alreadyImported":false}' },
    );
    expect(result.content[0]?.text).toContain("no full text");
    if (previous === undefined) delete process.env.LATTICE_BIN;
    else process.env.LATTICE_BIN = previous;
  });

  it("surfaces a failure instead of pretending the reference was added", async () => {
    const previous = process.env.LATTICE_BIN;
    process.env.LATTICE_BIN = "/bin/false";
    const { tool } = load();
    const result = await tool.execute("call-1", { query: "nonsense" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Could not add that reference");
    if (previous === undefined) delete process.env.LATTICE_BIN;
    else process.env.LATTICE_BIN = previous;
  });
});
