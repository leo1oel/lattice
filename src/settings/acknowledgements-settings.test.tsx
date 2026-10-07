import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcknowledgementsSettings } from "./acknowledgements-settings";

const license = vi.hoisted(() => ({ url: null as string | null }));
vi.mock("virtual:lattice-private-fonts-license", () => ({
  get fontLicenseUrl() {
    return license.url;
  },
}));
// The real viewer needs PDF.js and a canvas; what matters here is which file it is given.
vi.mock("../canvas/canvas-lazy-editors", () => ({
  PdfPreview: ({ url }: { url: string }) => <div role="document" data-url={url} />,
  PdfPreviewLoading: () => null,
}));

// What the bundled THIRD_PARTY_NOTICES.md holds, in the generator's shape.
const NOTICES = [
  "<!-- BEGIN GENERATED NOTICES — do not edit below this line -->",
  "## npm packages (web assets)",
  "#### 1. MIT — 2 package(s), from `LICENSE`",
  "`react@19.2.7`, `zustand@5.0.15`",
  "Copyright notices (1):",
  "```text",
  "Copyright (c) Meta Platforms, Inc. and affiliates.",
  "```",
  "```text",
  "MIT License — permission is hereby granted",
  "```",
  "## Rust crates (`src-tauri`)",
  "#### 1. MIT OR Apache-2.0 — 1 package(s), from `LICENSE-APACHE`",
  "`tauri@2.11.5`",
  "```text",
  "Apache License, Version 2.0",
  "```",
  "<!-- END GENERATED NOTICES -->",
].join("\n");

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(NOTICES)));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPane() {
  const view = render(<AcknowledgementsSettings />);
  await act(async () => {});
  return view;
}

describe("acknowledgements", () => {
  it("credits the software Lattice ships, with the version and license its notices record", async () => {
    license.url = null;
    await renderPane();
    expect(screen.getByRole("heading", { name: "Acknowledgements" })).toBeInTheDocument();
    const tauri = screen.getByText("Tauri").closest<HTMLElement>("[data-slot=settings-row]")!;
    expect(within(tauri).getByText("MIT OR Apache-2.0 · 2.11.5")).toBeInTheDocument();
    expect(screen.getByText("Open Knowledge")).toBeInTheDocument();
    expect(screen.getByText(/Uses Trellis by DanFessler - github\.com\/DanFessler\/trellis/)).toBeInTheDocument();
    // A build without the licensed fonts does not mention them.
    expect(screen.queryByText("Timeless")).not.toBeInTheDocument();
  });

  it("lists every shipped package by closure, searchable, and opens each one's license text", async () => {
    license.url = null;
    await renderPane();
    expect(screen.getByText(/ships 3 open-source packages/)).toBeInTheDocument();
    const interfaceClosure = screen.getByRole("button", { name: /Interface\s*2 packages/ });
    expect(interfaceClosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /zustand/ })).not.toBeInTheDocument();
    fireEvent.click(interfaceClosure);
    expect(screen.getByRole("button", { name: /zustand/ })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search third-party software" }), { target: { value: "tau" } });
    expect(screen.queryByRole("button", { name: /zustand/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /tauri\s*2\.11\.5/ }));
    const dialog = screen.getByRole("dialog", { name: "tauri 2.11.5" });
    expect(within(dialog).getByText("Apache License, Version 2.0")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /crates\.io/ })).toBeInTheDocument();
  });

  it("opens the whole notices file the app ships", async () => {
    license.url = null;
    await renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Third-party notices" }));
    const dialog = screen.getByRole("dialog", { name: "Third-party notices" });
    expect(dialog.querySelector("pre")?.textContent).toBe(NOTICES);
  });

  it("credits the embedded fonts and opens their shipped license in the PDF viewer", async () => {
    // A stand-in: the real license may not enter the repository.
    license.url = "/assets/LICENSE-stand-in.pdf";
    await renderPane();
    expect(screen.getByText(/used under the Timeless Free Font License/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /timeless\.co/ })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View license" }));
    const dialog = screen.getByRole("dialog", { name: "Timeless Free Font License" });
    expect(dialog.querySelector("[role=document]")).toHaveAttribute("data-url", "/assets/LICENSE-stand-in.pdf");
  });
});
