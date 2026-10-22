/**
 * The mocked backend and helpers the `useOverleafRealtime` tests share. A test
 * file still declares its own `vi.mock` of `@tauri-apps/api/core` and
 * `/event`, and runs `resetRealtimeBackend` / `cleanupRealtimeBackend` around
 * each test.
 */
/* eslint-disable lingui/no-unlocalized-strings -- test-only code: mocked backend answers, never interface copy */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { invokeCalls, mockInvoke, mockListen } from "../platform/tauri-test-mocks";
import { useOverleafRealtime } from "./use-overleaf-realtime";

export const DOC_A = "doc-a";
export const DOC_B = "doc-b";
export const DOC_MD = "doc-md";
/** Our own account, and the colour Overleaf gives it. */
export const OWN_USER_ID = "me-user";
export const OWN_HUE = 210;

/** What the mocked backend answers; reset before each test, varied by the tests that need to. */
export const freshBackend = () => ({
  /** What Overleaf says this account may do. */
  permission: "readAndWrite",
  /** Overleaf's track-changes setting for this account when we connect. */
  trackChanges: false,
  /** The public connection id returned by the connect call, when known. */
  publicId: "me" as string | null,
  /** Simulate a server commit whose acknowledgement never reaches the command. */
  loseSendAck: false,
  /** Joins fail, as they do while the socket that carried a send is going down. */
  joinsFail: false,
  /** The lost send never reached Overleaf at all, so a replay holds nothing of ours. */
  lostSendMissing: false,
  /** Transient connection failures still to return before succeeding, and what they say. */
  connectFailures: 0,
  connectError: "network unavailable",
  /** A join held open to reproduce updates arriving before its snapshot resolves. */
  deferredJoin: null as { docId: string; promise: Promise<unknown> } | null,
  /** Comment and suggestion anchors the server reports on joining. */
  anchors: { comments: [] as unknown[], changes: [] as unknown[] },
  /**
   * Leaves wait for a server answer that has not arrived yet. A disconnect
   * rejects them the way the Rust client drains its pending requests when the
   * socket goes down underneath them.
   */
  holdLeaves: false,
  heldLeaves: [] as ((reason: Error) => void)[],
});
export let backend: ReturnType<typeof freshBackend>;
/** Feeds the hook the events the Rust side would emit, stamped with the project they came from. */
export let emit: (payload: Record<string, unknown>, projectRoot?: string) => void;

/** Every join, reduced to the version it resumed from. */
export const joins = () => invokeCalls("overleaf_rt_join_doc").map(({ docId, fromVersion }) => ({ docId, fromVersion: fromVersion ?? null }));
export const joinsOf = (docId: string) => joins().filter((join) => join.docId === docId);
export const sends = () => invokeCalls("overleaf_rt_send_ops") as { docId: string; version: number; ops: unknown[] }[];
export const leaves = () => invokeCalls("overleaf_rt_leave_doc").map(({ docId }) => docId);
export const expectLeft = (fields: Record<string, unknown>) =>
  expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", expect.objectContaining(fields));

export function joinAnswer(docId: string, fromVersion: number | null = null) {
  const { anchors } = backend;
  if (backend.joinsFail) throw new Error("the connection is closing");
  if (docId === DOC_A && fromVersion === 10 && backend.lostSendMissing && sends().length) {
    return { text: "alpha", version: 10, ...anchors, caughtUp: [], resumed: true };
  }
  if (docId === DOC_A && fromVersion === 10 && backend.loseSendAck && sends().length) {
    return { text: "alpha edited", version: 11, ...anchors, caughtUp: [{ version: 10, ops: sends()[0]!.ops, source: "me" }], resumed: true };
  }
  // The lost send did land: that is the server's copy from now on.
  if (docId === DOC_A && backend.loseSendAck && !backend.lostSendMissing && sends().length) {
    return { text: "alpha edited", version: 11, ...anchors, caughtUp: [], resumed: fromVersion === 11 };
  }
  return { text: docId === DOC_A ? "alpha" : "beta", version: 10, ...anchors, caughtUp: [], resumed: false };
}

/** Answer the realtime commands from a fresh mocked backend; call before each test. */
export function resetRealtimeBackend() {
  backend = freshBackend();
  const deliver = mockListen();
  emit = (payload, projectRoot = "/tmp/project") => deliver({ projectRoot, ...payload });
  mockInvoke({
    overleaf_rt_connect: () => {
      if (backend.connectFailures > 0) {
        backend.connectFailures -= 1;
        throw new Error(backend.connectError);
      }
      return {
        publicId: backend.publicId, docs: [{ id: DOC_A, path: "a.tex" }, { id: DOC_B, path: "b.tex" }], entities: [],
        permission: backend.permission, trackChanges: backend.trackChanges, userId: OWN_USER_ID, ownHue: OWN_HUE,
      };
    },
    overleaf_rt_join_doc: ({ docId, fromVersion }: { docId: string; fromVersion: number | null }) =>
      backend.deferredJoin?.docId === docId ? backend.deferredJoin.promise : joinAnswer(docId, fromVersion ?? null),
    overleaf_rt_send_ops: () => { if (backend.loseSendAck) throw new Error("ack lost"); },
    // Reading a document's ranges back: what the server holds now, at the version asked about.
    overleaf_rt_doc_ranges: ({ version }: { version: number }) =>
      ({ text: "", version, ...backend.anchors, caughtUp: [], resumed: true }),
    overleaf_rt_leave_doc: () => backend.holdLeaves
      ? new Promise((_, reject) => { backend.heldLeaves.push(reject); })
      : undefined,
    overleaf_rt_disconnect: () => {
      for (const reject of backend.heldLeaves.splice(0)) {
        reject(new Error("The Overleaf realtime connection closed before the server answered."));
      }
    },
    overleaf_set_permission: undefined,
  });
}

/** Unmount and forget the mocked answers; call after each test. */
export function cleanupRealtimeBackend() {
  // Unmount while IPC still returns promises, before the global locale reset
  // can notify a mounted hook and re-run its translated effects.
  cleanup();
  vi.mocked(invoke).mockReset();
}

export type Options = Parameters<typeof useOverleafRealtime>[0];

/** Live on a.tex in /tmp/project; `rerender` takes only the props that change. */
export function mount(overrides: Partial<Options> = {}) {
  return renderHook((props: Partial<Options>) => useOverleafRealtime({
    enabled: true,
    documents: true,
    projectRoot: "/tmp/project",
    activeFile: "a.tex",
    onRemoteText: () => undefined,
    onNotice: () => undefined,
    ...overrides,
    ...props,
  }), { initialProps: {} });
}

export type Hook = ReturnType<typeof mount>["result"];

/**
 * Type `text`, let the send debounce fire, and wait until the operation has
 * actually gone out. Needs fake timers. The first send from a document carries
 * a hash computed by WebCrypto, which settles on a worker thread rather than
 * as a microtask, so `act` alone can return before `overleaf_rt_send_ops` is
 * invoked and an answer emitted next would arrive before its own send.
 * Pass `sent: false` where the hook must not send at all.
 */
export async function typeAndSend(result: Hook, text: string, { sent = true } = {}) {
  const before = sends().length;
  await act(async () => {
    result.current.pushLocal(text);
    vi.advanceTimersByTime(300);
  });
  if (sent) await waitFor(() => expect(sends()).toHaveLength(before + 1));
}

export const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

/** Mount on a.tex and wait until it is live. */
export async function mountLive(overrides: Partial<Options> = {}) {
  const view = mount(overrides);
  await waitFor(() => expect(view.result.current.liveFile).toBe(true));
  return view;
}
