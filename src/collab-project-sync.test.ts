import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  classifySyncablePath,
  collabBlobsMap,
  collabDocHasProject,
  collabSyncedFileCount,
  endCollabShare,
  ensureCollabText,
  estimateBase64Bytes,
  isCollabShareActive,
  listSharedCollabPaths,
  listSyncableProjectPaths,
  normalizeCollabPath,
  observeCollabShareEnded,
  readCollabMeta,
  readTextsFromDoc,
  removeCollabPath,
  renameCollabPath,
  seedTextsIntoDoc,
  setCollabBlob,
  writeCollabMeta,
} from "./collab-project-sync";

describe("collab project sync catalog", () => {
  it("classifies text and blob paths and excludes agent/history", () => {
    expect(classifySyncablePath("main.tex")).toBe("text");
    expect(classifySyncablePath("references.bib")).toBe("text");
    expect(classifySyncablePath(".research/project.json")).toBe("text");
    expect(classifySyncablePath(".research/brief.md")).toBe("text");
    expect(classifySyncablePath(".research/papers/2401.00001/paper.md")).toBe("text");
    expect(classifySyncablePath("figures/plot.png")).toBe("blob");
    expect(classifySyncablePath("figures/diagram.pdf")).toBe("blob");
    expect(classifySyncablePath(".research/history/1.json")).toBeNull();
    expect(classifySyncablePath(".research/sessions/a.json")).toBeNull();
    expect(classifySyncablePath(".research/omp-sessions/x")).toBeNull();
    expect(classifySyncablePath(".research/pdf-annotations.json")).toBeNull();
    expect(classifySyncablePath(".research/editor-comments.json")).toBe("text");
  });

  it("lists syncable paths from the file tree plus paper sidecars", () => {
    const paths = listSyncableProjectPaths({
      files: [
        { path: "main.tex", kind: "tex" },
        { path: "references.bib", kind: "bib" },
        {
          path: "figures",
          kind: "directory",
          children: [{ path: "figures/a.png", kind: "png" }],
        },
        { path: ".research/history/skip.json", kind: "json" },
      ],
      paperIds: ["2401.00001"],
    });
    expect(paths.map((entry) => entry.path)).toEqual([
      ".research/brief.md",
      ".research/editor-comments.json",
      ".research/papers/2401.00001/metadata.json",
      ".research/papers/2401.00001/paper.md",
      ".research/project.json",
      "figures/a.png",
      "main.tex",
      "references.bib",
    ]);
    expect(paths.find((entry) => entry.path === "figures/a.png")?.kind).toBe("blob");
  });

  it("lists shared paths from texts and blobs", () => {
    const doc = new Y.Doc();
    seedTextsIntoDoc(doc, { "main.tex": "x" });
    setCollabBlob(doc, "figures/a.png", "image/png", "aGVsbG8=");
    expect([...listSharedCollabPaths(doc)].sort()).toEqual(["figures/a.png", "main.tex"]);
  });

  it("round-trips texts and meta on an in-memory Y.Doc", () => {
    const host = new Y.Doc();
    writeCollabMeta(host, {
      schemaVersion: 1,
      projectId: "p1",
      name: "Demo",
      manifestJson: JSON.stringify({ projectId: "p1", name: "Demo" }),
      rootDocument: "main.tex",
    });
    seedTextsIntoDoc(host, {
      "main.tex": "\\documentclass{article}",
      "references.bib": "@article{a, title={A}}",
      ".research/brief.md": "# Brief",
    });
    setCollabBlob(host, "figures/a.png", "image/png", "aGVsbG8=");

    expect(collabDocHasProject(host)).toBe(true);
    expect(collabSyncedFileCount(host)).toBe(4);
    expect(readCollabMeta(host)?.rootDocument).toBe("main.tex");

    const guest = new Y.Doc();
    const update = Y.encodeStateAsUpdate(host);
    Y.applyUpdate(guest, update);

    expect(readTextsFromDoc(guest)).toEqual({
      "main.tex": "\\documentclass{article}",
      "references.bib": "@article{a, title={A}}",
      ".research/brief.md": "# Brief",
    });
    expect(collabSyncedFileCount(guest)).toBe(4);
    expect(ensureCollabText(guest, "main.tex").toString()).toContain("documentclass");
  });

  it("normalizes map keys so raw paths hit the seeded entry", () => {
    const doc = new Y.Doc();
    seedTextsIntoDoc(doc, { "main.tex": "hello" });
    // A leading slash or backslash must resolve to the same shared text, not a
    // second duplicate entry.
    expect(ensureCollabText(doc, "/main.tex").toString()).toBe("hello");
    expect(ensureCollabText(doc, "main.tex").toString()).toBe("hello");
    expect(collabSyncedFileCount(doc)).toBe(1);
    expect(normalizeCollabPath("chapters\\a.tex")).toBe("chapters/a.tex");
    // A delete via a denormalized path still removes the seeded entry.
    removeCollabPath(doc, "/main.tex");
    expect(collabSyncedFileCount(doc)).toBe(0);
  });

  it("re-exporting a blob under the same path notifies peers (shallow observer fires)", () => {
    const doc = new Y.Doc();
    setCollabBlob(doc, "figures/a.png", "image/png", "aGVsbG8=");
    const seen: string[] = [];
    collabBlobsMap(doc).observe((event) => {
      event.changes.keys.forEach((_change, key) => seen.push(key));
    });
    // Update the SAME path with new bytes — previously this mutated the inner
    // map in place and fired no event, so peers kept the stale figure.
    setCollabBlob(doc, "figures/a.png", "image/png", "d29ybGQ=");
    expect(seen).toContain("figures/a.png");
    expect(String(collabBlobsMap(doc).get("figures/a.png")?.get("b64"))).toBe("d29ybGQ=");
  });

  it("estimates base64 payload size", () => {
    expect(estimateBase64Bytes("YQ==")).toBe(1);
    expect(estimateBase64Bytes("YWI=")).toBe(2);
    expect(estimateBase64Bytes("YWJj")).toBe(3);
  });

  it("renames shared text paths when a local file is renamed", () => {
    const doc = new Y.Doc();
    seedTextsIntoDoc(doc, { "chapters/a.tex": "hello" });
    renameCollabPath(doc, "chapters/a.tex", "chapters/b.tex");
    expect(readTextsFromDoc(doc)).toEqual({ "chapters/b.tex": "hello" });
  });

  it("marks share ended so guests can leave when the host stops", () => {
    const doc = new Y.Doc();
    writeCollabMeta(doc, {
      schemaVersion: 1,
      projectId: "p1",
      name: "Demo",
      manifestJson: "{}",
    });
    expect(isCollabShareActive(doc)).toBe(true);
    let ended = 0;
    const stop = observeCollabShareEnded(doc, () => {
      ended += 1;
    });
    expect(ended).toBe(0);
    endCollabShare(doc);
    expect(isCollabShareActive(doc)).toBe(false);
    expect(ended).toBe(1);
    endCollabShare(doc);
    expect(ended).toBe(1);
    stop();
  });
});
