import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImportConflictDialog from "./import-conflict-dialog";
import type { NameConflict } from "../app/use-project-tree";
import { activateAppLocale } from "../i18n";

function renderConflict(names = ["main.tex"], targetDirectory = "figures") {
  const answer = vi.fn<(choice: NameConflict | null) => void>();
  render(<ImportConflictDialog request={{ names, targetDirectory, answer }} />);
  return answer;
}

describe("ImportConflictDialog", () => {
  beforeEach(async () => { await activateAppLocale("en"); });
  afterEach(cleanup);

  it("names the one taken file and the folder it is in", () => {
    renderConflict(["main.tex"], "figures");
    expect(screen.getByRole("dialog", { name: "“main.tex” is already in figures" })).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    cleanup();
    renderConflict(["main.tex"], "");
    expect(screen.getByRole("dialog", { name: "“main.tex” is already in the project root" })).toBeInTheDocument();
  });

  it("counts several names and lists the first three", () => {
    renderConflict(["a.tex", "b.tex", "c.tex", "d.tex", "e.tex"], "sections");
    expect(screen.getByRole("dialog", { name: "5 items with these names are already in sections" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["a.tex", "b.tex", "c.tex", "and 2 more"]);
  });

  it.each<[string, NameConflict | null]>([
    ["Keep both", "keepBoth"],
    ["Replace", "replace"],
    ["Skip", "skip"],
    ["Cancel", null],
  ])("%s answers %s", (label, choice) => {
    const answer = renderConflict();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith(choice);
  });

  it("focuses Keep both, so Enter keeps both, and Escape cancels", async () => {
    const answer = renderConflict();
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep both" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(answer).toHaveBeenCalledWith(null);
  });

  it("draws Replace in the danger ink and the other answers as plain buttons", () => {
    renderConflict();
    expect(screen.getByRole("button", { name: "Replace" })).toHaveClass("import-conflict-replace");
    expect(screen.getByRole("button", { name: "Keep both" })).toHaveClass("ui-button--primary");
  });

  it("asks in Chinese", async () => {
    await activateAppLocale("zh-CN");
    renderConflict(["main.tex"], "figures");
    expect(screen.getByRole("dialog", { name: "figures 中已有“main.tex”" })).toBeInTheDocument();
    for (const label of ["取消", "跳过", "替换", "保留两者"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });
});
