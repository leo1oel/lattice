/**
 * End-to-end live-sharing check against a real sync server.
 *
 * Everything else about v2 sharing is unit-tested against fakes, which is what
 * let a guest sit in a room it had never activated — connected, materialized,
 * and invisible to everyone — without a single test noticing. This drives an
 * actual host and guest over the wire instead.
 *
 * Opt-in, because it needs a server running:
 *
 *   pnpm --dir collab-server dev
 *   LATTICE_COLLAB_LIVE=1 pnpm vitest run src/collab-live.integration.test.ts
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { MemoryCollabCredentialStore } from "./collab-credentials";
import { collabDeploymentOrigin } from "./collab-config";
import { createProjectV2, type NativeImportSourceV2 } from "./collab-import-v2";
import { acceptCollabInvitationV2 } from "./collab-join-v2";
import { parseCollabInvitationV2 } from "./collab-invitation-v2";
import { CollabProjectControllerV2 } from "./collab-project-v2";
import type { CollabPeer } from "./collab-session";
import { readCollabComments, writeCollabComments } from "./collab-comments";

const DEPLOYMENT = collabDeploymentOrigin("localhost:8787");

const MAIN_TEX = "\\documentclass{article}\n\\begin{document}\nHello shared world.\n\\end{document}\n";
const BIB = "@article{a,title={A}}\n";
// 1x1 transparent PNG.
const PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
), (c) => c.charCodeAt(0));

function source(): NativeImportSourceV2 {
  const files: Record<string, Uint8Array> = {
    "main.tex": new TextEncoder().encode(MAIN_TEX),
    "references.bib": new TextEncoder().encode(BIB),
    "figures/plot.png": PNG,
  };
  return {
    async inventory() {
      return [
        { path: "main.tex", kind: "text" as const },
        { path: "references.bib", kind: "text" as const },
        { path: "figures/plot.png", kind: "binary" as const },
      ];
    },
    async read(path: string) { return files[path]; },
  };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Offline durability is not what this checks, and jsdom has no IndexedDB. */
function memoryStore() {
  return {
    async load() { return undefined; },
    async loadCatalog() { return undefined; },
    async persistLocal() { /* no-op */ },
    async persistSnapshot() { /* no-op */ },
    async persistCatalog() { /* no-op */ },
    async deleteCovered() { return []; },
    async compactAck() { return []; },
    async export() { return undefined; },
  } as unknown as Parameters<typeof CollabProjectControllerV2.start>[0]["store"];
}

const live = Boolean(process.env.LATTICE_COLLAB_LIVE);

describe.skipIf(!live)("live collaboration against the local sync server", () => {
  it("imports a concurrent batch of binary files through the real coordinator and R2 path", async () => {
    const hostStore = new MemoryCollabCredentialStore();
    const paths = Array.from({ length: 12 }, (_, index) => `figures/plot-${index}.png`);
    const imported = await createProjectV2({
      deployment: DEPLOYMENT,
      projectName: "Concurrent binary import",
      source: {
        async inventory() {
          return [{ path: "main.tex", kind: "text" as const }, ...paths.map((path) => ({ path, kind: "binary" as const }))];
        },
        async read(path) { return path === "main.tex" ? new TextEncoder().encode(MAIN_TEX) : PNG; },
      },
      credentialStore: hostStore,
      onRecord: async () => {},
    });

    const host = await CollabProjectControllerV2.start({
      deployment: DEPLOYMENT,
      projectInstanceId: imported.projectInstanceId,
      credentialRef: imported.credentialRef,
      credentialStore: hostStore,
      permission: "host",
      displayName: "Ada",
      store: memoryStore(),
    });
    expect(host.fileCount()).toBe(paths.length + 1);
    host.destroy();
  }, 60_000);

  it("host and guest see one another correctly", async () => {
    const hostStore = new MemoryCollabCredentialStore();
    const guestStore = new MemoryCollabCredentialStore();
    let hostPeers: CollabPeer[] = [];
    let guestPeers: CollabPeer[] = [];
    let guestPermanentError: Error | undefined;

    // --- host: import the project and start sharing -----------------------
    let record!: { projectInstanceId: string; credentialRef: string };
    const imported = await createProjectV2({
      deployment: DEPLOYMENT,
      projectName: "Live check",
      source: source(),
      credentialStore: hostStore,
      onRecord: async (created) => { record = created; },
    });
    expect(imported.projectInstanceId).toBeTruthy();

    const host = await CollabProjectControllerV2.start({
      deployment: DEPLOYMENT,
      projectInstanceId: record.projectInstanceId,
      credentialRef: record.credentialRef,
      credentialStore: hostStore,
      permission: "host",
      displayName: "Ada",
      store: memoryStore(),
      eventsPollIntervalMs: 400,
      onPeers: (peers) => { hostPeers = peers; },
    });
    await host.openPath("main.tex");
    expect(host.activePath).toBe("main.tex");
    const invite = await host.createInvitation("write");
    expect(parseCollabInvitationV2(invite)?.projectInstanceId).toBe(record.projectInstanceId);

    // --- guest: accept, materialize, open ---------------------------------
    const guestRecord = await acceptCollabInvitationV2(invite, guestStore, { projectRoot: null });
    expect(guestRecord?.credentialRef).toBeTruthy();

    const guest = await CollabProjectControllerV2.start({
      deployment: guestRecord!.host,
      projectInstanceId: guestRecord!.projectInstanceId,
      credentialRef: guestRecord!.credentialRef!,
      credentialStore: guestStore,
      permission: "write",
      displayName: "Bo",
      store: memoryStore(),
      eventsPollIntervalMs: 400,
      onPeers: (peers) => { guestPeers = peers; },
      onPermanentError: (error) => { guestPermanentError = error; },
    });

    const written: Record<string, string> = {};
    const bytes: Record<string, number> = {};
    const lease = { projectRoot: "/tmp/live-check", generation: 1, isCurrent: () => true };
    const materialized = await guest.materializeProject(lease, {
      async writeText(path, content) { written[path] = content; },
      async writeBytes(path, value) { bytes[path] = value.byteLength; },
    });

    // Materialization must deliver every file, text and binary alike.
    expect(written["main.tex"]).toBe(MAIN_TEX);
    expect(written["references.bib"]).toBe(BIB);
    expect(bytes["figures/plot.png"]).toBe(PNG.byteLength);
    expect(materialized.openPath).toBe("main.tex");

    // What loadFile does once the workspace is on disk.
    await guest.openPath(materialized.openPath);
    expect(guest.activePath).toBe("main.tex");

    // Let both heartbeats land so the coordinator has both entries.
    await settle(1600);

    // --- the roster each side sees ----------------------------------------
    expect(guestPeers.map((peer) => peer.name)).toEqual(["Ada"]);
    expect(guestPeers[0].permission).toBe("host");
    expect(guestPeers[0].path).toBe("main.tex");

    expect(hostPeers.map((peer) => peer.name)).toEqual(["Bo"]);
    expect(hostPeers[0].permission).toBe("write");
    expect(hostPeers[0].path).toBe("main.tex");

    // Editing on one side reaches the other.
    guest.setActivePath("main.tex").insert(0, "% guest edit\n");
    await settle(1200);
    expect(host.setActivePath("main.tex").toString()).toContain("% guest edit");

    // Ending the room fences every open text socket. The guest must receive
    // the permanent reason immediately rather than waiting for catalog polling.
    await host.close();
    for (let i = 0; i < 40 && !guestPermanentError; i++) await settle(250);
    expect(guestPermanentError).toMatchObject({ code: "project_closed" });
    expect(guest.canWrite).toBe(false);

    guest.destroy();
    host.destroy();
  }, 60_000);

  // A sideloaded document is unpinned, so opening more files than the pool
  // holds evicts it — and an observer left on the destroyed document never
  // hears another word. That is what made one peer's resolve invisible to the
  // other. openCommentsDoc pins it for the session.
  it("keeps the comments document alive under open-file pressure", async () => {
    const hostStore = new MemoryCollabCredentialStore();
    const make = (id: string, at: string, resolved = false) => ({
      id, path: "main.tex", from: 0, to: 4, quote: "Hell", prefix: "", suffix: "",
      body: id, authorId: id, authorName: id, resolved, replies: [],
      createdAt: at, updatedAt: at,
    });

    let record!: { projectInstanceId: string; credentialRef: string };
    await createProjectV2({
      deployment: DEPLOYMENT, projectName: "Pinning", source: source(),
      credentialStore: hostStore, onRecord: async (created) => { record = created; },
    });
    const host = await CollabProjectControllerV2.start({
      deployment: DEPLOYMENT, projectInstanceId: record.projectInstanceId,
      credentialRef: record.credentialRef, credentialStore: hostStore,
      permission: "host", displayName: "Ada", store: memoryStore(),
      eventsPollIntervalMs: 400,
      // Smaller than the number of files this project has, so eviction is certain.
      poolCapacity: 1,
    });
    host.bindWorkspace({ projectRoot: "/tmp/live-pin", isCurrent: () => true }, {
      async writeText() {}, async writeBytes() {},
    });

    const doc = await host.openCommentsDoc();
    expect(doc).not.toBeNull();
    writeCollabComments(doc!, [make("c1", "2026-01-01T00:00:00.000Z")], []);

    // Churn every other file through the pool.
    for (const path of host.catalogTextPaths()) {
      if (path === ".research/editor-comments.json") continue;
      await host.openPath(path, "secondary", { sideload: true });
    }

    // Same document, still holding the comment — not a resurrected empty one.
    expect(await host.openCommentsDoc()).toBe(doc);
    expect(readCollabComments(doc!).map((c) => c.id)).toEqual(["c1"]);

    host.destroy();
  }, 60_000);

  // Comments live in `.research/editor-comments.json`, which the native
  // inventory deliberately excludes, so the file only enters the catalog when
  // someone writes the first comment during a share. If a peer never learns
  // about that file, their comments panel can never observe it.
  it("keeps both peers' comments and propagates a delete over the wire", async () => {
    const hostStore = new MemoryCollabCredentialStore();
    const guestStore = new MemoryCollabCredentialStore();
    const COMMENTS = ".research/editor-comments.json";
    const make = (id: string, at: string) => ({
      id, path: "main.tex", from: 0, to: 4, quote: "Hell", prefix: "", suffix: "",
      body: id, authorId: id, authorName: id, resolved: false, replies: [],
      createdAt: at, updatedAt: at,
    });

    let record!: { projectInstanceId: string; credentialRef: string };
    await createProjectV2({
      deployment: DEPLOYMENT, projectName: "Comments", source: source(),
      credentialStore: hostStore, onRecord: async (created) => { record = created; },
    });
    const host = await CollabProjectControllerV2.start({
      deployment: DEPLOYMENT, projectInstanceId: record.projectInstanceId,
      credentialRef: record.credentialRef, credentialStore: hostStore,
      permission: "host", displayName: "Ada", store: memoryStore(), eventsPollIntervalMs: 400,
    });
    await host.openPath("main.tex");
    host.bindWorkspace({ projectRoot: "/tmp/live-comments-host", isCurrent: () => true }, {
      async writeText() {}, async writeBytes() {},
    });
    const invite = await host.createInvitation("write");
    const guestRecord = await acceptCollabInvitationV2(invite, guestStore, { projectRoot: null });
    const guest = await CollabProjectControllerV2.start({
      deployment: guestRecord!.host, projectInstanceId: guestRecord!.projectInstanceId,
      credentialRef: guestRecord!.credentialRef!, credentialStore: guestStore,
      permission: "write", displayName: "Bo", store: memoryStore(), eventsPollIntervalMs: 400,
    });
    await guest.materializeProject(
      { projectRoot: "/tmp/live-comments-guest", isCurrent: () => true },
      { async writeText() {}, async writeBytes() {} },
    );

    // The host writes the first comment, which is what registers the file.
    await host.create(COMMENTS, "text", { seedText: "", adoptExisting: true });
    const hostDoc = (await host.openPath(COMMENTS, "secondary", { sideload: true })).doc!;
    writeCollabComments(hostDoc, [make("a1", "2026-01-01T00:00:00.000Z")], []);

    for (let i = 0; i < 40 && !guest.hasTextPath(COMMENTS); i++) await settle(250);
    const guestDoc = (await guest.openPath(COMMENTS, "secondary", { sideload: true })).doc!;
    for (let i = 0; i < 40 && readCollabComments(guestDoc).length === 0; i++) await settle(250);
    expect(readCollabComments(guestDoc).map((c) => c.id)).toEqual(["a1"]);

    // The guest adds its own without having to echo the host's back.
    writeCollabComments(guestDoc, [...readCollabComments(guestDoc), make("b1", "2026-01-01T00:00:01.000Z")], readCollabComments(guestDoc));
    for (let i = 0; i < 40 && readCollabComments(hostDoc).length < 2; i++) await settle(250);
    expect(readCollabComments(hostDoc).map((c) => c.id)).toEqual(["a1", "b1"]);

    // Deleting reaches the other side and stays deleted.
    writeCollabComments(hostDoc, readCollabComments(hostDoc).filter((c) => c.id !== "a1"), readCollabComments(hostDoc));
    for (let i = 0; i < 40 && readCollabComments(guestDoc).length > 1; i++) await settle(250);
    expect(readCollabComments(guestDoc).map((c) => c.id)).toEqual(["b1"]);

    guest.destroy();
    host.destroy();
  }, 60_000);

  it("makes a file created mid-share visible to the other peer", async () => {
    const hostStore = new MemoryCollabCredentialStore();
    const guestStore = new MemoryCollabCredentialStore();
    const COMMENTS = ".research/editor-comments.json";
    const payload = JSON.stringify({ schemaVersion: 1, comments: [{ id: "c1", body: "hh" }] });

    let record!: { projectInstanceId: string; credentialRef: string };
    await createProjectV2({
      deployment: DEPLOYMENT, projectName: "Mid-share create", source: source(),
      credentialStore: hostStore, onRecord: async (created) => { record = created; },
    });
    const host = await CollabProjectControllerV2.start({
      deployment: DEPLOYMENT, projectInstanceId: record.projectInstanceId,
      credentialRef: record.credentialRef, credentialStore: hostStore,
      permission: "host", displayName: "Ada", store: memoryStore(), eventsPollIntervalMs: 400,
    });
    await host.openPath("main.tex");
    const invite = await host.createInvitation("write");

    const guestRecord = await acceptCollabInvitationV2(invite, guestStore, { projectRoot: null });
    const guest = await CollabProjectControllerV2.start({
      deployment: guestRecord!.host, projectInstanceId: guestRecord!.projectInstanceId,
      credentialRef: guestRecord!.credentialRef!, credentialStore: guestStore,
      permission: "write", displayName: "Bo", store: memoryStore(), eventsPollIntervalMs: 400,
    });
    const lease = { projectRoot: "/tmp/live-check-2", generation: 1, isCurrent: () => true };
    await guest.materializeProject(lease, { async writeText() {}, async writeBytes() {} });

    expect(host.hasTextPath(COMMENTS)).toBe(false);
    host.bindWorkspace({ projectRoot: "/tmp/live-check-host", isCurrent: () => true }, {
      async writeText() {}, async writeBytes() {},
    });
    await host.create(COMMENTS, "text", { seedText: payload, adoptExisting: true });
    expect(host.hasTextPath(COMMENTS)).toBe(true);

    // The guest learns about it through the coordinator's event stream.
    for (let attempt = 0; attempt < 40 && !guest.hasTextPath(COMMENTS); attempt++) await settle(250);
    expect(guest.hasTextPath(COMMENTS)).toBe(true);

    const seen = await guest.openPath(COMMENTS, "secondary", { sideload: true });
    expect(seen.toString()).toContain("hh");

    guest.destroy();
    host.destroy();
  }, 60_000);
});
