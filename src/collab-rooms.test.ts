import { afterEach, describe, expect, it } from "vitest";
import { forgetCollabRoom, loadActiveCollabRooms, rememberCollabRoom } from "./collab-rooms";

afterEach(() => localStorage.clear());

const host = "lattice-collab.example.workers.dev";

describe("collab room memory", () => {
  it("remembers rooms and lists them newest-first", () => {
    rememberCollabRoom({ room: "LT-A", token: "t1", host, role: "host", title: "Alpha", projectRoot: "/a" }, 1000);
    rememberCollabRoom({ room: "LT-B", token: "t2", host, role: "guest", title: "Beta", projectRoot: null }, 2000);
    const rooms = loadActiveCollabRooms(2500);
    expect(rooms.map((r) => r.room)).toEqual(["LT-B", "LT-A"]);
    expect(rooms[0].token).toBe("t2");
  });

  it("de-dupes by host+room, keeping the latest metadata and timestamp", () => {
    rememberCollabRoom({ room: "LT-A", token: "t1", host, role: "host", title: "Old", projectRoot: "/a" }, 1000);
    rememberCollabRoom({ room: "LT-A", token: "t9", host, role: "host", title: "New", projectRoot: "/a" }, 3000);
    const rooms = loadActiveCollabRooms(3500);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].title).toBe("New");
    expect(rooms[0].token).toBe("t9");
  });

  it("hides rooms past the 30-day active window (matching server expiry)", () => {
    rememberCollabRoom({ room: "LT-A", token: "t1", host, role: "host", title: "Alpha", projectRoot: "/a" }, 0);
    const thirtyOneDays = 31 * 24 * 60 * 60 * 1000;
    expect(loadActiveCollabRooms(thirtyOneDays)).toHaveLength(0);
    expect(loadActiveCollabRooms(1000)).toHaveLength(1);
  });

  it("forgets one room without touching the others", () => {
    rememberCollabRoom({ room: "LT-A", token: "t1", host, role: "host", title: "Alpha", projectRoot: "/a" }, 1000);
    rememberCollabRoom({ room: "LT-B", token: "t2", host, role: "guest", title: "Beta", projectRoot: null }, 1000);
    forgetCollabRoom(host, "LT-A");
    expect(loadActiveCollabRooms(2000).map((r) => r.room)).toEqual(["LT-B"]);
  });
});
