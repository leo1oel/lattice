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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEST = path.join(REPO, 'src/open-knowledge-core');
const LOCK = path.join(REPO, 'open-knowledge-core.lock.json');
const UPSTREAM = path.join(homedir(), '.cache/research-writer/open-knowledge');
const SOURCE_ROOT = 'packages/core/src';

const write = process.argv.includes('--write');
const check = process.argv.includes('--check');
const revisionArgument = process.argv.find((argument) => argument.startsWith('--revision='));
if (write === check) throw new Error('Pass exactly one of --write or --check.');

function gitBlobHash(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

function localFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...localFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

function sourcePath(relative) {
  return relative === 'LICENSE' ? 'LICENSE' : `${SOURCE_ROOT}/${relative}`;
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: UPSTREAM,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function upstreamBlobs(commit) {
  const lines = git(
    ['ls-tree', '-r', commit, '--', SOURCE_ROOT, 'LICENSE'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  const blobs = new Map();
  for (const line of lines) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match) blobs.set(match[2], match[1]);
  }
  return blobs;
}

function upstreamHash(relative, blobs) {
  return blobs.get(sourcePath(relative)) ?? null;
}

function summarize(records) {
  const values = Object.values(records);
  const localOnly = values.filter((record) => record.upstream === null).length;
  const exact = values.filter((record) => record.upstream === record.vendored).length;
  return {
    files: values.length,
    exact,
    overrides: values.length - exact - localOnly,
    localOnly,
  };
}

if (write) {
  if (!existsSync(path.join(UPSTREAM, '.git'))) {
    throw new Error(`Open Knowledge upstream clone is missing at ${UPSTREAM}.`);
  }
  const requestedRevision = revisionArgument?.slice('--revision='.length);
  if (!requestedRevision) throw new Error('--write requires --revision=<ref>.');
  const commit = git(['rev-parse', `${requestedRevision}^{commit}`], { encoding: 'utf8' }).trim();
  const blobs = upstreamBlobs(commit);
  const records = {};
  for (const relative of localFiles(DEST)) {
    records[relative] = {
      upstream: upstreamHash(relative, blobs),
      vendored: gitBlobHash(readFileSync(path.join(DEST, relative))),
    };
  }
  const summary = summarize(records);
  writeFileSync(
    LOCK,
    `${JSON.stringify(
      {
        upstream: 'https://github.com/inkeep/open-knowledge',
        commit,
        sourceRoot: SOURCE_ROOT,
        note: 'Every local core file is reviewed in place. Hashes are Git blob IDs; upstream is null for Lattice-only files, and differing IDs are intentional three-way overrides.',
        files: records,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Locked ${summary.files} core files at ${commit}: ${summary.exact} upstream-exact, ${summary.overrides} overrides, ${summary.localOnly} Lattice-only`,
  );
  process.exit(0);
}

if (!existsSync(LOCK)) throw new Error('open-knowledge-core.lock.json is missing.');
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
const actualPaths = localFiles(DEST);
const lockedPaths = Object.keys(lock.files).sort();
const missing = lockedPaths.filter((relative) => !actualPaths.includes(relative));
const untracked = actualPaths.filter((relative) => !lockedPaths.includes(relative));
const drift = lockedPaths.filter((relative) => (
  actualPaths.includes(relative)
  && gitBlobHash(readFileSync(path.join(DEST, relative))) !== lock.files[relative].vendored
));

let provenanceDrift = [];
if (existsSync(path.join(UPSTREAM, '.git'))) {
  const commit = git(['rev-parse', `${lock.commit}^{commit}`], { encoding: 'utf8' }).trim();
  if (commit !== lock.commit) throw new Error(`Locked core commit does not resolve exactly: ${lock.commit}.`);
  const blobs = upstreamBlobs(commit);
  provenanceDrift = lockedPaths.filter((relative) => (
    upstreamHash(relative, blobs) !== lock.files[relative].upstream
  ));
}

for (const relative of missing) console.error(`MISSING core file: ${relative}`);
for (const relative of untracked) console.error(`UNLOCKED core file: ${relative}`);
for (const relative of drift) console.error(`DRIFT in reviewed core file: ${relative}`);
for (const relative of provenanceDrift) console.error(`UPSTREAM PROVENANCE DRIFT: ${relative}`);
if (missing.length || untracked.length || drift.length || provenanceDrift.length) process.exit(1);

const summary = summarize(lock.files);
console.log(
  `Verified ${summary.files} core files: ${summary.exact} upstream-exact, ${summary.overrides} overrides, ${summary.localOnly} Lattice-only`,
);
