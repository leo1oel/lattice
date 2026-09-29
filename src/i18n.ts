import { i18n } from "@lingui/core";
import type { Messages } from "@lingui/core";
import type { AppLocale } from "./settings/app-settings";

// The app must load and activate @lingui/core's global instance, not one from
// `setupI18n()`: the `t`/`plural` macros from `@lingui/core/macro` compile to
// calls on that global, and the vendored Open Knowledge editor uses them
// outside React (slash-menu items, upload errors, component summaries).
export { i18n };

const catalogLoaders: Record<AppLocale, () => Promise<{ messages: Messages }>> = {
  en: () => import("./locales/en/messages.po"),
  "zh-CN": () => import("./locales/zh-CN/messages.po"),
};

let activationGeneration = 0;

/** Load the bundled catalog before activating it, ignoring stale switches. */
export async function activateAppLocale(locale: AppLocale): Promise<void> {
  const generation = ++activationGeneration;
  const { messages } = await catalogLoaders[locale]();
  if (generation !== activationGeneration) return;
  i18n.load(locale, messages);
  i18n.activate(locale);
}
