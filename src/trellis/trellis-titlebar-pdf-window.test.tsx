import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detachPdf, pdfWindowOpen } from "../app/pdf-window-state";
import { TrellisController } from "./trellis-controller";
import { TrellisTitlebar } from "./trellis-titlebar";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("the titlebar while the PDF is in its own window", () => {
  it("shows a chip that brings the PDF back to the workspace", () => {
    const controller = new TrellisController();
    controller.app.set({ projectRoot: "/papers/chip" });
    const showPanel = vi.spyOn(controller, "showPanel").mockImplementation(() => {});
    render(<TrellisTitlebar controller={controller} />);
    expect(screen.queryByRole("button", { name: /PDF window/ })).toBeNull();

    act(() => detachPdf(controller, "/papers/chip"));
    const chip = screen.getByRole("button", { name: /PDF window/ });
    fireEvent.click(chip);
    expect(pdfWindowOpen("/papers/chip")).toBe(false);
    expect(showPanel).toHaveBeenCalledWith("pdf", { focus: false });
    expect(screen.queryByRole("button", { name: /PDF window/ })).toBeNull();
  });
});
