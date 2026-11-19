/** Where a project lives, as a writer reads it: its parent folder, home written as ~. */
export function parentFolderLabel(path: string) {
  const parent = path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
  return parent.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/** "yesterday", "3 days ago", "last month": how long before `now` a moment was. */
export function age(then: number, now: number, locale: string, justNow: string): string {
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) return justNow;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const days = seconds / 86_400;
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  if (days < 1) return format.format(-Math.round(seconds / 3600), "hour");
  if (days < 7) return format.format(-Math.round(days), "day");
  if (days < 30) return format.format(-Math.round(days / 7), "week");
  if (days < 365) return format.format(-Math.round(days / 30), "month");
  return format.format(-Math.round(days / 365), "year");
}
