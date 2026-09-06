import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BibliographyAudit, type AuditEntry, type AuditResult } from "./bibliography-audit";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
afterEach(cleanup);
beforeEach(() => { vi.mocked(invoke).mockReset(); });
const entries: AuditEntry[] = Array.from({ length: 3 }, (_, i) => ({ path: `refs${i}.bib`, key: `key${i}`, title: `Paper ${i}`, bibtex: `@article{key${i},title={Paper ${i}}}`, issues: [] }));
const updated: AuditResult = { status: "update", message: "A published version is available.", before: entries[0].bibtex, after: "@article{key0,title={Updated}}", changes: [{ field: "title", before: "Paper 0", after: "Updated" }] };
function props() { return { open: true, projectRoot: "/project", canApply: true, onClose: vi.fn(), onPrepare: vi.fn(async () => true), onApply: vi.fn(async () => {}) }; }

it("shows local issues first, bounds concurrency, and cancels the remaining queue", async () => {
  const pending: ((r: AuditResult) => void)[] = [];
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "bibliography_audit_scan") return { entries, issues: [{ path: "refs0.bib", message: "Missing author field." }] };
    if (command === "bibliography_audit_batch") return entries.map(() => null);
    return new Promise(resolve => pending.push(resolve)) as never;
  });
  render(<BibliographyAudit {...props()} />);
  await screen.findByText(/Missing author field/);
  await waitFor(() => expect(pending).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Cancel check" }));
  await act(async () => pending.forEach(resolve => resolve({ ...updated, status: "unavailable", after: undefined })));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(screen.getAllByText("Check incomplete")).toHaveLength(2);
  expect(screen.getByText("Not checked")).toBeInTheDocument();
});

it("uses one batch for twenty entries and only individually checks unresolved records", async () => {
  const records = Array.from({ length: 22 }, (_, i) => ({ ...entries[0], key: `paper${i}`, bibtex: `@article{paper${i},title={Paper ${i}}}` }));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "bibliography_audit_scan") return { entries: records, issues: [] };
    if (command === "bibliography_audit_batch") {
      const batch = (args as { entries: AuditEntry[] }).entries;
      return batch.map(entry => entry.key === "paper5" ? null : { ...updated, before: entry.bibtex });
    }
    return { ...updated, before: records[5].bibtex };
  });
  render(<BibliographyAudit {...props()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
  const calls = vi.mocked(invoke).mock.calls;
  expect(calls.filter(([cmd]) => cmd === "bibliography_audit_batch").map(([, args]) => (args as { entries: AuditEntry[] }).entries.length)).toEqual([20, 2]);
  expect(calls.filter(([cmd]) => cmd === "bibliography_audit_entry")).toHaveLength(1);
  expect(screen.getAllByText("Update available")).toHaveLength(22);
});

it("stops scheduling after cancellation during a batch", async () => {
  let resolve!: (value: (AuditResult | null)[]) => void;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "bibliography_audit_scan") return { entries, issues: [] };
    return new Promise(done => { resolve = done; });
  });
  render(<BibliographyAudit {...props()} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("bibliography_audit_batch", expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "Cancel check" }));
  await act(async () => resolve([updated, null, null]));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText("Not checked")).toHaveLength(2);
});

it("does not repeat a failed batch request in subsequent groups", async () => {
  const records = Array.from({ length: 22 }, (_, i) => ({ ...entries[0], key: `paper${i}` }));
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "bibliography_audit_scan") return { entries: records, issues: [] };
    if (command === "bibliography_audit_batch") throw new Error("429");
    return updated;
  });
  render(<BibliographyAudit {...props()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "bibliography_audit_batch")).toHaveLength(1);
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "bibliography_audit_entry")).toHaveLength(22);
});

it("applies the exact reviewed snapshot without another network lookup, including StrictMode", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : updated);
  const p = props();
  render(<StrictMode><BibliographyAudit {...p} /></StrictMode>);
  await screen.findByText("Update available");
  await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
  fireEvent.click(screen.getByText("Review proposed changes"));
  fireEvent.click(screen.getByRole("button", { name: "Apply this update" }));
  await screen.findByText("Update applied");
  expect(p.onApply).toHaveBeenCalledWith(entries[0], updated);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("continues while hidden but prevents read-only updates", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : updated);
  const p = { ...props(), canApply: false };
  const { rerender } = render(<BibliographyAudit {...p} />);
  await screen.findByText("Update available");
  rerender(<BibliographyAudit {...p} open={false} />);
  rerender(<BibliographyAudit {...p} />);
  fireEvent.click(screen.getByText("Review proposed changes"));
  expect(screen.getByRole("button", { name: "Apply this update" })).toBeDisabled();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("opens publisher notices through the native URL opener", async () => {
  const health = { kind: "corrected", link: "https://doi.org/10.1234/notice", checkedAt: "2026-09-05" };
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : { ...updated, health });
  render(<BibliographyAudit {...props()} />);
  fireEvent.click(await screen.findByRole("link", { name: "Open notice" }));
  expect(openUrl).toHaveBeenCalledWith(health.link);
});

it("keeps technical details and full BibTeX collapsed independently from the field diff", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : updated);
  render(<BibliographyAudit {...props()} />);
  await screen.findByText("Update available");
  expect(screen.getByText("Details").closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("Review proposed changes"));
  expect(screen.getByText("Title")).toBeVisible();
  expect(screen.getByText("BibTeX").closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("BibTeX"));
  expect(screen.getByText(updated.after!)).toBeVisible();
});

it("shows an explicit empty state without claiming references were verified", async () => {
  vi.mocked(invoke).mockResolvedValue({ entries: [], issues: [] });
  render(<BibliographyAudit {...props()} />);
  await screen.findByText("No references to check");
  expect(screen.getByRole("status")).toHaveTextContent("0 of 0 references checked");
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("explains partial publication lookups without exposing internal error codes", async () => {
  const result: AuditResult = {
    status: "unavailable", message: "Publication lookup: sources_unavailable.",
    publicationReason: "sources_unavailable", before: entries[0].bibtex, changes: [],
    sources: [{ source: "crossref", outcome: "no_match" }, { source: "semanticscholar", outcome: "rate_limited" }, { source: "dblp", outcome: "connection_failed" }],
  };
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : result);
  render(<BibliographyAudit {...props()} />);
  await screen.findByText("Published version not confirmed");
  expect(screen.queryByText(/sources_unavailable/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Results reflect available sources/)).not.toBeInTheDocument();
  expect(screen.getByText("Rate limited")).not.toBeVisible();
  fireEvent.click(screen.getByText("Details"));
  expect(screen.getByText("Some sources could not complete the lookup. This does not mean the reference is incorrect.")).toBeVisible();
  expect(screen.getByText("Rate limited")).toBeVisible();
  expect(screen.getByText("Connection failed")).toBeVisible();
  expect(screen.getByText("No published version found")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Apply this update" })).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("distinguishes a completed publication search from unavailable sources", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : {
    status: "checked", publicationReason: "no_published_version", message: "No published version was found.", before: entries[0].bibtex, changes: [],
  });
  render(<BibliographyAudit {...props()} />);
  await screen.findByText("No update found");
  fireEvent.click(screen.getByText("Details"));
  expect(screen.getByText("No published version was found in the sources checked.")).toBeVisible();
  expect(screen.queryByText("Published version not confirmed")).not.toBeInTheDocument();
});
