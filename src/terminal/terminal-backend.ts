/**
 * The terminals' host side over Tauri (src-tauri/src/ipc/terminal.rs). Output
 * arrives on a channel per terminal: raw bytes, in order, then one JSON
 * `{"exit": code}` when the shell ends by itself.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { TerminalBackend } from "./terminal-sessions";

/** A paste goes over in pieces: the host takes at most 256 KB of typing per request. */
const WRITE_CHARS = 32 * 1024;

const writing = new Map<number, Promise<void>>();

/** `data` in pieces of at most WRITE_CHARS, never splitting a surrogate pair. */
function pieces(data: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + WRITE_CHARS, data.length);
    const code = data.charCodeAt(end - 1);
    if (end < data.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    out.push(data.slice(start, end));
    start = end;
  }
  return out;
}

function isExit(message: unknown): message is { exit: number | null } {
  return typeof message === "object" && message !== null && "exit" in message;
}

export const tauriTerminalBackend: TerminalBackend = {
  open: async ({ projectRoot, cols, rows, onOutput, onExit }) => {
    const channel = new Channel<ArrayBuffer | { exit: number | null }>();
    channel.onmessage = (message) => {
      if (message instanceof ArrayBuffer) onOutput(new Uint8Array(message));
      else if (ArrayBuffer.isView(message)) onOutput(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
      else if (Array.isArray(message)) onOutput(Uint8Array.from(message as number[]));
      else if (isExit(message)) onExit(typeof message.exit === "number" ? message.exit : null);
    };
    return invoke<{ id: number; shell: string }>("terminal_open", { projectRoot, cols, rows, onOutput: channel });
  },
  // Each terminal's writes go one after another, so a long paste's pieces
  // and the keys typed after it reach the shell in order.
  write: (id, data) => {
    const sent = (writing.get(id) ?? Promise.resolve()).then(async () => {
      for (const piece of pieces(data)) await invoke("terminal_write", { id, data: piece });
    });
    const settled = sent.catch(() => {});
    writing.set(id, settled);
    void settled.then(() => {
      if (writing.get(id) === settled) writing.delete(id);
    });
    return sent;
  },
  resize: (id, cols, rows) => invoke("terminal_resize", { id, cols, rows }),
  ack: (id, bytes) => invoke("terminal_ack", { id, bytes }),
  runningCommand: (id) => invoke<string | null>("terminal_running_command", { id }),
  close: (id) => invoke("terminal_close", { id }),
};
