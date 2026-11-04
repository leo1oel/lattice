import { afterEach, expect, it, vi } from "vitest";
import { mountPet } from "./pet-window";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("loads imported art, reports live work, drags and hides through native commands, and stops on disposal", async () => {
  const invoke = vi.fn(async (command: string) => {
    if (command === "desktop_pet_asset") return "data:image/png;base64,cGV0";
    if (command === "desktop_pet_status") return { enabled: true, name: "Sample", version: 1, activity: "building" };
  });
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
  vi.stubGlobal("Image", class { src = ""; decode = vi.fn(async () => {}); });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const animation = vi.spyOn(window, "requestAnimationFrame");
  const root = document.createElement("main");
  document.body.append(root);
  const dispose = await mountPet(root);
  expect(root.textContent).toContain("Building");
  const sprite = root.querySelector<HTMLElement>(".pet-sprite")!;
  expect(sprite.style.backgroundImage).toContain("data:image/png");
  expect(sprite.style.backgroundPosition).toBe("0% 0%");
  expect(animation).not.toHaveBeenCalled();
  root.querySelector('button[aria-label="Drag companion"]')!.dispatchEvent(new MouseEvent("pointerdown", { button: 0 }));
  expect(invoke).toHaveBeenCalledWith("plugin:window|start_dragging", { label: "desktop-pet" });
  (root.querySelector('button[aria-label="Hide companion"]') as HTMLElement).click();
  expect(invoke).toHaveBeenCalledWith("desktop_pet_set_enabled", { enabled: false });
  dispose();
  expect(root.children).toHaveLength(0);
  animation.mockRestore();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
