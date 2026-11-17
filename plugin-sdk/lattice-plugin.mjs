// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Lattice contributors
//
// The Lattice plugin runtime: the JSON-RPC loop over stdin/stdout, so a
// plugin is a set of async command handlers. One file, no dependencies, so a
// plugin can copy it beside its own code (the sandbox lets a plugin read only
// its own folder). Types: ./index.d.ts. Protocol: docs/plugins.md.

/** An error to show the writer as the command's outcome. */
export class PluginError extends Error {}

/** A host call that failed; `code` is a JSON-RPC code (-32001 permission denied). */
export class HostError extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const API_LEVEL = 1;
const CANCELLED = -32800;

/**
 * Start the plugin. `commands` maps each command id in lattice-plugin.toml
 * to `async ({ input, context, host, signal }) => result`.
 */
export function definePlugin({ commands }) {
  const out = process.stdout;
  // stdout is the protocol; anything a dependency logs goes to stderr.
  for (const method of ["log", "info", "debug", "warn"]) {
    console[method] = (...args) => process.stderr.write(`${args.map(String).join(" ")}\n`);
  }
  const send = (message) => out.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const pending = new Map();
  const running = new Map();
  let nextId = 1;

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `p${nextId++}`;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params });
  const host = {
    bibliographyEntries: (file) => call("bibliography/entries", file ? { file } : {}),
    fetch: (request) => call("http/fetch", typeof request === "string" ? { url: request } : request),
    secret: async (name) => (await call("secrets/get", { name })).value ?? null,
    log: (level, message) => notify("log", { level, message: String(message) }),
    progress: (message, fraction) => notify("progress", fraction === undefined ? { message } : { message, fraction }),
  };

  async function run(id, params) {
    const handler = commands[params.command];
    const controller = new AbortController();
    running.set(id, controller);
    try {
      if (!handler) throw new PluginError(`Unknown command ${params.command}`);
      const result = await handler({ input: params.input ?? null, context: params.context, host, signal: controller.signal });
      if (controller.signal.aborted) return;
      send({ id, result });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      send({ id, error: { code: -32000, message } });
    } finally {
      running.delete(id);
    }
  }

  function receive(message) {
    if (message.method === "initialize") {
      const { hostApiLevel, hostApiCompat } = message.params;
      if (API_LEVEL < hostApiCompat || API_LEVEL > hostApiLevel) {
        send({ id: message.id, error: { code: -32002, message: "Unsupported API level", data: { supported: [API_LEVEL, API_LEVEL] } } });
      } else {
        send({ id: message.id, result: { apiLevel: API_LEVEL } });
      }
    } else if (message.method === "command/run") {
      run(message.id, message.params);
    } else if (message.method === "$/cancelRequest") {
      const controller = running.get(message.params?.id);
      if (controller) {
        controller.abort();
        send({ id: message.params.id, error: { code: CANCELLED, message: "Cancelled" } });
      }
    } else if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new HostError(message.error.message, message.error.code, message.error.data));
      else resolve(message.result);
    }
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) receive(JSON.parse(line));
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
