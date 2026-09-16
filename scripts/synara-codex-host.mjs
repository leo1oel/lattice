// Keep these host integration fixes fail-closed against the pinned bundle until
// the fork incorporates them. Do not remove the standalone bibliography guard.
export function patchCodexHostProcess(source) {
  const replacements = [
    [
      'const latticeBibGuard = ACTIVE_AGENT_HOST_PROFILE.id === "lattice" && process.platform === "darwin";',
      'const latticeBibGuard = ACTIVE_AGENT_HOST_PROFILE.id === "lattice" && process.platform === "darwin" && process.env.LATTICE_BIBLIOGRAPHY_SANDBOX !== "1";',
    ],
    [
      '\t\tcontext.child.stderr.on("data", (chunk) => {\n\t\t\tif (context.stopping) return;\n\t\t\tconst lines = chunk.toString().split(/\\r?\\n/g);',
      '\t\tcontext.child.stderr.on("data", (chunk) => {\n\t\t\tconst lines = chunk.toString().split(/\\r?\\n/g);',
    ],
    [
      '\t\t\t\tif (!classified) continue;\n\t\t\t\tthis.emitErrorEvent(context, "process/stderr", classified.message);',
      '\t\t\t\tif (!classified) continue;\n\t\t\t\tlog$2.warn("codex app-server stderr", { threadId: context.session.threadId, message: classified.message });\n\t\t\t\tif (!context.stopping) this.emitErrorEvent(context, "process/stderr", classified.message);',
    ],
    [
      '\t\tcontext.child.on("exit", (code, signal) => {\n\t\t\tif (context.stopping) return;\n\t\t\tconst message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;',
      '\t\tcontext.child.on("exit", (code, signal) => {\n\t\t\tlog$2.info("codex app-server exit", { threadId: context.session.threadId, code, signal, stopping: context.stopping });\n\t\t\tif (context.stopping) return;\n\t\t\tconst message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;',
    ],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) {
      throw new Error("Expected one Codex host process patch target; re-check the pinned Synara bundle");
    }
    source = source.replace(before, after);
  }
  return source;
}
