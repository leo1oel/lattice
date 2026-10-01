#!/usr/bin/env node
/**
 * Fails the build unless the production bundle ships exactly one PDF.js worker
 * and that worker is the pdfjs-dist release the app's API code comes from.
 *
 * PDF.js refuses a worker from another release ("The API version … does not
 * match the Worker version …"), and only the production chunk graph decides
 * which `GlobalWorkerOptions.workerSrc` assignment runs last — the dev server
 * keeps source import order and cannot show the problem. A dependency that
 * bundles its own worker (PDFSlick 4.0.2 ships PDF.js 6.2.108's) surfaces here
 * as a second worker asset.
 */
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WORKER_ASSET = /^pdf\.worker(?:\.min)?-[\w-]+\.m?js$/;
// The worker's only semver literal is the `workerVersion` it compares against
// the API's version on its first message.
const VERSION_LITERAL = /["'`](\d+\.\d+\.\d+)["'`]/g;

export async function checkPdfjsWorkers(distRoot, expectedVersion) {
  const assetsDir = path.join(distRoot, "assets");
  const workers = (await readdir(assetsDir)).filter((name) => WORKER_ASSET.test(name)).sort();
  const failures = [];
  if (workers.length !== 1) {
    failures.push(`expected exactly one PDF.js worker in ${assetsDir}, found ${workers.length}: ${workers.join(", ") || "none"}`);
  }
  for (const name of workers) {
    const source = await readFile(path.join(assetsDir, name), "utf8");
    const versions = [...new Set([...source.matchAll(VERSION_LITERAL)].map((match) => match[1]))];
    if (versions.length !== 1 || versions[0] !== expectedVersion) {
      failures.push(`${name} is PDF.js ${versions.join("/") || "of unknown version"}, but the app uses pdfjs-dist ${expectedVersion}`);
    }
  }
  return failures;
}

async function main() {
  const require = createRequire(import.meta.url);
  const { version } = require("pdfjs-dist/package.json");
  const failures = await checkPdfjsWorkers(path.resolve("dist"), version);
  if (failures.length) {
    for (const failure of failures) console.error(`pdfjs worker check: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`pdfjs worker check: one worker, PDF.js ${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
