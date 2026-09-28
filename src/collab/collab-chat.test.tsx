import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollabChatPanel } from "./collab-chat";

afterEach(cleanup);

describe("CollabChatPanel", () => {
  it("sides the viewer's messages by author id and uses the hover-revealed scrollbar", () => {
    render(
      <CollabChatPanel
        messages={[
          { id: "m1", authorId: "guest-1", authorName: "Robin", body: "hello", at: 1_700_000_000_000 },
          { id: "m2", authorId: "host-1", authorName: "Robin", body: "hi back", at: 1_700_000_001_000 },
        ]}
        selfId="host-1"
        onSend={vi.fn()}
      />,
    );
    // Same display name, different people: the header is not merged away.
    expect(screen.getByText("Robin")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("hi back").closest("article")).toHaveClass("mine");
    expect(screen.getByRole("region", { name: "Chat messages" })).toHaveClass("collab-chat-list", "native-hover-scrollbar");
  });
});
