import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";
import {
  attachCollabProjectObservers,
  CollabTextConflictError,
  materializeCollabDocToProject,
  publishLocalTextToCollab,
  pushLocalTextToCollab,
} from "./collab-project-io";
import {
  ensureCollabText,
  setCollabTextContent,
  writeCollabMeta,
} from "./collab-project-sync";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("pushLocalTextToCollab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not clobber non-empty shared text with an empty buffer", () => {
    const doc = new Y.Doc();
    const ytext = ensureCollabText(doc, "main.tex");
    setCollabTextContent(ytext, "\\documentclass{article}\n");
    pushLocalTextToCollab(doc, "main.tex", "\\documentclass{article}\n", "");
    expect(ytext.toString()).toBe("\\documentclass{article}\n");
  });

  it("updates when local content is non-empty", () => {
    const doc = new Y.Doc();
    ensureCollabText(doc, "main.tex");
    pushLocalTextToCollab(doc, "main.tex", "", "hello");
    expect(ensureCollabText(doc, "main.tex").toString()).toBe("hello");
  });

  it("preserves a peer's concurrent edit when publishing a local buffer", () => {
    const host = new Y.Doc();
    const hostText = ensureCollabText(host, "main.tex");
    setCollabTextContent(hostText, "abc");
    const guest = new Y.Doc();
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));

    pushLocalTextToCollab(host, "main.tex", "abc", "aXbc");
    ensureCollabText(guest, "main.tex").insert(3, "Y");
    Y.applyUpdate(host, Y.encodeStateAsUpdate(guest));
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));

    expect(hostText.toString()).toBe("aXbcY");
    expect(ensureCollabText(guest, "main.tex").toString()).toBe("aXbcY");
  });

  it("preserves a peer edit that arrives before the local buffer is published", () => {
    const host = new Y.Doc();
    const hostText = ensureCollabText(host, "main.tex");
    setCollabTextContent(hostText, "abc");
    const guest = new Y.Doc();
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));

    ensureCollabText(guest, "main.tex").insert(3, "Y");
    Y.applyUpdate(host, Y.encodeStateAsUpdate(guest));
    expect(pushLocalTextToCollab(host, "main.tex", "abc", "aXbc")).toBe("aXbcY");
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));

    expect(hostText.toString()).toBe("aXbcY");
    expect(ensureCollabText(guest, "main.tex").toString()).toBe("aXbcY");
  });

  it("rejects overlapping whole-buffer edits instead of erasing either one", () => {
    const doc = new Y.Doc();
    const text = ensureCollabText(doc, "main.tex");
    setCollabTextContent(text, "abc");
    setCollabTextContent(text, "aYc");

    expect(pushLocalTextToCollab(doc, "main.tex", "abc", "aXc")).toBeNull();
    expect(text.toString()).toBe("aYc");
  });

  it("keeps Yjs unchanged when the merged disk write fails", async () => {
    const doc = new Y.Doc();
    const text = ensureCollabText(doc, "main.tex");
    setCollabTextContent(text, "abc");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));

    await expect(publishLocalTextToCollab(doc, "main.tex", "abc", "aXbc"))
      .rejects.toThrow("disk full");
    expect(text.toString()).toBe("abc");
  });

  it("re-merges when a peer edits while the disk write is in flight", async () => {
    const host = new Y.Doc();
    const hostText = ensureCollabText(host, "main.tex");
    setCollabTextContent(hostText, "abc");
    const guest = new Y.Doc();
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));
    vi.mocked(invoke).mockImplementationOnce(async () => {
      ensureCollabText(guest, "main.tex").insert(3, "Y");
      Y.applyUpdate(host, Y.encodeStateAsUpdate(guest));
      return null;
    });

    await expect(publishLocalTextToCollab(host, "main.tex", "abc", "aXbc"))
      .resolves.toBe("aXbcY");
    expect(hostText.toString()).toBe("aXbcY");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("saves a conflict copy and restores shared text on an overlapping disk edit", async () => {
    const doc = new Y.Doc();
    const text = ensureCollabText(doc, "main.tex");
    setCollabTextContent(text, "aYc");

    await expect(publishLocalTextToCollab(doc, "main.tex", "abc", "aXc"))
      .rejects.toBeInstanceOf(CollabTextConflictError);
    expect(text.toString()).toBe("aYc");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invoke).mock.calls[0]?.[1]).toMatchObject({ content: "aXc" });
    expect(vi.mocked(invoke).mock.calls[1]?.[1]).toEqual({ path: "main.tex", content: "aYc" });
  });

  it("reports only peer transactions as remote project edits", () => {
    const host = new Y.Doc();
    const hostText = ensureCollabText(host, "main.tex");
    setCollabTextContent(hostText, "abc");
    const guest = new Y.Doc();
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));
    const onRemoteText = vi.fn();
    const detach = attachCollabProjectObservers(host, {
      onRemoteText,
      onRemoteBlob: vi.fn(),
      onRemoteDelete: vi.fn(),
    });

    // y-codemirror uses a private object as its origin, so locality rather than
    // our string marker is what distinguishes a local keystroke from the wire.
    host.transact(() => hostText.insert(1, "X"), { yCollabOrigin: true });
    expect(onRemoteText).not.toHaveBeenCalled();

    ensureCollabText(guest, "main.tex").insert(3, "Y");
    Y.applyUpdate(host, Y.encodeStateAsUpdate(guest));
    expect(onRemoteText).toHaveBeenCalledTimes(1);
    expect(onRemoteText).toHaveBeenCalledWith("main.tex", "aXbcY");
    detach();
  });

  it("observes peer edits to a shared text that was created locally after attach", () => {
    const host = new Y.Doc();
    const guest = new Y.Doc();
    const onRemoteText = vi.fn();
    const detach = attachCollabProjectObservers(host, {
      onRemoteText,
      onRemoteBlob: vi.fn(),
      onRemoteDelete: vi.fn(),
    });

    pushLocalTextToCollab(host, "new.tex", "", "host");
    expect(onRemoteText).not.toHaveBeenCalled();
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));
    ensureCollabText(guest, "new.tex").insert(4, " + guest");
    Y.applyUpdate(host, Y.encodeStateAsUpdate(guest));

    expect(onRemoteText).toHaveBeenCalledTimes(1);
    expect(onRemoteText).toHaveBeenCalledWith("new.tex", "host + guest");
    detach();
  });
});

describe("materializeCollabDocToProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "write_project_file") return null;
      if (command === "write_project_bytes") return null;
      if (command === "read_project_file") throw new Error("missing");
      return null;
    });
  });

  it("writes shared files into the current workspace without deleting locals", async () => {
    const doc = new Y.Doc();
    writeCollabMeta(doc, {
      schemaVersion: 1,
      projectId: "host",
      name: "Host",
      manifestJson: "{}",
      rootDocument: "main.tex",
    });
    setCollabTextContent(ensureCollabText(doc, "main.tex"), "\\documentclass{article}\n");

    const result = await materializeCollabDocToProject(doc);

    expect(result.textCount).toBe(1);
    expect(result.rootDocument).toBe("main.tex");
    expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex",
      content: "\\documentclass{article}\n",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "delete_project_entry",
      expect.anything(),
    );
  });
});
