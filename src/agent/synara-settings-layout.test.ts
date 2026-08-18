import { describe, expect, it } from "vitest";

import {
  applySynaraSettingsHeight,
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

  it("applies a reported height synchronously before the next wheel event", () => {
    const container = document.createElement("div");
    const frame = document.createElement("iframe");

    expect(
      applySynaraSettingsHeight({
        container,
        frame,
        height: 4_812.2,
        active: true,
      }),
    ).toBe(4_813);
    expect(container.style.height).toBe("4813px");
    expect(frame.style.height).toBe("4813px");

    applySynaraSettingsHeight({
      container,
      frame,
      height: 4_813,
      active: false,
    });
    expect(container.style.height).toBe("0px");
    expect(frame.style.height).toBe("4813px");
  });

  it("uses the latest scroll range for the first forwarded wheel", () => {
    const viewport = {
      clientHeight: 470,
      clientWidth: 500,
      scrollHeight: 4_813,
      scrollLeft: 0,
      scrollTop: 1_000,
      scrollWidth: 500,
    };

    expect(scrollSynaraSettingsViewportBy(viewport, 5_000)).toEqual({
      left: 0,
      top: 4_343,
    });
    expect(viewport.scrollTop).toBe(4_343);
  });
});
