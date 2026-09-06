import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LiteratureSettings } from "./literature-settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
const anonymous = { openalex: "anonymous", semanticscholar: "anonymous", crossrefEmail: "" };
afterEach(cleanup);
beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue(anonymous); });

async function ready() {
  render(<StrictMode><LiteratureSettings /></StrictMode>);
  await waitFor(() => expect(screen.getAllByLabelText("API key")[0]).toBeEnabled());
}

it("saves a trimmed key without displaying it again and removes it with environment fallback", async () => {
  await ready();
  const field = screen.getAllByLabelText("API key")[0];
  expect(field).toHaveAttribute("type", "password");
  vi.mocked(invoke).mockResolvedValueOnce({ ...anonymous, openalex: "saved" });
  fireEvent.change(field, { target: { value: "  draft-key  " } });
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
  await screen.findByText("Personal key saved");
  expect(invoke).toHaveBeenLastCalledWith("set_literature_credential", { provider: "openalex", secret: "draft-key" });
  expect(field).toHaveValue("");
  vi.mocked(invoke).mockResolvedValueOnce({ ...anonymous, openalex: "environment" });
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  await screen.findByText("Using environment key");
  expect(invoke).toHaveBeenLastCalledWith("set_literature_credential", { provider: "openalex", secret: null });
});

it("tests a draft once without saving, disables concurrent actions, and explains rate limiting", async () => {
  await ready();
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  fireEvent.change(screen.getAllByLabelText("API key")[1], { target: { value: "s2-draft" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Test connection" })[1]);
  expect(screen.getAllByRole("button", { name: "Test connection" })[0]).toBeDisabled();
  expect(invoke).toHaveBeenLastCalledWith("test_literature_credential", { provider: "semanticscholar", secret: "s2-draft" });
  await act(async () => resolve({ status: "rate_limited", authenticated: true }));
  await screen.findByText("The service is rate-limiting requests. No retry was made.");
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command !== "get_literature_credentials")).toHaveLength(1);
  expect(screen.getAllByLabelText("API key")[1]).toHaveValue("s2-draft");
});

it("tests the effective credentials when the input is empty", async () => {
  await ready();
  vi.mocked(invoke).mockResolvedValueOnce({ status: "ok", authenticated: false });
  fireEvent.click(screen.getAllByRole("button", { name: "Test connection" })[0]);
  await screen.findByText("Public API connection succeeded.");
  expect(invoke).toHaveBeenLastCalledWith("test_literature_credential", { provider: "openalex", secret: null });
});

it("saves and clears the optional Crossref email", async () => {
  await ready();
  vi.mocked(invoke).mockResolvedValueOnce({ ...anonymous, crossrefEmail: "person@example.org" });
  fireEvent.change(screen.getByLabelText("Contact email"), { target: { value: "person@example.org" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[2]);
  await screen.findByText("Contact settings saved.");
  expect(invoke).toHaveBeenLastCalledWith("set_literature_contact", { email: "person@example.org" });
  vi.mocked(invoke).mockResolvedValueOnce(anonymous);
  fireEvent.change(screen.getByLabelText("Contact email"), { target: { value: "" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[2]);
  await screen.findByText("Contact settings saved.");
  expect(invoke).toHaveBeenLastCalledWith("set_literature_contact", { email: "" });
});

it("does not expose backend errors or lose the draft when saving fails", async () => {
  await ready();
  vi.mocked(invoke).mockRejectedValueOnce("https://provider.test?api_key=secret-leak");
  fireEvent.change(screen.getAllByLabelText("API key")[0], { target: { value: "draft" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
  await screen.findByRole("alert");
  expect(document.body.textContent).not.toContain("secret-leak");
  expect(screen.getAllByLabelText("API key")[0]).toHaveValue("draft");
});

it("keeps credentials disabled when secure storage cannot be read", async () => {
  vi.mocked(invoke).mockRejectedValue("keychain denied");
  render(<LiteratureSettings />);
  await screen.findByRole("alert");
  expect(screen.getAllByLabelText("API key")[0]).toBeDisabled();
  expect(screen.queryByText("Public access · no key")).not.toBeInTheDocument();
});
