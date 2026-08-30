import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccessPolicy,
  createBootstrapDocument,
  createMutationQueue,
  isSameOriginBrowserRequest,
  replaceOpenSlideEditorFont,
  safeRelativePath,
} from "./server.mjs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

test("uses Inter Variable throughout the Open Slide editor stylesheet", () => {
  const source = `@import "@fontsource-variable/geist";
@theme inline {
  --font-sans: "Geist Variable", sans-serif;
  --font-heading: "Geist Variable", system-ui, sans-serif;
}`;
  const transformed = replaceOpenSlideEditorFont(
    source,
    "/runtime/node_modules/@open-slide/core/src/app/styles.css?direct",
  );
  assert.match(transformed, /@fontsource-variable\/inter/);
  assert.match(transformed, /"Inter Variable"/);
  assert.doesNotMatch(transformed, /Geist/);
  assert.equal(replaceOpenSlideEditorFont(source, "/project/styles.css"), null);
});

test("accepts normalized project-relative paths", () => {
  assert.equal(safeRelativePath("slides/intro.tsx"), "slides/intro.tsx");
  assert.equal(safeRelativePath("slides\\intro.tsx"), "slides/intro.tsx");
});

test("rejects traversal and absolute paths", () => {
  assert.equal(safeRelativePath("../secret"), null);
  assert.equal(safeRelativePath("slides/../../secret"), null);
  assert.equal(safeRelativePath("/tmp/secret"), null);
});

test("bootstraps a cookie-free session and removes an obsolete service worker", () => {
  const document = createBootstrapDocument("/s/talk");
  assert.match(document, /getRegistrations/);
  assert.match(document, /registration\.unregister/);
  assert.match(document, /location\.replace\(next\)/);
  assert.doesNotMatch(document, /serviceWorker\.register/);
  assert.doesNotMatch(document, /cookie/i);
});

test("accepts only browser requests originating from the activated loopback app", () => {
  const host = "127.0.0.1:4321";
  assert.equal(isSameOriginBrowserRequest({
    headers: { referer: "http://127.0.0.1:4321/s/talk" },
  }, host), true);
  assert.equal(isSameOriginBrowserRequest({
    headers: { origin: "http://127.0.0.1:4321" },
  }, host), true);
  assert.equal(isSameOriginBrowserRequest({
    headers: { "sec-fetch-site": "same-origin" },
  }, host), true);
  assert.equal(isSameOriginBrowserRequest({
    headers: { referer: "https://attacker.example/", "sec-fetch-site": "cross-site" },
  }, host), false);
});

test("keeps native mutations read-only until every active lease is writable", () => {
  const access = createAccessPolicy();
  const writer = "11111111-1111-1111-1111-111111111111";
  const reader = "22222222-2222-2222-2222-222222222222";
  assert.equal(access.writable(), false);
  access.update(writer, true);
  assert.equal(access.writable(), true);
  access.update(reader, false);
  assert.equal(access.writable(), false);
  access.update(reader, null);
  assert.equal(access.writable(), true);
});

test("does not report initial files or exact host mirror echoes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-"));
  try {
    await mkdir(path.join(root, "slides", "talk"), { recursive: true });
    const entry = path.join(root, "slides", "talk", "index.tsx");
    await writeFile(entry, "before");
    const queue = createMutationQueue(root, "secret");
    await queue.seed();
    await queue.enqueue("add", entry);
    await queue.sync([{ path: "slides/talk/index.tsx", kind: "write", text: "after" }]);
    await queue.enqueue("change", entry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streams host files into the shadow without retaining temporary files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-"));
  try {
    const queue = createMutationQueue(root, "secret");
    await queue.seed();
    await queue.syncFile(
      "slides/talk/index.tsx",
      Readable.from([Buffer.from("export "), Buffer.from("default []")]),
    );
    assert.equal(
      await readFile(path.join(root, "slides", "talk", "index.tsx"), "utf8"),
      "export default []",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streams the current page and inspector selection to Lattice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-"));
  try {
    const queue = createMutationQueue(root, "secret");
    const frames = [];
    queue.attach({
      on() {},
      write(frame) { frames.push(frame); return true; },
    });

    queue.reportCurrent({
      slideId: "research-update",
      pageIndex: 2,
      totalPages: 8,
      slideTitle: "Research update",
      view: "slides",
    });
    queue.reportCurrent({
      selection: { line: 42.8, column: 6.2, tagName: "H1", text: "  Q2   Roadmap  " },
    });

    const context = JSON.parse(frames.at(-1).split("data: ")[1]).context;
    assert.deepEqual(context, {
      slideId: "research-update",
      pageIndex: 2,
      pageNumber: 3,
      totalPages: 8,
      slideTitle: "Research update",
      view: "slides",
      pagePath: "slides/research-update/index.tsx",
      selection: { line: 42, column: 6, tagName: "h1", text: "Q2 Roadmap" },
      updatedAt: context.updatedAt,
    });
    assert.match(context.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
