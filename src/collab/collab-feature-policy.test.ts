import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COLLAB_FEATURE_POLICY, isCollabEnabled, loadCollabFeaturePolicy, mayResumeCollabProject, mayWriteCollabProject, saveCollabFeaturePolicy } from "./collab-feature-policy";

describe("collaboration feature policy", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "", "false"])("disables sharing without explicit build opt-in (%s), even with persisted enablement", (value) => {
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", value);
    saveCollabFeaturePolicy(DEFAULT_COLLAB_FEATURE_POLICY);
    expect(isCollabEnabled()).toBe(false);
    expect(loadCollabFeaturePolicy()).toMatchObject({ allowCreateV2: false, emergencyDisableReads: true, emergencyDisableWrites: true });
    expect(mayResumeCollabProject(2)).toBe(false);
    expect(mayWriteCollabProject()).toBe(false);
    expect(JSON.parse(localStorage.getItem("lattice.collab.feature-policy.v1")!)).toEqual(DEFAULT_COLLAB_FEATURE_POLICY);
  });

  it("retains sharing in explicitly opted-in builds", () => {
    expect(isCollabEnabled()).toBe(true);
    expect(loadCollabFeaturePolicy()).toMatchObject(DEFAULT_COLLAB_FEATURE_POLICY);
    expect(mayResumeCollabProject(1)).toBe(true);
    expect(mayResumeCollabProject(2)).toBe(true);
  });

  it("persists rollout policy independently from room credentials", () => {
    saveCollabFeaturePolicy({ ...DEFAULT_COLLAB_FEATURE_POLICY, allowCreateV2: true, preferV2ForNewProjects: true });
    expect(loadCollabFeaturePolicy()).toMatchObject({ allowCreateV2: true, preferV2ForNewProjects: true });
    expect(localStorage.getItem("lattice.collab.feature-policy.v1")).not.toContain("secret");
  });
});
