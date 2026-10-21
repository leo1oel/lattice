/**
 * Builds for the edits that reach the project without passing through the
 * editor.
 *
 * The Agent writes the project's files itself, and so do a terminal, another
 * editor and a sync. Autosave never sees those writes, and the Agent's own
 * rebuild (use-agent-checkpoints.ts) follows Synara's turn checkpoints, which
 * exist only in a Git project and only once a turn has ended: in a plain
 * project the PDF stayed as it was until the writer pressed Build. The
 * project watcher sees every one of them, so its reports drive this. Each
 * change to a build input makes the compiled PDF older at once, and with
 * automatic builds on, a burst of them builds once the writes pause.
 *
 * The same reports carry the app's own saves (autosave builds those itself)
 * and everything a build writes. Build output is told apart by name
 * (build-inputs.ts) and by the build's own recorder, which names a package's
 * scratch file no list of extensions knows: a pass rewriting one must never
 * start the next pass.
 */
import { isBuildOutput } from "../build/build-inputs";
import { normalizeProjectRelativePath, onProjectFilesChanged } from "../project/project-files-changed";

/** How long the writes must pause before they build: an Agent's edits come in quick runs of tool calls. */
export const WATCHED_BUILD_IDLE_MS = 1_500;
/** How long after the app writes a file the watcher's next report of that file is its echo, not a new change. */
const OWN_WRITE_ECHO_MS = 3_000;

/** What the build pipeline lends the watcher's reports. */
type PipelineSide = {
  rootDocuments: () => readonly string[];
  /** A project input changed: the compiled PDF and its SyncTeX map are older than the project now. */
  inputsChanged: () => void;
  /** Whether changes build on their own (Settings › Builds). */
  automatic: () => boolean;
  building: () => boolean;
  build: () => void;
};

export function createWatchedBuilds() {
  let side: PipelineSide | null = null;
  let watched: string | null = null;
  /** When the app last wrote each project path itself; see OWN_WRITE_ECHO_MS. */
  const ownWrites = new Map<string, number>();
  /** What the last build wrote, by its recorder. */
  let written = new Set<string>();
  /** Inputs changed since the last pass started, and whether the watcher could not say which. */
  const pending = new Set<string>();
  let unknown = false;
  let timer: number | null = null;
  /** The pause came while a build ran: decide once it has finished and its output has been reported. */
  let waiting = false;

  const cancel = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    waiting = false;
  };
  const fire = () => {
    timer = null;
    if (!side) return;
    // The running pass may be the one writing these files. Its recorder
    // says so once it is done, and a build starts only after that.
    if (side.building()) {
      waiting = true;
      return;
    }
    for (const path of written) pending.delete(path);
    if (!pending.size && !unknown) return;
    if (side.automatic()) side.build();
  };
  const schedule = () => {
    cancel();
    timer = window.setTimeout(fire, WATCHED_BUILD_IDLE_MS);
  };
  const reset = () => {
    cancel();
    ownWrites.clear();
    pending.clear();
    unknown = false;
  };

  return {
    /** Follow the watcher's reports for the project at `root` until the returned disposer runs. */
    watch(root: string, pipeline: PipelineSide): () => void {
      // The pipeline attaches again whenever what it lends changes; only
      // another project starts over.
      if (root !== watched) {
        reset();
        written = new Set();
        watched = root;
      }
      side = pipeline;
      const stop = onProjectFilesChanged(root, (paths) => {
        const now = Date.now();
        for (const [path, writtenAt] of ownWrites) if (now - writtenAt > OWN_WRITE_ECHO_MS) ownWrites.delete(path);
        const rootDocuments = pipeline.rootDocuments();
        let changed = !paths;
        unknown ||= !paths;
        for (const path of paths ?? []) {
          const file = normalizeProjectRelativePath(path);
          if (file && (ownWrites.delete(file) || written.has(file) || isBuildOutput(file, rootDocuments))) continue;
          changed = true;
          if (file) pending.add(file);
          else unknown = true;
        }
        if (!changed) return;
        pipeline.inputsChanged();
        if (pipeline.automatic()) schedule();
      });
      return () => {
        stop();
        if (side === pipeline) side = null;
      };
    },
    /** The app wrote `paths` itself: the watcher's next report of each is that write's echo. */
    saved(paths: readonly string[]): void {
      const now = Date.now();
      for (const path of paths) {
        const file = normalizeProjectRelativePath(path);
        if (file) ownWrites.set(file, now);
      }
    },
    /** A build pass is about to read the project: it compiles every change reported so far. */
    passStarted(): void {
      pending.clear();
      unknown = false;
    },
    /** A pass finished and its recorder named the project files it wrote. */
    passWrote(paths: readonly string[] | undefined): void {
      if (paths) written = new Set(paths);
    },
    /** The pipeline is free again: a pause that came during the build is decided now. */
    idle(): void {
      // Not at once: the watcher reports the build's own writes a moment
      // after it ends, and those must not count as the pause being over.
      if (waiting) schedule();
    },
    /** Forget the own-write echoes and any wait: the project was entered again. */
    reset,
  };
}
