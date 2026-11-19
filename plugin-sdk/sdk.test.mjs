import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { generate } from "./scripts/gen-types.mjs";
import { packFiles, packed, pluginFiles } from "./scripts/pack-plugin.mjs";
import { drifted } from "./scripts/sync-examples.mjs";

const sdk = resolve("plugin-sdk/lattice-plugin.mjs");

/** Run a plugin as Lattice does (minus the sandbox): NDJSON on stdio, with
 *  `answer` serving its host calls. */
function launch(main, answer = () => ({})) {
  const child = spawn(process.execPath, [main], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) {
      const { result, error } = answer(message.method, message.params);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result, error })}\n`);
    } else if (waiting.has(message.id)) {
      waiting.get(message.id)(message);
    } else if (message.method) {
      (waiting.get("notifications") ?? (() => {}))(message);
    }
  });
  const request = (id, method, params) =>
    new Promise((done) => {
      waiting.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const init = () => request(1, "initialize", { hostApiLevel: 1, hostApiCompat: 1, hostVersion: "test", plugin: {}, granted: {}, locale: "en", platform: "macos" });
  return { child, request, init, stderr: () => stderr, onNotification: (f) => waiting.set("notifications", f) };
}

function scratchPlugin(source) {
  const dir = mkdtempSync(join(tmpdir(), "lattice-sdk-"));
  const main = join(dir, "main.mjs");
  writeFileSync(main, source.replace("SDK", JSON.stringify(sdk)));
  return main;
}

describe("plugin SDK", () => {
  it("api.d.ts is generated from the committed schema", () => {
    const schema = JSON.parse(readFileSync("plugin-api/schema/level-1.json", "utf8"));
    expect(readFileSync("plugin-sdk/api.d.ts", "utf8")).toBe(generate(schema));
  });

  it("every example carries the current runtime and licence", () => {
    expect(drifted().map((d) => d.path)).toEqual([]);
  });

  it("answers initialize, runs a command and keeps stdout for the protocol", async () => {
    const plugin = launch(
      scratchPlugin(`import { definePlugin } from SDK;
        definePlugin({ commands: { hi: ({ input, context }) => { console.log("noise"); return { kind: "message", markdown: input + " " + context.project.name }; } } });`),
    );
    expect((await plugin.init()).result).toEqual({ apiLevel: 1 });
    const reply = await plugin.request(2, "command/run", { command: "hi", input: "hello", context: { project: { name: "Paper", bibliographies: [] } } });
    expect(reply.result).toEqual({ kind: "message", markdown: "hello Paper" });
    expect(plugin.stderr()).toContain("noise");
    plugin.child.kill();
  });

  it("refuses a host whose levels it cannot speak", async () => {
    const plugin = launch(scratchPlugin(`import { definePlugin } from SDK; definePlugin({ commands: {} });`));
    const reply = await plugin.request(1, "initialize", { hostApiLevel: 5, hostApiCompat: 3 });
    expect(reply.error.code).toBe(-32002);
    plugin.child.kill();
  });

  it("turns thrown errors, unknown commands and cancellation into JSON-RPC errors", async () => {
    const plugin = launch(
      scratchPlugin(`import { definePlugin, PluginError } from SDK;
        definePlugin({ commands: {
          fail: () => { throw new PluginError("Zotero is closed"); },
          wait: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ kind: "message", markdown: "late" }))),
        } });`),
    );
    await plugin.init();
    expect((await plugin.request(2, "command/run", { command: "fail", context: {} })).error).toMatchObject({ code: -32000, message: "Zotero is closed" });
    expect((await plugin.request(3, "command/run", { command: "nope", context: {} })).error.message).toContain("Unknown command");
    const waiting = plugin.request(4, "command/run", { command: "wait", context: {} });
    plugin.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 4 } })}\n`);
    expect((await waiting).error.code).toBe(-32800);
    plugin.child.kill();
  });

  it("packs a folder reproducibly, without tests or dot files", () => {
    const files = pluginFiles("examples/plugins/bib-check");
    expect(files.map((f) => f.path)).toEqual(["LICENSE", "README.md", "check.mjs", "lattice-plugin.mjs", "lattice-plugin.toml", "main.mjs"]);
    expect(packed(".github/x.mjs") || packed("a/.env") || packed("check.test.mjs")).toBe(false);
    const zip = packFiles(files);
    expect(packFiles([...files].reverse()).equals(zip)).toBe(true);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(12)).toBe(33);
    expect(zip.readUInt16LE(8)).toBe(0);
    expect(zip.subarray(30 + "LICENSE".length, 30 + "LICENSE".length + files[0].data.length).equals(files[0].data)).toBe(true);
    expect(zip.readUInt16LE(zip.length - 22 + 8)).toBe(files.length);
  });

  it("runs the bib-check example end to end over the protocol", async () => {
    const files = [
      {
        path: "refs.bib",
        entries: [
          { key: "knuth84", type: "article", line: 1, fields: { author: "Knuth", title: "Literate Programming", journal: "Comput. J.", year: "1984", doi: "https://doi.org/10.1093/COMJNL/27.2.97" } },
          { key: "Knuth84", type: "book", line: 9, fields: { title: "TeX", year: "84" } },
        ],
      },
    ];
    const plugin = launch(resolve("examples/plugins/bib-check/main.mjs"), (method) =>
      method === "bibliography/entries" ? { result: { files } } : { error: { code: -32601, message: "no" } },
    );
    const progress = [];
    plugin.onNotification((m) => progress.push(m));
    await plugin.init();
    const { result } = await plugin.request(2, "command/run", { command: "check", context: { project: { name: "P", bibliographies: ["refs.bib"] } } });
    expect(result.kind).toBe("diagnostics");
    expect(result.items.map((d) => d.code).sort()).toEqual(["bad-year", "doi-format", "duplicate-key", "missing-field", "missing-field"]);
    expect(result.summary).toBe("2 entries in 1 file: 4 problems.");
    expect(progress[0]).toMatchObject({ method: "progress", params: { message: "Reading the bibliography" } });
    plugin.child.kill();
  });
});
