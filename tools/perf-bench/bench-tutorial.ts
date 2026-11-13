/**
 * The bundled sample project (src-tauri/templates/tutorial) as the backend's
 * `open_tutorial_project` opens it: its files, with the binary ones fetched.
 * The Guided tutorial entry opens it, and the cross-references project
 * (bench-crossrefs.ts) borrows its `.bib` and figures.
 */
import { filesUnder } from "../mock-backend/project";

export const TUTORIAL_ROOT = "/bench/Lattice Tutorials/Understanding Attention";

const tutorialText = import.meta.glob<string>(
  ["../../src-tauri/templates/tutorial/**/*", "!**/*.png", "!**/*.pdf"],
  { query: "?raw", import: "default", eager: true },
);
const tutorialBinary = import.meta.glob<string>(
  ["../../src-tauri/templates/tutorial/**/*.png", "../../src-tauri/templates/tutorial/**/*.pdf"],
  { query: "?url", import: "default", eager: true },
);

/** The tutorial's files by their path in the project, those `keep` accepts. */
export async function tutorialFiles(keep: (path: string) => boolean = () => true): Promise<Map<string, string | Uint8Array>> {
  const files = new Map<string, string | Uint8Array>(filesUnder("tutorial", tutorialText).filter(([path]) => keep(path)));
  for (const [path, url] of filesUnder("tutorial", tutorialBinary)) {
    if (keep(path)) files.set(path, new Uint8Array(await (await fetch(url)).arrayBuffer()));
  }
  return files;
}
