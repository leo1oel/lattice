import { describe, expect, it } from "vitest";
import { compareVersions, releaseItems, statedVersion, updateComment } from "./issue-version-check.mjs";

/** An issue body as GitHub renders the bug form. */
const form = (version) => [
  "### Lattice version", "", version, "",
  "### macOS version", "", "macOS 15.3.1 (Apple M2 Pro)", "",
  "### Steps to reproduce", "", "1. Install IEEEtran 0.16.10 times",
].join("\n");

const release = (tag, body = "", extra = {}) => ({
  tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`, draft: false, prerelease: false, body, ...extra,
});

describe("statedVersion", () => {
  it("reads the bug form's Lattice version field, and nothing else in the form", () => {
    expect(statedVersion("[Bug]: x", form("0.16.8"))).toBe("0.16.8");
    expect(statedVersion("[Bug]: x", form("v0.16.8 (Apple Silicon)"))).toBe("0.16.8");
    // A source build names a commit: no version, though later fields hold numbers.
    expect(statedVersion("[Bug]: x", form("3f2c1a9"))).toBeNull();
    expect(statedVersion("[Bug]: x", form("_No response_"))).toBeNull();
  });

  it("finds a version written in a free-form issue, in English or Chinese", () => {
    expect(statedVersion("Crash on Lattice 0.16.7", "")).toBe("0.16.7");
    expect(statedVersion("", "Lattice version: v0.16.9\nmacOS 15.1.0")).toBe("0.16.9");
    expect(statedVersion("编译失败", "版本：0.16.6")).toBe("0.16.6");
  });

  it("finds nothing when no Lattice version is stated", () => {
    expect(statedVersion("Proofread fails", "macOS version: 15.1.0, TeX Live 2025")).toBeNull();
    expect(statedVersion("", "")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compares numerically, part by part", () => {
    expect(compareVersions("0.16.10", "v0.16.9")).toBe(1);
    expect(compareVersions("0.16.9", "0.16.10")).toBe(-1);
    expect(compareVersions("v0.16.10", "0.16.10")).toBe(0);
  });
});

describe("updateComment", () => {
  const releases = [
    release("v0.17.0-beta.1", "", { prerelease: true }),
    release("v0.16.10", [
      "## Highlights since 0.16.9", "", "- **New project templates.** IEEE and ACM.", "",
      "## Notable fixes", "",
      "- \"Install missing package\" no longer gives up on `IEEEtran.cls` (#785).",
      "- About Lattice links to GitHub. Thanks to @quark67.", "",
      "## Changes in v0.16.10", "", "- Fix the sign-in window (#784)",
    ].join("\n")),
    release("v0.16.9", "## Highlights since 0.16.8\n\n- **Know when your TeX packages are out of date.** One click.\n"),
    release("v0.16.8"),
  ];

  it("asks a reporter on an older release to update first, listing what changed since", () => {
    const comment = updateComment("0.16.8", releases, "o/r");
    expect(comment).toContain("Lattice **v0.16.8**, and the latest release is **v0.16.10**");
    expect(comment).toContain("- [v0.16.10](https://github.com/o/r/releases/tag/v0.16.10)");
    expect(comment).toContain("  - \"Install missing package\" no longer gives up on `IEEEtran.cls`");
    expect(comment).toContain("  - Know when your TeX packages are out of date.");
    // Neither the prerelease, the stated release itself, nor the commit list.
    expect(comment).not.toMatch(/beta|\[v0\.16\.8\]|sign-in window/);
  });

  it("notifies no one and cross-links nothing", () => {
    const items = releaseItems("## Notable fixes\n\n- Fixed (#785). Thanks to @quark67.\n- Ping @someone\n");
    expect(items).toEqual(["Fixed (#\u200b785).", "Ping @\u200bsomeone"]);
  });

  it("says nothing to a reporter on the latest release, a newer build, or with no version", () => {
    expect(updateComment("0.16.10", releases, "o/r")).toBeNull();
    expect(updateComment("0.17.0", releases, "o/r")).toBeNull();
    expect(updateComment(null, releases, "o/r")).toBeNull();
    expect(updateComment("0.16.8", [], "o/r")).toBeNull();
  });

  it("links the rest when many releases came since", () => {
    const many = Array.from({ length: 8 }, (_, index) => release(`v0.16.${10 - index}`));
    expect(updateComment("0.16.1", many, "o/r")).toContain("…and 3 more in [all releases](https://github.com/o/r/releases)");
  });
});
