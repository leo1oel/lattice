// The Tauri app keeps a TypeScript copy of the contrast fitting for the
// build-time code-theme export and the highlight palette; the app's accent
// and theme fitting run in Rust (lattice_theme::color). These vectors are
// written by that Rust code, so the copy cannot drift from it.
import { describe, expect, it } from "vitest";

import vectors from "../../design-system/themes/color-vectors.json";
import { contrastRatio, fitContrast } from "./theme-customization";

type Vector = { grounds: string; on: string[]; kind: "light" | "dark"; ratio: number; color: string; fitted: string; contrast: number };

describe("contrast fitting matches lattice_theme::color", () => {
  it.each((vectors.cases as Vector[]).map((vector) => [`${vector.color} at ${vector.ratio}:1 on ${vector.grounds}`, vector] as const))(
    "%s",
    (_, vector) => {
      expect(fitContrast(vector.color, vector.on, vector.ratio, vector.kind)).toBe(vector.fitted);
      expect(contrastRatio(vector.color, vector.on[0])).toBeCloseTo(vector.contrast, 5);
    },
  );
});
