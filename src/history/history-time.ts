/**
 * How the history timeline names a time. A day heads its entries, so an
 * entry needs only its clock time, and two entries an afternoon apart read
 * apart where "3h ago" would not. Both come from `Intl` in the interface
 * language: a Chinese heading reads 10月10日周六, never toDateString's English.
 */

/** The local day `ms` falls on, as a key two times on that day share. */
export function dayKey(ms: number): string {
  return new Date(ms).toDateString();
}

/** "Today", "Yesterday", or a short localized date (with the year once it is not this one). */
export function dayName(ms: number, locale: string): string {
  const when = new Date(ms);
  if (!Number.isFinite(when.getTime())) return "";
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const capitalized = (text: string) => text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
  const now = new Date();
  if (dayKey(ms) === dayKey(now.getTime())) return capitalized(relative.format(0, "day"));
  // A calendar day back, not 24 hours: across a clock change those land on
  // today (the last hour of a 25-hour day) or two days back (just after
  // midnight following a 23-hour one).
  now.setDate(now.getDate() - 1);
  if (dayKey(ms) === dayKey(now.getTime())) return capitalized(relative.format(-1, "day"));
  return when.toLocaleDateString(locale, {
    weekday: "short", month: "short", day: "numeric",
    ...(when.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" as const }),
  });
}

/** The clock time of `ms`, to the minute. */
export function clockTime(ms: number, locale: string): string {
  const when = new Date(ms);
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Intl.DateTimeFormat option values
  return Number.isFinite(when.getTime()) ? when.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }) : "";
}

/** The full date and time, for a tooltip. */
export function fullTime(ms: number, locale: string): string {
  const when = new Date(ms);
  return Number.isFinite(when.getTime()) ? when.toLocaleString(locale) : "";
}

/** `items`, already newest first, in runs that share a day. */
export function groupByDay<Item>(items: readonly Item[], at: (item: Item) => number): Array<{ key: string; at: number; items: Item[] }> {
  const days: Array<{ key: string; at: number; items: Item[] }> = [];
  for (const item of items) {
    const key = dayKey(at(item));
    const last = days.at(-1);
    if (last?.key === key) last.items.push(item);
    else days.push({ key, at: at(item), items: [item] });
  }
  return days;
}
