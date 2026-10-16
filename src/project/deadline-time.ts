import type { ProjectDeadline } from "../app-types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AOE_OFFSET = 12 * HOUR;
const DUE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The stored wall-clock time read as if it were UTC, so formatting it with
 * `timeZone: "UTC"` prints the AoE clock exactly as the call for papers wrote
 * it. AoE is a fixed UTC−12 with no daylight saving; going through
 * `Etc/GMT+12` instead would put an inverted-sign zone name within reach of
 * the interface.
 */
export function aoeWallClock(due: string): Date | null {
  const match = DUE_PATTERN.exec(due);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // Date.UTC rolls an impossible date over ("02-30" becomes March 2) rather than failing.
  const exact = wall.getUTCMonth() === month - 1 && wall.getUTCDate() === day && hour < 24 && minute < 60;
  return exact ? wall : null;
}

/** The instant the deadline passes: the AoE clock plus twelve hours in UTC. */
export function deadlineInstant(due: string): number | null {
  const wall = aoeWallClock(due);
  return wall ? wall.getTime() + AOE_OFFSET : null;
}

/** Grey with three days or more to go, amber under three days, red under one day or once passed. */
export type DeadlineUrgency = "calm" | "soon" | "urgent";

export function deadlineUrgency(remaining: number): DeadlineUrgency {
  return remaining < DAY ? "urgent" : remaining < 3 * DAY ? "soon" : "calm";
}

/**
 * The two largest whole units of a duration, the way people say it: days and
 * hours, or hours and minutes under a day, or minutes alone under an hour. A
 * zero second unit is dropped ("3 days", not "3 days 0 hours").
 */
export function durationParts(span: number): { days: number; hours: number; minutes: number } {
  const total = Math.floor(Math.abs(span) / 60_000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = days > 0 ? 0 : total % 60;
  return { days, hours, minutes };
}

export function deadlineDraftFrom(deadline: ProjectDeadline | null, venue: string): {
  venue: string; kind: ProjectDeadline["kind"]; date: string; time: string;
} {
  if (!deadline) return { venue, kind: "paper", date: "", time: "23:59" };
  // eslint-disable-next-line lingui/no-unlocalized-strings -- the stored "YYYY-MM-DDTHH:MM" form
  const [date = "", time = "23:59"] = deadline.due.split("T");
  return { venue: deadline.venue, kind: deadline.kind, date, time };
}
