import type { TrellisController } from "../trellis/trellis-controller";
import type { TerminalScreen, TerminalSessions } from "./terminal-sessions";

export interface CodeRunConfig {
  program: string;
  programArgs: string[];
  scriptArgs: string[];
}

/** POSIX shell argument, not shell code. Embedded quotes, spaces and metacharacters stay literal. */
export function shellArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function codeRunCommand(path: string, config: CodeRunConfig): string {
  const values = [config.program, ...config.programArgs, path, ...config.scriptArgs];
  if (!config.program.trim() || path.startsWith("/") || path.split("/").some((part) => part === "..") || values.some((value) => /[\r\n\0]/.test(value))) {
    // eslint-disable-next-line lingui/no-unlocalized-strings -- internal validation; the caller presents a localized failure
    throw new Error("Invalid program or argument.");
  }
  // exec replaces the dedicated shell, so its exit code is the program's and
  // Ctrl-C/closing the terminal reaches that program's process group directly.
  return "exec " + values.map(shellArgument).join(" ") + "\r";
}

export function defaultCodeProgram(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  // eslint-disable-next-line lingui/no-unlocalized-strings -- executable names, not interface copy
  return ({ py: "python3", js: "node", mjs: "node", cjs: "node", ts: "node", sh: "sh", bash: "bash", rb: "ruby", pl: "perl", r: "Rscript" } as Record<string, string>)[extension ?? ""] ?? "";
}

/** Save the exact active file, then start only if it is still the same project/document. */
export async function runProjectCode<S extends TerminalScreen>(controller: TrellisController, terminals: TerminalSessions<S>, config: CodeRunConfig): Promise<boolean> {
  const { projectRoot, activeKey } = controller.app.get();
  if (!projectRoot || !activeKey || !controller.bridge) return false;
  const input = codeRunCommand(activeKey, config);
  if (!(await controller.bridge.save())) return false;
  const current = controller.app.get();
  if (current.projectRoot !== projectRoot || current.activeKey !== activeKey) return false;
  terminals.setProject(projectRoot);
  const session = terminals.open({ input, keepOnExit: true });
  if (!session) return false;
  terminals.rename(session.key, activeKey.split("/").at(-1) ?? activeKey);
  controller.showPanel("terminal");
  return true;
}
