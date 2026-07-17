import { describe, expect, it } from "vitest";
import latticeExtension from "./lattice";

type ToolEvent = { toolName: string; input: Record<string, unknown> };
type HookResult = { block: true; reason: string } | undefined;

function hook() {
  let callback: ((event: ToolEvent) => HookResult) | undefined;
  latticeExtension({
    on: (_name: string, next: (event: ToolEvent) => HookResult) => {
      callback = next;
    },
  } as never);
  if (!callback) throw new Error("The tool hook was not registered.");
  return callback;
}

describe("Lattice Pi extension", () => {
  it("blocks direct bibliography writes and points the agent to bibcite", () => {
    const result = hook()({ toolName: "edit", input: { path: "references.bib" } });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("bibcite skill");
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
});
