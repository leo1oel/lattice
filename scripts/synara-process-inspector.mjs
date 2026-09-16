// The host inspector exits zero with empty output for absent PIDs. A nonzero
// exit means the snapshot failed, not that every captured descendant exited.
// Keep this narrow host-contract patch here until the pinned fork includes it.
export function patchProcessInspectorFailures(source) {
  const start = source.indexOf("function readCurrentCommands(pids) {");
  const end = source.indexOf("\nfunction ", start + 1);
  if (start < 0 || end < 0) {
    throw new Error("Could not locate Synara readCurrentCommands; re-check the process inspector patch");
  }
  const body = source.slice(start, end);
  const before = "if (result.status !== 0) return /* @__PURE__ */ new Map();";
  const after = "if (result.status !== 0) return process.env.SYNARA_PROCESS_PS_PATH ? null : new Map();";
  if (body.split(before).length !== 2) {
    throw new Error("Expected one Synara process exit-status check; re-check the process inspector patch");
  }
  return source.slice(0, start) + body.replace(before, after) + source.slice(end);
}
