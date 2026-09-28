import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCollabEnabled, loadCollabFeaturePolicy, mayResumeCollabProject, mayWriteCollabProject } from "./collab-feature-policy";

const DEFAULTS = { allowCreateV2: true, emergencyDisableWrites: false, emergencyDisableReads: false };
const persist = (policy: object) => localStorage.setItem("lattice.collab.feature-policy.v1", JSON.stringify(policy));

describe("collaboration feature policy", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "", "false"])("disables sharing without explicit build opt-in (%s), even with persisted enablement", (value) => {
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", value);
    persist(DEFAULTS);
    expect(isCollabEnabled()).toBe(false);
    expect(loadCollabFeaturePolicy()).toEqual({ allowCreateV2: false, emergencyDisableReads: true, emergencyDisableWrites: true });
    expect(mayResumeCollabProject()).toBe(false);
    expect(mayWriteCollabProject()).toBe(false);
  });

  it("retains sharing in explicitly opted-in builds", () => {
    expect(isCollabEnabled()).toBe(true);
    expect(loadCollabFeaturePolicy()).toEqual(DEFAULTS);
    expect(mayResumeCollabProject()).toBe(true);
    expect(mayWriteCollabProject()).toBe(true);
  });

  it("layers a persisted override under build-time env flags", () => {
    persist({ allowCreateV2: false, emergencyDisableWrites: true, emergencyDisableReads: "yes" });
    expect(loadCollabFeaturePolicy()).toEqual({ allowCreateV2: false, emergencyDisableWrites: true, emergencyDisableReads: false });
    vi.stubEnv("VITE_LATTICE_COLLAB_DISABLE_WRITES", "false");
    expect(mayWriteCollabProject()).toBe(true);
  });
});
