import { describe, expect, it } from "vitest";
import {
  isProjectIndexPending, PROJECT_INDEX_IDLE, projectIndexNotice, projectIndexReducer, type ProjectIndexAction,
} from "./project-index-load";

const after = (...actions: ProjectIndexAction[]) => actions.reduce(projectIndexReducer, PROJECT_INDEX_IDLE);
const OLD_DRAFT = { path: "archive/old-draft.tex", reason: "notUtf8" } as const;

describe("project index load", () => {
  it("waits for both reads before checking or listing skipped files", () => {
    const halfway = after({ type: "reset" }, { type: "loaded", part: "references", skipped: [OLD_DRAFT] });
    expect([isProjectIndexPending(halfway), projectIndexNotice(halfway)]).toEqual([true, null]);

    const landed = projectIndexReducer(halfway, { type: "loaded", part: "citations", skipped: [] });
    expect([isProjectIndexPending(landed), projectIndexNotice(landed)]).toEqual([false, { kind: "skipped", files: [OLD_DRAFT] }]);
  });

  it("keeps the checks off and says why when a first read fails", () => {
    const failed = after({ type: "reset" }, { type: "failed", part: "citations", error: "denied" });
    expect([isProjectIndexPending(failed), projectIndexNotice(failed)]).toEqual([true, { kind: "failed", error: "denied" }]);
  });

  it("keeps an index already read when a later read fails", () => {
    const read = after({ type: "reset" }, { type: "loaded", part: "citations", skipped: [] }, { type: "loaded", part: "references", skipped: [] });
    expect(projectIndexReducer(read, { type: "failed", part: "references", error: "busy" })).toBe(read);
  });
});
