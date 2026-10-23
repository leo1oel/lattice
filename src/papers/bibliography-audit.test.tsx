import { StrictMode, type ComponentProps } from "react";
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
function props() { return { open: true, projectRoot: "/project", onClose: vi.fn(), onPrepare: vi.fn(async () => true), onApply: vi.fn<(entry: AuditEntry, result: AuditResult) => Promise<void>>().mockResolvedValue(undefined) }; }
async function checkAll() {
  const button = await screen.findByRole("button", { name: "Check all" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
async function renderChecked(overrides: Partial<ComponentProps<typeof BibliographyAudit>> = {}) {
  const p = { ...props(), ...overrides };
  const view = render(<BibliographyAudit {...p} />);
  await checkAll();
  return { ...view, props: p };
}
// "Check all" until a reference has been checked, then "Check again".
const idle = () => waitFor(() => expect(screen.getByRole("button", { name: /^Check (all|again)$/ })).toBeEnabled());
/** Opens the `index`th closed finding, as a click on its row does; its details unfold under it. */
const openRow = (index = 0) => fireEvent.click(screen.getAllByRole("button", { expanded: false })[index]);
/** Unfolds a finding's Details, where the finding has them (an incomplete check shows its sources directly). */
const openDetails = () => { const details = screen.queryByText("Details"); if (details) fireEvent.click(details); };
const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
/** Scans `scanned` and answers every remote check (batch or entry) with `result`. */
function mockAudit(result: unknown, scanned = entries.slice(0, 1)) {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: scanned, issues: [] } : result);
}
/** Every batch proposes an update for each of its entries. */
function mockBatchUpdates() {
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "bibliography_audit_scan"
    ? { entries, issues: [] }
    : { results: (args as { entries: AuditEntry[] }).entries.map(entry => ({ ...updated, before: entry.bibtex })) });
}
/** Holds the S2 batch open while every per-entry check comes back incomplete. */
function holdBatch() {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "bibliography_audit_scan") return { entries, issues: [] };
    if (command === "bibliography_audit_batch") return new Promise(resolve => { finish = resolve; });
    return { ...updated, status: "unavailable", after: undefined };
  });
  return (value: unknown) => finish(value);
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
  await idle();
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
  await renderChecked();
  await idle();
  expect(calls("bibliography_audit_batch").map(([, args]) => (args as { entries: AuditEntry[] }).entries.length)).toEqual([20, count - 20]);
  expect(calls("bibliography_audit_entry")).toHaveLength(1);
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
  await renderChecked();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("bibliography_audit_batch", expect.anything()));
  const startedCalls = vi.mocked(invoke).mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Cancel check" }));
  // Under load, the 250ms fallback may already have started. Drain only those
  // requests; don't let an entry request overwrite the batch's resolver.
  await act(async () => {
    finishBatch({ results: [updated, null, null] });
    inFlight.forEach(finish => finish({ ...updated, status: "checked", after: undefined }));
  });
  await idle();
  expect(invoke).toHaveBeenCalledTimes(startedCalls);
  expect(calls("bibliography_audit_entry").length).toBeLessThan(entries.length);
});

it("does not repeat a failed batch request in subsequent groups", async () => {
  const records = Array.from({ length: 22 }, (_, i) => ({ ...entries[0], key: `paper${i}` }));
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "bibliography_audit_scan") return { entries: records, issues: [] };
    if (command === "bibliography_audit_batch") return { results: records.slice(0, 20).map(() => null), s2Failure: "upstream_rate_limit" };
    return { ...updated, sources: [{ source: "semanticscholar", outcome: "batch_upstream_rate_limit" }] };
  });
  await renderChecked();
  await idle();
  expect(calls("bibliography_audit_batch")).toHaveLength(1);
  const fallbacks = calls("bibliography_audit_entry");
  expect(fallbacks).toHaveLength(22);
  expect(fallbacks.every(([, args]) => (args as { s2BatchStatus: string }).s2BatchStatus === "upstream_rate_limit")).toBe(true);
  openRow();
  openDetails();
  expect(screen.getByText("Semantic Scholar rate limited the service; subsequent queries skipped")).toBeVisible();
});

it("continues other sources while S2 waits and discards its late result after cancellation", async () => {
  const finishBatch = holdBatch();
  await renderChecked();
  await screen.findByText(/Waiting for Semantic Scholar/);
  await waitFor(() => expect(screen.getAllByText("Check incomplete")).toHaveLength(3));
  expect(invoke).toHaveBeenCalledWith("bibliography_audit_entry", expect.objectContaining({ s2BatchStatus: "checked" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel check" }));
  await idle();
  await act(async () => finishBatch({ results: entries.map(() => updated) }));
  expect(screen.queryByText("Update available")).not.toBeInTheDocument();
});

it("uses a late batch proposal after parallel checks complete", async () => {
  const finishBatch = holdBatch();
  await renderChecked();
  await waitFor(() => expect(screen.getAllByText("Check incomplete")).toHaveLength(3));
  await act(async () => finishBatch({ results: [updated, null, null], s2Failure: undefined }));
  await idle();
  expect(screen.getAllByText("Update available")).toHaveLength(1);
  expect(screen.getAllByText("Check incomplete")).toHaveLength(2);
});

it("keeps results usable and warns when native persistence fails", async () => {
  vi.mocked(saveAuditReport).mockRejectedValue(new Error("Disk full"));
  mockAudit(updated);
  await renderChecked();
  await screen.findByText("Update available");
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save the report on this device"));
});

it("never overwrites a report or enables checking when loading the saved report fails", async () => {
  vi.mocked(loadAuditReport).mockRejectedValue(new Error("Report could not be read"));
  vi.mocked(invoke).mockResolvedValue({ entries, issues: [] });
  render(<BibliographyAudit {...props()} />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Report could not be read"));
  expect(screen.getByRole("button", { name: "Check all" })).toBeDisabled();
  expect(saveAuditReport).not.toHaveBeenCalled();
});

it.each([
  ["distinguishes batch reuse and local queue limits from upstream rate limits", { ...updated, status: "unavailable", sources: [
    { source: "semanticscholar", outcome: "batch_reused" },
    { source: "openalex", outcome: "daily_quota" },
    { source: "crossref", outcome: "queue_busy" },
  ] }, ["Batch result reused", "Public daily quota exhausted", "Request queue busy"], ["Rate limited"]],
  ["shows the selected metadata source and cache attribution for updates",
    { ...updated, sources: [{ source: "crossref", outcome: "selected_cached" }] }, ["Crossref", "Metadata source · cached"], []],
  ["does not present legacy selected cached sources as accepted for unavailable results",
    { ...updated, status: "unavailable", after: undefined, publicationReason: "metadata_unavailable", sources: [{ source: "dblp", outcome: "selected_cached" }] },
    ["Independent metadata unavailable", "Source record considered, not verified · cached record"], ["Metadata source · cached"]],
] as const)("%s", async (_, result, shown, hidden) => {
  mockAudit(result);
  await renderChecked();
  await idle();
  openRow();
  openDetails();
  for (const text of shown) expect(screen.getByText(text)).toBeVisible();
  for (const text of hidden) expect(screen.queryByText(text)).not.toBeInTheDocument();
});

it("applies the exact reviewed snapshot without another network lookup and shows it as current, including StrictMode", async () => {
  mockAudit(updated);
  const p = props();
  render(<StrictMode><BibliographyAudit {...p} /></StrictMode>);
  await checkAll();
  await screen.findByText("Update available");
  await idle();
  openRow();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText("Update applied");
  expect(p.onApply).toHaveBeenCalledWith(entries[0], expect.objectContaining(updated));
  expect(invoke).toHaveBeenCalledTimes(4);
  openRow();
  fireEvent.click(screen.getByText("Current BibTeX"));
  expect(screen.getByText(updated.after!)).toBeVisible();
  expect(screen.queryByText(entries[0].bibtex)).not.toBeInTheDocument();
});

it("continues while hidden", async () => {
  mockAudit(updated);
  const { rerender, props: p } = await renderChecked();
  await screen.findByText("Update available");
  rerender(<BibliographyAudit {...p} open={false} />);
  rerender(<BibliographyAudit {...p} />);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "bibliography_audit_scan", "bibliography_audit_scan", "bibliography_audit_entry", "bibliography_audit_scan",
  ]);
});

it("files an update as a fix rather than a success, folds its fields and BibTeX, and opens notices natively", async () => {
  const health = { kind: "corrected", link: "https://doi.org/10.1234/notice", checkedAt: "2026-09-05" };
  mockAudit({ ...updated, health });
  await renderChecked();
  expect((await screen.findByText("Update available")).closest("[data-bucket]")).toHaveAttribute("data-bucket", "fix");
  openRow();
  expect(screen.getByText("Details").closest("details")).not.toHaveAttribute("open");
  expect(screen.getByText("Fields and BibTeX").closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("Fields and BibTeX"));
  expect(screen.getByText("Title")).toBeVisible();
  expect(screen.getByText("Proposed BibTeX")).toBeVisible();
  expect(screen.getByText(updated.after!)).toBeVisible();
  fireEvent.click(screen.getByRole("link", { name: "Open notice" }));
  expect(openUrl).toHaveBeenCalledWith(health.link);
});

it("shows the scanned BibTeX for not-checked and no-update entries", async () => {
  mockAudit({ status: "checked", message: "No update found.", before: entries[0].bibtex, changes: [] }, entries.slice(0, 2));
  render(<BibliographyAudit {...props()} />);
  await screen.findByText("Paper 1");
  openRow(1);
  fireEvent.click(screen.getByText("Current BibTeX"));
  expect(screen.getByText(entries[1].bibtex)).toBeVisible();
  openRow(0);
  fireEvent.click(screen.getByRole("button", { name: "Check this reference" }));
  await screen.findAllByText("No update found");
  fireEvent.click(screen.getByText("Current BibTeX"));
  expect(screen.getByText(entries[0].bibtex)).toBeVisible();
});

it("shows an explicit empty state without claiming references were verified", async () => {
  vi.mocked(invoke).mockResolvedValue({ entries: [], issues: [] });
  render(<BibliographyAudit {...props()} />);
  await screen.findByText("No references to check");
  expect(screen.getByRole("status")).toHaveTextContent("No references to check");
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check all" })).toBeEnabled();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("explains partial publication lookups without exposing internal error codes", async () => {
  mockAudit({
    status: "unavailable", message: "Publication lookup: sources_unavailable.",
    publicationReason: "sources_unavailable", before: entries[0].bibtex, changes: [],
    sources: [{ source: "crossref", outcome: "no_match" }, { source: "semanticscholar", outcome: "rate_limited" }, { source: "dblp", outcome: "connection_failed" }],
  });
  await renderChecked();
  await screen.findByText("Some sources unavailable");
  expect(screen.getByText("No answer from Semantic Scholar, DBLP")).toBeVisible();
  expect(screen.queryByText(/sources_unavailable/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Results reflect available sources/)).not.toBeInTheDocument();
  expect(screen.queryByText("Rate limited")).not.toBeInTheDocument();
  openRow();
  // The sources that did not answer are the explanation; no sentence restates them.
  expect(screen.queryByText(/does not mean the reference is incorrect/)).not.toBeInTheDocument();
  expect(screen.getByText("Rate limited")).toBeVisible();
  expect(screen.getByText("Connection failed")).toBeVisible();
  expect(screen.getByText("No published version found")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(3);
});

it.each([
  // A completed search is distinguished from unavailable sources.
  ["checked", "no_published_version", "No update found", "No matching publication was found in the sources checked."],
  ["skipped", "missing_identity", "Reference lacks identifying metadata", "Add a title, full authors, and year, or add a DOI or arXiv identifier, before checking this reference."],
  ["checked", "no_match", "No matching publication found", "No matching publication was found in the sources checked."],
] as const)("uses %s status with publication reason %s", async (status, publicationReason, label, explanation) => {
  mockAudit({ status, publicationReason, message: publicationReason, before: entries[0].bibtex, changes: [] });
  await renderChecked();
  expect(await screen.findByText(label)).toBeInTheDocument();
  openRow();
  openDetails();
  expect(screen.getByText(explanation)).toBeVisible();
  expect(screen.queryByText("Some sources unavailable")).not.toBeInTheDocument();
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

it("checks one row without its neighbors, then only selected rows, preserving unrelated results by path and key", async () => {
  let checks = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "bibliography_audit_scan") return { entries, issues: [] };
    if (command === "bibliography_audit_batch") return { results: (args as { entries: AuditEntry[] }).entries.map((entry) => ({ ...updated, before: entry.bibtex })) };
    checks += 1;
    return checks === 1 ? { ...updated, message: "First result" } : { ...updated, message: "Refreshed result" };
  });
  render(<BibliographyAudit {...props()} />);
  await screen.findByText("Paper 0");
  openRow(0);
  fireEvent.click(screen.getByRole("button", { name: "Check this reference" }));
  await screen.findByText("Update available");
  expect(screen.getAllByText("Not checked")).toHaveLength(2);
  expect(calls("bibliography_audit_entry")).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith("bibliography_audit_entry", expect.objectContaining({ entry: entries[0] }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select key1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select key2" }));
  fireEvent.click(screen.getByRole("button", { name: "Check selected" }));
  await waitFor(() => expect(screen.getAllByText("Update available")).toHaveLength(3));
  expect(screen.getByRole("checkbox", { name: "Select key0" })).not.toBeChecked();
  expect(calls("bibliography_audit_batch")).toHaveLength(1);
  fireEvent.click(screen.getAllByText("Details")[0]);
  expect(screen.getByText("First result")).toBeVisible();
});

it("accepts all updates sequentially without applying an item twice", async () => {
  mockBatchUpdates();
  const p = props();
  const onApplied = vi.fn();
  await renderChecked({ ...p, onApplied });
  fireEvent.click(await screen.findByRole("button", { name: "Apply 3 fixes" }));
  await waitFor(() => expect(screen.getAllByText("Update applied")).toHaveLength(3));
  expect(onApplied).toHaveBeenCalledTimes(1);
  expect(p.onApply.mock.calls.map(([entry]) => entry.key)).toEqual(["key0", "key1", "key2"]);
  expect(screen.queryByRole("button", { name: "Apply 3 fixes" })).not.toBeInTheDocument();
});

it("stops bulk apply on failure while retaining earlier successes", async () => {
  mockBatchUpdates();
  const p = props();
  p.onApply.mockImplementation(async entry => { if (entry.key === "key1") throw new Error("write failed"); });
  await renderChecked(p);
  fireEvent.click(await screen.findByRole("button", { name: "Apply 3 fixes" }));
  await screen.findByText("Error: write failed");
  expect(p.onApply.mock.calls.map(([entry]) => entry.key)).toEqual(["key0", "key1"]);
  expect(screen.getAllByText("Update applied")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Apply 2 fixes" }));
  await waitFor(() => expect(p.onApply).toHaveBeenCalledTimes(3));
  expect(p.onApply.mock.calls.map(([entry]) => entry.key)).toEqual(["key0", "key1", "key1"]);
});

it("explains when Semantic Scholar is not configured", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries, issues: [] } : command === "bibliography_audit_batch"
    ? { results: entries.map(() => null), s2Failure: "not_configured" }
    : { ...updated, status: "unavailable", after: undefined });
  await renderChecked();
  await idle();
  openRow();
  expect(screen.getByText("Not enabled · add your own API key in Settings")).toBeVisible();
});

it("explains a candidate with localized identity fields and no apply action", async () => {
  mockAudit({
    status: "unavailable", message: "identity_conflict", publicationReason: "identity_conflict",
    before: entries[0].bibtex, changes: [], sources: [
      { source: "dblp", outcome: "candidate_cached" },
      { source: "crossref", outcome: "forbidden" },
    ],
    candidate: {
      bibtex: "@inproceedings{other,title={Another paper}}",
      changes: [
        { field: "ENTRYTYPE", before: "article", after: "inproceedings" },
        { field: "publisher", before: "Original Press", after: "Candidate Press" },
      ],
      reasons: ["title", "author", "year", "venue", "arxiv", "insufficient_identity"],
    },
  } satisfies AuditResult);
  await renderChecked();
  expect(await screen.findByText("Candidate does not match reference")).toBeInTheDocument();
  openRow();
  fireEvent.click(screen.getByText("Details"));
  expect(screen.getByText("A possible record conflicts with this reference")).toBeVisible();
  expect(screen.getByText("Candidate record considered, not verified · cached record")).toBeVisible();
  expect(screen.getByText("Access forbidden by provider")).toBeVisible();
  expect(screen.getByText("Entry type")).toBeVisible();
  expect(screen.getByText("Publisher")).toBeVisible();
  expect(screen.getAllByText(/Title, Authors, Year, Venue, arXiv identifier, Insufficient identifying metadata/)[0]).toBeVisible();
  // Only the differing word is marked, and nothing reads as a change to apply.
  expect(screen.getByText("Candidate").closest("p")).toHaveTextContent("Candidate Press");
  for (const comparison of document.querySelectorAll(".bibliography-audit-compare")) expect(comparison.querySelector("del, ins")).toBeNull();
  expect(screen.getAllByText("Yours")).toHaveLength(2);
  expect(screen.getAllByText("Source · DBLP · not verified")).toHaveLength(2);
  expect(screen.getByText("Unverified candidate BibTeX")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Current BibTeX"));
  expect(screen.getByText(entries[0].bibtex)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  expect(screen.queryByText("Metadata source · cached")).not.toBeInTheDocument();
});

it("never offers individual or bulk apply when a restored payload contains a malformed candidate", async () => {
  const malformed = { ...updated, candidate: { changes: "invalid" } } as unknown as AuditResult;
  vi.mocked(loadAuditReport).mockResolvedValue(new Map([[`${entries[0].path}\0${entries[0].key}`, {
    snapshot: entries[0].bibtex, result: malformed, applied: false,
  }]]));
  vi.mocked(invoke).mockResolvedValue({ entries: entries.slice(0, 1), issues: [] });
  render(<BibliographyAudit {...props()} />);
  await screen.findByText("Update available");
  expect(screen.queryByText("Review proposed changes")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Apply \d+ fix/ })).not.toBeInTheDocument();
});

it("restores checked results after remount without making any remote checks", async () => {
  mockAudit(updated);
  const first = await renderChecked();
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
  const view = await renderChecked();
  await screen.findByText("Update available");
  view.rerender(<BibliographyAudit {...view.props} open={false} />);
  currentEntries = [{ ...entries[0], bibtex: "@article{key0,title={Edited}}" }];
  view.rerender(<BibliographyAudit {...view.props} />);
  await screen.findByText("Entry changed");
  expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
});

it("preserves applied status against the post-apply snapshot", async () => {
  let currentEntries = entries.slice(0, 1);
  vi.mocked(invoke).mockImplementation(async command => command === "bibliography_audit_scan" ? { entries: currentEntries, issues: [] } : updated);
  const p = props();
  p.onApply.mockImplementation(async () => { currentEntries = [{ ...entries[0], bibtex: updated.after! }]; });
  const view = await renderChecked(p);
  fireEvent.click(await screen.findByRole("button", { name: "Apply 1 fix" }));
  await screen.findByText("Update applied");
  view.unmount();
  render(<BibliographyAudit {...p} />);
  await screen.findByText("Update applied");
  expect(screen.queryByRole("button", { name: "Apply 1 fix" })).not.toBeInTheDocument();
});

it("isolates project reports", async () => {
  mockAudit(updated);
  const view = render(<BibliographyAudit {...props()} />);
  await screen.findByText("Not checked");
  await checkAll();
  await screen.findByText("Update available");
  view.unmount();
  render(<BibliographyAudit {...props()} projectRoot="/other" />);
  await screen.findByText("Not checked");
  expect(screen.queryByText("Update available")).not.toBeInTheDocument();
});
