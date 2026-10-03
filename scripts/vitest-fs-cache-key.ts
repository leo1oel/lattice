import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vitest/config";

/**
 * Seeds Vitest's fs module cache key (`experimental.fsModuleCache`) with what
 * Vitest's own key leaves out. Vitest hashes each module's id and source, the
 * Vitest config's source and the plugin *names*; three more inputs decide what
 * the transforms here emit:
 *
 * - `lingui.config.ts`, read by the Lingui plugin and macro.
 * - The installed dependencies. Vitest is meant to clear the cache when the
 *   lockfile changes, but its integrity check (Vitest 4.1) clears it without
 *   rewriting the lockfile record, so the *next* change is taken for a first
 *   run: the new hash is recorded and the previous install's transforms are
 *   kept. Two installs in a row then replay the React Compiler or Lingui output
 *   of the version before. Keying every module on the installed lockfile makes
 *   that record irrelevant. The installed copy is the truth (a pull that moves
 *   pnpm-lock.yaml leaves the old packages in place until `pnpm install`), the
 *   committed one covers an install that did not write it.
 * - Other catalogs. A `.po` module compiles to its own messages merged over the
 *   source locale's (`sourceLocale` in lingui.config.ts), so the zh-CN catalog's
 *   output changes when only an English string does. Catalogs are cheap to
 *   compile and few, so they are not cached at all rather than keyed on a list
 *   of catalogs that has to track Lingui's fallback rules.
 */
export function fsModuleCacheKey(root: string): Plugin {
  return {
    name: "lattice:fs-module-cache-key",
    configureVitest({ experimental_defineCacheKeyGenerator }) {
      const digest = createHash("sha256");
      for (const file of ["lingui.config.ts", "pnpm-lock.yaml", "node_modules/.pnpm/lock.yaml"]) {
        // The file name goes in too, so content cannot shift between two
        // files (or a missing one) and hash the same.
        digest.update(`\0${file}\0${readOptional(join(root, file))}`);
      }
      const seed = digest.digest("hex");
      experimental_defineCacheKeyGenerator(({ id }) => (isCatalog(id) ? false : seed));
    },
  };
}

function isCatalog(id: string): boolean {
  return /\.po(?:\?|$)/.test(id);
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
