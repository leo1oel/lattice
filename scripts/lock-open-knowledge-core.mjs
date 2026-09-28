#!/usr/bin/env node
/**
 * Record and verify the reviewed Open Knowledge core subset.
 *
 * Unlike the app layer, this tree is a three-way-maintained subset rather than
 * regeneratable output. The lock records both the upstream v0.66.2 hash and
 * the reviewed Lattice hash for every local file, so unchanged upstream files,
 * intentional overrides, and Lattice-only files remain distinguishable.
 *
 * Usage:
 *   node scripts/lock-open-knowledge-core.mjs --write --revision=v0.66.2
 *   node scripts/lock-open-knowledge-core.mjs --check
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { capture, projectRoot, readJson, walkFiles, writeJson } from './lib/util.mjs';

const DEST = path.join(projectRoot, 'src/open-knowledge-core');
const LOCK = path.join(projectRoot, 'open-knowledge-core.lock.json');
const UPSTREAM = path.join(homedir(), '.cache/research-writer/open-knowledge');
const SOURCE_ROOT = 'packages/core/src';

const write = process.argv.includes('--write');
const check = process.argv.includes('--check');
const revisionArgument = process.argv.find((argument) => argument.startsWith('--revision='));
if (write === check) throw new Error('Pass exactly one of --write or --check.');

const git = (args) => capture('git', args, { cwd: UPSTREAM }).trim();
const localFiles = () => walkFiles(DEST).map((file) => path.relative(DEST, file)).sort();
const vendoredHash = (relative) => {
  const bytes = readFileSync(path.join(DEST, relative));
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

/** Upstream Git blob ID per local path (LICENSE sits at the repository root). */
function upstreamHashes(commit) {
  const blobs = new Map();
  for (const line of git(['ls-tree', '-r', commit, '--', SOURCE_ROOT, 'LICENSE']).split('\n')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match) blobs.set(match[2], match[1]);
  }
  return (relative) => blobs.get(relative === 'LICENSE' ? 'LICENSE' : `${SOURCE_ROOT}/${relative}`) ?? null;
}

function summarize(records) {
  const values = Object.values(records);
  const localOnly = values.filter((record) => record.upstream === null).length;
  const exact = values.filter((record) => record.upstream === record.vendored).length;
  return `${exact} upstream-exact, ${values.length - exact - localOnly} overrides, ${localOnly} Lattice-only`;
}

const hasUpstream = existsSync(path.join(UPSTREAM, '.git'));

if (write) {
  if (!hasUpstream) throw new Error(`Open Knowledge upstream clone is missing at ${UPSTREAM}.`);
  const requestedRevision = revisionArgument?.slice('--revision='.length);
  if (!requestedRevision) throw new Error('--write requires --revision=<ref>.');
  const commit = git(['rev-parse', `${requestedRevision}^{commit}`]);
  const upstreamHash = upstreamHashes(commit);
  const records = Object.fromEntries(localFiles().map((relative) => [
    relative,
    { upstream: upstreamHash(relative), vendored: vendoredHash(relative) },
  ]));
  writeJson(LOCK, {
    upstream: 'https://github.com/inkeep/open-knowledge',
    commit,
    sourceRoot: SOURCE_ROOT,
    note: 'Every local core file is reviewed in place. Hashes are Git blob IDs; upstream is null for Lattice-only files, and differing IDs are intentional three-way overrides.',
    files: records,
  });
  console.log(`Locked ${Object.keys(records).length} core files at ${commit}: ${summarize(records)}`);
  process.exit(0);
}

if (!existsSync(LOCK)) throw new Error('open-knowledge-core.lock.json is missing.');
const lock = readJson(LOCK);
const actualPaths = localFiles();
const lockedPaths = Object.keys(lock.files).sort();
const failures = [
  ...lockedPaths.filter((relative) => !actualPaths.includes(relative)).map((relative) => `MISSING core file: ${relative}`),
  ...actualPaths.filter((relative) => !lockedPaths.includes(relative)).map((relative) => `UNLOCKED core file: ${relative}`),
  ...lockedPaths
    .filter((relative) => actualPaths.includes(relative) && vendoredHash(relative) !== lock.files[relative].vendored)
    .map((relative) => `DRIFT in reviewed core file: ${relative}`),
];
if (hasUpstream) {
  const commit = git(['rev-parse', `${lock.commit}^{commit}`]);
  if (commit !== lock.commit) throw new Error(`Locked core commit does not resolve exactly: ${lock.commit}.`);
  const upstreamHash = upstreamHashes(commit);
  for (const relative of lockedPaths) {
    if (upstreamHash(relative) !== lock.files[relative].upstream) failures.push(`UPSTREAM PROVENANCE DRIFT: ${relative}`);
  }
}
for (const failure of failures) console.error(failure);
if (failures.length > 0) process.exit(1);
console.log(`Verified ${Object.keys(lock.files).length} core files: ${summarize(lock.files)}`);
