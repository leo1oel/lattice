// The project tree in the App suites: it renders into a shadow root, so screen queries do not reach its rows.
/* eslint-disable lingui/no-unlocalized-strings -- test-only code: the strings are the English UI the suites query by, not interface copy */
import { fireEvent, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/** Expands `directories` in the project tree, as a previous session left them. */
export const expandDirectories = (...directories: string[]) => (
  localStorage.setItem("lattice:expanded-directories:/tmp/lattice-paper", JSON.stringify(directories))
);

export const projectTreeRoot = () => document.querySelector("file-tree-container.lattice-file-tree")?.shadowRoot ?? null;
export const queryProjectTreeItem = (path: string) => projectTreeRoot()?.querySelector<HTMLElement>(`[data-item-path="${path}"]`) ?? null;

/** Waits for `selector` inside the project tree's shadow root. */
export function findInProjectTree<T extends HTMLElement = HTMLElement>(selector: string, timeout?: number): Promise<T> {
  return waitFor(() => {
    const element = projectTreeRoot()?.querySelector<T>(selector) ?? null;
    expect(element, `Project tree: ${selector}`).not.toBeNull();
    return element!;
  }, { timeout });
}

export const findProjectTreeItem = (path: string, timeout = 1000) => findInProjectTree(`[data-item-path="${path}"]`, timeout);
export const findProjectTreeRenameInput = () => findInProjectTree<HTMLInputElement>("[data-item-rename-input]");

/** Drags a project-tree row over `target` and drops it there; a function target is re-queried for the drop. */
export function dragTreeItem(source: Element, target: Element | (() => Element)) {
  const at = () => (typeof target === "function" ? target() : target);
  const pointer = { pointerId: 1, pointerType: "mouse" };
  fireEvent.pointerDown(source, { button: 0, clientX: 1, clientY: 1, ...pointer });
  fireEvent.pointerMove(at(), { clientX: 20, clientY: 20, ...pointer });
  fireEvent.pointerUp(at(), { clientX: 20, clientY: 20, ...pointer });
}
