import { afterEach, expect, it, vi } from "vitest";
import { mountPet } from "./pet-window";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  const native = window as unknown as { __TAURI_INTERNALS__?: unknown; __LATTICE_PET_GENERATION__?: unknown };
  delete native.__TAURI_INTERNALS__; delete native.__LATTICE_PET_GENERATION__;
});

it("loads imported art, reports live work, drags and hides through native commands, and stops on disposal", async () => {
  const invoke = vi.fn(async (command: string) => {
    if (command === "desktop_pet_asset") return "data:image/png;base64,cGV0";
    if (command === "desktop_pet_status") return { enabled: true, name: "Sample", version: 1, activity: "building" };
    if (command === "desktop_pet_ready") {
      const frame = root.querySelector<HTMLElement>(".pet-sprite")!;
      expect(frame.style.backgroundImage).toContain("data:image/png");
      expect(frame.style.backgroundPosition).toBe("0% 0%");
      expect(root.textContent).toContain("Building");
    }
  });
  Object.assign(window, { __TAURI_INTERNALS__: { invoke }, __LATTICE_PET_GENERATION__: "test-generation" });
  vi.stubGlobal("Image", class { src = ""; decode = vi.fn(async () => {}); });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const animation = vi.spyOn(window, "requestAnimationFrame");
  const root = document.createElement("main");
  document.body.append(root);
  const dispose = await mountPet(root);
  expect(root.textContent).toContain("Building");
  expect(invoke).toHaveBeenCalledWith("desktop_pet_ready", { generation: "test-generation", failed: false });
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

it("keeps readiness pending until the actual image decodes and reports decoder failure without leaking its URL", async () => {
  let decode!: () => void;
  let rejectDecode!: (reason: Error) => void;
  const invoke = vi.fn(async (command: string) => {
    if (command === "desktop_pet_asset") return "data:image/png;base64,cHJpdmF0ZQ==";
    if (command === "desktop_pet_status") return { enabled: false, name: "Sample", version: 1, activity: "idle" };
  });
  Object.assign(window, { __TAURI_INTERNALS__: { invoke }, __LATTICE_PET_GENERATION__: "pending-generation" });
  vi.stubGlobal("Image", class { src = ""; decode = () => new Promise<void>((done, fail) => { decode = done; rejectDecode = fail; }); });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const root = document.createElement("main");
  const mounting = mountPet(root);
  await Promise.resolve();
  expect(decode).toBeTypeOf("function");
  expect(invoke).not.toHaveBeenCalledWith("desktop_pet_ready", expect.anything());
  rejectDecode(new Error("decoder failed data:image/png;base64,cHJpdmF0ZQ=="));
  const dispose = await mounting;
  expect(root.textContent).toContain("Companion unavailable");
  expect(invoke).toHaveBeenCalledWith("desktop_pet_ready", { generation: "pending-generation", failed: true });
  expect(invoke.mock.calls.filter(([command]) => command === "desktop_pet_ready")).toEqual([
    ["desktop_pet_ready", { generation: "pending-generation", failed: true }],
  ]);
  expect(root.querySelector<HTMLElement>(".pet-sprite")!.style.backgroundImage).toBe("");
  dispose();
});

it("advances native-style sprite timers for a wave and stops them when reduced motion changes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 0));
  const invoke = vi.fn(async (command: string) => {
    if (command === "desktop_pet_asset") return "data:image/png;base64,cGV0";
    if (command === "desktop_pet_status") return { enabled: true, name: "Sample", version: 1, activity: "idle" };
  });
  let changed!: () => void;
  const media = { matches: false, addEventListener: (_event: string, listener: () => void) => { changed = listener; }, removeEventListener: vi.fn() };
  Object.assign(window, { __TAURI_INTERNALS__: { invoke }, __LATTICE_PET_GENERATION__: "timer-generation" });
  vi.stubGlobal("Image", class { src = ""; decode = async () => {}; });
  vi.stubGlobal("matchMedia", () => media);
  const root = document.createElement("main");
  const dispose = await mountPet(root);
  const sprite = root.querySelector<HTMLButtonElement>(".pet-sprite")!;
  sprite.click();
  expect(sprite.style.backgroundPosition).toBe("0% 37.5%");
  await vi.advanceTimersByTimeAsync(150);
  expect(sprite.style.backgroundPosition).toBe("14.285714285714286% 37.5%");
  media.matches = true;
  changed();
  expect(sprite.style.backgroundPosition).toBe("0% 0%");
  expect(vi.getTimerCount()).toBe(1); // only the native status refresh remains
  dispose();
  expect(vi.getTimerCount()).toBe(0);
});
