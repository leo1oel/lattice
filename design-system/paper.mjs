// The Lattice design system's Paper file, and a minimal client for the Paper
// desktop app's MCP server over stdio (`paper mcp`, the same server an agent
// connects to). PAPER_BIN overrides the binary; it defaults to
// ~/.paper/bin/paper, then `paper` on PATH. Used by export.mjs and
// screens/draw.mjs.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FILE_ID = "01M6EKRMTWZ2JD6ZHKF830MAVP";
export const FILE_URL = `https://app.paper.design/file/${FILE_ID}`;

function paperBinary() {
  if (process.env.PAPER_BIN) return process.env.PAPER_BIN;
  const local = join(homedir(), ".paper/bin/paper");
  return existsSync(local) ? local : "paper";
}

/** A minimal MCP client: newline-delimited JSON-RPC over the server's stdio. */
export async function connect() {
  const child = spawn(paperBinary(), ["mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lattice-design-system", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  /** Every Paper tool answers a file header object, then its payload. */
  const call = async (name, args) => {
    const result = await send("tools/call", { name, arguments: { fileId: FILE_ID, ...args } });
    const texts = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
    if (result.isError) throw new Error(`${name}: ${texts.join(" ")}`);
    const payload = (texts.length > 1 ? texts.slice(1).join("\n") : texts[0].slice(texts[0].indexOf("\n}\n") + 3)).trim();
    return payload.startsWith("{") || payload.startsWith("[") ? JSON.parse(payload) : payload;
  };
  return { call, close: () => child.kill() };
}
