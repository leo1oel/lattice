import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findProjectTreeItem, fileNodes, projectCommands, projectSnapshot, waitForSelectedTab } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";

const { renderApp } = appHarness({ documentCanvas });

const tabNames = () => screen.queryAllByRole("tab").map((tab) => tab.textContent ?? "").filter((name) => /\.(tex|md)/.test(name));

describe("preview tabs from the Project tree", () => {
  it("opens a pressed file as a preview the next press replaces, and keeps one double-clicked", async () => {
    renderApp(projectCommands(projectSnapshot({ files: fileNodes("main.tex", "a.md", "b.md", "c.md") })));
    await waitForSelectedTab("main.tex");

    fireEvent.click(await findProjectTreeItem("a.md"));
    await waitForSelectedTab("a.md");
    // Screen readers hear the mark the italic title shows.
    expect(screen.getByRole("tab", { name: /Preview.*a\.md/ })).toBeInTheDocument();

    fireEvent.click(await findProjectTreeItem("b.md"));
    await waitForSelectedTab("b.md");
    await waitFor(() => expect(tabNames()).toEqual(["main.tex", "Previewb.md"]));

    fireEvent.doubleClick(await findProjectTreeItem("b.md"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ }).textContent).not.toMatch(/Preview/));
    fireEvent.click(await findProjectTreeItem("c.md"));
    await waitForSelectedTab("c.md");
    await waitFor(() => expect(tabNames()).toEqual(["main.tex", "b.md", "Previewc.md"]));
  });
});
