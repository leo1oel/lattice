import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COLLAB_FEATURE_POLICY, loadCollabFeaturePolicy, mayResumeCollabProject, saveCollabFeaturePolicy } from "./collab-feature-policy";

describe("collaboration feature policy", () => {
  beforeEach(() => localStorage.clear());

  it("defaults new v2 projects and migration off without disabling recovery", () => {
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
