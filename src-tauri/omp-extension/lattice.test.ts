import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import latticeExtension from "./lattice";

let fakeLattice = "";
let scriptDirectory = "";

beforeAll(() => {
  scriptDirectory = mkdtempSync(join(tmpdir(), "lattice-literature-"));
  fakeLattice = join(scriptDirectory, "lattice");
  writeFileSync(fakeLattice, "#!/bin/sh\nprintf '%s' \"$LATTICE_FAKE_RESULT\"\n");
  chmodSync(fakeLattice, 0o755);
});

afterAll(() => rmSync(scriptDirectory, { recursive: true, force: true }));

function load() {
  type Hook = (event: { toolName: string; input: Record<string, unknown> }) =>
    | { block: true; reason: string }
    | undefined;
  let hook: Hook = () => undefined;
  const tools: Array<{ name: string; description: string; approval: string; loadMode: string; execute: Function }> = [];
  const schema: any = { describe: () => schema, optional: () => schema };
  latticeExtension({
    on: (_name: string, callback: Hook) => { hook = callback; },
    registerTool: (tool: any) => tools.push(tool),
    zod: {
      object: () => schema,
      string: () => schema,
      boolean: () => schema,
      number: () => schema,
    },
  } as never);
  return { hook, tools };
}

describe("Lattice literature extension", () => {
  it("registers exactly five concise essential tools", () => {
    const { tools } = load();
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_literature", "fetch_paper", "cite", "upgrade_bibliography", "remove_reference",
    ]);
    expect(tools.every((tool) => tool.loadMode === "essential")).toBe(true);
    expect(tools.every((tool) => tool.description.length < 200)).toBe(true);
    expect(tools[0]?.approval).toBe("read");
  });

  it("blocks direct writes and bibcite, but allows safe bibliography reads", () => {
    const { hook } = load();
    expect(hook({ toolName: "write", input: { path: "references.bib" } })?.block).toBe(true);
    expect(hook({ toolName: "bash", input: { command: "bibcite tidy references.bib" } })?.block).toBe(true);
    expect(hook({ toolName: "bash", input: { command: "cat references.bib" } })).toBeUndefined();
  });

  it("reports a missing executable", async () => {
    delete process.env.LATTICE_BIN;
    const result = await load().tools[0]!.execute("call", { query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("executable path");
  });

  it("routes through the dispatcher and exposes the exact cite command", async () => {
    process.env.LATTICE_BIN = fakeLattice;
    process.env.LATTICE_FAKE_RESULT = JSON.stringify({
      title: "Attention Is All You Need",
      citationKey: "vaswani2017attention",
      paperPath: ".research/papers/1706.03762/paper.md",
    });
    const cite = load().tools.find((tool) => tool.name === "cite")!;
    const result = await cite.execute("call", { query: "1706.03762" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("\\cite{vaswani2017attention}");
    expect(result.content[0].text).toContain(".research/papers/1706.03762/paper.md");
  });

  it("states when a cited work has no full text", async () => {
    process.env.LATTICE_BIN = fakeLattice;
    process.env.LATTICE_FAKE_RESULT = JSON.stringify({ title: "The TeXbook", citationKey: "knuth1984" });
    const cite = load().tools.find((tool) => tool.name === "cite")!;
    const result = await cite.execute("call", { query: "The TeXbook" });
    expect(result.content[0].text).toContain("no cached full text");
  });

  it("surfaces dispatcher failures", async () => {
    process.env.LATTICE_BIN = "/bin/false";
    const result = await load().tools[0]!.execute("call", { query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("search_literature failed");
  });
});
