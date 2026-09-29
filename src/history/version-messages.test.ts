import { afterEach, describe, expect, it } from "vitest";
import { activateAppLocale } from "../i18n";
import { AUTO_COMMIT_MESSAGES, versionMessageLabel } from "./version-messages";

afterEach(async () => {
  await activateAppLocale("en");
});

describe("version messages", () => {
  it("shows Lattice's own commit messages in the interface language", async () => {
    await activateAppLocale("zh-CN");
    for (const message of Object.values(AUTO_COMMIT_MESSAGES)) {
      expect(versionMessageLabel(message)).not.toBe(message);
      expect(versionMessageLabel(message)).toMatch(/[一-鿿]/);
    }
    expect(versionMessageLabel("Restore project to abc1234")).toMatch(/[一-鿿].*abc1234|abc1234.*[一-鿿]/);
  });

  it("keeps the English that git history stores and leaves authors' messages as written", async () => {
    expect(versionMessageLabel(AUTO_COMMIT_MESSAGES.overleafSync)).toBe("Overleaf sync");
    await activateAppLocale("zh-CN");
    expect(versionMessageLabel("Tighten the abstract")).toBe("Tighten the abstract");
    expect(versionMessageLabel("toString")).toBe("toString");
  });
});
