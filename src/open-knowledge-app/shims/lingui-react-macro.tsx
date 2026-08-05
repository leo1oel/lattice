/**
 * Local seam — not upstream code.
 *
 * Runtime stand-in for `@lingui/react/macro`. `<Trans>` renders its children
 * unchanged (English-only build); `useLingui` returns the shim `t`.
 */
import type { ReactNode } from "react";
import { t } from "./lingui-core-macro.ts";

export function Trans({ children }: { children?: ReactNode; id?: string; comment?: string }): ReactNode {
  return <>{children}</>;
}

export function useLingui(): { t: typeof t } {
  return { t };
}

/**
 * English-only plural select; `#` in the chosen form is replaced with the
 * value, matching Lingui's ICU message behavior.
 */
export function Plural({
  value,
  one,
  other,
}: {
  value: number;
  one: string;
  other: string;
}): ReactNode {
  const form = value === 1 ? one : other;
  return <>{form.replaceAll("#", String(value))}</>;
}
