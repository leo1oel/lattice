import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import { OverleafCollabDrawer, type OverleafCollabTab } from "./overleaf-collab";

function drawer(tab: OverleafCollabTab, overrides: Partial<Parameters<typeof OverleafCollabDrawer>[0]> = {}) {
  return (
    <OverleafCollabDrawer
      tab={tab}
      onTab={vi.fn()}
      projectName="Attention Paper"
      onClose={vi.fn()}
      threads={[]}
      anchors={new Map()}
      activeDocId={null}
      pathForDoc={() => null}
      documentOpen
      commentsLoading={false}
      commentsError={null}
      onReply={vi.fn().mockResolvedValue(undefined)}
      onResolve={vi.fn().mockResolvedValue(undefined)}
      onDeleteThread={vi.fn().mockResolvedValue(undefined)}
      onEditMessage={vi.fn().mockResolvedValue(undefined)}
      onDeleteMessage={vi.fn().mockResolvedValue(undefined)}
      onRevealComment={vi.fn()}
      onReveal={vi.fn()}
      messages={[]}
      chatLoading={false}
      chatError={null}
      onSend={vi.fn().mockResolvedValue(undefined)}
      unreadChat={0}
      changes={[]}
      source=""
      changeAuthorName={() => "未知"}
      canActOnChanges
      changesBusy={null}
      changesError={null}
      onAcceptChanges={vi.fn().mockResolvedValue(undefined)}
      onRejectChanges={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />
  );
}

describe("Overleaf collaboration drawer localization", () => {
  afterEach(cleanup);

  it("counts both sources and keeps local history accessible even without open local comments", async () => {
    await activateAppLocale("en");
    const props = {
      threads: [{ id: "remote", messages: [], resolved: false, resolvedBy: null, resolvedAt: null }],
      hasLocalComments: true,
      localCommentCount: 2,
      localComments: <div>Unsynced file discussion</div>,
    };
    const { rerender } = render(drawer("comments", props));
    expect(screen.getByRole("tab", { name: "Comments3" })).toBeInTheDocument();
    expect(screen.queryByText("Unsynced file discussion")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Local comments2" }));
    expect(screen.getByText("Unsynced file discussion")).toBeInTheDocument();
    expect(screen.getByText("These comments stay in Lattice and are not sent to Overleaf.")).toBeInTheDocument();
    rerender(drawer("comments", { ...props, localCommentCount: 0 }));
    expect(screen.getByRole("tab", { name: "Local comments" })).toBeInTheDocument();
    expect(screen.getByText("Unsynced file discussion")).toBeInTheDocument();
  });

  it("opens local inline replies in the local view", async () => {
    await activateAppLocale("en");
    render(drawer("comments", {
      hasLocalComments: true,
      focusLocalComments: true,
      localComments: <div>Local reply editor</div>,
    }));
    expect(screen.getByRole("tab", { name: "Local comments" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Local reply editor")).toBeInTheDocument();
  });

  it("renders the drawer and all three surfaces in Simplified Chinese", async () => {
    await activateAppLocale("zh-CN");
    const { rerender } = render(drawer("comments"));

    expect(screen.getByText("Overleaf 协作")).toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "Overleaf 协作视图" });
    expect(within(tabs).getByRole("tab", { name: "评论" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: "更改" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: "聊天" })).toBeInTheDocument();
    expect(screen.getByText(/此项目中没有未解决的评论/)).toBeInTheDocument();

    rerender(drawer("changes"));
    expect(screen.getByText(/这里显示 Overleaf 上创建的修订建议/)).toBeInTheDocument();
    expect(screen.getByText("此文档中没有修订建议")).toBeInTheDocument();

    rerender(drawer("chat"));
    expect(screen.getByText(/这里显示与 Overleaf 中 Attention Paper 项目的聊天面板相同的对话/))
      .toBeInTheDocument();
    expect(screen.getByText(/还没有消息/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("给协作者发送消息…")).toBeInTheDocument();
  });
});
