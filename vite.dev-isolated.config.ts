/**
 * TEMPORARY local-testing config — delete when done.
 *
 * Identical to vite.config.ts except that env files are read from
 * `.tmp/dev-env/`. Vite restarts the whole dev server whenever a file in
 * `envDir` is written, and a concurrent agent kept rewriting `.env.local`;
 * every restart invalidated the module graph of the already-open app windows
 * ("Importing a module script failed" → blank window) and they had to be
 * relaunched by hand. Pointing envDir somewhere quiet keeps a manual test
 * session alive.
 *
 * Lives in the repo root so `import.meta.url` in the base config still
 * resolves the `@` aliases to ./src.
 *
 *   pnpm exec vite --config vite.dev-isolated.config.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import base from "./vite.config";

export default async (env: { command: "build" | "serve"; mode: string }) => {
  const resolved = typeof base === "function" ? await base(env) : base;
  return {
    ...resolved,
    envDir: path.resolve(fileURLToPath(new URL(".", import.meta.url)), ".tmp/dev-env"),
  };
};
