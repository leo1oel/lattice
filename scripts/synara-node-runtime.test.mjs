import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureSynaraNodeRuntime } from "./synara-node-runtime.mjs";

let fixture;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

function stageStandaloneRuntime() {
  fixture = mkdtempSync(join(tmpdir(), "lattice-synara-node-"));
  mkdirSync(join(fixture, "bin"), { recursive: true });
  mkdirSync(join(fixture, "server/dist"), { recursive: true });
  writeFileSync(join(fixture, "bin/node"), "standalone node\n");
  writeFileSync(join(fixture, "server/dist/index.mjs"), "server\n");
  writeFileSync(join(fixture, "manifest.json"), '{"buildKey":"fixture"}\n');
}

function manifest() {
  return JSON.parse(readFileSync(join(fixture, "manifest.json"), "utf8"));
}

describe("Synara Node runtime staging", () => {
  it("strips standalone Node only for release Electron staging", () => {
    stageStandaloneRuntime();

    expect(configureSynaraNodeRuntime({
      synaraRoot: fixture,
      nodeRuntime: "electron",
      electronNodeVersion: "24.18.1",
      standaloneNodeVersion: "24.20.0",
    })).toBe(true);

    expect(existsSync(join(fixture, "bin"))).toBe(false);
    expect(manifest()).toMatchObject({
      nodeRuntime: "electron",
      nodeVersion: "24.18.1",
    });
  });

  it("requires and marks freshly prepared standalone Node for debug staging", () => {
    stageStandaloneRuntime();
    rmSync(join(fixture, "bin"), { recursive: true });
    writeFileSync(
      join(fixture, "manifest.json"),
      '{"buildKey":"fixture","nodeRuntime":"electron","nodeVersion":"24.18.1"}\n',
    );

    const configureDebug = () => configureSynaraNodeRuntime({
      synaraRoot: fixture,
      nodeRuntime: "standalone",
      electronNodeVersion: "24.18.1",
      standaloneNodeVersion: "24.20.0",
    });
    expect(configureDebug).toThrow(
      "Standalone Synara Node is missing after debug runtime preparation.",
    );

    mkdirSync(join(fixture, "bin"));
    writeFileSync(join(fixture, "bin/node"), "standalone node\n");
    expect(configureDebug()).toBe(true);
    expect(manifest()).toMatchObject({
      nodeRuntime: "standalone",
      nodeVersion: "24.20.0",
    });
  });
});
