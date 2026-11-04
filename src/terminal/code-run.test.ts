import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { TrellisController } from "../trellis/trellis-controller";
import { TerminalSessions, type TerminalBackend, type TerminalScreen } from "./terminal-sessions";
import { codeRunCommand, runProjectCode } from "./code-run";

function setup() {
  let opened: Parameters<TerminalBackend["open"]>[0] | null = null;
  const write = vi.fn().mockResolvedValue(undefined);
  const backend: TerminalBackend = {
    open: async (request) => { opened = request; return { id: 9, shell: "sh" }; },
    write, resize: vi.fn().mockResolvedValue(undefined), ack: vi.fn().mockResolvedValue(undefined),
    runningCommand: vi.fn().mockResolvedValue(null), close: vi.fn().mockResolvedValue(undefined),
  };
  const screen: TerminalScreen = {
    element: document.createElement("div"), cols: () => 80, rows: () => 24,
    write: (_bytes, done) => done(), note: () => {}, onInput: () => {}, onResize: () => {}, dispose: vi.fn(),
  };
  const terminals = new TerminalSessions(backend, () => screen);
  const controller = new TrellisController();
  controller.app.set({ projectRoot: "/projects/example", activeKey: "analysis.py" });
  const save = vi.fn().mockResolvedValue(true);
  controller.bridge = { save } as unknown as NonNullable<TrellisController["bridge"]>;
  vi.spyOn(controller, "showPanel").mockImplementation(() => {});
  return { controller, terminals, save, write, opened: () => opened! };
}

it("saves the real active document, starts a dedicated terminal, and retains its successful output", async () => {
  const { controller, terminals, save, write, opened } = setup();
  const run = runProjectCode(controller, terminals, { program: "python3", programArgs: ["-u"], scriptArgs: ["a b"] });
  expect(save).toHaveBeenCalledOnce();
  expect(opened()).toBeNull();
  await expect(run).resolves.toBe(true);
  await Promise.resolve();
  expect(opened()).toMatchObject({ projectRoot: "/projects/example" });
  expect(write).toHaveBeenCalledWith(9, "exec 'python3' '-u' './analysis.py' 'a b'\r");
  expect(controller.showPanel).toHaveBeenCalledWith("terminal");
  opened().onExit(0);
  expect(terminals.get().sessions).toHaveLength(1);
  expect(terminals.get().sessions[0].state).toEqual({ kind: "exited", code: 0 });
});

it("does not execute when saving fails or the project changes while saving", async () => {
  const { controller, terminals, save, opened } = setup();
  save.mockResolvedValueOnce(false);
  const config = { program: "python3", programArgs: [], scriptArgs: [] };
  await expect(runProjectCode(controller, terminals, config)).resolves.toBe(false);
  expect(opened()).toBeNull();
  save.mockImplementationOnce(async () => { controller.app.set({ projectRoot: "/projects/other" }); return true; });
  await expect(runProjectCode(controller, terminals, config)).resolves.toBe(false);
  expect(opened()).toBeNull();
});

it("passes filename and argument metacharacters literally through a real POSIX shell", () => {
  const root = mkdtempSync(join(tmpdir(), "lattice-code-run-"));
  try {
    const file = "analysis '; touch injected.py";
    writeFileSync(join(root, file), "import json, sys\nprint(json.dumps(sys.argv[1:]))\n");
    const argument = "$(touch escaped); 'quoted'";
    const command = codeRunCommand(file, { program: "python3", programArgs: [], scriptArgs: [argument] });
    const result = spawnSync("/bin/sh", ["-c", command.slice(0, -1)], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([argument]);
    expect(existsSync(join(root, "escaped"))).toBe(false);
    expect(() => codeRunCommand("../escape.py", { program: "python3", programArgs: [], scriptArgs: [] })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("interrupts a running program through the terminal's ordered input path", async () => {
  const { controller, terminals, write } = setup();
  await runProjectCode(controller, terminals, { program: "python3", programArgs: [], scriptArgs: [] });
  const key = terminals.get().active!;
  terminals.send(key, "\u0003");
  expect(write).toHaveBeenLastCalledWith(9, "\u0003");
});
