/**
 * Two people typing in one live document at once, both without pausing: the
 * writer here through the real hook and the real remote-text delivery, a
 * co-author through a ShareJS client, both against a server that runs
 * ShareJS's `text` transform the way Overleaf's document updater does (and
 * the Rust mock, overleaf_rt/mock_ot.rs, transcribes).
 *
 * This is the collaboration audit's F1 repro turned regression: a co-author's
 * keystroke arriving within the send interval of the writer's last one used
 * to drop the file out of live editing into regular sync — seconds behind,
 * with a full project download each time and conflict markers for edits to
 * the same paragraph — and continuous typing sent nothing until a pause (F9).
 */
import { createHash } from "node:crypto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useEffect, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { applyOverleafRemoteText } from "../app/overleaf-remote-text";
import type { AcceptExpectation } from "../app/use-document-store";
import { mockInvoke, mockListen } from "../platform/tauri-test-mocks";
import { applyOps, OtDocument, transformBoth, type OtOp } from "./ot";
import { createOverleafConnectionStore } from "./overleaf-connection-store";
import { useOverleafRealtime } from "./use-overleaf-realtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
// Overleaf's update hash, computed synchronously so fake time stays in step with sends.
vi.mock("./overleaf-realtime-model", async (importOriginal) => ({
  ...await importOriginal<typeof import("./overleaf-realtime-model")>(),
  overleafDocHash: async (text: string) => sha1Blob(text),
}));

const sha1Blob = (text: string) => createHash("sha1").update(`blob ${text.length}\0${text}`).digest("hex");

const ROOT = "/tmp/project";
const DOC = "doc-main";
const PATH = "main.tex";
/** One way, per message. */
const NETWORK_MS = 30;
const WRITER_EVERY_MS = 150;
const COAUTHOR_EVERY_MS = 120;
const TYPING_MS = 5_000;
const STEP_MS = 10;

/**
 * Overleaf's document updater: each update arriving at version `v` is
 * transformed, as the left side, against every update applied since, then
 * applied; the hash is checked only when nothing had to be transformed.
 */
class ShareJsServer {
  private applied: OtOp[][] = [];
  constructor(public text: string, private readonly from: number) {}
  get version() { return this.from + this.applied.length; }
  submit(at: number, ops: OtOp[], hash?: string): { version: number; ops: OtOp[] } {
    if (at < this.from || at > this.version) throw new Error(`no version ${at}`);
    const concurrent = this.applied.slice(at - this.from);
    let op = ops;
    for (const other of concurrent) op = transformBoth(op, other)[0];
    const next = applyOps(this.text, op);
    if (next === null) throw new Error("delete mismatch");
    if (!concurrent.length && hash && hash !== sha1Blob(next)) throw new Error("hash mismatch");
    const version = this.version;
    this.text = next;
    this.applied.push(op);
    return { version, ops: op };
  }
}

/** The open file's buffer and saved text, with the open-documents store's compare-and-swap. */
function createBuffer(text: string, disk: { text: string }) {
  let state = { text, saved: text };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    type: (next: string) => set({ text: next }),
    save: () => {
      disk.text = state.text;
      set({ saved: state.text });
    },
    accept: (path: string, content: string, expect: AcceptExpectation) => {
      if (path !== PATH) return false;
      if (expect.text !== undefined && state.text !== expect.text) return false;
      if (expect.saved !== undefined && state.saved !== expect.saved) return false;
      const shown = expect.show ? expect.show(state.text) : content;
      if (shown === null) return false;
      set({ text: shown, saved: content });
      return true;
    },
  };
}

type Scenario = { start: string; writerAfter: string; coauthorAfter: string };

const SAME_PARAGRAPH: Scenario = {
  start: "We study W> how attention C> scales.\n\nRelated work follows.\n",
  writerAfter: "W>", coauthorAfter: "C>",
};
const OTHER_PARAGRAPHS: Scenario = {
  start: "We study W> how attention scales.\n\nRelated work C> follows.\n",
  writerAfter: "W>", coauthorAfter: "C>",
};
/** Both typing at the very same spot: every keystroke is a tie the transform has to break the server's way. */
const SAME_SPOT: Scenario = {
  start: "We study X> how attention scales.\n\nRelated work follows.\n",
  writerAfter: "X>", coauthorAfter: "X>",
};

const WRITER_TYPES = "the writer keeps typing while a co-author types too ";
const COAUTHOR_TYPES = "and the co-author types along without pausing at all ";

/** `typed` arriving one character at a time right after `marker` (or after the run before it). */
const typeAt = (text: string, marker: string, typed: number, char: string) => {
  const at = text.indexOf(marker) + marker.length + typed;
  return text.slice(0, at) + char + text.slice(at);
};

async function run(scenario: Scenario) {
  const server = new ShareJsServer(scenario.start, 10);
  const disk = { text: scenario.start };
  const buffer = createBuffer(scenario.start, disk);
  const needsSync: string[][] = [];
  const notices: string[] = [];
  const otErrors: string[] = [];
  const deliver = mockListen();
  const emit = (payload: Record<string, unknown>) => deliver({ projectRoot: ROOT, ...payload });
  const later = (run: () => void) => setTimeout(run, NETWORK_MS);

  // The co-author: a ShareJS client of its own.
  const coauthor = new OtDocument(server.text, server.version);
  const coauthorSend = (send: { version: number; ops: OtOp[] } | null) => {
    if (!send) return;
    later(() => {
      const applied = server.submit(send.version, send.ops);
      later(() => emit({ type: "docUpdate", docId: DOC, version: applied.version, ops: applied.ops, source: "peer" }));
      later(() => coauthorSend(coauthor.acknowledge(applied.version).send));
    });
  };

  mockInvoke({
    overleaf_rt_connect: () => ({
      publicId: "me", docs: [{ id: DOC, path: PATH }], entities: [], permission: "readAndWrite",
      trackChanges: false, userId: "me-user", ownHue: 210,
    }),
    overleaf_rt_join_doc: () => ({
      text: server.text, version: server.version, comments: [], changes: [], caughtUp: [], resumed: false,
    }),
    overleaf_rt_send_ops: ({ version, ops, hash }: Record<string, unknown>) => {
      later(() => {
        try {
          const applied = server.submit(version as number, ops as OtOp[], hash as string | undefined);
          later(() => emit({ type: "docAck", docId: DOC, version: applied.version }));
          later(() => coauthor.remote(applied.ops, applied.version));
        } catch (reason) {
          otErrors.push(String(reason));
          later(() => emit({ type: "otError", docId: DOC, message: String(reason) }));
        }
      });
    },
    write_project_file: ({ content, expectedContent }: Record<string, unknown>) => {
      if (expectedContent !== undefined && expectedContent !== disk.text) throw new Error("The file changed on disk.");
      disk.text = content as string;
    },
    overleaf_rt_leave_doc: undefined,
    overleaf_rt_disconnect: undefined,
    overleaf_set_permission: undefined,
  });

  const store = createOverleafConnectionStore();
  const view = renderHook(() => {
    const realtime = useOverleafRealtime({
      store, enabled: true, documents: true, projectRoot: ROOT, activeFile: PATH,
      onRemoteText: (text, context) => applyOverleafRemoteText({
        projectRef: { current: { root: ROOT } as never },
        projectOperationGenerationRef: { current: 1 },
        activeFileRef: { current: PATH },
        sourceRef: { get current() { return buffer.get().text; } },
        savedSourceRef: { get current() { return buffer.get().saved; } },
        accept: buffer.accept,
      }, text, context),
      onNotice: (message) => notices.push(message),
      onNeedsSync: (paths) => needsSync.push([...paths]),
    });
    // As useOverleafWorkspace does: everything typed goes to the live channel.
    const { text } = useSyncExternalStore(buffer.subscribe, buffer.get);
    const { liveFile, pushLocal } = realtime;
    useEffect(() => {
      if (liveFile) pushLocal(text);
    }, [liveFile, pushLocal, text]);
    return realtime;
  });
  await waitFor(() => expect(view.result.current.liveFile).toBe(true));
  vi.useFakeTimers();

  const start = Date.now();
  const typedAt = { writer: [] as number[], coauthor: [] as number[] };
  const seenAt = { writer: [] as number[], coauthor: [] as number[] };
  let writerTyped = 0;
  let coauthorTyped = 0;
  let leftLive = false;
  const typedRun = (who: "writer" | "coauthor", count: number) => (who === "writer" ? WRITER_TYPES : COAUTHOR_TYPES).slice(0, count);
  const observe = () => {
    const now = Date.now() - start;
    // The writer's keystroke has landed once Overleaf holds it; the co-author's once the writer's buffer shows it.
    for (let k = seenAt.writer.length; k < writerTyped && server.text.includes(typedRun("writer", k + 1)); k += 1) seenAt.writer.push(now);
    for (let k = seenAt.coauthor.length; k < coauthorTyped && buffer.get().text.includes(typedRun("coauthor", k + 1)); k += 1) seenAt.coauthor.push(now);
    if (needsSync.length || otErrors.length) leftLive = true;
  };
  // Same-spot typing interleaves the two runs, so they are checked by what survives, not by when.
  const contiguous = scenario.writerAfter !== scenario.coauthorAfter;

  for (let elapsed = 0; elapsed < TYPING_MS + 3_000; elapsed += STEP_MS) {
    await act(async () => {
      if (elapsed < TYPING_MS && elapsed % WRITER_EVERY_MS === 0 && writerTyped < WRITER_TYPES.length) {
        buffer.type(typeAt(buffer.get().text, scenario.writerAfter, contiguous ? writerTyped : 0, WRITER_TYPES[writerTyped]!));
        typedAt.writer.push(Date.now() - start);
        writerTyped += 1;
      }
      if (elapsed < TYPING_MS && elapsed % COAUTHOR_EVERY_MS === 0 && coauthorTyped < COAUTHOR_TYPES.length) {
        const next = typeAt(coauthor.text, scenario.coauthorAfter, contiguous ? coauthorTyped : 0, COAUTHOR_TYPES[coauthorTyped]!);
        coauthorSend(coauthor.local(next).send);
        typedAt.coauthor.push(Date.now() - start);
        coauthorTyped += 1;
      }
      // Autosave now and then, as the editor does.
      if (elapsed % 1_000 === 500) buffer.save();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });
    observe();
  }

  const latency = (who: "writer" | "coauthor") => {
    const delays = seenAt[who].map((seen, k) => seen - typedAt[who][k]!).sort((left, right) => left - right);
    return {
      landed: `${delays.length}/${typedAt[who].length}`,
      p50: delays[Math.floor(delays.length / 2)] ?? null,
      max: delays.at(-1) ?? null,
    };
  };
  const result = {
    leftLive, needsSync: needsSync.length, otErrors: otErrors.length,
    stillLive: view.result.current.liveFile,
    writer: latency("writer"), coauthor: latency("coauthor"),
    converged: buffer.get().text === server.text && coauthor.text === server.text,
    conflictMarkers: server.text.includes("<<<<<<<") || buffer.get().text.includes("<<<<<<<"),
    notices,
  };
  vi.useRealTimers();
  return { result, server, buffer, coauthor, writerTyped, coauthorTyped, contiguous };
}

beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe("both writers typing at once in a live document", () => {
  it.each([
    ["the same paragraph", SAME_PARAGRAPH],
    ["different paragraphs", OTHER_PARAGRAPHS],
    ["the very same spot", SAME_SPOT],
  ])("stays live and keeps both people's text when typing in %s", async (_label, scenario) => {
    const { result, server, writerTyped, coauthorTyped, contiguous } = await run(scenario);
    if (process.env.OT_CONCURRENCY_REPORT) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.OT_CONCURRENCY_REPORT, `${JSON.stringify({ scenario: _label, ...result })}\n`);
    }
    expect(result).toMatchObject({ leftLive: false, needsSync: 0, otErrors: 0, stillLive: true, converged: true, conflictMarkers: false });
    expect(result.notices).toEqual([]);
    if (contiguous) {
      expect(server.text).toContain(WRITER_TYPES.slice(0, writerTyped));
      expect(server.text).toContain(COAUTHOR_TYPES.slice(0, coauthorTyped));
      // Every keystroke reached the other side, and soon: the send interval
      // plus a round trip, never a pause in typing or a regular sync.
      expect(result.writer.landed).toBe(`${writerTyped}/${writerTyped}`);
      expect(result.coauthor.landed).toBe(`${coauthorTyped}/${coauthorTyped}`);
      expect(result.writer.max).toBeLessThanOrEqual(600);
      expect(result.coauthor.max).toBeLessThanOrEqual(300);
    } else {
      // Interleaved at one spot, but nothing typed went missing.
      const count = (text: string) => [...text].length;
      expect(count(server.text)).toBe(count(scenario.start) + writerTyped + coauthorTyped);
    }
  }, 60_000);
});
