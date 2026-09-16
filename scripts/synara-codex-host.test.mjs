import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { patchCodexHostProcess } from "./synara-codex-host.mjs";

// The pinned bundle's relevant branches. Staging also rejects any drift in
// these anchors against the actual bundle, including its logger symbol.
const source = `
function spawnCodexAppServer(input) {
	const latticeBibGuard = ACTIVE_AGENT_HOST_PROFILE.id === "lattice" && process.platform === "darwin";
	return spawnProcess(latticeBibGuard ? "/usr/bin/sandbox-exec" : input.binaryPath,
		latticeBibGuard ? ["-p", "bib-profile", input.binaryPath, "app-server"] : ["app-server"], { env: input.env });
}
class Manager {
	attachProcessListeners(context) {
		context.child.stdout.once("end", () => this.handleTransportFailure(context));
		context.child.stderr.on("data", (chunk) => {
			if (context.stopping) return;
			const lines = chunk.toString().split(/\\r?\\n/g);
			for (const rawLine of lines) {
				const classified = classifyCodexStderrLine(rawLine);
				if (!classified) continue;
				this.emitErrorEvent(context, "process/stderr", classified.message);
			}
		});
		context.child.on("exit", (code, signal) => {
			if (context.stopping) return;
			const message = \`codex app-server exited (code=\${code ?? "null"}, signal=\${signal ?? "null"}).\`;
			this.updateSession(context, { lastError: message });
		});
	}
}
({ spawnCodexAppServer, Manager });
`;

function load({ platform = "darwin", host = "lattice", marker, patched = true } = {}) {
  const log = { warn: vi.fn(), info: vi.fn() };
  const exports = runInNewContext(patched ? patchCodexHostProcess(source) : source, {
    process: { platform, env: { LATTICE_BIBLIOGRAPHY_SANDBOX: marker } },
    ACTIVE_AGENT_HOST_PROFILE: { id: host },
    spawnProcess: (binary, args, options) => ({ binary, args, options }),
    classifyCodexStderrLine: (line) => line.trim() ? { message: line.trim() } : null,
    log$2: log,
  });
  return { ...exports, log };
}

it.each([
  [{ marker: "1" }, "/codex"],
  [{ marker: undefined }, "/usr/bin/sandbox-exec"],
  [{ marker: "0" }, "/usr/bin/sandbox-exec"],
  [{ marker: "true" }, "/usr/bin/sandbox-exec"],
  [{ platform: "linux" }, "/codex"],
  [{ host: "synara" }, "/codex"],
])("avoids only the inherited host's duplicate sandbox: %j", (config, binary) => {
  const { spawnCodexAppServer } = load(config);
  const result = spawnCodexAppServer({ binaryPath: "/codex", env: { KEEP: "value" } });
  expect(result.binary).toBe(binary);
  expect(result.options.env).toEqual({ KEEP: "value" });
  expect(result.args.at(-1)).toBe("app-server");
});

it("captures stderr and exit after stdout EOF without resurrecting a stopped session", () => {
  const { Manager, log } = load();
  const manager = new Manager();
  const context = { session: { threadId: "thread-test" }, stopping: false,
    child: Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) };
  manager.emitErrorEvent = vi.fn();
  manager.updateSession = vi.fn();
  manager.handleTransportFailure = () => { context.stopping = true; };
  manager.attachProcessListeners(context);
  context.child.stdout.emit("end");
  context.child.stderr.emit("data", Buffer.from("sandbox-exec: sandbox_apply: Operation not permitted\n"));
  context.child.emit("exit", 71, null);
  expect(log.warn).toHaveBeenCalledWith("codex app-server stderr", {
    threadId: "thread-test", message: "sandbox-exec: sandbox_apply: Operation not permitted",
  });
  expect(log.info).toHaveBeenCalledWith("codex app-server exit", {
    threadId: "thread-test", code: 71, signal: null, stopping: true,
  });
  expect(manager.emitErrorEvent).not.toHaveBeenCalled();
  expect(manager.updateSession).not.toHaveBeenCalled();
});

it("still reports stderr to an active thread", () => {
  const { Manager, log } = load();
  const manager = new Manager();
  manager.emitErrorEvent = vi.fn();
  const context = { session: { threadId: "active" }, stopping: false,
    child: Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) };
  manager.attachProcessListeners(context);
  context.child.stderr.emit("data", Buffer.from("\nactual failure\n"));
  expect(manager.emitErrorEvent).toHaveBeenCalledExactlyOnceWith(context, "process/stderr", "actual failure");
  expect(log.warn).toHaveBeenCalledOnce();
});

it("rejects upstream drift and double patching", () => {
  expect(() => patchCodexHostProcess("changed upstream")).toThrow();
  expect(() => patchCodexHostProcess(patchCodexHostProcess(source))).toThrow();
});
