import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync, readlinkSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mirrorTree } from "./mirror-tree.mjs";

let scratch, source, dest, manifest;

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "mirror-tree-"));
  source = path.join(scratch, "source");
  dest = path.join(scratch, "dest");
  manifest = path.join(scratch, "manifest.json");
  mkdirSync(source);
  mkdirSync(dest);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function put(root, file, content) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}
const read = (file) => readFileSync(path.join(dest, file), "utf8");
const mtime = (file) => statSync(path.join(dest, file)).mtimeMs;
// A time well before the test, as a file checked out last week would carry.
const weekAgo = () => new Date(Date.now() - 7 * 24 * 3600 * 1000);

describe("mirrorTree", () => {
  it("copies the listed files and nothing else", () => {
    put(source, "a.rs", "a");
    put(source, "dir/b.rs", "b");
    put(source, "ignored.log", "x");
    expect(mirrorTree(source, dest, ["a.rs", "dir/b.rs"], manifest)).toEqual({ written: 2, deleted: 0 });
    expect(read("a.rs")).toBe("a");
    expect(read("dir/b.rs")).toBe("b");
    expect(existsSync(path.join(dest, "ignored.log"))).toBe(false);
  });

  it("keeps an unchanged file's mtime and gives a changed one the current time, even when the source's is older", () => {
    const lastWeek = weekAgo();
    put(source, "same.rs", "same");
    put(source, "changed.rs", "old");
    mirrorTree(source, dest, ["same.rs", "changed.rs"], manifest);
    utimesSync(path.join(dest, "same.rs"), lastWeek, lastWeek);
    utimesSync(path.join(dest, "changed.rs"), lastWeek, lastWeek);

    put(source, "changed.rs", "new");
    // Another checkout's file can be older than the mirror's last build.
    utimesSync(path.join(source, "changed.rs"), lastWeek, lastWeek);
    expect(mirrorTree(source, dest, ["same.rs", "changed.rs"], manifest)).toEqual({ written: 1, deleted: 0 });

    expect(mtime("same.rs")).toBe(lastWeek.getTime());
    expect(read("changed.rs")).toBe("new");
    expect(mtime("changed.rs")).toBeGreaterThan(Date.now() - 60_000);
  });

  it("deletes what an earlier sync wrote and the source no longer lists, and leaves the rest of the mirror alone", () => {
    put(source, "keep.rs", "k");
    put(source, "gone/old.rs", "o");
    mirrorTree(source, dest, ["keep.rs", "gone/old.rs"], manifest);
    put(dest, "target/release/app", "built");

    expect(mirrorTree(source, dest, ["keep.rs"], manifest)).toEqual({ written: 0, deleted: 1 });
    expect(existsSync(path.join(dest, "gone"))).toBe(false);
    expect(read("target/release/app")).toBe("built");
  });

  it("treats a listed file missing from the source (deleted, not committed) as deleted", () => {
    put(source, "a.rs", "a");
    mirrorTree(source, dest, ["a.rs"], manifest);
    rmSync(path.join(source, "a.rs"));
    expect(mirrorTree(source, dest, ["a.rs"], manifest)).toEqual({ written: 0, deleted: 1 });
    expect(existsSync(path.join(dest, "a.rs"))).toBe(false);
  });

  it("replaces a file that became a directory, and the other way round", () => {
    put(source, "x", "file");
    put(source, "y/inner.rs", "inner");
    mirrorTree(source, dest, ["x", "y/inner.rs"], manifest);

    rmSync(path.join(source, "x"));
    rmSync(path.join(source, "y"), { recursive: true });
    put(source, "x/inner.rs", "now a dir");
    put(source, "y", "now a file");
    mirrorTree(source, dest, ["x/inner.rs", "y"], manifest);
    expect(read("x/inner.rs")).toBe("now a dir");
    expect(read("y")).toBe("now a file");
  });

  it("copies symlinks as links and keeps the executable bit", () => {
    put(source, "script/run", "#!/bin/sh\n");
    chmodSync(path.join(source, "script/run"), 0o755);
    symlinkSync("script/run", path.join(source, "link"));
    mirrorTree(source, dest, ["script/run", "link"], manifest);
    expect(readlinkSync(path.join(dest, "link"))).toBe("script/run");
    expect(statSync(path.join(dest, "script/run")).mode & 0o111).not.toBe(0);
  });

  it("still deletes, on the next sync, a file an interrupted sync wrote", () => {
    put(source, "a.rs", "a");
    mirrorTree(source, dest, ["a.rs"], manifest);
    put(source, "new.rs", "n");
    // An interrupted sync leaves the merged list it wrote before copying.
    writeFileSync(manifest, JSON.stringify(["a.rs", "new.rs"]));
    put(dest, "new.rs", "n");
    rmSync(path.join(source, "new.rs"));
    expect(mirrorTree(source, dest, ["a.rs"], manifest)).toEqual({ written: 0, deleted: 1 });
    expect(existsSync(path.join(dest, "new.rs"))).toBe(false);
  });
});
