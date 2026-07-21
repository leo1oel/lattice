import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";
import { materializeCollabDocToProject, pushLocalTextToCollab } from "./collab-project-io";
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
    pushLocalTextToCollab(doc, "main.tex", "");
    expect(ytext.toString()).toBe("\\documentclass{article}\n");
  });

  it("updates when local content is non-empty", () => {
    const doc = new Y.Doc();
    ensureCollabText(doc, "main.tex");
    pushLocalTextToCollab(doc, "main.tex", "hello");
    expect(ensureCollabText(doc, "main.tex").toString()).toBe("hello");
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
