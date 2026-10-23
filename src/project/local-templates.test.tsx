import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalTemplates } from "./local-templates";

const api = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: api.open }));
const source = { files: ["main.tex", "appendix.tex", "figures/图.png"], root: "main.tex", engine: "xelatex" };
beforeEach(() => {
  api.open.mockReset().mockResolvedValue("/tmp/school");
  api.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "list_local_templates") return [];
    if (command === "inspect_template_source") return source;
    if (command === "save_local_template") return { ...args.template, id: "new-id" };
    throw new Error(command);
  });
});
afterEach(cleanup);

it("requires explicit file selection, saves metadata and selects the new template", async () => {
  const onSelect = vi.fn();
  render(<LocalTemplates selected="blank" onSelect={onSelect} currentProject />);
  fireEvent.click(await screen.findByRole("button", { name: "Save a local template…" }));
  fireEvent.click(screen.getByRole("button", { name: "Current project" }));
  fireEvent.change(await screen.findByLabelText("Template name"), { target: { value: "学校期刊模板" } });
  expect(api.invoke).toHaveBeenCalledWith("inspect_template_source", { source: null });
  const save = screen.getByRole("button", { name: "Save template" });
  expect(save).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "main.tex" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "main.tex" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "figures/图.png" }));
  fireEvent.change(screen.getByLabelText("Preview image"), { target: { value: "figures/图.png" } });
  fireEvent.click(save);
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith("local:new-id"));
  expect(api.invoke).toHaveBeenCalledWith("save_local_template", { source: null, template: expect.objectContaining({
    name: "学校期刊模板", files: ["main.tex", "figures/图.png"], root: "main.tex", engine: "xelatex", preview: "figures/图.png",
  }) });
});

it("keeps a failed save reviewable and leaves selection unchanged", async () => {
  const onSelect = vi.fn();
  render(<LocalTemplates selected="icml" onSelect={onSelect} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save a local template…" }));
  expect(screen.queryByRole("button", { name: "Current project" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "From ZIP" }));
  fireEvent.change(await screen.findByLabelText("Template name"), { target: { value: "Journal" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "main.tex" }));
  api.invoke.mockRejectedValueOnce(new Error("Disk is full"));
  fireEvent.click(screen.getByRole("button", { name: "Save template" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Disk is full"));
  expect(screen.getByRole("checkbox", { name: "main.tex" })).toBeChecked();
  expect(onSelect).not.toHaveBeenCalled();
  expect(api.open).toHaveBeenCalledWith(expect.objectContaining({ directory: false, filters: [{ name: "ZIP archive", extensions: ["zip"] }] }));
});

it("labels saved versions and offers uppercase preview images", async () => {
  api.invoke.mockImplementation(async (command) => {
    if (command === "list_local_templates") return [
      { id: "a", name: "Lab template", sourceUrl: "", version: "2025", files: ["main.tex"], root: "main.tex", engine: "pdf", preview: null },
      { id: "b", name: "Lab template", sourceUrl: "", version: "2026", files: ["main.tex"], root: "main.tex", engine: "pdf", preview: null },
    ];
    if (command === "inspect_template_source") return { ...source, files: ["main.tex", "figures/Preview.PNG"] };
    throw new Error(command);
  });
  render(<LocalTemplates selected="local:b" onSelect={vi.fn()} />);
  expect(await screen.findByRole("combobox", { name: "My templates" })).toHaveTextContent("Lab template · 2026");
  fireEvent.click(screen.getByRole("button", { name: "Save a local template…" }));
  fireEvent.click(screen.getByRole("button", { name: "From folder" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "figures/Preview.PNG" }));
  fireEvent.change(screen.getByLabelText("Preview image"), { target: { value: "figures/Preview.PNG" } });
  expect(screen.getByLabelText("Preview image")).toHaveValue("figures/Preview.PNG");
});
