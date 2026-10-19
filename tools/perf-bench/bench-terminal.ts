/**
 * The bench's Terminal panel: a pretend zsh, so the panel can be opened,
 * typed into and looked at without a host. It echoes what is typed, keeps a
 * line, and on Return answers a few commands the way the real ones look
 * (`ls`, `pwd`, `git status`, `latexmk`), coloured as they colour; anything
 * else is "command not found". `exit` ends the shell with code 0, `exit N`
 * with N. Nothing runs.
 */
import { NOT_HANDLED } from "./bench-overleaf";

type Args = Record<string, unknown> | undefined;
/** The open project, as the bench holds it. */
type Project = { root: string; files: Map<string, unknown> };
type Context = { root: () => string; files: () => string[]; send: (shell: Shell, message: unknown) => void };

type Shell = { channel: number; sent: number; line: string };

/**
 * What Tauri does for each `channel.send`: the channel's callback with the
 * message's place in order, which Tauri's Channel waits for.
 */
function deliver(shell: Shell, message: unknown) {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, payload: unknown) => void } }).__TAURI_INTERNALS__;
  internals.runCallback(shell.channel, { index: shell.sent++, message });
}

const shells = new Map<number, Shell>();
let nextId = 1;

const ESC = "\x1b";
const dim = (text: string) => `${ESC}[2m${text}${ESC}[0m`;
const bold = (text: string) => `${ESC}[1m${text}${ESC}[0m`;
const color = (code: number, text: string) => `${ESC}[${code}m${text}${ESC}[0m`;

function prompt(root: string) {
  const folder = root.split("/").filter(Boolean).at(-1) ?? "~";
  return `${color(32, "writer@lattice")} ${color(34, folder)} ${bold("%")} `;
}

function run(command: string, context: Context): string {
  const [name, ...rest] = command.trim().split(/\s+/);
  const lines = (...text: string[]) => text.map((line) => `${line}\r\n`).join("");
  switch (name) {
    case "":
      return "";
    case "pwd":
      return lines(context.root());
    case "ls": {
      const top = [...new Set(context.files().map((path) => path.split("/")[0]))].sort();
      return lines(top.map((entry) => (context.files().includes(entry) ? entry : color(34, entry))).join("  "));
    }
    case "git":
      return rest[0] === "status"
        ? lines("On branch main", "Changes not staged for commit:", `\t${color(31, "modified:   main.tex")}`, "", `no changes added to commit (use "git add")`)
        : lines(`git: '${rest[0] ?? ""}' is not a git command. See 'git --help'.`);
    case "latexmk":
      return lines(
        dim("Rc files read:"), dim("  /Library/TeX/texbin/latexmkrc"),
        `Latexmk: This is Latexmk, John Collins, 7 Jun. 2025. Version ${bold("4.86a")}.`,
        "Latexmk: applying rule 'pdflatex'...",
        color(33, "LaTeX Warning: Citation `vaswani2017' on page 2 undefined on input line 48."),
        "Output written on main.pdf (12 pages, 412300 bytes).",
        color(32, "Latexmk: All targets (main.pdf) are up-to-date"),
      );
    case "echo":
      return lines(rest.join(" "));
    default:
      return lines(`zsh: command not found: ${name}`);
  }
}

const encode = (text: string) => new TextEncoder().encode(text).buffer;

export function terminalAnswer(command: string, args: Args, project: () => Project): unknown {
  const context: Context = { root: () => project().root, files: () => [...project().files.keys()], send: deliver };
  switch (command) {
    case "terminal_open": {
      const id = nextId++;
      const shell = { channel: Number((args?.onOutput as { id?: number } | undefined)?.id), sent: 0, line: "" };
      shells.set(id, shell);
      setTimeout(() => context.send(shell, encode(`${dim("Last login: Mon Oct 19 09:12:44 on ttys002")}\r\n${prompt(context.root())}`)), 30);
      return { id, shell: "zsh" };
    }
    case "terminal_write": {
      const shell = shells.get(Number(args?.id));
      if (!shell) throw new Error("This terminal has closed.");
      let out = "";
      for (const key of String(args?.data ?? "")) {
        if (key === "\r") {
          const line = shell.line;
          shell.line = "";
          const exit = /^\s*exit(?:\s+(\d+))?\s*$/.exec(line);
          if (exit) {
            context.send(shell, encode(`${out}\r\n`));
            context.send(shell, { exit: Number(exit[1] ?? 0) });
            shells.delete(Number(args?.id));
            return null;
          }
          out += `\r\n${run(line, context)}${prompt(context.root())}`;
        } else if (key === "\x7f") {
          if (shell.line) {
            shell.line = [...shell.line].slice(0, -1).join("");
            out += "\b \b";
          }
        } else if (key === "\x03") {
          shell.line = "";
          out += `^C\r\n${prompt(context.root())}`;
        } else if (key >= " ") {
          shell.line += key;
          out += key;
        }
      }
      if (out) context.send(shell, encode(out));
      return null;
    }
    case "terminal_resize":
    case "terminal_ack":
      return null;
    case "terminal_running_command":
      return null;
    case "terminal_close":
      shells.delete(Number(args?.id));
      return null;
    default:
      return NOT_HANDLED;
  }
}
