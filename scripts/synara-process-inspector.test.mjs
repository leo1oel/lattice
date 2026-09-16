import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { patchProcessInspectorFailures } from "./synara-process-inspector.mjs";

const source = `function readCurrentCommands(pids) {
  const result = spawnProcessSync();
  if (result.error) return null;
  if (result.status !== 0) return /* @__PURE__ */ new Map();
  return parseProcessCommandMap(result.stdout);
}
function followingFunction() { return 42; }
`;

it.each([
  { status: 1, stderr: "Operation not permitted" },
  { status: null, signal: "SIGKILL" },
  { status: 2, stderr: "Unsupported arguments" },
  { error: new Error("timeout") },
])("keeps a failed host inspection unknown: %j", (result) => {
  const read = runInNewContext(`${patchProcessInspectorFailures(source)}; readCurrentCommands`, {
    process: { env: { SYNARA_PROCESS_PS_PATH: "/host/ps" } },
    spawnProcessSync: () => result,
  });
  expect(read([123])).toBeNull();
});

it("distinguishes a successful empty host snapshot from a read failure", () => {
  const read = runInNewContext(`${patchProcessInspectorFailures(source)}; readCurrentCommands`, {
    process: { env: { SYNARA_PROCESS_PS_PATH: "/host/ps" } },
    spawnProcessSync: () => ({ status: 0, stdout: "" }),
    parseProcessCommandMap: () => new Map(),
  });
  expect(read([123])).toEqual(new Map());
});

it("preserves the system ps missing-PID convention without a host inspector", () => {
  const read = runInNewContext(`${patchProcessInspectorFailures(source)}; readCurrentCommands`, {
    process: { env: {} }, spawnProcessSync: () => ({ status: 1 }), Map,
  });
  expect(read([123])).toEqual(new Map());
});

it("rejects upstream drift and double patching rather than silently losing the fix", () => {
  expect(() => patchProcessInspectorFailures("changed upstream")).toThrow();
  expect(() => patchProcessInspectorFailures(patchProcessInspectorFailures(source))).toThrow();
  expect(patchProcessInspectorFailures(source)).toContain("function followingFunction() { return 42; }");
});
