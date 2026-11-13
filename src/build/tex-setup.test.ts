import { afterEach, expect, it, vi } from "vitest";
import { texDistributionName } from "./tex-setup";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", "BasicTeX"],
  ["Windows NT 10.0", "TeX Live"],
  // Linux builds with the distribution's TeX Live, never BasicTeX.
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)", "TeX Live"],
])("names the distribution each host builds with (%s)", (agent, name) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
  expect(texDistributionName()).toBe(name);
});
