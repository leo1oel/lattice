/**
 * Local seam — not upstream code.
 *
 * Type stand-in for `@lingui/core` (vendored files import only the
 * MessageDescriptor type and the `i18n._` runtime shape from it).
 */
export interface MessageDescriptor {
  id: string;
  message?: string;
  comment?: string;
}

export const i18n = {
  _(d: MessageDescriptor | string): string {
    if (typeof d === "string") return d;
    return d.message ?? d.id;
  },
};
