import { describe, expect, it } from "vitest";
import type { PaperSummary } from "../app-types";
import { addedGroup, addedMonthName, groupPapers, paperOrder, type PaperFacts } from "./paper-library-view";

const facts: PaperFacts = { venue: () => "", uses: () => null, usages: () => null };
const paper = (title: string, addedAt?: number): PaperSummary => ({
  arxivId: "", title, citationKey: title, hasFullText: false, hasBlog: false, ...(addedAt === undefined ? {} : { addedAt }),
});
/** Local noon on a calendar day, so the cases read the same in any time zone. */
const day = (year: number, month: number, date: number, hour = 12) => new Date(year, month - 1, date, hour).getTime();

describe("the date added", () => {
  // A Sunday afternoon in mid-November.
  const now = day(2026, 11, 15, 15);

  it("groups today, the six days before it, the rest of the month, then each earlier month", () => {
    expect(addedGroup(day(2026, 11, 15, 0), now)).toBe("today");
    expect(addedGroup(day(2026, 11, 16), now)).toBe("today");
    expect(addedGroup(day(2026, 11, 14, 23), now)).toBe("week");
    expect(addedGroup(day(2026, 11, 9, 0), now)).toBe("week");
    expect(addedGroup(day(2026, 11, 8, 23), now)).toBe("month");
    expect(addedGroup(day(2026, 11, 1, 0), now)).toBe("month");
    expect(addedGroup(day(2026, 10, 31, 23), now)).toBe("2026-10");
    expect(addedGroup(day(2025, 12, 3), now)).toBe("2025-12");
    expect(addedGroup(undefined, now)).toBe("");
    // Early in a month the week reaches into the last one, and wins.
    expect(addedGroup(day(2026, 10, 30), day(2026, 11, 2))).toBe("week");
  });

  it("orders its groups newest first and puts the papers without a date last", () => {
    const papers = [
      paper("unknown"), paper("september", day(2026, 9, 3)), paper("today", day(2026, 11, 15, 9)),
      paper("last year", day(2025, 11, 20)), paper("month", day(2026, 11, 2)), paper("week", day(2026, 11, 12)),
      paper("october", day(2026, 10, 7)),
    ];
    const sections = groupPapers(papers, "added", facts, (value) => value || "none", now);
    expect(sections.map((section) => section.id)).toEqual(["today", "week", "month", "2026-10", "2026-09", "2025-11", ""]);
    expect(sections.map((section) => section.papers.map((member) => member.title))).toEqual([
      ["today"], ["week"], ["month"], ["october"], ["september"], ["last year"], ["unknown"],
    ]);
  });

  it("sorts newest first, keeping the given order for ties and the undated last", () => {
    const papers = [paper("b"), paper("old", 1_000), paper("a"), paper("new", 3_000), paper("same", 3_000)];
    expect([...papers].sort(paperOrder("added", facts)).map((member) => member.title)).toEqual(["new", "same", "old", "b", "a"]);
  });

  it("names an earlier month in the interface language", () => {
    expect(addedMonthName("2026-10", "en")).toBe("October 2026");
    expect(addedMonthName("2026-10", "zh-CN")).toBe("2026年10月");
  });
});
