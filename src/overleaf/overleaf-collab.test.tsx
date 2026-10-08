import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import { OverleafCollabDrawer, type OverleafCollabTab } from "./overleaf-collab";

const resolves = () => vi.fn().mockResolvedValue(undefined);
type DrawerProps = Parameters<typeof OverleafCollabDrawer>[0];
const drawer = (
  tab: OverleafCollabTab,
  { comments, ...overrides }: Partial<Omit<DrawerProps, "comments">> & { comments?: Partial<DrawerProps["comments"]> } = {},
) => (
  <OverleafCollabDrawer
    tab={tab} onTab={vi.fn()} onClose={vi.fn()}
    comments={{
      threads: [], anchors: new Map(), loading: false, error: null, reply: resolves(), setResolved: resolves(),
      remove: resolves(), editMessage: resolves(), deleteMessage: resolves(), ...comments,
    }}
    chat={{ messages: [], loading: false, error: null, send: resolves(), unread: 0 }}
    trackChanges={{ authorName: () => "未知", busy: null, error: null, accept: resolves(), reject: resolves() }}
    realtime={{ docId: "doc", changes: [], canWrite: true }}
    pathForDoc={() => null} source="" onRevealComment={vi.fn()} onReveal={vi.fn()} {...overrides}
  />
);

// test-setup.ts starts every test in English (and restores it afterwards), so
// only the Simplified Chinese case switches locale.
describe("Overleaf collaboration drawer localization", () => {
  afterEach(cleanup);

  it("counts both sources and keeps local history accessible even without open local comments", () => {
    const props = {
      comments: { threads: [{ id: "remote", messages: [], resolved: false, resolvedBy: null, resolvedAt: null }] },
      hasLocalComments: true, localCommentCount: 2, localComments: <div>Unsynced file discussion</div>,
    };
    const { rerender } = render(drawer("comments", props));
    expect(screen.getByRole("tab", { name: "Comments3" })).toBeInTheDocument();
    expect(screen.queryByText("Unsynced file discussion")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Local2" }));
    expect(screen.getByText("Unsynced file discussion")).toBeInTheDocument();
    expect(screen.getByText("These comments stay in Lattice and are not sent to Overleaf.")).toBeInTheDocument();
    rerender(drawer("comments", { ...props, localCommentCount: 0 }));
    expect(screen.getByRole("tab", { name: "Local" })).toBeInTheDocument();
    expect(screen.getByText("Unsynced file discussion")).toBeInTheDocument();
  });

  it("keeps the comment-source switch, and its focus, across sources", () => {
    render(drawer("comments", { hasLocalComments: true, localComments: <div>Unsynced file discussion</div> }));
    const overleaf = screen.getByRole("tab", { name: "Overleaf" });
    overleaf.focus();
    fireEvent.keyDown(overleaf, { key: "ArrowRight" });
    expect(screen.getByText("Unsynced file discussion")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Local" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Overleaf" })).toBe(overleaf);
  });

  it("lists resolved Overleaf threads only when the filter asks for all", () => {
    render(drawer("comments", {
      comments: { threads: [{ id: "t1", messages: [{ id: "c1", content: "Settled point", authorName: "Ada", authorEmail: "", timestamp: 0, mine: false }], resolved: true, resolvedBy: "Robin", resolvedAt: null }] },
    }));
    expect(screen.queryByText("Settled point")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All (1)" }));
    expect(screen.getByText("Settled point")).toBeInTheDocument();
  });

  it("opens local inline replies in the local view", () => {
    render(drawer("comments", { hasLocalComments: true, focusLocalComments: true, localComments: <div>Local reply editor</div> }));
    expect(screen.getByRole("tab", { name: "Local" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Local reply editor")).toBeInTheDocument();
  });

  it("renders the drawer and all three surfaces in Simplified Chinese", async () => {
    await activateAppLocale("zh-CN");
    const { rerender } = render(drawer("comments"));

    expect(screen.getByText("协作")).toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "Overleaf 协作视图" });
    expect(within(tabs).getByRole("tab", { name: "评论" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: "修订" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: "聊天" })).toBeInTheDocument();
    expect(screen.getByText("没有待处理的批注")).toBeInTheDocument();

    rerender(drawer("changes"));
    expect(screen.getByText("这份文档没有修订建议")).toBeInTheDocument();

    rerender(drawer("chat"));
    expect(screen.getByText(/还没有消息/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("给协作者发消息…")).toBeInTheDocument();
  });
});
