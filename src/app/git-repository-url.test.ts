import { describe, expect, it } from "vitest";
import { githubRepositoryUrl } from "./git-repository-url";

describe("githubRepositoryUrl", () => {
  it.each([
    ["git@github.com:leo1oel/lattice.git", "https://github.com/leo1oel/lattice"],
    ["ssh://git@github.com/leo1oel/lattice.git", "https://github.com/leo1oel/lattice"],
    ["https://github.com/leo1oel/lattice.git", "https://github.com/leo1oel/lattice"],
  ])("turns %s into a browser URL", (remote, expected) => {
    expect(githubRepositoryUrl(remote)).toBe(expected);
  });

  it.each([
    null,
    "git@gitlab.com:leo1oel/lattice.git",
    "/Users/leo/lattice",
    "https://github.com/leo1oel/lattice/issues",
  ])("does not present a non-repository remote as GitHub", (remote) => {
    expect(githubRepositoryUrl(remote)).toBeNull();
  });
});
