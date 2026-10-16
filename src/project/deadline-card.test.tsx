import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineCard } from "./deadline-card";
import { deadlineInstant, deadlineUrgency, durationParts } from "./deadline-time";
import { activateAppLocale } from "../i18n";
import type { ProjectDeadline } from "../app-types";

const HOUR = 3_600_000;
// 23:59 AoE on May 15 is 11:59 UTC on May 16.
const deadline: ProjectDeadline = { venue: "NeurIPS 2027", kind: "paper", due: "2027-05-15T23:59" };
const instant = Date.UTC(2027, 4, 16, 11, 59);

describe("deadline time", () => {
  it("reads the stored clock as UTC−12 with no daylight saving", () => {
    expect(deadlineInstant(deadline.due)).toBe(instant);
    expect(deadlineInstant("2027-12-31T23:59")).toBe(Date.UTC(2028, 0, 1, 11, 59));
  });

  it.each(["2027-02-30T12:00", "2027-05-15T24:00", "2027-05-15", "", "2027-05-15T23:59Z"])("rejects %j", (due) => {
    expect(deadlineInstant(due)).toBeNull();
  });

  it.each([
    [80 * HOUR, "calm"], [72 * HOUR, "calm"], [71 * HOUR, "soon"], [24 * HOUR, "soon"],
    [23 * HOUR, "urgent"], [-1 * HOUR, "urgent"],
  ] as const)("colours %i ms as %s", (remaining, urgency) => {
    expect(deadlineUrgency(remaining)).toBe(urgency);
  });

  it("keeps the two largest units", () => {
    expect(durationParts(76 * HOUR + 20 * 60_000)).toEqual({ days: 3, hours: 4, minutes: 0 });
    expect(durationParts(10 * HOUR + 25 * 60_000)).toEqual({ days: 0, hours: 10, minutes: 25 });
    expect(durationParts(-(2 * HOUR + 59_000))).toEqual({ days: 0, hours: 2, minutes: 0 });
  });
});

describe("DeadlineCard", () => {
  beforeEach(async () => {
    await activateAppLocale("en");
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const renderCard = (value: ProjectDeadline | null, onSave = vi.fn()) => {
    render(<DeadlineCard deadline={value} venue="NeurIPS" onSave={onSave} />);
    return onSave;
  };

  it("counts down in words, gives the AoE time once and the writer's own time beside it", () => {
    vi.setSystemTime(instant - (76 * HOUR + 20 * 60_000));
    renderCard(deadline);
    const card = screen.getByRole("region", { name: "Deadline" });
    expect(card).toHaveAttribute("data-urgency", "calm");
    expect(card).toHaveTextContent("NeurIPS 2027 · full paper");
    expect(card).toHaveTextContent("3 days 4 hours left");
    expect(card).toHaveTextContent("Sat, May 15, 11:59 PM AoE (UTC−12)");
    expect(card).toHaveTextContent(/your time · \S+/);
    expect(card).not.toHaveTextContent("GMT+12");
  });

  it("turns amber under three days and red under one, and keeps counting", () => {
    vi.setSystemTime(instant - 30 * HOUR);
    renderCard(deadline);
    const card = screen.getByRole("region", { name: "Deadline" });
    expect(card).toHaveAttribute("data-urgency", "soon");
    expect(card).toHaveTextContent("1 day 6 hours left");
    act(() => vi.advanceTimersByTime(7 * HOUR));
    expect(card).toHaveAttribute("data-urgency", "urgent");
    expect(card).toHaveTextContent("23 hours left");
    act(() => vi.advanceTimersByTime(22 * HOUR + 59 * 60_000 + 30_000));
    expect(card).toHaveTextContent("Less than a minute left");
    act(() => vi.advanceTimersByTime(2 * HOUR + 60_000));
    expect(card).toHaveTextContent("Closed 2 hours ago");
  });

  it("speaks Chinese, with the zone after the local time rather than inside it", async () => {
    await activateAppLocale("zh-CN");
    vi.setSystemTime(instant - (76 * HOUR + 20 * 60_000));
    renderCard(deadline);
    const card = screen.getByRole("region", { name: "截止时间" });
    expect(card).toHaveTextContent("NeurIPS 2027 · 全文");
    expect(card).toHaveTextContent("还剩 3 天 4 小时");
    expect(card).toHaveTextContent("AoE 时间（UTC−12）");
    expect(card).toHaveTextContent(/^.*你的时间 [^G]+ · \S+$/);
  });

  it("adds a deadline with AoE pinned, naming it after the project's template", () => {
    vi.setSystemTime(Date.UTC(2027, 3, 1));
    const onSave = renderCard(null);
    fireEvent.click(screen.getByRole("button", { name: /Add the submission deadline/ }));
    expect(screen.getByLabelText("Deadline for")).toHaveValue("NeurIPS");
    const save = screen.getByRole("button", { name: "Save deadline" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2027-05-15" } });
    expect(screen.getByLabelText("Time, AoE (UTC−12)")).toHaveValue("23:59");
    expect(screen.getByRole("form", { name: "Deadline" })).toHaveTextContent("your time");
    fireEvent.click(screen.getByRole("tab", { name: "Abstract" }));
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ venue: "NeurIPS", kind: "abstract", due: "2027-05-15T23:59" });
  });

  it("edits and removes the stored deadline", () => {
    vi.setSystemTime(Date.UTC(2027, 3, 1));
    const onSave = renderCard(deadline);
    fireEvent.click(screen.getByRole("button", { name: "Edit deadline" }));
    expect(screen.getByLabelText("Date")).toHaveValue("2027-05-15");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });
});
