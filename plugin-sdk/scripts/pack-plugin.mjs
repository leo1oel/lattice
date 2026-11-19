#!/usr/bin/env node
// Pack a plugin folder as the .zip Settings › Plugins › Install from URL
// takes, and print its SHA-256 to publish beside it:
//   node plugin-sdk/scripts/pack-plugin.mjs examples/plugins/bib-check dist/bib-check-0.1.0.zip
//
// The zip is reproducible: the same files give the same bytes on any machine,
// whatever their mtimes, owners or the order the file system lists them in.
// The plugin registry (leo1oel/lattice-plugins, scripts/pack.mjs) packs the
// tagged source with a copy of this code and requires the entry's sha256, so
// what a reviewer read is byte for byte what Lattice installs. Change both
// together: any difference here changes every registry hash.
//
// Entries are the regular files under the folder, sorted by path, minus tests
// (*.test.mjs) and anything under a dot-named file or folder. Each is deflated
// at level 9 with a fixed 1980-01-01 timestamp, Unix permissions 0644 (0755
// when the source is executable), and no extra fields.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { constants, crc32, deflateRawSync } from "node:zlib";

/** Whether `path` (relative, `/`-separated) goes into the pack. */
export function packed(path) {
  return !path.split("/").some((part) => part.startsWith(".")) && !path.endsWith(".test.mjs");
}

const sortFiles = (files) =>
  [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

/** The folder's packed files as `{ path, data, executable }`, sorted. */
export function pluginFiles(folder) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!packed(path)) continue;
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`${path} is a symlink; a plugin packs regular files only`);
      if (stat.isDirectory()) walk(full, path);
      else if (stat.isFile()) files.push({ path, data: readFileSync(full), executable: (stat.mode & 0o111) !== 0 });
    }
  };
  walk(resolve(folder), "");
  return sortFiles(files);
}

/** The zip of `files` (`{ path, data, executable }`), byte for byte reproducible. */
export function packFiles(files) {
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  const sorted = sortFiles(files);
  for (const file of sorted) {
    const name = Buffer.from(file.path, "utf8");
    const data = deflateRawSync(file.data, { level: constants.Z_BEST_COMPRESSION });
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: deflate
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // 00:00:00
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, zip 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((file.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [folder, out] = process.argv.slice(2);
  if (!folder || !out) {
    console.error("usage: pack-plugin.mjs <plugin folder> <out.zip>");
    process.exit(2);
  }
  const zip = packFiles(pluginFiles(folder));
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, zip);
  console.log(`${target}\nsha256 ${createHash("sha256").update(zip).digest("hex")}`);
}
