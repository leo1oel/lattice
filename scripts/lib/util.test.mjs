import { describe, expect, it } from "vitest";
import { windowsPnpmCommand } from "./util.mjs";

describe("windowsPnpmCommand", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";

  it("runs pnpm's JavaScript entry point with this Node", () => {
    const cli = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs";
    expect(windowsPnpmCommand(cli, node)).toEqual([node, [cli]]);
  });

  it("runs a standalone pnpm.exe, as mise installs it, directly", () => {
    const cli = "C:\\Users\\me\\AppData\\Local\\mise\\installs\\pnpm\\10.13.1\\pnpm.exe";
    expect(windowsPnpmCommand(cli, node)).toEqual([cli, []]);
  });

  it("asks to be run through pnpm when npm_execpath is missing or another tool's", () => {
    expect(() => windowsPnpmCommand(undefined, node)).toThrow(/through pnpm/);
    expect(() => windowsPnpmCommand("C:\\npm\\bin\\npm-cli.js", node)).toThrow(/through pnpm/);
  });
});
