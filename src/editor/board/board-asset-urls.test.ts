import { describe, expect, it } from "vitest";
import { DEFAULT_EMBED_DEFINITIONS, defaultEditorAssetUrls, iconTypes } from "tldraw";
import packageJson from "../../../package.json";
import tauriConfig from "../../../src-tauri/tauri.conf.json";
import fontsLicense from "../../../public/licenses/tldraw-fonts-OFL.txt?raw";
import { boardAssetUrls } from "./board-asset-urls";

const urls = [
  ...Object.values(boardAssetUrls.fonts),
  ...Object.values(boardAssetUrls.icons),
  ...Object.values(boardAssetUrls.translations),
  ...Object.values(boardAssetUrls.embedIcons),
];

describe("board asset URLs", () => {
  it("come from the @tldraw/assets release matching tldraw", () => {
    expect(packageJson.dependencies["@tldraw/assets"]).toBe(packageJson.dependencies.tldraw);
  });

  it("cover every asset tldraw would otherwise fetch from its CDN", () => {
    expect(Object.keys(boardAssetUrls.fonts).sort()).toEqual(Object.keys(defaultEditorAssetUrls.fonts!).sort());
    expect(Object.keys(boardAssetUrls.icons).sort()).toEqual([...iconTypes].sort());
    expect(Object.keys(boardAssetUrls.embedIcons).sort()).toEqual(DEFAULT_EMBED_DEFINITIONS.map((def) => def.type).sort());
    // BoardEditor only ever selects these two locales; `en` is always fetched as the base.
    expect(Object.keys(boardAssetUrls.translations).sort()).toEqual(["en", "zh-cn"]);
  });

  it("are all same-origin, so the strict font-src still admits them", () => {
    for (const url of urls) expect(url).not.toMatch(/^[a-z]+:\/\//i);
    for (const csp of [tauriConfig.app.security.csp, tauriConfig.app.security.devCsp]) {
      expect(csp["font-src"]).toEqual(["'self'", "data:"]);
    }
  });

  it("ship with the OFL text the bundled fonts require", () => {
    expect(fontsLicense).toContain('Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"');
    expect(fontsLicense).toContain("Copyright 2022 The Shantell Sans Project Authors");
    expect(fontsLicense).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });
});
