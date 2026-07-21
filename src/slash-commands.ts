export type AgentCommand = {
  name: string;
  description: string;
  hint?: string | null;
  subcommands: string[];
};

export type SlashState = { start: number; end: number; query: string };

/**
 * OMP only treats a message as a command when it *opens* with the slash, so the
 * menu is offered for a leading `/word` and nothing else — `see /tmp/x` and a
 * second line starting with `/` are ordinary prose.
 */
export function slashAtCaret(value: string, caret: number): SlashState | null {
  if (!value.startsWith("/")) return null;
  const beforeCaret = value.slice(0, caret);
  // Once a space is typed the name is settled and the user is on to arguments.
  if (/\s/.test(beforeCaret)) return null;
  return { start: 0, end: caret, query: beforeCaret.slice(1) };
}

/** Prefix matches first, then anything else that contains the query. */
export function filterSlashCommands(commands: AgentCommand[], query: string): AgentCommand[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return commands;
  const prefix: AgentCommand[] = [];
  const contains: AgentCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLocaleLowerCase();
    if (name.startsWith(needle)) prefix.push(command);
    else if (name.includes(needle) || command.description.toLocaleLowerCase().includes(needle)) {
      contains.push(command);
    }
  }
  return [...prefix, ...contains];
}

/**
 * Replace the typed fragment with the full command. A command that takes
 * arguments keeps the caret on the same line after a space; one that does not
 * is left ready to send.
 */
export function applySlashCommand(
  value: string,
  state: SlashState,
  command: AgentCommand,
): { value: string; caret: number } {
  const takesArguments = Boolean(command.hint) || command.subcommands.length > 0;
  const inserted = `/${command.name}${takesArguments ? " " : ""}`;
  const rest = value.slice(state.end);
  return { value: `${inserted}${rest}`, caret: inserted.length };
}
