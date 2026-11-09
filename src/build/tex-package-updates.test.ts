import { describe, expect, it } from "vitest";
import { texPackageCheckProblem } from "./tex-package-updates";

const NETWORK = "Couldn’t check for updates. Check the network connection, then run the TeX doctor again.";
const TOO_OLD = "This TeX Live release is older than the package repository. Install the current TeX Live release, then try again.";

describe("texPackageCheckProblem", () => {
  it("blames the network only for an unreachable repository, without tlmgr's words", () => {
    for (const error of [
      "The TeX Live repository did not answer within 45 seconds.",
      "tlmgr: TLPDB::from_file could not get texlive.tlpdb from https://mirror.ctan.org/systems/texlive/tlnet",
      "Unable to download the checksum of the remote TeX Live database",
    ]) {
      expect(texPackageCheckProblem(error)).toEqual({ summary: NETWORK, detail: "" });
    }
  });

  it("blames the network for what tlmgr says about an unreachable repository", () => {
    // A real BasicTeX 2026 tlmgr's reason for an unreachable repository, as
    // the backend keeps it (package_updates.rs `update_list_failure`).
    const unreachable = "/Library/TeX/texbin/tlmgr: TLPDB::from_file could not get texlive.tlpdb from: https://nonexistent.invalid/tlnet/tlpkg/texlive.tlpdb\n"
      + "Maybe the repository setting should be changed.\n"
      + "More info: https://tug.org/texlive/acquire.html";
    expect(texPackageCheckProblem(unreachable)).toEqual({ summary: NETWORK, detail: "" });
  });

  it("says when the TeX Live release is older than the repository, even if a later mirror timed out", () => {
    const error = "tlmgr: Local TeX Live (2026) is older than remote repository (2027).\n"
      + "The TeX Live repository did not answer within 45 seconds.";
    expect(texPackageCheckProblem(error)).toEqual({ summary: TOO_OLD, detail: error });
  });

  it("shows tlmgr's own words for any other failure", () => {
    const error = "tlmgr: cannot write to /usr/local/texlive/2026basic/tlpkg: Permission denied";
    expect(texPackageCheckProblem(error)).toEqual({ summary: "Couldn’t check for updates", detail: error });
  });
});
