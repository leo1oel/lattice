/**
 * Dev-only performance probe (see docs/performance.md for the playbook).
 *
 * Loaded from main.tsx via dynamic import behind
 * `import.meta.env.DEV && localStorage.getItem("lattice-perf")`, so it never
 * enters the startup chunk and is dead-code-eliminated from production
 * builds. Everything here is observational — no behavior changes.
 *
 * What it measures:
 *  - Keystroke latency: capture-phase keydown inside an editor surface →
 *    time to the next painted frame (rAF + macrotask, so layout/paint of the
 *    frame is included). Rolling p50/p95 logged every 30 samples.
 *  - IPC latency: wraps `window.__TAURI_INTERNALS__.invoke` (the primitive
 *    every @tauri-apps/api call funnels through) and aggregates per-command
 *    durations. `read_project_file` completions additionally time to the
 *    next paint as a file-switch proxy.
 *
 * Console API: `__latticePerf.report()` dumps both tables and resets nothing;
 * `__latticePerf.reset()` clears samples between scenarios.
 */

type Samples = number[];

interface CommandStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

interface TauriInternals {
  invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
}

function quantile(samples: Samples, q: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index];
}

export function installPerfProbe(): void {
  const keystrokes: Samples = [];
  const switches: Samples = [];
  const commands = new Map<string, CommandStats>();

  const afterNextPaint = (callback: () => void) => {
    requestAnimationFrame(() => {
      setTimeout(callback, 0);
    });
  };

  // --- keystroke → next paint -------------------------------------------
  document.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest(".cm-editor, .ProseMirror")) return;
      const start = performance.now();
      afterNextPaint(() => {
        keystrokes.push(performance.now() - start);
        if (keystrokes.length % 30 === 0) {
           
          console.log(
            `[lattice-perf] keystroke p50 ${quantile(keystrokes, 0.5).toFixed(1)}ms ` +
              `p95 ${quantile(keystrokes, 0.95).toFixed(1)}ms (n=${keystrokes.length})`,
          );
        }
      });
    },
    { capture: true, passive: true },
  );

  // --- IPC command timing ------------------------------------------------
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === "function") {
    const original = internals.invoke.bind(internals);
    internals.invoke = (cmd, args, options) => {
      const start = performance.now();
      const finish = () => {
        const elapsed = performance.now() - start;
        const stats = commands.get(cmd) ?? { count: 0, totalMs: 0, maxMs: 0 };
        stats.count += 1;
        stats.totalMs += elapsed;
        stats.maxMs = Math.max(stats.maxMs, elapsed);
        commands.set(cmd, stats);
        if (cmd === "read_project_file") {
          afterNextPaint(() => switches.push(performance.now() - start));
        }
      };
      const result = original(cmd, args, options);
      result.then(finish, finish);
      return result;
    };
  } else {
     
    console.warn("[lattice-perf] __TAURI_INTERNALS__ not found; IPC timing disabled");
  }

  const report = () => {
     
    console.log(
      `[lattice-perf] keystroke p50 ${quantile(keystrokes, 0.5).toFixed(1)}ms ` +
        `p95 ${quantile(keystrokes, 0.95).toFixed(1)}ms (n=${keystrokes.length}) | ` +
        `switch(read→paint) p50 ${quantile(switches, 0.5).toFixed(1)}ms ` +
        `p95 ${quantile(switches, 0.95).toFixed(1)}ms (n=${switches.length})`,
    );
     
    console.table(
      [...commands.entries()]
        .map(([command, stats]) => ({
          command,
          count: stats.count,
          "avg ms": Number((stats.totalMs / stats.count).toFixed(1)),
          "max ms": Number(stats.maxMs.toFixed(1)),
          "total ms": Number(stats.totalMs.toFixed(0)),
        }))
        .sort((a, b) => b["total ms"] - a["total ms"]),
    );
  };

  const reset = () => {
    keystrokes.length = 0;
    switches.length = 0;
    commands.clear();
  };

  (window as unknown as Record<string, unknown>).__latticePerf = { report, reset };
   
  console.log("[lattice-perf] probe installed — __latticePerf.report() / .reset()");
}
