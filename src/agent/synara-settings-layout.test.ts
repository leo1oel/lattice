import { describe, expect, it } from "vitest";

import {
  applySynaraSettingsHeight,
  applySynaraSettingsWheel,
  isSettingsViewportNearBottom,
  normalizeSynaraSettingsHeight,
  scrollSynaraSettingsViewportBy,
} from "./synara-settings-layout";

describe("Synara settings layout", () => {
  it("normalizes reported content heights into the supported range", () => {
    expect(normalizeSynaraSettingsHeight(120)).toBe(470);
    expect(normalizeSynaraSettingsHeight(812.2)).toBe(813);
    expect(normalizeSynaraSettingsHeight(8_000)).toBe(8_000);
    expect(normalizeSynaraSettingsHeight(100_000)).toBe(64_000);
  });

  it.each([
    [470, 1_200, 706, true],
    [470, 1_200, 705, false],
    [600, 470, 0, false],
  ])("treats a %ipx viewport over %ipx content at scrollTop %i as near the bottom: %s", (clientHeight, scrollHeight, scrollTop, near) => {
    expect(isSettingsViewportNearBottom({ clientHeight, scrollHeight, scrollTop })).toBe(near);
  });

  it("applies a reported height synchronously before the next wheel event", () => {
    const container = document.createElement("div");
    const frame = document.createElement("iframe");

    expect(applySynaraSettingsHeight({ container, frame, height: 4_812.2, active: true })).toBe(4_813);
    expect(container.style.height).toBe("4813px");
    expect(frame.style.height).toBe("4813px");

    applySynaraSettingsHeight({ container, frame, height: 4_813, active: false });
    expect(container.style.height).toBe("0px");
    expect(frame.style.height).toBe("4813px");
  });

  const viewport = () => ({
    clientHeight: 470,
    clientWidth: 500,
    scrollHeight: 4_813,
    scrollLeft: 0,
    scrollTop: 1_000,
    scrollWidth: 500,
  });

  it("uses the latest scroll range for the first forwarded wheel", () => {
    const settings = viewport();
    expect(scrollSynaraSettingsViewportBy(settings, 5_000)).toEqual({ left: 0, top: 4_343 });
    expect(settings.scrollTop).toBe(4_343);
  });

  it("scales line-mode wheels onto the host settings viewport", () => {
    const settings = viewport();
    expect(applySynaraSettingsWheel(settings, { deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ left: 0, top: 1_048 });
    expect(settings.scrollTop).toBe(1_048);
  });
});
