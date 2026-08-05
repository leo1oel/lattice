/**
 * Local seam — not upstream code.
 *
 * Runtime stand-in for `@lingui/core/macro`. Upstream compiles these macros
 * with the Lingui babel plugin; Research Writer ships English-only, so the
 * shim evaluates template literals directly and treats message descriptors
 * as their default message.
 */
import type { MessageDescriptor } from "./lingui-core.ts";

function interpolate(strings: TemplateStringsArray, values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += String(values[i]) + (strings[i + 1] ?? "");
  }
  return out;
}

/** `t` — tagged template or descriptor call, returns the English message. */
export function t(strings: TemplateStringsArray | MessageDescriptor, ...values: unknown[]): string {
  if (typeof strings === "object" && strings !== null && "raw" in strings) {
    return interpolate(strings as TemplateStringsArray, values);
  }
  const d = strings as MessageDescriptor;
  return d.message ?? d.id;
}

/** `msg` — tagged template returning a MessageDescriptor. */
export function msg(strings: TemplateStringsArray, ...values: unknown[]): MessageDescriptor {
  const text = interpolate(strings, values);
  return { id: text, message: text };
}
