import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function configureSynaraNodeRuntime({
  synaraRoot,
  nodeRuntime,
  electronNodeVersion,
  standaloneNodeVersion,
}) {
  if (nodeRuntime !== "electron" && nodeRuntime !== "standalone") {
    throw new Error(`Unsupported Synara Node runtime: ${nodeRuntime}`);
  }
  const manifestPath = join(synaraRoot, "manifest.json");
  if (!existsSync(manifestPath)) return false;
  if (!existsSync(join(synaraRoot, "server", "dist", "index.mjs"))) {
    throw new Error("Synara is staged without its server entry point.");
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let nodeVersion;
  if (nodeRuntime === "electron") {
    if (electronNodeVersion.split(".", 1)[0] !== standaloneNodeVersion.split(".", 1)[0]) {
      throw new Error(
        `Electron Node ${electronNodeVersion} is incompatible with Synara's Node ${standaloneNodeVersion} pin.`,
      );
    }
    // Keep the tiny launchers in bin/: bibcite discovers the bundled
    // bibtex-tidy there. Only the standalone Node binary is duplicated by the
    // packaged Electron runtime.
    rmSync(join(synaraRoot, "bin", "node"), { force: true });
    rmSync(join(synaraRoot, "bin", "node.exe"), { force: true });
    nodeVersion = electronNodeVersion;
  } else {
    if (!existsSync(join(synaraRoot, "bin", "node"))) {
      throw new Error("Standalone Synara Node is missing after debug runtime preparation.");
    }
    nodeVersion = standaloneNodeVersion;
  }

  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, nodeVersion, nodeRuntime }, null, 2)}\n`,
  );
  return true;
}
