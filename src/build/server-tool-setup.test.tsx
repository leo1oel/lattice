import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TexSetupWizard } from "./tex-setup-wizard";

afterEach(() => { cleanup(); delete (window as Window & { __LATTICE_HEADLESS__?: boolean }).__LATTICE_HEADLESS__; });
it("lets a headless writer continue editing and rechecks server tools without launching the macOS installer", async () => {
  (window as Window & { __LATTICE_HEADLESS__?: boolean }).__LATTICE_HEADLESS__ = true;
  const close = vi.fn();
  const recheck = vi.fn().mockResolvedValue(null);
  render(<TexSetupWizard open checking={false} report={{ ok: false, summary: "missing tools", checks: [] }} onClose={close} onRecheck={recheck} />);
  await screen.findByText("Configure tools on the server");
  expect(screen.queryByRole("button", { name: /Install Basic/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Recheck server tools" }));
  expect(recheck).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
  expect(close).toHaveBeenCalledOnce();
});
