/**
 * The window's terminals: one shell per tab, in the project folder, kept
 * apart from the panel that shows them.
 *
 * The panel can unmount while its shells run (a named workspace without a
 * Terminal panel, a layout reset), and mounting again shows the same
 * terminals with their scrollback, so the sessions live here, one store per
 * window, rather than in React state. A shell ends only when its tab is
 * closed, the Terminal panel is closed, or the window's project changes; the
 * host ends the rest (a reload, the window closing, quitting; see
 * src-tauri/src/terminal.rs).
 *
 * The store knows nothing of xterm.js or of Tauri: it is handed a backend and
 * a way to make a terminal's screen, so its rules are tested with fakes.
 */

/** The host side of one window's terminals (terminal-backend.ts). */
export type TerminalBackend = {
  open: (request: {
    projectRoot: string;
    cols: number;
    rows: number;
    onOutput: (data: Uint8Array) => void;
    /** The shell ended by itself: its exit code, or null when a signal ended it. */
    onExit: (code: number | null) => void;
  }) => Promise<{ id: number; shell: string }>;
  write: (id: number, data: string) => Promise<void>;
  resize: (id: number, cols: number, rows: number) => Promise<void>;
  /** The window has drawn `bytes` more output (flow control). */
  ack: (id: number, bytes: number) => Promise<void>;
  /** What closing the terminal would stop ("latexmk", "" when unnamed), or null at the prompt. */
  runningCommand: (id: number) => Promise<string | null>;
  close: (id: number) => Promise<void>;
};

/** A terminal's screen (terminal-screen.ts): xterm.js in an element of its own. */
export type TerminalScreen = {
  /** The element the screen draws in; the panel moves it into place. */
  element: HTMLElement;
  cols: () => number;
  rows: () => number;
  /** Draw shell output; `done` once it is on screen. */
  write: (data: Uint8Array, done: () => void) => void;
  /** A line from Lattice itself, not the shell (dimmed). */
  note: (text: string) => void;
  onInput: (listener: (data: string) => void) => void;
  onResize: (listener: (cols: number, rows: number) => void) => void;
  dispose: () => void;
};

export type TerminalSession<S extends TerminalScreen = TerminalScreen> = {
  /** The tab's own id; the host's id arrives once the shell has started. */
  key: number;
  /** Shown as "Terminal {number}" until renamed. */
  number: number;
  name: string | null;
  /** The shell's program ("zsh"), once started. */
  shell: string;
  screen: S;
  /** "running", or how it stopped: the shell exited (code), or never started (message). */
  state: { kind: "starting" | "running" } | { kind: "exited"; code: number | null } | { kind: "failed"; message: string };
};

type Snapshot<S extends TerminalScreen> = { sessions: readonly TerminalSession<S>[]; active: number | null };

/** Output the window draws before it tells the host (see `ack`). */
const ACK_EVERY = 64 * 1024;

type Internal<S extends TerminalScreen> = { session: TerminalSession<S>; id: number | null; queued: string[]; drawn: number; closed: boolean };

export class TerminalSessions<S extends TerminalScreen = TerminalScreen> {
  private items: Internal<S>[] = [];
  private snapshot: Snapshot<S> = { sessions: [], active: null };
  private listeners = new Set<() => void>();
  private nextKey = 1;
  private root = "";

  constructor(
    private readonly backend: TerminalBackend,
    private readonly createScreen: () => S,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get = () => this.snapshot;

  /** The project the terminals run in. Another project ends every terminal of the last one. */
  get projectRoot() {
    return this.root;
  }

  setProject(root: string) {
    if (root === this.root) return;
    this.endAll();
    this.root = root;
  }

  /** Start a terminal in the project folder and make it the active tab. */
  open(): TerminalSession<S> | null {
    if (!this.root) return null;
    const used = new Set(this.items.map(({ session }) => session.number));
    let number = 1;
    while (used.has(number)) number += 1;
    const screen = this.createScreen();
    const session: TerminalSession<S> = { key: this.nextKey++, number, name: null, shell: "", screen, state: { kind: "starting" } };
    const item: Internal<S> = { session, id: null, queued: [], drawn: 0, closed: false };
    this.items.push(item);
    this.publish(session.key);
    const root = this.root;
    screen.onInput((data) => {
      if (item.id === null) item.queued.push(data);
      else void this.backend.write(item.id, data).catch(() => {});
    });
    screen.onResize((cols, rows) => {
      if (item.id !== null) void this.backend.resize(item.id, cols, rows).catch(() => {});
    });
    void this.backend.open({
      projectRoot: root,
      cols: screen.cols(),
      rows: screen.rows(),
      onOutput: (data) => {
        if (item.closed) return;
        screen.write(data, () => {
          item.drawn += data.byteLength;
          if (item.drawn < ACK_EVERY || item.id === null) return;
          void this.backend.ack(item.id, item.drawn).catch(() => {});
          item.drawn = 0;
        });
      },
      onExit: (code) => this.exited(item, code),
    }).then(({ id, shell }) => {
      if (item.closed || root !== this.root) {
        void this.backend.close(id).catch(() => {});
        return;
      }
      item.id = id;
      this.update(item, { shell, state: { kind: "running" } });
      // The size may have changed while the shell started (the panel laid out).
      void this.backend.resize(id, screen.cols(), screen.rows()).catch(() => {});
      for (const data of item.queued.splice(0)) void this.backend.write(id, data).catch(() => {});
    }, (reason: unknown) => {
      if (item.closed) return;
      this.update(item, { state: { kind: "failed", message: reason instanceof Error ? reason.message : String(reason) } });
    });
    return session;
  }

  select(key: number) {
    if (this.items.some(({ session }) => session.key === key)) this.publish(key);
  }

  rename(key: number, name: string) {
    const item = this.items.find(({ session }) => session.key === key);
    const trimmed = name.trim();
    if (item) this.update(item, { name: trimmed || null });
  }

  /** What closing these terminals would stop, by command name ("" when unnamed). */
  async running(keys: readonly number[] = this.items.map(({ session }) => session.key)): Promise<string[]> {
    const ids = this.items.filter(({ session, id }) => keys.includes(session.key) && id !== null).map(({ id }) => id!);
    const answers = await Promise.all(ids.map((id) => this.backend.runningCommand(id).catch(() => null)));
    return answers.filter((answer): answer is string => answer !== null);
  }

  /** Close one tab, ending its shell. */
  close(key: number) {
    const index = this.items.findIndex(({ session }) => session.key === key);
    if (index < 0) return;
    const [item] = this.items.splice(index, 1);
    this.end(item);
    const active = this.snapshot.active === key
      ? (this.items[index] ?? this.items[index - 1])?.session.key ?? null
      : this.snapshot.active;
    this.publish(active);
  }

  /** Close every tab, ending every shell. */
  endAll() {
    if (!this.items.length) return;
    for (const item of this.items.splice(0)) this.end(item);
    this.publish(null);
  }

  private end(item: Internal<S>) {
    item.closed = true;
    if (item.id !== null) void this.backend.close(item.id).catch(() => {});
    item.session.screen.dispose();
  }

  /**
   * The shell exited by itself (`exit`, ⌃D): a clean exit closes its tab, as
   * closing it would; any other keeps the tab and says how it ended, so a
   * profile that fails at once does not just vanish.
   */
  private exited(item: Internal<S>, code: number | null) {
    if (item.closed) return;
    if (code === 0) {
      this.close(item.session.key);
      return;
    }
    this.update(item, { state: { kind: "exited", code } });
  }

  private update(item: Internal<S>, patch: Partial<TerminalSession<S>>) {
    item.session = { ...item.session, ...patch };
    this.publish(this.snapshot.active);
  }

  private publish(active: number | null) {
    const sessions = this.items.map(({ session }) => session);
    this.snapshot = { sessions, active: sessions.some((session) => session.key === active) ? active : sessions.at(-1)?.key ?? null };
    for (const listener of [...this.listeners]) listener();
  }
}
