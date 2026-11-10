import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import { CreateProjectDialog } from "./project-dialogs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
afterEach(async () => {
  cleanup();
  await act(() => activateAppLocale("en"));
});

function openVenues(onVenue = vi.fn()) {
  render(
    <CreateProjectDialog
      projectName="Paper" setProjectName={vi.fn()} projectVenue="neurips" setProjectVenue={onVenue}
      error={null} onCreate={vi.fn()} onClose={vi.fn()}
    />,
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: /Venue template|模板/ }), { key: "ArrowDown" });
  return within(screen.getByRole("listbox"));
}

it("offers every bundled template with its edition and starting mode", () => {
  const onVenue = vi.fn();
  const list = openVenues(onVenue);
  expect(list.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "Blank article",
    "Chinese article (ctexart)",
    "NeurIPS 2026 (preprint)",
    "ICML 2026 (preprint)",
    "ICLR 2026",
    "ACL / ARR (preprint)",
    "CVPR 2027",
    "CVPR 2027 Rebuttal",
    "AAAI 2027 (preprint)",
    "IEEE conference paper (IEEEtran)",
    "IEEE journal article (IEEEtran)",
    "ACM paper (acmart)",
    "Tsinghua University thesis (ThuThesis)",
    "USTC thesis (ustcthesis)",
  ]);
  fireEvent.click(list.getByRole("option", { name: "Tsinghua University thesis (ThuThesis)" }));
  expect(onVenue).toHaveBeenCalledWith("thuthesis");
});

it("offers the CVPR rebuttal as its own template", () => {
  const onVenue = vi.fn();
  fireEvent.click(openVenues(onVenue).getByRole("option", { name: "CVPR 2027 Rebuttal" }));
  expect(onVenue).toHaveBeenCalledWith("cvpr-rebuttal");
});

it("offers the IEEE conference, IEEE journal and ACM templates", () => {
  for (const [name, venue] of [
    ["IEEE conference paper (IEEEtran)", "ieee-conference"],
    ["IEEE journal article (IEEEtran)", "ieee-journal"],
    ["ACM paper (acmart)", "acm"],
  ]) {
    const onVenue = vi.fn();
    fireEvent.click(openVenues(onVenue).getByRole("option", { name }));
    expect(onVenue).toHaveBeenCalledWith(venue);
    cleanup();
  }
});

it("offers the Chinese article beside the blank one", () => {
  const onVenue = vi.fn();
  fireEvent.click(openVenues(onVenue).getByRole("option", { name: "Chinese article (ctexart)" }));
  expect(onVenue).toHaveBeenCalledWith("chinese-article");
});

it("names the thesis templates by their universities in Chinese", async () => {
  await act(() => activateAppLocale("zh-CN"));
  const list = openVenues();
  expect(list.getByRole("option", { name: "清华大学学位论文（ThuThesis）" })).toBeInTheDocument();
  expect(list.getByRole("option", { name: "中国科学技术大学学位论文（ustcthesis）" })).toBeInTheDocument();
  expect(list.getByRole("option", { name: "AAAI 2027（预印本）" })).toBeInTheDocument();
  expect(list.getByRole("option", { name: "CVPR 2027 作者回复（Rebuttal）" })).toBeInTheDocument();
  expect(list.getByRole("option", { name: "IEEE 会议论文（IEEEtran）" })).toBeInTheDocument();
  expect(list.getByRole("option", { name: "IEEE 期刊论文（IEEEtran）" })).toBeInTheDocument();
  expect(list.getByRole("option", { name: "ACM 论文（acmart）" })).toBeInTheDocument();
  expect(list.getByRole("option", { name: "中文文章（ctexart）" })).toBeInTheDocument();
});
