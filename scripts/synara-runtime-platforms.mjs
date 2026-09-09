import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Pi ships a nested installation containing esbuild's optional binaries for
// every platform. Preserve the host binary in both dependency trees.
export function pruneEsbuildPlatforms(serverRoot, platform) {
  let removedBytes = 0;
  for (const directory of [
    join(serverRoot, "node_modules/@esbuild"),
    join(serverRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild"),
  ]) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory)) {
      if (entry === platform) continue;
      const path = join(directory, entry);
      for (const file of readdirSync(path, { recursive: true })) {
        const info = lstatSync(join(path, file));
        if (info.isFile()) removedBytes += info.size;
      }
      rmSync(path, { recursive: true, force: true });
    }
  }
  return removedBytes;
}
