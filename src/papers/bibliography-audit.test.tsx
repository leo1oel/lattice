import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BibliographyAudit, type AuditEntry, type AuditResult } from "./bibliography-audit";
import { loadAuditReport, saveAuditReport, type AuditReport } from "./bibliography-audit-storage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("./bibliography-audit-storage", () => ({ loadAuditReport: vi.fn(), saveAuditReport: vi.fn() }));
afterEach(cleanup);
beforeEach(() => {
  vi.mocked(invoke).mockReset(); localStorage.clear();
  const reports = new Map<string, AuditReport>();
  vi.mocked(loadAuditReport).mockReset().mockImplementation(async root => new Map(reports.get(root) ?? []));
  vi.mocked(saveAuditReport).mockReset().mockImplementation(async (root, report) => { reports.set(root, report); });
});
const entries: AuditEntry[] = Array.from({ length: 3 }, (_, i) => ({ path: `refs${i}.bib`, key: `key${i}`, title: `Paper ${i}`, bibtex: `@article{key${i},title={Paper ${i}}}`, issues: [] }));
const updated: AuditResult = { status: "update", message: "A published version is available.", before: entries[0].bibtex, after: "@article{key0,title={Updated}}", changes: [{ field: "title", before: "Paper 0", after: "Updated" }] };
function props() { return { open: true, projectRoot: "/project", canApply: true, onClose: vi.fn(), onPrepare: vi.fn(async () => true), onApply: vi.fn<(entry: AuditEntry, result: AuditResult) => Promise<void>>().mockResolvedValue(undefined) }; }
async function checkAll() {
  const button = await screen.findByRole("button", { name: "Check all" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

it("shows local issues first, bounds concurrency, and cancels the remaining queue", async () => {
  const pending: ((r: AuditResult) => void)[] = [];
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "bibliography_audit_scan") return { entries, issues: [{ path: "refs0.bib", message: "Missing author field." }] };
    if (command === "bibliography_audit_batch") return { results: entries.map(() => null) };
    return new Promise(resolve => pending.push(resolve)) as never;
  });
  render(<BibliographyAudit {...props()} />);
  await screen.findByText(/Missing author field/);
  await checkAll();
  await waitFor(() => expect(pending).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Cancel check" }));
  await act(async () => pending.forEach(resolve => resolve({ ...updated, status: "unavailable", after: undefined })));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled());
  expect(invoke).toHaveBeenCalledTimes(5);
  expect(screen.getAllByText("Check incomplete")).toHaveLength(2);
  expect(screen.getByText("Not checked")).toBeInTheDocument();
});

it.each([21, 22])("batches all %i entries including a single-entry final group", async count => {
  const records = Array.from({ length: count }, (_, i) => ({ ...entries[0], key: `paper${i}`, bibtex: `@article{paper${i},title={Paper ${i}}}` }));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "bibliography_audit_scan") return { entries: records, issues: [] };
    if (command === "bibliography_audit_batch") {
      const batch = (args as { entries: AuditEntry[] }).entries;
      return { results: batch.map(entry => entry.key === "paper5" ? null : { ...updated, before: entry.bibtex }) };
    }
    return { ...updated, before: records[5].bibtex };
  });
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  await waitFor(() => expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled());
  const calls = vi.mocked(invoke).mock.calls;
  expect(calls.filter(([cmd]) => cmd === "bibliography_audit_batch").map(([, args]) => (args as { entries: AuditEntry[] }).entries.length)).toEqual([20, count - 20]);
  expect(calls.filter(([cmd]) => cmd === "bibliography_audit_entry")).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith("bibliography_audit_entry", expect.objectContaining({ s2BatchStatus: "checked" }));
  expect(screen.getAllByText("Update available")).toHaveLength(count);
});

it("stops scheduling after cancellation during a batch", async () => {
  let finishBatch!: (value: unknown) => void;
  const inFlight: ((value: AuditResult) => void)[] = [];
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "bibliography_audit_scan") return { entries, issues: [] };
    if (command === "bibliography_audit_batch") return new Promise(done => { finishBatch = done; });
    return new Promise<AuditResult>(done => { inFlight.push(done); });
  });
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("bibliography_audit_batch", expect.anything()));
  const startedCalls = vi.mocked(invoke).mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Cancel check" }));
  // Under load, the 250ms fallback may already have started. Drain only those
  // requests; don't let an entry request overwrite the batch's resolver.
  await act(async () => {
    finishBatch({ results: [updated, null, null] });
    inFlight.forEach(finish => finish({ ...updated, status: "checked", after: undefined }));
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled());
  expect(invoke).toHaveBeenCalledTimes(startedCalls);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "bibliography_audit_entry").length).toBeLessThan(entries.length);
});

it("does not repeat a failed batch request in subsequent groups", async () => {
  const records = Array.from({ length: 22 }, (_, i) => ({ ...entries[0], key: `paper${i}` }));
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "bibliography_audit_scan") return { entries: records, issues: [] };
    if (command === "bibliography_audit_batch") return { results: records.slice(0, 20).map(() => null), s2Failure: "upstream_rate_limit" };
    return { ...updated, sources: [{ source: "semanticscholar", outcome: "batch_upstream_rate_limit" }] };
  });
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  await waitFor(() => expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled());
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "bibliography_audit_batch")).toHaveLength(1);
  const fallbacks = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "bibliography_audit_entry");
  expect(fallbacks).toHaveLength(22);
  expect(fallbacks.every(([, args]) => (args as { s2BatchStatus: string }).s2BatchStatus === "upstream_rate_limit")).toBe(true);
  expect(screen.getAllByText("Semantic Scholar rate limited the service; subsequent queries skipped")).toHaveLength(22);
});

it("continues other sources while S2 waits and discards its late result after cancellation", async () => {
  let finishBatch!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "bibliography_audit_scan") return { entries, issues: [] };
    if (command === "bibliography_audit_batch") return new Promise(resolve => { finishBatch = resolve; });
    return { ...updated, status: "unavailable", after: undefined };
  });
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  await screen.findByText(/Semantic Scholar is queued or querying/);
  await waitFor(() => expect(screen.getAllByText("Check incomplete")).toHaveLength(3));
  expect(invoke).toHaveBeenCalledWith("bibliography_audit_entry", expect.objectContaining({ s2BatchStatus: "checked" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel check" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled());
  await act(async () => finishBatch({ results: entries.map(() => updated) }));
  expect(screen.queryByText("Update available")).not.toBeInTheDocument();
});

it("keeps results usable and warns when native persistence fails", async () => {
  vi.mocked(saveAuditReport).mockRejectedValue(new Error("Disk full"));
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : updated);
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  await screen.findByText("Update available");
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the report on this device");
});

it("never overwrites a report or enables checking when loading the saved report fails", async () => {
  vi.mocked(loadAuditReport).mockRejectedValue(new Error("Report could not be read"));
  vi.mocked(invoke).mockResolvedValue({ entries, issues: [] });
  render(<BibliographyAudit {...props()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Report could not be read");
  expect(screen.getByRole("button", { name: "Check all" })).toBeDisabled();
  expect(saveAuditReport).not.toHaveBeenCalled();
});

it("uses a late batch proposal after parallel checks complete", async () => {
  let finishBatch!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "bibliography_audit_scan") return { entries, issues: [] };
    if (command === "bibliography_audit_batch") return new Promise(resolve => { finishBatch = resolve; });
    return { ...updated, status: "unavailable", after: undefined };
  });
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  await waitFor(() => expect(screen.getAllByText("Check incomplete")).toHaveLength(3));
  await act(async () => finishBatch({ results: [updated, null, null], s2Failure: undefined }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled());
  expect(screen.getAllByText("Update available")).toHaveLength(1);
  expect(screen.getAllByText("Check incomplete")).toHaveLength(2);
});

it("distinguishes batch reuse and local queue limits from upstream rate limits", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan"
    ? { entries: entries.slice(0, 1), issues: [] }
    : { ...updated, status: "unavailable", sources: [
      { source: "semanticscholar", outcome: "batch_reused" },
      { source: "openalex", outcome: "daily_quota" },
      { source: "crossref", outcome: "queue_busy" },
    ] });
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  await screen.findByText("Batch result reused");
  expect(screen.getByText("Public daily quota exhausted")).toBeInTheDocument();
  expect(screen.getByText("Request queue busy")).toBeInTheDocument();
  expect(screen.queryByText("Rate limited")).not.toBeInTheDocument();
});

it("applies the exact reviewed snapshot without another network lookup, including StrictMode", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : updated);
  const p = props();
  render(<StrictMode><BibliographyAudit {...p} /></StrictMode>);
  await checkAll();
  await screen.findByText("Update available");
  await waitFor(() => expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled());
  fireEvent.click(screen.getByText("Review proposed changes"));
  fireEvent.click(screen.getByRole("button", { name: "Apply this update" }));
  await screen.findByText("Update applied");
  expect(p.onApply).toHaveBeenCalledWith(entries[0], expect.objectContaining(updated));
  expect(invoke).toHaveBeenCalledTimes(4);
});

it("continues while hidden but prevents read-only updates", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : updated);
  const p = { ...props(), canApply: false };
  const { rerender } = render(<BibliographyAudit {...p} />);
  await checkAll();
  await screen.findByText("Update available");
  rerender(<BibliographyAudit {...p} open={false} />);
  rerender(<BibliographyAudit {...p} />);
  fireEvent.click(screen.getByText("Review proposed changes"));
  expect(screen.getByRole("button", { name: "Apply this update" })).toBeDisabled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "bibliography_audit_scan", "bibliography_audit_scan", "bibliography_audit_entry", "bibliography_audit_scan",
  ]);
});

it("opens publisher notices through the native URL opener", async () => {
  const health = { kind: "corrected", link: "https://doi.org/10.1234/notice", checkedAt: "2026-09-05" };
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : { ...updated, health });
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  fireEvent.click(await screen.findByRole("link", { name: "Open notice" }));
  expect(openUrl).toHaveBeenCalledWith(health.link);
});

it("keeps technical details and full BibTeX collapsed independently from the field diff", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : updated);
  render(<BibliographyAudit {...props()} />);
  await checkAll();
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
  expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled();
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
  await checkAll();
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
  expect(invoke).toHaveBeenCalledTimes(3);
});

it("distinguishes a completed publication search from unavailable sources", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : {
    status: "checked", publicationReason: "no_published_version", message: "No published version was found.", before: entries[0].bibtex, changes: [],
  });
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  await screen.findByText("No update found");
  fireEvent.click(screen.getByText("Details"));
  expect(screen.getByText("No published version was found in the sources checked.")).toBeVisible();
  expect(screen.queryByText("Published version not confirmed")).not.toBeInTheDocument();
});

it("only performs the local scan when opened", async () => {
  const p = props();
  vi.mocked(invoke).mockResolvedValue({ entries, issues: [] });
  render(<BibliographyAudit {...p} />);
  await screen.findByText("Paper 0");
  expect(p.onPrepare).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("bibliography_audit_scan", { projectRoot: "/project" });
});

it("checks one row explicitly without checking its neighbors", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries, issues: [] } : updated);
  render(<BibliographyAudit {...props()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Check key1" }));
  await screen.findByText("Update available");
  expect(screen.getAllByText("Not checked")).toHaveLength(2);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "bibliography_audit_entry")).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith("bibliography_audit_entry", expect.objectContaining({ entry: entries[1] }));
});

it("checks only selected rows and preserves unrelated results by path and key", async () => {
  let checks = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "bibliography_audit_scan") return { entries, issues: [] };
    if (command === "bibliography_audit_batch") return { results: (args as { entries: AuditEntry[] }).entries.map((entry) => ({ ...updated, before: entry.bibtex })) };
    checks += 1;
    return checks === 1 ? { ...updated, message: "First result" } : { ...updated, message: "Refreshed result" };
  });
  render(<BibliographyAudit {...props()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Check key0" }));
  await screen.findByText("Update available");
  fireEvent.click(screen.getByRole("checkbox", { name: "Select key1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select key2" }));
  fireEvent.click(screen.getByRole("button", { name: "Check selected" }));
  await waitFor(() => expect(screen.getAllByText("Update available")).toHaveLength(3));
  expect(screen.getByRole("checkbox", { name: "Select key0" })).not.toBeChecked();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "bibliography_audit_batch")).toHaveLength(1);
  fireEvent.click(screen.getAllByText("Details")[0]);
  expect(screen.getByText("First result")).toBeVisible();
});

it("uses a success-tone badge for an available update", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : updated);
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  expect((await screen.findByText("Update available")).closest('[data-slot="badge"]')).toHaveAttribute("data-tone", "success");
});

it("accepts all updates sequentially without applying an item twice", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "bibliography_audit_scan" ? { entries, issues: [] } : { results: (args as { entries: AuditEntry[] }).entries.map(entry => ({ ...updated, before: entry.bibtex })) });
  const p = props();
  const onApplied = vi.fn();
  render(<BibliographyAudit {...p} onApplied={onApplied} />);
  await checkAll();
  fireEvent.click(await screen.findByRole("button", { name: "Accept all updates" }));
  await waitFor(() => expect(screen.getAllByText("Update applied")).toHaveLength(3));
  expect(onApplied).toHaveBeenCalledTimes(1);
  expect(p.onApply.mock.calls.map(([entry]) => entry.key)).toEqual(["key0", "key1", "key2"]);
  expect(screen.queryByRole("button", { name: "Accept all updates" })).not.toBeInTheDocument();
});

it("stops bulk apply on failure while retaining earlier successes", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "bibliography_audit_scan" ? { entries, issues: [] } : { results: (args as { entries: AuditEntry[] }).entries.map(entry => ({ ...updated, before: entry.bibtex })) });
  const p = props();
  p.onApply.mockImplementation(async entry => { if (entry.key === "key1") throw new Error("write failed"); });
  render(<BibliographyAudit {...p} />);
  await checkAll();
  fireEvent.click(await screen.findByRole("button", { name: "Accept all updates" }));
  await screen.findByText("Error: write failed");
  expect(p.onApply.mock.calls.map(([entry]) => entry.key)).toEqual(["key0", "key1"]);
  expect(screen.getAllByText("Update applied")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Accept all updates" }));
  await waitFor(() => expect(p.onApply).toHaveBeenCalledTimes(3));
  expect(p.onApply.mock.calls.map(([entry]) => entry.key)).toEqual(["key0", "key1", "key1"]);
});

it("disables bulk updates in read-only projects", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : updated);
  render(<BibliographyAudit {...props()} canApply={false} />);
  await checkAll();
  expect(await screen.findByRole("button", { name: "Accept all updates" })).toBeDisabled();
});

it("explains when Semantic Scholar is not configured", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries, issues: [] } : command === "bibliography_audit_batch"
    ? { results: entries.map(() => null), s2Failure: "not_configured" }
    : { ...updated, status: "unavailable", after: undefined });
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  await screen.findAllByText("Not enabled · add your own API key in Settings");
});

it("shows the selected metadata source and cache attribution for updates", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan"
    ? { entries: entries.slice(0, 1), issues: [] }
    : { ...updated, sources: [{ source: "crossref", outcome: "selected_cached" }] });
  render(<BibliographyAudit {...props()} />);
  await checkAll();
  expect(await screen.findByText("Crossref")).toBeInTheDocument();
  expect(screen.getByText("Metadata source · cached")).toBeInTheDocument();
});

it("restores checked results after remount without making any remote checks", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan"
    ? { entries: entries.slice(0, 1), issues: [] } : updated);
  const first = render(<BibliographyAudit {...props()} />);
  await checkAll();
  await screen.findByText("Update available");
  const time = document.querySelector("time")!.dateTime;
  first.unmount();
  vi.mocked(invoke).mockClear();
  render(<BibliographyAudit {...props()} />);
  await screen.findByText("Update available");
  expect(document.querySelector("time")!.dateTime).toBe(time);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["bibliography_audit_scan"]);
});

it("invalidates changed snapshots on reopen and never offers the stale proposal", async () => {
  let currentEntries = entries.slice(0, 1);
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: currentEntries, issues: [] } : updated);
  const p = props();
  const view = render(<BibliographyAudit {...p} />);
  await checkAll();
  await screen.findByText("Update available");
  view.rerender(<BibliographyAudit {...p} open={false} />);
  currentEntries = [{ ...entries[0], bibtex: "@article{key0,title={Edited}}" }];
  view.rerender(<BibliographyAudit {...p} />);
  await screen.findByText("Entry changed");
  expect(screen.queryByRole("button", { name: "Apply this update" })).not.toBeInTheDocument();
});

it("preserves applied status against the post-apply snapshot", async () => {
  let currentEntries = entries.slice(0, 1);
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: currentEntries, issues: [] } : updated);
  const p = props();
  p.onApply.mockImplementation(async () => { currentEntries = [{ ...entries[0], bibtex: updated.after! }]; });
  const view = render(<BibliographyAudit {...p} />);
  await checkAll();
  fireEvent.click(await screen.findByRole("button", { name: "Accept all updates" }));
  await screen.findByText("Update applied");
  view.unmount();
  render(<BibliographyAudit {...p} />);
  await screen.findByText("Update applied");
  expect(screen.queryByRole("button", { name: "Accept all updates" })).not.toBeInTheDocument();
});

it("isolates project reports", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: entries.slice(0, 1), issues: [] } : updated);
  const view = render(<BibliographyAudit {...props()} />);
  await screen.findByText("Not checked");
  await checkAll();
  await screen.findByText("Update available");
  view.unmount();
  render(<BibliographyAudit {...props()} projectRoot="/other" />);
  await screen.findByText("Not checked");
  expect(screen.queryByText("Update available")).not.toBeInTheDocument();
});
