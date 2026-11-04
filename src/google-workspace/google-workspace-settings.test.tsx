import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invokeCalls, mockInvoke } from "../platform/tauri-test-mocks";
import { GoogleWorkspaceSettings } from "./google-workspace-settings";
import { WorkspaceOperations } from "./workspace-operations";
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const disconnected = {
  connected: false,
  pending: false,
  email: null,
  products: [],
  error: false,
};
const connected = {
  ...disconnected,
  connected: true,
  email: "fixture@example.edu",
  products: ["docs", "sheets", "slides", "forms", "calendar"],
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keeps a newer browser sign-in pending when the initial account lookup resolves late", async () => {
  let resolveInitial!: (value: unknown) => void;
  let lookups = 0;
  mockInvoke({
    google_workspace_status: () =>
      ++lookups === 1
        ? new Promise((resolve) => {
            resolveInitial = resolve;
          })
        : { ...disconnected, pending: true },
    google_workspace_begin: undefined,
  });
  render(<GoogleWorkspaceSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Advanced: Google API access" }));
  fireEvent.change(screen.getByLabelText("Desktop OAuth client ID"), {
    target: { value: "fixture.apps.googleusercontent.com" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in with default browser" }),
  );
  await screen.findByText("Waiting for Google authorization…");
  await act(async () => {
    resolveInitial(disconnected);
  });
  await waitFor(() =>
    expect(
      screen.getByText("Waiting for Google authorization…"),
    ).toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
});

it("requires explicit client/product setup before system-browser consent and never handles access tokens", async () => {
  let pending = false;
  mockInvoke({
    google_workspace_status: () => ({ ...disconnected, pending }),
    google_workspace_begin: () => {
      pending = true;
    },
  });
  render(<GoogleWorkspaceSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Advanced: Google API access" }));
  const button = await screen.findByRole("button", {
    name: "Sign in with default browser",
  });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Desktop OAuth client ID"), {
    target: { value: "fixture.apps.googleusercontent.com" },
  });
  fireEvent.change(screen.getByLabelText("Client secret (optional)"), {
    target: { value: "private-client-secret" },
  });
  fireEvent.click(screen.getByLabelText("Google Forms"));
  fireEvent.click(button);
  await screen.findByText("Waiting for Google authorization…");
  expect(invokeCalls("google_workspace_begin")).toEqual([
    {
      client: {
        clientId: "fixture.apps.googleusercontent.com",
        clientSecret: "private-client-secret",
        products: ["docs", "forms"],
      },
    },
  ]);
  expect(screen.getByLabelText("Client secret (optional)")).toHaveValue("");
  expect(screen.queryByText("fixture@example.edu")).not.toBeInTheDocument();
});
it("creates a document through the workspace consumer, then reads and explicitly updates that resource", async () => {
  mockInvoke({
    google_workspace_status: connected,
    google_workspace_request: ({ request }: Record<string, unknown>) => {
      const value = request as { operation: string };
      return value.operation === "create"
        ? { documentId: "new-document" }
        : { title: "Research notes" };
    },
  });
  render(<GoogleWorkspaceSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Advanced: Google API access" }));
  fireEvent.change(await screen.findByLabelText("New resource title"), {
    target: { value: "Experiments" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Resource ID")).toHaveValue("new-document"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  await screen.findByText(/Research notes/);
  fireEvent.change(screen.getByLabelText("Request JSON (advanced)"), {
    target: {
      value: JSON.stringify({
        requests: [
          { insertText: { location: { index: 1 }, text: "Result\n" } },
        ],
      }),
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply update" }));
  await waitFor(() =>
    expect(invokeCalls("google_workspace_request")).toHaveLength(3),
  );
  expect(invokeCalls("google_workspace_request")[2]).toEqual({
    request: {
      product: "docs",
      operation: "update",
      resourceId: "new-document",
      itemId: "",
      range: "A1",
      body: {
        requests: [
          { insertText: { location: { index: 1 }, text: "Result\n" } },
        ],
      },
    },
  });
});
it("never renders provider credential errors or treats failed JSON writes as success", async () => {
  mockInvoke({
    google_workspace_request: () =>
      Promise.reject(new Error("Bearer private-access-token")),
  });
  render(<WorkspaceOperations products={["docs"]} />);
  fireEvent.change(screen.getByLabelText("Resource ID"), {
    target: { value: "fixture-resource" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  await screen.findByText(/Google could not complete this operation/);
  expect(document.body.textContent).not.toContain("private-access-token");
  expect(
    screen.queryByLabelText("Google API response"),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Request JSON (advanced)"), {
    target: { value: "{not-json" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply update" }));
  await waitFor(() =>
    expect(invokeCalls("google_workspace_request")).toHaveLength(1),
  );
});

it("does not advertise API operations when Google grants no product scopes", async () => {
  mockInvoke({ google_workspace_status: { ...connected, products: [] } });
  render(<GoogleWorkspaceSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Advanced: Google API access" }));
  await screen.findByText(
    "No product permissions were granted. Reconnect and approve the products you want to use.",
  );
  expect(
    screen.queryByLabelText("Google Workspace operations"),
  ).not.toBeInTheDocument();
});

it("clears a document response when the resource identity changes", async () => {
  mockInvoke({ google_workspace_request: { title: "Original document" } });
  render(<WorkspaceOperations products={["docs"]} />);
  fireEvent.change(screen.getByLabelText("Resource ID"), {
    target: { value: "original-document" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  await screen.findByText(/Original document/);
  fireEvent.change(screen.getByLabelText("Resource ID"), {
    target: { value: "different-document" },
  });
  expect(
    screen.queryByLabelText("Google API response"),
  ).not.toBeInTheDocument();
});
it("does not reveal a completed request after its account workspace unmounts", async () => {
  let settle!: (value: unknown) => void;
  mockInvoke({
    google_workspace_request: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  });
  const result = render(<WorkspaceOperations products={["docs"]} />);
  fireEvent.change(screen.getByLabelText("Resource ID"), {
    target: { value: "old-document" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  await waitFor(() =>
    expect(invokeCalls("google_workspace_request")).toHaveLength(1),
  );
  result.unmount();
  settle({ title: "Old account private content" });
  await Promise.resolve();
  expect(document.body.textContent).not.toContain(
    "Old account private content",
  );
});
it("opens all five official websites without client setup or Google IPC", async () => {
  mockInvoke({});
  render(<GoogleWorkspaceSettings />);
  expect(screen.queryByLabelText("Desktop OAuth client ID")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Advanced: Google API access" })).toHaveAttribute("aria-expanded", "false");
  for (const button of screen.getAllByRole("button", { name: "Open in default browser" })) {
    fireEvent.click(button);
  }
  await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(5));
  expect(vi.mocked(openUrl).mock.calls.map(([url]) => url)).toEqual([
    "https://docs.google.com/document/",
    "https://docs.google.com/spreadsheets/",
    "https://docs.google.com/presentation/",
    "https://docs.google.com/forms/",
    "https://calendar.google.com/",
  ]);
  expect(invokeCalls("google_workspace_status")).toHaveLength(0);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("opens in Lattice when supported and falls back to the browser when the command is absent", async () => {
  mockInvoke({ web_browser_open: undefined });
  render(<GoogleWorkspaceSettings />);
  const docs = screen.getByText("Google Docs").closest(".google-web-product") as HTMLElement;
  fireEvent.click(within(docs).getByRole("button", { name: "Open in Lattice" }));
  await waitFor(() => expect(invokeCalls("web_browser_open")).toEqual([{ url: "https://docs.google.com/document/" }]));
  expect(openUrl).not.toHaveBeenCalled();
  mockInvoke({});
  fireEvent.click(within(docs).getByRole("button", { name: "Open in Lattice" }));
  await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://docs.google.com/document/"));
});

it("keeps web access available after optional API setup fails on a host without Google commands", async () => {
  mockInvoke({});
  render(<GoogleWorkspaceSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Advanced: Google API access" }));
  expect(await screen.findByLabelText("Desktop OAuth client ID")).toBeInTheDocument();
  await screen.findByText(/Google Workspace could not complete that action/);
  fireEvent.click(screen.getByRole("button", { name: "Advanced: Google API access" }));
  expect(screen.queryByLabelText("Desktop OAuth client ID")).not.toBeInTheDocument();
  expect(screen.queryByText(/Google Workspace could not complete that action/)).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Open in default browser" })[4]);
  await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://calendar.google.com/"));
});
