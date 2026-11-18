// @vitest-environment node
import { describe, expect, it } from "vitest";
import { JOBS, ciTier, localMacosPass, wantsFull } from "./ci-tier.mjs";

const scan = {
  testReads: [
    { test: "src/platform/host-error-catalog.test.ts", read: "src-tauri/src" },
    { test: "src/editor/markdown/spec.test.ts", read: "docs/visual-editor-spec.md" },
  ],
  rustTargets: [{ target: "src/styles/titlebar.css", prefix: false }],
  gpuiTargets: ["THIRD_PARTY_NOTICES.md"],
  harness: ["scripts/perf-bench/smoke.test.mjs"],
};
const running = (files) => {
  const tier = ciTier(files, { scan });
  return { on: JOBS.filter((job) => tier.jobs[job]), files: tier.vitestFiles, docsOnly: tier.docsOnly };
};

describe("ci-tier", () => {
  it("runs nothing for documentation", () => {
    expect(running(["docs/agent-validation.md", "README.md", "gpui/docs/design-system.md", ".github/ISSUE_TEMPLATE/bug.yml", "LICENSE"])).toEqual({ on: [], files: [], docsOnly: true });
  });

  it("runs the tests that name a document, and nothing else", () => {
    expect(running(["docs/visual-editor-spec.md"])).toEqual({ on: ["vitest"], files: ["src/editor/markdown/spec.test.ts"], docsOnly: false });
  });

  it("runs the Rust jobs and only the tests that read Rust sources for a Rust change", () => {
    expect(running(["src-tauri/src/lib.rs"])).toEqual({ on: ["vitest", "rust"], files: ["src/platform/host-error-catalog.test.ts"], docsOnly: false });
    expect(running(["src-tauri/Cargo.lock"]).on).toEqual(["lint-build", "rust"]);
  });

  it("runs only gpui.yml for a GPUI change, and both apps for lattice-core", () => {
    expect(running(["gpui/crates/lattice-gpui/src/main.rs"]).on).toEqual(["gpui"]);
    expect(running(["src-tauri/lattice-core/src/lib.rs"]).on).toEqual(["rust", "gpui"]);
  });

  it("runs the frontend jobs for anything else, and every test file", () => {
    expect(running(["src/App.tsx"])).toEqual({ on: ["vitest", "lint-build", "perf-bench"], files: [], docsOnly: false });
    expect(running(["scripts/lint.mjs"]).on).toEqual(["vitest", "lint-build"]);
    expect(running(["src/editor/board/board.tsx"]).on).toEqual(["vitest", "lint-build", "perf-bench", "gpui"]);
    expect(running(["src/styles/titlebar.css"]).on).toEqual(["vitest", "lint-build", "perf-bench", "rust"]);
  });

  it("keeps the self-contained projects to their own jobs", () => {
    expect(running(["literature-worker/src/index.ts"]).on).toEqual(["literature-worker"]);
    expect(running(["research-env/lattice_env/cli.py"]).on).toEqual(["research-env"]);
    expect(running(["tools/open-slide-runtime/server.mjs"]).on).toEqual(["vitest", "lint-build", "open-slide-runtime"]);
    expect(running(["scripts/synara-runtime.json"]).on).toEqual(["vitest", "lint-build", "synara-pin"]);
  });

  it("counts THIRD_PARTY_NOTICES.md and docs/performance.md as inputs, not documentation", () => {
    expect(running(["THIRD_PARTY_NOTICES.md"]).on).toEqual(["vitest", "lint-build", "gpui"]);
    expect(running(["docs/performance.md"]).on).toEqual(["lint-build"]);
  });

  it("runs a workflow's every job when it changes, and everything for the shared pieces", () => {
    expect(running([".github/workflows/gpui.yml"]).on).toEqual(["gpui"]);
    expect(running([".github/workflows/ci.yml"]).on).toEqual(JOBS.filter((job) => job !== "gpui"));
    expect(running(["scripts/ci-tier.mjs"]).on).toEqual(JOBS);
    expect(running([".github/actions/setup-pnpm/action.yml"]).on).toEqual(JOBS);
    expect(ciTier(["README.md"], { full: true, scan }).jobs).toEqual(Object.fromEntries(JOBS.map((job) => [job, true])));
  });

  it("reads the CI: full trailer and the ci:full label", () => {
    expect(wantsFull("fix: x\n\nCI: full\n")).toBe(true);
    expect(wantsFull("fix: CI: full is mentioned in prose")).toBe(false);
    expect(wantsFull("fix: x", ["ci:full"])).toBe(true);
  });

  it("takes a CI-local trailer only for the tree it names", () => {
    const tree = "0123456789abcdef0123456789abcdef01234567";
    expect(localMacosPass("fix: x\n\nCI-local: macos 0123456789ab\n", tree)).toBe(true);
    expect(localMacosPass("fix: x\n\nCI-local: macos fedcba987654\n", tree)).toBe(false);
    expect(localMacosPass("fix: x", tree)).toBe(false);
  });
});
