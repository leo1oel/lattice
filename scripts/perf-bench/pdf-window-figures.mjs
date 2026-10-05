/**
 * The figures pdf-window-timing.mjs reports for each run, shared with
 * scripts/check-perf-evidence.mjs, which recomputes docs/performance.md's
 * page-window tables from the retained runs with these same definitions.
 */

export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * The frame rate of a measurement Playwright's WebKit paced at the display's
 * 60 Hz, or null: now and then it paces at 30 Hz for a while (in either
 * variant, sometimes for one gesture of a run), which halves the rate whatever
 * the page does. Its longest frame still counts.
 */
const fps = (frames) => (median(frames) < 25 ? (frames.length * 1000) / frames.reduce((sum, frame) => sum + frame, 0) : null);

/** Each figure of a run by name, in the order the driver prints them. */
export function figures(engine) {
  const read = {
    "open ms": (run) => run.openMs,
    "jump ms": (run) => run.jumpMs,
    elements: (run) => run.elements,
    "page boxes": (run) => run.pageBoxes,
  };
  for (const name of ["in", "out"]) {
    if (engine === "webkit") {
      read[`zoom ${name} fps`] = (run) => fps(run.zoom[name].frames);
      read[`zoom ${name} longest frame ms`] = (run) => Math.max(...run.zoom[name].frames);
    } else {
      read[`zoom ${name} style ms`] = (run) => run.zoom[name].styleMs;
      read[`zoom ${name} layout ms`] = (run) => run.zoom[name].layoutMs;
    }
    read[`zoom ${name} page under pointer moved`] = (run) => Number(run.zoom[name].pageBefore !== run.zoom[name].pageAfter);
  }
  if (engine === "webkit") {
    read["scroll fps"] = (run) => fps(run.scroll.frames);
    read["scroll longest frame ms"] = (run) => Math.max(...run.scroll.frames);
  } else {
    read["scroll style ms"] = (run) => run.scroll.styleMs;
    read["scroll layout ms"] = (run) => run.scroll.layoutMs;
  }
  read["scroll frames with a blank page"] = (run) => run.scroll.blankFrames;
  read["scroll frames with a spacer"] = (run) => run.scroll.spacerFrames;
  read["page errors"] = (run) => run.errors.length;
  return read;
}

/** One figure of one run: a number, or null where it does not apply (fps at 30 Hz). */
export function readFigure(run, name) {
  const read = figures(run.engine)[name];
  if (!read) throw new Error(`pdf-window-timing has no figure "${name}" for ${run.engine}`);
  return read(run);
}
