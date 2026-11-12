/**
 * Switching to another file and back while a co-author keeps typing in the
 * first, against a fake Overleaf that transforms, acknowledges and replays
 * operations the way the real one does.
 *
 * Coming back used to hand the file to regular sync whenever the writer's
 * last edit was still on its way as they left, or a co-author's operation
 * arrived while it was: the checkpoint written on leaving was older than the
 * text both sides held, so nothing proved a merge would not type an edit
 * twice. The document now leaves with the local copy's own text as its
 * checkpoint and resumes from the server's replay of what happened since.
 */
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { applyOverleafRemoteText } from "../app/overleaf-remote-text";
import type { AcceptExpectation } from "../app/use-document-store";
import { invokeCalls } from "../platform/tauri-test-mocks";
import { applyOps, transformBoth, type OtOp } from "./ot";
import { DOC_A, cleanupRealtimeBackend, emit, mount, resetRealtimeBackend, sends } from "./use-overleaf-realtime-test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const START = "Intro.\n\nMethods.\n\nResults.\n";
const FIRST_VERSION = 10;

/**
 * Overleaf's copy of a.tex. Each operation is transformed against everything
 * applied since the version it was built on, as the left side, the way the
 * document updater does it, and a join from a version it still reaches
 * replays every update since.
 */
class FakeOverleaf {
  text = START;
  history: { ops: OtOp[]; source: string }[] = [];
  /** The base copy on disk: what the last sync or leave checkpoint agreed a.tex held. */
  agreed: string | null = START;
  /** Every checkpoint a leave wrote. */
  checkpoints: string[] = [];
  /** Our operations, not yet reached by the server, oldest first. */
  incoming: { ops: OtOp[]; version: number }[] = [];
  /** Versions our operations were applied at, not yet acknowledged. */
  acks: number[] = [];
  /** The server can no longer replay from the versions it is asked for. */
  forgetsHistory = false;
  /** Replays leave out this version, as a history with a hole in it would. */
  replayHole: number | null = null;

  get version() { return FIRST_VERSION + this.history.length; }

  apply(ops: OtOp[], source: string, version = this.version): number {
    let incoming = ops;
    for (const accepted of this.history.slice(version - FIRST_VERSION)) incoming = transformBoth(incoming, accepted.ops)[0];
    this.text = applyOps(this.text, incoming)!;
    this.history.push({ ops: incoming, source });
    return this.version - 1;
  }

  /** The server reaches our oldest operation; its acknowledgement is yet to arrive. */
  land() {
    const { ops, version } = this.incoming.shift()!;
    this.acks.push(this.apply(ops, "me", version));
  }

  join(fromVersion: number | null) {
    const reachable = fromVersion !== null && !this.forgetsHistory && fromVersion >= FIRST_VERSION && fromVersion <= this.version;
    const caughtUp = reachable
      ? this.history.slice(fromVersion - FIRST_VERSION)
        .map(({ ops, source }, index) => ({ version: fromVersion + index, ops, source }))
        .filter((update) => update.version !== this.replayHole)
      : [];
    return {
      text: this.text, version: this.version, comments: [], changes: [], agreed: this.agreed,
      caughtUp, resumed: reachable && (caughtUp.length > 0 || fromVersion === this.version),
    };
  }
}

let overleaf: FakeOverleaf;
/** The open file, and a.tex's editor buffer and file on disk. */
let active: string;
let buffer: { text: string; saved: string };
let disk: string;

beforeEach(() => {
  resetRealtimeBackend();
  overleaf = new FakeOverleaf();
  active = "a.tex";
  buffer = { text: START, saved: START };
  disk = START;
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const fields = (args ?? {}) as Record<string, unknown>;
    if (fields.docId === DOC_A || fields.path === "a.tex") {
      if (command === "overleaf_rt_join_doc") return overleaf.join((fields.fromVersion as number | null) ?? null);
      if (command === "overleaf_rt_send_ops") {
        overleaf.incoming.push({ ops: fields.ops as OtOp[], version: fields.version as number });
        return undefined;
      }
      if (command === "overleaf_rt_leave_doc") {
        const checkpoint = fields.checkpoint as { text: string } | null;
        if (checkpoint) overleaf.checkpoints.push(overleaf.agreed = checkpoint.text);
        return undefined;
      }
      if (command === "write_project_file") {
        if (fields.expectedContent !== disk) throw new Error("The file changed on disk.");
        disk = fields.content as string;
        return undefined;
      }
    }
    if (command === "overleaf_rt_join_doc") {
      return { text: "beta", version: 1, comments: [], changes: [], caughtUp: [], resumed: false, agreed: null };
    }
    return base(command, args as never);
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanupRealtimeBackend();
});

const deps = {
  projectRef: { current: { root: "/tmp/project" } as never },
  projectOperationGenerationRef: { current: 1 },
  activeFileRef: { get current() { return active; } },
  sourceRef: { get current() { return buffer.text; } },
  savedSourceRef: { get current() { return buffer.saved; } },
  accept: (path: string, content: string, expect: AcceptExpectation) => {
    if (path !== active || (expect.saved !== undefined && buffer.saved !== expect.saved)) return false;
    if (expect.text !== undefined && buffer.text !== expect.text) return false;
    const shown = expect.show ? expect.show(buffer.text) : content;
    if (shown === null) return false;
    buffer = { text: shown, saved: content };
    return true;
  },
};

async function open() {
  const needsSync = vi.fn();
  const view = mount({
    onRemoteText: (text, context) => context.path === "a.tex" ? applyOverleafRemoteText(deps, text, context) : true,
    onNeedsSync: needsSync,
  });
  await waitFor(() => expect(view.result.current.liveFile).toBe(true));
  return { view, needsSync };
}
type View = Awaited<ReturnType<typeof open>>["view"];

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(20); });

/** The writer types in a.tex; it goes out on the next send tick. */
async function type(view: View, edit: (text: string) => string) {
  buffer = { ...buffer, text: edit(buffer.text) };
  act(() => view.result.current.pushLocal(buffer.text));
}
const sendTick = () => act(async () => { await vi.advanceTimersByTimeAsync(300); });

/** A co-author types into Overleaf's copy, and the update is broadcast. */
function coauthor(ops: OtOp[]) {
  const version = overleaf.apply(ops, "peer");
  emit({ type: "docUpdate", docId: DOC_A, version, ops: overleaf.history.at(-1)!.ops, source: "peer" });
}
const insertAfter = (anchor: string, text: string): OtOp[] => [{ p: overleaf.text.indexOf(anchor) + anchor.length, i: text }];

/** Overleaf applies our oldest operation, if it has not yet, and answers it. */
async function acknowledge() {
  if (!overleaf.acks.length) {
    // The first send of a document hashes its text on the way out, which takes
    // real time the fake clock does not advance: wait for it to arrive.
    await waitFor(() => expect(overleaf.incoming.length).toBeGreaterThan(0));
    overleaf.land();
  }
  emit({ type: "docAck", docId: DOC_A, version: overleaf.acks.shift()! });
  await settle();
}

/** Switch to b.tex; the editor saves a.tex on the way out. */
async function leave(view: View) {
  active = "b.tex";
  view.rerender({ activeFile: "b.tex" });
  disk = buffer.text;
  buffer = { ...buffer, saved: buffer.text };
  await settle();
}

async function comeBack(view: View) {
  active = "a.tex";
  const joined = invokeCalls("overleaf_rt_join_doc").length;
  view.rerender({ activeFile: "a.tex" });
  await waitFor(() => expect(invokeCalls("overleaf_rt_join_doc").length).toBeGreaterThan(joined));
  await settle();
  return invokeCalls("overleaf_rt_join_doc").at(-1)!.fromVersion;
}

const occurrences = (text: string, piece: string) => text.split(piece).length - 1;

/** Live on Overleaf's text again: nothing handed to sync, every piece of typing exactly once. */
async function expectLiveWith(view: View, needsSync: ReturnType<typeof vi.fn>, pieces: string[]) {
  await waitFor(() => expect(view.result.current.liveFile).toBe(true));
  expect(needsSync).not.toHaveBeenCalled();
  expect([buffer.text, disk]).toEqual([overleaf.text, overleaf.text]);
  for (const piece of pieces) expect(occurrences(overleaf.text, piece)).toBe(1);
}

describe("switching files and back while a co-author types", () => {
  it("resumes live, carrying the co-author's typing in once and the writer's never twice", async () => {
    const { view, needsSync } = await open();
    coauthor(insertAfter("Intro.", " Theirs 1."));
    await settle();
    await type(view, (text) => text.replace("Methods.", "Methods. Mine 1."));
    await sendTick();
    await waitFor(() => expect(sends()).toHaveLength(1));
    // While that is on its way, the co-author types again and the writer
    // keeps going, then leaves at once: "Mine 2." goes out as they leave.
    coauthor(insertAfter("Results.", " Theirs 2."));
    await settle();
    await type(view, (text) => text.replace("Mine 1.", "Mine 1. Mine 2."));
    await leave(view);
    const atLeave = buffer.text;
    // The document drains off screen: a co-author operation lands between our
    // two acknowledgements, and never reaches the disk.
    await acknowledge();
    coauthor(insertAfter("Intro.", " Theirs 3."));
    await acknowledge();
    // The checkpoint is the writer's text, not Overleaf's: regular sync must
    // not read "Theirs 3." as deleted here.
    await waitFor(() => expect(overleaf.checkpoints).toEqual([atLeave]));
    expect(atLeave).not.toContain("Theirs 3.");
    // Let go of now; the co-author keeps typing.
    coauthor(insertAfter("Results.", " Theirs 4."));
    coauthor(insertAfter("Theirs 4.", " Theirs 5."));

    const resumedFrom = await comeBack(view);
    expect(resumedFrom).not.toBeNull();
    await expectLiveWith(view, needsSync, ["Mine 1.", "Mine 2.", ...[1, 2, 3, 4, 5].map((n) => `Theirs ${n}.`)]);
    expect(sends()).toHaveLength(2);
  });

  it("carries the writer forward when they come back before their last edit was acknowledged", async () => {
    const { view, needsSync } = await open();
    await type(view, (text) => text.replace("Intro.", "Intro. Mine."));
    await leave(view);
    await waitFor(() => expect(sends()).toHaveLength(1));
    coauthor(insertAfter("Methods.", " Theirs 1."));
    coauthor(insertAfter("Intro.", " Theirs 2."));
    overleaf.land();

    // Back before the answer arrived: the replay carries their operations
    // and our own, applied after them.
    await comeBack(view);
    await expectLiveWith(view, needsSync, ["Mine.", "Theirs 1.", "Theirs 2."]);
    // The late acknowledgement of what the replay already answered changes nothing.
    await acknowledge();
    await expectLiveWith(view, needsSync, ["Mine.", "Theirs 1.", "Theirs 2."]);
    expect(sends()).toHaveLength(1);
  });

  it("takes in a co-author's typing that arrives while the writer is joining again", async () => {
    const { view, needsSync } = await open();
    await type(view, (text) => text.replace("Intro.", "Intro. Mine."));
    await leave(view);
    await acknowledge();
    await waitFor(() => expect(overleaf.checkpoints).toHaveLength(1));
    coauthor(insertAfter("Methods.", " Theirs 1."));
    // The join's answer is on its way back when the next update is broadcast.
    const join = overleaf.join.bind(overleaf);
    overleaf.join = (fromVersion) => {
      const answer = join(fromVersion);
      coauthor(insertAfter("Results.", " Theirs 2."));
      return answer;
    };
    await comeBack(view);
    await expectLiveWith(view, needsSync, ["Mine.", "Theirs 1.", "Theirs 2."]);
  });
});

describe("coming back when the replay cannot be trusted", () => {
  /** Leave settled with an edit in, and let the co-author type while away. */
  async function awayWhileTheyType() {
    const opened = await open();
    await type(opened.view, (text) => text.replace("Intro.", "Intro. Mine."));
    await leave(opened.view);
    await acknowledge();
    await waitFor(() => expect(overleaf.checkpoints).toHaveLength(1));
    coauthor(insertAfter("Methods.", " Theirs 1."));
    coauthor(insertAfter("Results.", " Theirs 2."));
    return opened;
  }
  /** An agent edits a.tex while it is not open, so the local copy moved on too. */
  const agentEdits = () => {
    disk = buffer.text.replace("Results.", "Results. Agent.");
    buffer = { text: disk, saved: disk };
  };

  it.each([
    ["can no longer replay from that version", () => { overleaf.forgetsHistory = true; }],
    ["replays with an update missing", () => { overleaf.replayHole = overleaf.version - 2; }],
    ["had its checkpoint moved by a sync since", () => {
      overleaf.agreed = disk = overleaf.text;
      buffer = { text: disk, saved: disk };
      coauthor(insertAfter("Intro.", " Theirs 3."));
    }],
  ])("falls back to regular sync, keeping the local edit, when the server %s", async (_label, breakIt) => {
    const { view, needsSync } = await awayWhileTheyType();
    breakIt();
    agentEdits();
    const local = buffer.text;
    await comeBack(view);
    await waitFor(() => expect(needsSync).toHaveBeenCalledWith(["a.tex"]));
    expect(view.result.current.liveFile).toBe(false);
    expect([buffer.text, disk]).toEqual([local, local]);
    expect(sends()).toHaveLength(1);
  });

  it.each([
    ["can no longer replay from that version", () => { overleaf.forgetsHistory = true; }],
    ["replays with an update missing", () => { overleaf.replayHole = overleaf.version - 2; }],
  ])("takes Overleaf's text as it is when the server %s and nothing changed here", async (_label, breakIt) => {
    const { view, needsSync } = await awayWhileTheyType();
    breakIt();
    await comeBack(view);
    await expectLiveWith(view, needsSync, ["Mine.", "Theirs 1.", "Theirs 2."]);
  });
});
