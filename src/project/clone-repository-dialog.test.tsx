import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloneRepositoryDialog } from "./clone-repository-dialog";
import { cloneError, joinPath, parentFolder, repositoryName } from "./clone-repository";

type Channel = { onmessage: ((message: unknown) => void) | null };
const tauri = vi.hoisted(() => ({ invoke: vi.fn(), channel: null as Channel | null, open: vi.fn(), documentDir: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;

    constructor() {
      tauri.channel = this;
    }
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ documentDir: tauri.documentDir }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open }));

/** The next clone_repository call, answered when the test says. */
function nextClone() {
  const settle: { finish: (root: string) => void; fail: (reason: unknown) => void } = { finish: () => {}, fail: () => {} };
  tauri.invoke.mockImplementation((command: string) => {
    if (command === "cancel_clone") {
      settle.fail({ kind: "cancelled" });
      return Promise.resolve(null);
    }
    expect(command).toBe("clone_repository");
    return new Promise((resolve, reject) => {
      settle.finish = resolve;
      settle.fail = reject;
    });
  });
  return settle;
}

function renderDialog(recentProjectPath: string | null = "/Users/ada/Papers/thesis") {
  const props = { recentProjectPath, onClose: vi.fn(), onCloned: vi.fn() };
  render(<CloneRepositoryDialog {...props} />);
  return props;
}

const urlField = () => screen.getByRole("textbox", { name: "Repository URL" });
const locationField = () => screen.getByRole("textbox", { name: "Location" });

beforeEach(() => {
  tauri.documentDir.mockResolvedValue("/Users/ada/Documents");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  tauri.channel = null;
});

describe("repository names and paths", () => {
  it("names the folder as git would", () => {
    expect(repositoryName("https://github.com/latex3/latex2e.git")).toBe("latex2e");
    expect(repositoryName("https://github.com/owner/paper/")).toBe("paper");
    expect(repositoryName("git@github.com:owner/paper.git")).toBe("paper");
    expect(repositoryName("ssh://git@example.com:2222/owner/thesis")).toBe("thesis");
    expect(repositoryName("https://example.com/owner/paper.git?ref=main")).toBe("paper");
    expect(repositoryName("https://github.com")).toBe("");
    expect(repositoryName("")).toBe("");
  });

  it("joins and splits folders", () => {
    expect(joinPath("/Users/ada/Papers/", "paper")).toBe("/Users/ada/Papers/paper");
    expect(parentFolder("/Users/ada/Papers/thesis")).toBe("/Users/ada/Papers");
    expect(parentFolder("/thesis")).toBe("/");
  });

  it("reads the backend's refusals and treats anything else as a failure", () => {
    expect(cloneError({ kind: "folderExists" })).toEqual({ kind: "folderExists" });
    expect(cloneError({ kind: "auth", detail: "Permission denied (publickey)." })).toEqual({ kind: "auth", detail: "Permission denied (publickey)." });
    expect(cloneError("command clone_repository not found")).toEqual({ kind: "failed", detail: "command clone_repository not found" });
  });
});

describe("CloneRepositoryDialog", () => {
  it("clones beside the last project into a folder named for the repository, then opens it", async () => {
    const clone = nextClone();
    const props = renderDialog();
    const clonePress = screen.getByRole("button", { name: "Clone" });
    expect(clonePress).toHaveProperty("disabled", true);

    fireEvent.change(urlField(), { target: { value: " https://github.com/owner/neurips-paper.git " } });
    expect(locationField()).toHaveProperty("value", "/Users/ada/Papers/neurips-paper");
    fireEvent.click(clonePress);

    expect(tauri.invoke).toHaveBeenCalledWith("clone_repository", expect.objectContaining({
      url: "https://github.com/owner/neurips-paper.git",
      destination: "/Users/ada/Papers/neurips-paper",
    }));
    expect(screen.getByText("Connecting…")).toBeTruthy();
    expect(urlField()).toHaveProperty("disabled", true);
    act(() => tauri.channel?.onmessage?.({ stage: "receiving", progress: 0.4 }));
    expect(screen.getByText("Downloading… 40%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");

    await act(async () => clone.finish("/Users/ada/Papers/neurips-paper"));
    expect(props.onCloned).toHaveBeenCalledWith("/Users/ada/Papers/neurips-paper");
  });

  it("starts in Documents with no project yet, and Choose puts the clone in the chosen folder", async () => {
    renderDialog(null);
    fireEvent.change(urlField(), { target: { value: "git@github.com:owner/paperr.git" } });
    await waitFor(() => expect(locationField()).toHaveProperty("value", "/Users/ada/Documents/paperr"));

    tauri.open.mockResolvedValue("/Volumes/Work");
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(locationField()).toHaveProperty("value", "/Volumes/Work/paperr"));
    // A URL fixed after choosing still names the folder.
    fireEvent.change(urlField(), { target: { value: "git@github.com:owner/paper.git" } });
    expect(locationField()).toHaveProperty("value", "/Volumes/Work/paper");
  });

  it("says plainly why a clone failed, with git's own words, and lets the writer try again", async () => {
    const clone = nextClone();
    renderDialog();
    fireEvent.change(urlField(), { target: { value: "git@github.com:owner/private.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    await act(async () => clone.fail({ kind: "auth", detail: "git@github.com: Permission denied (publickey)." }));

    expect(await screen.findByText("Git couldn’t sign in to this repository")).toBeTruthy();
    expect(screen.getByText("git@github.com: Permission denied (publickey).")).toBeTruthy();
    expect(urlField()).toHaveProperty("disabled", false);
    expect(screen.queryByRole("progressbar")).toBeNull();
    // Editing clears the error.
    fireEvent.change(urlField(), { target: { value: "git@github.com:owner/public.git" } });
    expect(screen.queryByText("Git couldn’t sign in to this repository")).toBeNull();
  });

  it("names the folder that is in the way", async () => {
    const clone = nextClone();
    renderDialog();
    fireEvent.change(urlField(), { target: { value: "https://github.com/owner/thesis" } });
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    await act(async () => clone.fail({ kind: "folderExists" }));
    expect(await screen.findByText("“thesis” already exists there. Choose another location")).toBeTruthy();
  });

  it("Cancel stops a running clone and returns to the form, without closing", async () => {
    nextClone();
    const props = renderDialog();
    fireEvent.change(urlField(), { target: { value: "https://github.com/owner/big-paper.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(tauri.invoke).toHaveBeenCalledWith("cancel_clone");
    expect(props.onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(document.querySelector(".clone-repository-error")).toBeNull();
    expect(urlField()).toHaveProperty("value", "https://github.com/owner/big-paper.git");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalled();
  });
});
