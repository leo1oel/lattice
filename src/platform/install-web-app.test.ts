import { afterEach, expect, it, vi } from "vitest";
import { registerWebApp } from "./install-web-app";

afterEach(() => { delete (window as Window & { __LATTICE_HEADLESS__?: boolean }).__LATTICE_HEADLESS__; vi.unstubAllGlobals(); });
it("registers a network-only worker only for a secure standalone server", async () => {
  const register = vi.fn().mockResolvedValue({});
  vi.stubGlobal("navigator", { serviceWorker: { register } });
  vi.stubGlobal("isSecureContext", true);
  await registerWebApp();
  expect(register).not.toHaveBeenCalled();
  (window as Window & { __LATTICE_HEADLESS__?: boolean }).__LATTICE_HEADLESS__ = true;
  await registerWebApp();
  expect(register).toHaveBeenCalledWith("/lattice-sw.js", { scope: "/", updateViaCache: "none" });
  register.mockClear();
  vi.stubGlobal("isSecureContext", false);
  await registerWebApp();
  expect(register).not.toHaveBeenCalled();
});
