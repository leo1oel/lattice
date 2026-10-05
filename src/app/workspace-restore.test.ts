import { describe, expect, it } from "vitest";
import type { PaperSummary, ProjectSnapshot } from "../app-types";
import { paperTabKey } from "../app-utils";
import type { WorkspaceLayout } from "../settings/app-settings";
import { planWorkspaceRestore } from "./workspace-restore";

const file = (path: string) => ({ name: path.split("/").at(-1)!, path, kind: "tex", children: [] });

const snapshot = {
  root: "/tmp/sample",
  files: [file("main.tex"), file("sections/intro.tex")],
  manifest: { rootDocuments: [{ path: "main.tex", isDefault: true }] },
} as unknown as ProjectSnapshot;

const vit: PaperSummary = { arxivId: "2010.11929", title: "An Image is Worth 16x16 Words", hasFullText: true, hasBlog: true };
const layout = (activeTab: string) => ({
  openTabs: ["sections/intro.tex", paperTabKey(vit.arxivId)],
  activeTab,
  activeFile: "sections/intro.tex",
  canvasMode: "pdf",
}) as WorkspaceLayout;

describe("workspace restore", () => {
  it("reopens a Paper tab that can still be read", () => {
    const plan = planWorkspaceRestore(snapshot, [vit], layout(paperTabKey(vit.arxivId)), null);
    expect(plan).toMatchObject({
      primaryFile: "sections/intro.tex",
      tabs: ["sections/intro.tex", paperTabKey(vit.arxivId)],
      activeTab: paperTabKey(vit.arxivId),
      activeKind: "paper",
    });
  });

  // Resetting the sample project deletes a paper imported into it; the
  // bibliography keeps the entry, with neither a Blog nor a full text. Its
  // restored tab used to fail to read and show a missing-file toast.
  it("drops a Paper tab with nothing left to read, opening the root document in place of an active one", () => {
    const deleted = { ...vit, hasFullText: false, hasBlog: false };
    expect(planWorkspaceRestore(snapshot, [deleted], layout(paperTabKey(vit.arxivId)), null)).toMatchObject({
      primaryFile: "main.tex",
      tabs: ["sections/intro.tex", "main.tex"],
      activeTab: "main.tex",
      activeKind: "document",
    });
    // A source file that was active stays active.
    expect(planWorkspaceRestore(snapshot, [deleted], layout("sections/intro.tex"), null)).toMatchObject({
      primaryFile: "sections/intro.tex",
      tabs: ["sections/intro.tex"],
      activeTab: "sections/intro.tex",
    });
  });
});
