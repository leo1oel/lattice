import { beforeEach, describe, expect, it, vi } from "vitest";

const cuelume = vi.hoisted(() => ({
  play: vi.fn(),
  setEnabled: vi.fn(),
  setVolume: vi.fn(),
}));

vi.mock("cuelume", () => cuelume);

import {
  configureInterfaceSounds,
  playInterfaceSound,
} from "./interface-sounds";

describe("interface sounds", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the palette quiet and honors the global preference", () => {
    configureInterfaceSounds(false);

    expect(cuelume.setVolume).toHaveBeenCalledWith(0.5);
    expect(cuelume.setEnabled).toHaveBeenCalledWith(false);
  });

  it("maps app outcomes to restrained semantic cues", () => {
    playInterfaceSound("build-succeeded");
    playInterfaceSound("build-failed");
    playInterfaceSound("collaboration-ready");

    expect(cuelume.play.mock.calls).toEqual([
      ["ready"],
      ["error"],
      ["arrival"],
    ]);
  });

  it("never lets unavailable audio break the completed operation", () => {
    cuelume.play.mockImplementationOnce(() => {
      throw new Error("AudioContext unavailable");
    });

    expect(() => playInterfaceSound("build-succeeded")).not.toThrow();
  });
});
