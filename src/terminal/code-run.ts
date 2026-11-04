import type { TrellisController } from "../trellis/trellis-controller";
import type { TerminalProgram, TerminalScreen, TerminalSessions } from "./terminal-sessions";

export interface CodeRunConfig {
  program: string;
  programArgs: string[];
  scriptArgs: string[];
}

/** A literal program/argv request: the backend never parses it as shell code. */
export function codeRunProgram(path: string, config: CodeRunConfig): TerminalProgram {
  const args = [...config.programArgs, `./${path}`, ...config.scriptArgs];
  if (!config.program.trim() || path.startsWith("/") || path.split("/").some((part) => part === "..") || [config.program,...args].some((value) => value.includes("\0"))) {
    // eslint-disable-next-line lingui/no-unlocalized-strings -- internal validation; the caller presents a localized failure
    throw new Error("Invalid program or argument.");
  }
  return { executable: config.program, args };
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
  const program = codeRunProgram(activeKey, config);
  if (!(await controller.bridge.save())) return false;
  const current = controller.app.get();
  if (current.projectRoot !== projectRoot || current.activeKey !== activeKey) return false;
  terminals.setProject(projectRoot);
  const session = terminals.open({ program, keepOnExit: true });
  if (!session) return false;
  terminals.rename(session.key, activeKey.split("/").at(-1) ?? activeKey);
  controller.showPanel("terminal");
  return true;
}
