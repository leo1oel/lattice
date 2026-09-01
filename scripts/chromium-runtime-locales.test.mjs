import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHROMIUM_LOCALE_ALLOWLIST,
  pruneChromiumLocales,
} from "./chromium-runtime-locales.mjs";

let fixture;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

function addLocale(parent, locale) {
  const directory = join(parent, `${locale}.lproj`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "locale.pak"), locale);
}

function frameworkResources(root) {
  return join(
    root,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Resources",
  );
}

describe("Chromium runtime locale pruning", () => {
  it("retains only base English and simplified Chinese at every resource depth", () => {
    fixture = mkdtempSync(join(tmpdir(), "lattice-chromium-locales-"));
    const appResources = join(fixture, "Contents", "Resources");
    const electronResources = frameworkResources(fixture);
    for (const resources of [appResources, electronResources]) {
      addLocale(resources, "en");
      addLocale(resources, "zh_CN");
      addLocale(resources, "en_GB");
      addLocale(resources, "zh_TW");
      addLocale(resources, "en_FEMININE");
    }

    expect(CHROMIUM_LOCALE_ALLOWLIST).toEqual(new Set(["en.lproj", "zh_CN.lproj"]));
    expect(pruneChromiumLocales(fixture)).toBe(6);
    for (const resources of [appResources, electronResources]) {
      expect([...CHROMIUM_LOCALE_ALLOWLIST].every((locale) =>
        existsSync(join(resources, locale))
      )).toBe(true);
      expect(existsSync(join(resources, "en_GB.lproj"))).toBe(false);
      expect(existsSync(join(resources, "zh_TW.lproj"))).toBe(false);
      expect(existsSync(join(resources, "en_FEMININE.lproj"))).toBe(false);
    }
  });

  it("rejects an empty duplicate when the required framework pack is missing", () => {
    fixture = mkdtempSync(join(tmpdir(), "lattice-chromium-locales-"));
    addLocale(frameworkResources(fixture), "en");
    mkdirSync(join(fixture, "Contents/Resources/zh_CN.lproj"), { recursive: true });

    expect(() => pruneChromiumLocales(fixture)).toThrow(
      "Electron Framework is missing required locale pack zh_CN.lproj/locale.pak",
    );
  });
});
