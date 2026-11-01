import { i18n } from "@lingui/core";
import type { Messages } from "@lingui/core";
import type { AppLocale } from "./settings/app-settings";
import { installHostErrors } from "./platform/host-error-text";

// The app must load and activate @lingui/core's global instance, not one from
// `setupI18n()`: the `t`/`plural` macros from `@lingui/core/macro` compile to
// calls on that global, including from modules outside React.
export { i18n };

const catalogLoaders: Record<AppLocale, () => Promise<{ messages: Messages }>> = {
  en: () => import("./locales/en/messages.po"),
  "zh-CN": () => import("./locales/zh-CN/messages.po"),
};

// The host's English errors need no translation in English, so their
// catalog (`platform/host-error-text.ts`) loads only beside another language.
const loadHostErrors = () => import("./platform/host-error-catalog").then((catalog) => catalog.HOST_ERRORS);

let activationGeneration = 0;

/** Load the bundled catalog before activating it, ignoring stale switches. */
export async function activateAppLocale(locale: AppLocale): Promise<void> {
  const generation = ++activationGeneration;
  const [{ messages }, hostErrors] = await Promise.all([
    catalogLoaders[locale](),
    locale === "en" ? [] : loadHostErrors(),
  ]);
  if (generation !== activationGeneration) return;
  i18n.load(locale, messages);
  i18n.activate(locale);
  installHostErrors(hostErrors);
}

/**
 * A count as the interface language reads it: digits grouped ("120,400"), and
 * in Chinese from 10,000 on in 万 and 亿 with up to two decimals ("12.04 万"),
 * the unit a Chinese reader counts in. The space before 万 is the one every
 * number takes before its unit; a catalog's "{count} 词" then reads
 * "12.04 万 词" until `spaceMixedScript` closes the gap between the two
 * Chinese characters.
 */
export function formatCount(value: number, locale: string = i18n.locale || "en"): string {
  if (locale.startsWith("zh") && Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 2 })
      .format(value)
      .replace(/(\d)(?=[万亿])/, "$1 ");
  }
  return new Intl.NumberFormat(locale).format(value);
}

/** A duration in seconds to one decimal, with the space SI puts before its unit ("1.2 s"). */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}
