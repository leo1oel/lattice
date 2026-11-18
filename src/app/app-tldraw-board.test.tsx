import {
  EMPTY_BOARD, argPath, fileNodes, invokeCalls, projectSnapshot, refreshableProject, rootDocument,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { invoke } from "@tauri-apps/api/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { renderApp } = appHarness({ documentCanvas });

describe("tldraw boards", () => {
  it("opens a tldraw board as the Excalidraw board converted beside it, never as the tldraw file", async () => {
    const snapshot = projectSnapshot({
      rootDocuments: rootDocument("notes.md"), files: fileNodes("notes.md", "legacy.tldr"),
    });
    renderApp({
      ...refreshableProject(snapshot), write_project_file: undefined,
      read_project_file: (args) => argPath(args) === "notes.md" ? "[Old board](legacy.tldr)" : EMPTY_BOARD,
      convert_tldr_board: () => "legacy.excalidraw",
    });

    fireEvent.click(await screen.findByRole("link", { name: "Old board" }));
    expect(await screen.findByTestId("board-editor-mock")).toBeInTheDocument();
    expect(invokeCalls("convert_tldr_board")).toEqual([["convert_tldr_board", { path: "legacy.tldr", projectRoot: snapshot.root }]]);
    expect(await screen.findByRole("tab", { name: /legacy\.excalidraw/ })).toHaveAttribute("aria-selected", "true");
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", { path: "legacy.tldr", projectRoot: snapshot.root });
  }, 40_000);
});
