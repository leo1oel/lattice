import { petText } from "./pet-text";
import { paintSprite, type PetActivity } from "./pet-sprite";
import "./pet-window.css";

type NativeWindow = Window & { __LATTICE_PET_GENERATION__?: string; __TAURI_INTERNALS__?: { invoke: <T>(command: string, args?: unknown) => Promise<T> } };
const invoke = <T,>(command: string, args?: unknown): Promise<T> => {
  const native = (window as NativeWindow).__TAURI_INTERNALS__;
  return native ? native.invoke<T>(command, args) : Promise.reject(new Error(text.unavailable));
};
const text = petText(new URLSearchParams(window.location.search).get("locale") ?? navigator.language);

interface Snapshot { enabled: boolean; name: string | null; version: number | null; activity: PetActivity }

/** A separate entry: opening a pet does not mount the research workspace. */
export async function mountPet(root: HTMLElement): Promise<() => void> {
  const controls = document.createElement("div");
  controls.className = "pet-controls";
  const drag = document.createElement("button");
  drag.textContent = "⠿";
  drag.ariaLabel = text.drag;
  drag.addEventListener("pointerdown", (event) => {
    if (event.button === 0) void invoke("plugin:window|start_dragging", { label: "desktop-pet" }).catch(report);
  });
  const close = document.createElement("button");
  close.textContent = "×";
  close.ariaLabel = text.hide;
  close.addEventListener("click", () => {
    void invoke("desktop_pet_set_enabled", { enabled: false }).catch(report);
  });
  controls.append(drag, close);
  const sprite = document.createElement("button");
  sprite.className = "pet-sprite";
  const status = document.createElement("div");
  status.className = "pet-status";
  status.setAttribute("role", "status");
  root.append(controls, sprite, status);
  const generation = (window as NativeWindow).__LATTICE_PET_GENERATION__ ?? "";
  const ready = (failed: boolean) => invoke("desktop_pet_ready", { generation, failed });
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let disposed = false;
  let activity: PetActivity = "idle";
  let version = 1;
  let waveUntil = 0;
  let animation: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity: PetActivity = "idle";
  let began = performance.now();
  function report() { if (!disposed) status.textContent = text.unavailable; }

  const animate = (now: number) => {
    if (disposed) return;
    const next = waveUntil > now ? "wave" : activity;
    if (next !== lastActivity) { began = now; lastActivity = next; }
    const remaining = paintSprite(sprite, version, next, now - began, reduced.matches);
    // A non-key WKWebView can suspend rAF even while its floating window is
    // visible. Schedule actual sprite boundaries instead of polling at 60 Hz.
    if (!reduced.matches) animation = setTimeout(() => animate(performance.now()), Math.max(16, remaining));
  };
  const motionChanged = () => {
    clearTimeout(animation);
    animate(performance.now());
  };
  reduced.addEventListener("change", motionChanged);
  sprite.addEventListener("click", () => {
    clearTimeout(animation);
    waveUntil = performance.now() + 700;
    animate(performance.now());
  });

  const refresh = async (initial = false) => {
    try {
      const snapshot = await invoke<Snapshot>("desktop_pet_status");
      if (disposed) return;
      activity = snapshot.activity;
      version = snapshot.version ?? 1;
      sprite.ariaLabel = `${snapshot.name ?? ""}: ${text.wave}`;
      const label = activity === "building" ? text.building : activity === "working" ? text.working : text.ready;
      if (status.textContent !== label) status.textContent = label;
    } catch (reason) { report(); if (initial) throw reason; }
    if (!disposed) timer = setTimeout(() => { void refresh(); }, 1000);
  };
  try {
    const asset = await invoke<string>("desktop_pet_asset");
    if (disposed) return () => {};
    const image = new Image();
    image.src = asset;
    await image.decode();
    if (disposed) return () => {};
    sprite.style.backgroundImage = `url(${JSON.stringify(asset)})`;
    await refresh(true);
    paintSprite(sprite, version, activity, 0, reduced.matches);
    await ready(false);
    animate(performance.now());
  } catch {
    report();
    // Report only a boolean: decoder errors can contain the private data URL.
    await ready(true).catch(() => undefined);
  }
  return () => {
    disposed = true;
    clearTimeout(animation);
    clearTimeout(timer);
    reduced.removeEventListener("change", motionChanged);
    root.replaceChildren();
  };
}

if (document.getElementById("companion")) {
  void mountPet(document.getElementById("companion")!).then((dispose) => {
    window.addEventListener("pagehide", dispose, { once: true });
  });
}
