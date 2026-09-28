import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../i18n";

/**
 * Error capture is installed before the interface catalog loads, and Lingui
 * throws when no locale is active. Production descriptors carry only an id, so
 * the caller supplies the English text shown until a locale is active.
 */
export function translateOr(descriptor: MessageDescriptor, english: string): string {
  return i18n.locale ? i18n._(descriptor) : english;
}
