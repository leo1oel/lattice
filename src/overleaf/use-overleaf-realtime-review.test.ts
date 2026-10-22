/**
 * Review over the live channel: our edits follow the project's
 * track-changes setting, the suggestions they and a collaborator's make show
 * at once and are swapped for Overleaf's own when the document is quiet, and
 * losing the project stops the reconnect loop.
 */
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCalls } from "../platform/tauri-test-mocks";
import type { TrackedChange } from "./overleaf-realtime-model";
import { isProvisional } from "./overleaf-suggestions";
import {
  advance, backend, cleanupRealtimeBackend, DOC_A, emit, mount, mountLive, OWN_HUE, OWN_USER_ID, resetRealtimeBackend, sends,
  typeAndSend,
} from "./use-overleaf-realtime-test-utils";
import { SUGGESTION_REFRESH_MS } from "./use-open-doc-review";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => {
  resetRealtimeBackend();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(cleanupRealtimeBackend);

const tracked = () => sends().map((send) => (send as { tracked?: boolean }).tracked);
const rangeReads = () => invokeCalls("overleaf_rt_doc_ranges");
const shown = (changes: TrackedChange[]) => changes
  .map((change) => `${change.deletion ? "-" : "+"}${change.position}:${change.text}:${change.userId}`)
  .sort();

describe("the project's track-changes setting", () => {
  it("leaves our typing as ordinary edits while it is off", async () => {
    const { result } = await mountLive();
    await typeAndSend(result, "alpha!");
    expect(tracked()).toEqual([false]);
    expect(result.current.changes).toEqual([]);
  });

  it("sends our typing as suggestions when it is on for this account", async () => {
    // Every edit used to go out untracked, so a writer's typing in a project
    // set to "track changes for everyone" landed as plain text for everyone.
    backend.trackChanges = true;
    const { result } = await mountLive();
    await typeAndSend(result, "alpha!");
    expect(tracked()).toEqual([true]);
  });

  it("follows the setting as someone turns it on and off", async () => {
    const { result } = await mountLive();
    emit({ type: "trackChangesToggled", on: true });
    await typeAndSend(result, "alpha!");
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    emit({ type: "trackChangesToggled", on: false });
    await typeAndSend(result, "alpha!?");
    expect(tracked()).toEqual([true, false]);
  });
});

describe("suggestions as they are made", () => {
  it("shows ours at once in our colour, then swaps in Overleaf's own once the edit is answered and typing stops", async () => {
    backend.trackChanges = true;
    const { result } = await mountLive();
    // "alpha" → "a!ha": "lp" suggested away, and "!" suggested in its place.
    await typeAndSend(result, "a!ha");
    expect(shown(result.current.changes)).toEqual([`+1:!:${OWN_USER_ID}`, `-1:lp:${OWN_USER_ID}`]);
    expect(result.current.changes.every((change) => isProvisional(change) && change.hue === OWN_HUE)).toBe(true);

    // Nothing is read back while our edit is unanswered: the server's ranges
    // would describe a version this copy is not at.
    await advance(SUGGESTION_REFRESH_MS * 3);
    expect(rangeReads()).toHaveLength(0);

    const server: TrackedChange[] = [
      { id: "real-del", position: 1, text: "lp", deletion: true, userId: OWN_USER_ID, timestamp: "t", hue: OWN_HUE },
      { id: "real-ins", position: 1, text: "!", deletion: false, userId: OWN_USER_ID, timestamp: "t", hue: OWN_HUE },
    ];
    backend.anchors = { comments: [], changes: server };
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await advance(SUGGESTION_REFRESH_MS);
    await waitFor(() => expect(result.current.changes).toEqual(server));
    expect(rangeReads()).toEqual([expect.objectContaining({ docId: DOC_A, version: 11 })]);
    // Real ids: nothing provisional is left, so nothing more is read.
    await advance(SUGGESTION_REFRESH_MS * 3);
    expect(rangeReads()).toHaveLength(1);
  });

  it("shows a collaborator's suggestion as one, not as plain text", async () => {
    const { result } = await mountLive();
    emit({ type: "docUpdate", docId: DOC_A, version: 10, ops: [{ p: 1, d: "lp" }], source: "them", suggestedBy: { userId: "them", hue: 40 } });
    await waitFor(() => expect(shown(result.current.changes)).toEqual(["-1:lp:them"]));
    expect(result.current.changes[0]!.hue).toBe(40);
    // Their plain edit stays plain.
    emit({ type: "docUpdate", docId: DOC_A, version: 11, ops: [{ p: 0, i: ">" }], source: "them" });
    await waitFor(() => expect(shown(result.current.changes)).toEqual(["-2:lp:them"]));
  });

  it("moves suggestions with typing that waits behind an unanswered edit", async () => {
    // "ha" in "alpha", suggested by someone else.
    backend.anchors = {
      comments: [],
      changes: [{ id: "c1", position: 3, text: "ha", deletion: false, userId: "them", timestamp: null, hue: 40 }],
    };
    const { result } = await mountLive();
    await waitFor(() => expect(result.current.changes).toHaveLength(1));
    await typeAndSend(result, "Xalpha");
    // Queued behind the first edit's answer: it used to leave the anchor behind.
    await act(async () => {
      result.current.pushLocal("YXalpha");
      vi.advanceTimersByTime(300);
    });
    expect(sends()).toHaveLength(1);
    expect(result.current.changes[0]).toMatchObject({ id: "c1", position: 5, text: "ha" });
  });
});

describe("losing the project", () => {
  it("stops reconnecting once Overleaf says this account can no longer open it", async () => {
    backend.connectFailures = 1;
    backend.connectError = "This Overleaf account can no longer open the project. It may have been removed from the project, or the project deleted.";
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("error"));
    await advance(60_000);
    expect(invokeCalls("overleaf_rt_connect")).toHaveLength(1);
    expect(result.current.detail).toMatch(/can no longer open the project/);
  });
});
