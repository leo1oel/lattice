import { expect, it } from "vitest";
import { paintSprite } from "./pet-sprite";

it("draws the selected state through both atlas layouts and never enters an unused cell", () => {
  const sprite = document.createElement("button");
  paintSprite(sprite, 1, "working", 0, false);
  expect(sprite.style.backgroundSize).toBe("800% 900%");
  expect(sprite.style.backgroundPosition).toBe("0% 100%");
  paintSprite(sprite, 2, "working", 151, false);
  expect(sprite.style.backgroundSize).toBe("800% 1100%");
  expect(sprite.style.backgroundPosition).toBe("14.285714285714286% 80%");
  paintSprite(sprite, 1, "wave", 600, false);
  expect(sprite.style.backgroundPosition).toBe("42.857142857142854% 37.5%");
});

it("returns to a still idle frame when reduced motion is enabled during work", () => {
  const sprite = document.createElement("button");
  paintSprite(sprite, 1, "building", 300, false);
  expect(sprite.style.backgroundPosition).not.toBe("0% 0%");
  paintSprite(sprite, 1, "building", 400, true);
  expect(sprite.style.backgroundPosition).toBe("0% 0%");
});
