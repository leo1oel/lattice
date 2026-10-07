import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORE_SOFTWARE, DESIGN_CREDITS, ORIGIN_CREDITS } from "./acknowledged-software";
import { licenseGroupsFor, packageRegistryUrl, parseThirdPartyNotices, splitPackageId } from "./third-party-notices";

// The shape scripts/generate-notices.mjs writes, cut down to one group per case.
const FIXTURE = [
  "# Third-party notices",
  "",
  "## Hand-written section",
  "",
  "#### 1. MIT — 1 package(s), from `LICENSE`",
  "",
  "`not-generated@1.0.0`",
  "",
  "<!-- BEGIN GENERATED NOTICES — do not edit below this line -->",
  "",
  "## Unresolved attribution — npm and crates",
  "",
  "- `buffers@0.1.1` (npm)",
  "- `unicount@1.1.0` (npm) — declared `ISC`",
  "",
  "## npm packages (web assets)",
  "",
  "- `vite@8.2.1 → fsevents@~2.3.3`",
  "",
  "#### 1. MIT (+1 other declarations) — 2 package(s), from `LICENSE`",
  "",
  "<details><summary>Packages sharing this text</summary>",
  "",
  "`@scope/pkg@1.0.0-beta.6`, `react@19.2.7` (`MIT/X11`)",
  "",
  "</details>",
  "",
  "Copyright notices (1):",
  "",
  "```text",
  "Copyright (c) Meta Platforms, Inc.",
  "```",
  "",
  "````text",
  "MIT License",
  "",
  "#### 2. Not a heading — it is inside the license text",
  "```",
  "````",
  "",
  "## Rust crates (`src-tauri`)",
  "",
  "#### 1. MIT OR Apache-2.0 — 1 package(s), from `LICENSE-MIT`",
  "",
  "`tauri@2.11.5` (`Apache-2.0 OR MIT`)",
  "",
  "```text",
  "MIT License text",
  "```",
  "",
  "#### 2. MIT OR Apache-2.0 — 1 package(s), from `LICENSE-APACHE`",
  "",
  "`tauri@2.11.5` (`Apache-2.0 OR MIT`)",
  "",
  "```text",
  "Apache License text",
  "```",
  "",
  "<!-- notices:begin:sidecar -->",
  "## Synara agent sidecar (bundled Tauri resource)",
  "",
  "### Unresolved attribution — the Synara sidecar",
  "",
  "- `undici@7.0.0` (sidecar) — declared `MIT`",
  "",
  "<!-- END GENERATED NOTICES -->",
].join("\n");

describe("third-party notices", () => {
  const notices = parseThirdPartyNotices(FIXTURE);
  const ids = notices.packages.map((pkg) => `${pkg.closure}:${pkg.name}@${pkg.version}:${pkg.license}`);

  it("lists every package of the generated half, each under its own declaration", () => {
    expect(ids).toEqual([
      "npm:@scope/pkg@1.0.0-beta.6:MIT",
      "npm:buffers@0.1.1:",
      "npm:react@19.2.7:MIT/X11",
      "crates:tauri@2.11.5:Apache-2.0 OR MIT",
      "sidecar:undici@7.0.0:MIT",
      "npm:unicount@1.1.0:ISC",
    ]);
  });

  it("keeps a license text's own headings out of the structure", () => {
    const [group] = licenseGroupsFor(notices, notices.packages.find((pkg) => pkg.name === "react")!);
    expect(group.title).toBe("MIT — 2 package(s), from LICENSE");
    expect(group.copyrights).toBe("Copyright (c) Meta Platforms, Inc.");
    expect(group.text).toBe("MIT License\n\n#### 2. Not a heading — it is inside the license text\n```");
    expect(notices.groups).toHaveLength(3);
  });

  it("finds every text a package ships, and none for one that ships no text", () => {
    const tauri = notices.packages.find((pkg) => pkg.name === "tauri")!;
    expect(licenseGroupsFor(notices, tauri).map((group) => group.text)).toEqual(["MIT License text", "Apache License text"]);
    expect(licenseGroupsFor(notices, notices.packages.find((pkg) => pkg.name === "unicount")!)).toEqual([]);
  });

  it("splits scoped ids at the version's @, and links each closure to its registry", () => {
    expect(splitPackageId("@scope/pkg@1.0.0-beta.6")).toEqual({ name: "@scope/pkg", version: "1.0.0-beta.6" });
    expect(splitPackageId("@scope/pkg")).toBeNull();
    expect(packageRegistryUrl({ closure: "crates", name: "tauri" })).toBe("https://crates.io/crates/tauri");
    expect(packageRegistryUrl({ closure: "sidecar", name: "@scope/pkg" })).toBe("https://www.npmjs.com/package/@scope/pkg");
  });
});

describe("the shipped THIRD_PARTY_NOTICES.md", () => {
  const markdown = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
  const notices = parseThirdPartyNotices(markdown);

  it("yields as many packages per closure as each section counts", () => {
    // Each closure section states its size as "**N packages.**", in this order.
    const counted = [...markdown.matchAll(/^\*\*(\d+) packages\.\*\*$/gm)].map((match) => Number(match[1]));
    const parsed = ["npm", "crates", "sidecar", "presentation-runtime"]
      .map((closure) => notices.packages.filter((pkg) => pkg.closure === closure).length);
    expect(parsed).toEqual(counted);
    expect(parsed.every((count) => count > 0)).toBe(true);
  });

  it("records every package the Acknowledgements page credits by name", () => {
    const missing = [...CORE_SOFTWARE, ...DESIGN_CREDITS, ...ORIGIN_CREDITS]
      .filter((credit) => credit.pkg && !notices.packages.some((pkg) => pkg.closure === credit.pkg!.closure && pkg.name === credit.pkg!.name))
      .map((credit) => credit.name);
    expect(missing).toEqual([]);
  });
});
